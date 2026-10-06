# 13 — 结构化输出：让 LLM 可靠地输出 JSON

> 本 reference 覆盖 LLM 结构化输出的完整工程方案：Zod Schema First 范式、各厂商 JSON Mode 实战、容错解析、带错误注入的重试机制。读完本文件即可让 Agent 的 JSON 输出从"偶尔能解析"升级到"几乎不失败"。

---

## 目录

- [问题拆解：LLM 输出 JSON 的 12 种失败场景](#问题拆解llm-输出-json-的-12-种失败场景)
- [Zod Schema First 范式](#1-zod-schema-first-范式)
- [JSON Mode 实战](#2-json-mode-实战)
- [Loose JSON Parser](#3-loose-json-parser容错解析)
- [Retry with Error Injection](#4-retry-with-error-injection)
- [前端：Output Schema Designer](#5-前端output-schema-designer)
- [AI 避坑汇总](#6-ai-避坑汇总)

---

## 问题拆解：LLM 输出 JSON 的 12 种失败场景

**工程逻辑**：大部分 Agent 系统的 tool_call 依赖 LLM 输出结构化 JSON。但 LLM 不是 JSON 生成器——它输出的是"看起来像 JSON 的文本"。理解和分类失败场景是设计可靠 retry 机制的前提。

```
LLM JSON 输出的常见失败场景：

格式层面（容易修复）：
1. Markdown 包裹：  ```json\n{...}\n```
2. 多余文本前缀：  "Here is the result:\n{...}"
3. 多余文本后缀：  "{...}\n\nHope this helps!"
4. Trailing comma：{"a": 1,}  （JS 合法，JSON 非法）
5. 单引号：        {'key': 'value'}
6. 未转义字符：    {"text": "he said "hello""}
7. 注释：          {"a": 1, /* comment */ "b": 2}

结构层面（难以自动修复）：
8. 数组 vs 对象：  期望 {"items": [...]} 但返回 [...]
9. null vs 省略：  期望 {"key": null} 但返回 {}  （语义可能不同）
10. 类型漂移：     期望 {"count": 42} 但返回 {"count": "42"}
11. 字段缺失：     缺少必填字段，模型"忘了"输出
12. 字段多余：     返回了 schema 中没有定义的字段

截断场景（最难处理）：
13. max_tokens 截断：JSON 在大括号中间被截断
14. 流式截断：     SSE 流的最后 chunk 不完整

语义层面（只有 Zod 能检测）：
15. 数值越界：     age: 99999（too_big）
16. 字符串过短/长：name: ""（too_short）
17. 枚举值错误：    status: "unknown"（不在 enum 里）
```

---

## 1. Zod Schema First 范式

**工程逻辑**：不要手写 JSON Schema 然后"希望"LLM 遵守。正确的流程是：**先定义 Zod schema → 由 Zod schema 生成 tool definition 与 model 通信 → model 输出后 Zod 校验 → 失败则构建错误信息喂回 model**。

```typescript
// packages/core/src/llm/structured-output.ts

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Structured Output 请求
 */
export interface StructuredRequest<T extends z.ZodTypeAny> {
  schema: T;
  systemPrompt?: string;
  userMessage: string;
  maxRetries?: number;
  model?: string;
}

/**
 * Structured Output 结果
 */
export interface StructuredResult<T> {
  data: T;
  attempts: number;
  rawResponses: string[];
  validationErrors: z.ZodError[];
}

/**
 * Zod Schema First 范式核心
 *
 * 设计思路：
 * 1. Schema 是 truth source —— 不手写 JSON Schema，不维护两套定义
 * 2. 自动从 Zod schema 生成各厂商所需的格式
 * 3. 校验失败时把 zodiac 错误信息转化为自然语言喂回模型
 */
export class StructuredOutputEngine {
  private llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

  /**
   * 主入口：可靠地获取符合 schema 的结构化输出
   *
   * 流程：生成请求 → 调用模型 → Zod 校验 → 失败则注入错误重试
   */
  async generate<T extends z.ZodTypeAny>(
    request: StructuredRequest<T>
  ): Promise<StructuredResult<z.infer<T>>> {
    const schema = request.schema;
    const maxRetries = request.maxRetries ?? 3;
    const rawResponses: string[] = [];
    const validationErrors: z.ZodError[] = [];

    // 1. 从 Zod schema 转换为各模型所需的 JSON Schema
    const jsonSchema = zodToJsonSchema(schema, {
      name: 'output',
      $refStrategy: 'none',
      target: 'openApi3',
    });

    // 2. 构建 system prompt（要求模型只输出 JSON）
    const systemPrompt = request.systemPrompt ??
      `Output ONLY valid JSON matching the provided schema. No explanations, no markdown code blocks, no extra text.`;

    // 3. 构建 user message（let：重试时会被 userMessageWithErrors 覆盖）
    let userMessage = `
${request.userMessage}

Required output format (JSON Schema):
${JSON.stringify(jsonSchema, null, 2)}

Output ONLY the JSON object, nothing else.`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 4. 调用 LLM
      const rawResponse = await this.callModel(systemPrompt, userMessage, jsonSchema);
      rawResponses.push(rawResponse);

      // 5. 容错解析
      const parsed = parseLooseJson(rawResponse);
      if (!parsed) {
        // 解析完全失败，构造错误信息喂回
        validationErrors.push(createParseError(rawResponse));
        continue;
      }

      // 6. Zod 校验
      const result = schema.safeParse(parsed);
      if (result.success) {
        return {
          data: result.data,
          attempts: attempt + 1,
          rawResponses,
          validationErrors,
        };
      }

      // 7. 校验失败 —— 构建详细的错误信息
      validationErrors.push(result.error);

      if (attempt < maxRetries) {
        // 把 Zod 错误转化为用户/模型可读的自然语言
        const errorMessages = formatZodError(result.error);

        // (P1 修复：不可给 string 属性赋值，直接用返回值覆盖)
        userMessage = userMessageWithErrors(userMessage, errorMessages, rawResponse);
      }
    }

    // 所有重试都失败 —— 最后一次尝试宽松提取
    return this.fallbackExtraction(rawResponses[rawResponses.length - 1], schema, {
      data: null as any,
      attempts: maxRetries + 1,
      rawResponses,
      validationErrors,
    });
  }

  /**
   * 调用模型 —— 根据模型类型选择不同的结构化输出模式
   */
  private async callModel(systemPrompt: string, userMessage: string, jsonSchema: any): Promise<string> {
    // 优先使用 JSON Mode（OpenAI / Anthropic 均支持但语法不同）
    if (this.llmClient.provider === 'openai') {
      return this.callWithOpenAIJsonMode(systemPrompt, userMessage, jsonSchema);
    } else if (this.llmClient.provider === 'anthropic') {
      return this.callWithAnthropicToolMode(systemPrompt, userMessage, jsonSchema);
    }

    // 兜底：普通 prompt 调用
    return this.callPlain(systemPrompt, userMessage);
  }

  ...callMethods在下面展开...

  /**
   * 最终兜底：用 LLM 自己把错误 JSON 修正为合规 JSON
   */
  private async fallbackExtraction<T>(
    lastRaw: string,
    schema: z.ZodTypeAny,
    partialResult: StructuredResult<T>
  ): Promise<StructuredResult<T>> {
    const fixPrompt = `The following output failed validation. Fix it to match the schema.

Failed output:
${lastRaw}

Please output ONLY valid JSON that matches the correct schema.`;

    try {
      const fixed = await this.callPlain('Output ONLY valid JSON.', fixPrompt);
      const parsed = parseLooseJson(fixed);
      if (parsed) {
        const result = schema.safeParse(parsed);
        if (result.success) {
          return { ...partialResult, data: result.data, attempts: partialResult.attempts + 1 };
        }
      }
    } catch { /* ignore fallback failure */ }

    throw new Error(`Failed to produce valid structured output after ${partialResult.attempts} attempts. Last error: ${partialResult.validationErrors[partialResult.validationErrors.length - 1]?.message ?? 'unknown'}`);
  }
}
```

```typescript
// StructuredOutputEngine 的 call 方法细节

/**
 * OpenAI JSON Mode 调用
 *
 * 关键参数：response_format: { type: "json_schema", json_schema: { schema, strict: true } }
 * 这确保了模型会输出符合 schema 的 JSON（OpenAI 端到端保证）
 *
 * 注意：json_schema 的 name 必须是合法标识符（字母开头，只含字母数字下划线）
 * description 字段是可选的，但推荐加上（帮助模型理解期望输出）
 */
private async callWithOpenAIJsonMode(systemPrompt: string, userMessage: string, jsonSchema: any): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${this.llmClient.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: this.llmClient.model ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'structured_output',
          strict: true,
          schema: jsonSchema,
        },
      },
      temperature: 0.1,  // 低温度提高一致性和格式可靠性
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new OpenAIError(response.status, error);
  }

  const data = await response.json();
  return data.choices[0].message.content ?? '';
}

/**
 * Anthropic Tool Mode 调用
 *
 * Anthropic 不支持 JSON Schema Mode（截至 2024），但可以用 tool_use 模拟：
 * 定义一个 "output" tool，要求模型必须调用这个 tool 返回结果
 *
 * 优点：Claude 的 tool_use 输出是强类型 JSON，天然符合 schema
 * 缺点：多一次 tool call，延迟增加 ~200ms
 */
private async callWithAnthropicToolMode(systemPrompt: string, userMessage: string, jsonSchema: any): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': this.llmClient.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: this.llmClient.model ?? 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tools: [{
        name: 'structured_output',
        description: 'Output the structured result',
        input_schema: jsonSchema,
      }],
      tool_choice: { type: 'tool', name: 'structured_output' },  // 强制调用
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new AnthropicError(response.status, error);
  }

  const data = await response.json();
  // Claude 在 tool_use block 中返回结果
  const toolBlock = data.content.find((c: any) => c.type === 'tool_use');
  if (toolBlock) {
    return JSON.stringify(toolBlock.input);
  }

  // 兜底：从 text block 读取
  const textBlock = data.content.find((c: any) => c.type === 'text');
  return textBlock?.text ?? '';
}

/** 纯文本调用（最低可靠性兜底） */
private async callPlain(systemPrompt: string, userMessage: string): Promise<string> {
  const response = await this.llmClient.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.1,
  });
  return response.content ?? '';
}
```

---

## 2. JSON Mode 实战

### 各厂商 JSON Mode 对比

```
┌──────────────┬───────────────────────────────────────────────────────────┐
│ Vendor       │ JSON Mode 方案                                             │
├──────────────┼───────────────────────────────────────────────────────────┤
│ OpenAI       │ response_format: { type: "json_schema", json_schema: {...} } │
│              │ - 端到端保证，模型内部约束输出                                │
│              │ - 需要 gpt-4o-2024-08-06+ 或 gpt-4o-mini+                    │
│              │ - strict: true 时要求 schema 和输出完全一一对应               │
│              │                                                            │
│ Anthropic    │ 无原生 JSON Mode（截至 2024 年 10 月）                       │
│              │ - 用 tool_choice: tool 强制调用模拟                          │
│              │ - Claude 3.5+ 的 tool_use 本能输出合规 JSON                   │
│              │ - 或等待 Anthropic 后续版本支持 response_schema 参数         │
│              │                                                            │
│ Google       │ response_schema (Gemini 1.5+)                              │
│ Gemini       │ - 最灵活：支持 response_schema 字段直接嵌入 schema           │
│              │ - response_mime_type: "application/json" 作为基础 JSON Mode  │
│              │ - 注意：Gemini 的 JSON Mode 对 unknown_fields 处理严格        │
│              │                                                            │
│ Ollama       │ format: "json" (ollama >= 0.1.32)                          │
│              │ - 本地模型通过 GBNF grammar 约束输出                          │
│              │ - 需要提供 JSON grammar 或用内置 "json" 格式                 │
│              │ - 部分模型（如 Mistral）的 JSON Mode 不可靠                  │
│              │                                                            │
│ vLLM /       │ guided_json / guided_choice (Inference 引擎层面)            │
│ TGI          │ - 通过 grammar 采样强制输出符合 schema 的 JSON                │
│              │ - 完全不依赖模型的"自觉性"，从采样层面约束                    │
│              │ - 适合本地部署场景                                           │
└──────────────┴───────────────────────────────────────────────────────────┘
```

### Gemini JSON Mode 完整代码

```typescript
// packages/core/src/llm/gemini-json-mode.ts

/**
 * Google Gemini 结构化输出
 *
 * 两种模式：
 * 1. response_mime_type: "application/json" —— 只保证输出是 JSON，不保证符合 schema
 * 2. response_schema —— 严格保证输出符合 schema（推荐）
 *
 * 注意：Gemini 的 response_schema 字段名和 OpenAI 的 json_schema 略有不同：
 * - OpenAI: { type: "object", properties: {...}, required: [...] }
 * - Gemini 1.5+: { type: "object", properties: {...}, required: [...] } (相同)
 * - Gemini Flash: response_schema 仅支持部分 schema 类型（不支持 anyOf、array items 等复杂结构）
 */
export async function geminiStructuredOutput(
  apiKey: string,
  model: string,
  schema: object,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', content: userMessage },
        ],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          temperature: 0.1,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  return data.candidates[0]?.content?.parts[0]?.text ?? '';
}
```

### Grammar-guided Output (vLLM/TGI)

```typescript
// packages/core/src/llm/grammar-guided-output.ts

/**
 * Grammar-Guided Output —— 从采样层面强制 JSON 格式
 *
 * 适合本地部署（vLLM, TGI, llama.cpp），优势：
 * - 采样时直接 exclude 不符合 grammar 的 token
 * - 不依赖模型能力，100% 输出合法 JSON
 * - 支持任何 JSON Schema → GBNF grammar 自动转换
 *
 * 实现依赖后端推理引擎，前端通过特定 HTTP 头或参数启用
 */
export async function grammarGuidedOutput(
  endpoint: string,
  schema: object,
  messages: any[]
): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      guided_json: schema,       // vLLM / TGI 的参数
      // 或 grammar: convertToGBNF(schema)  // llama.cpp
      temperature: 0.1,
    }),
  });

  if (!response.ok) throw new Error(`Grammar-guided output error: ${response.status}`);
  const data = await response.json();
  return data.choices[0].message.content ?? '';
}

/**
 * JSON Schema → GBNF Grammar 转换（简化版本）
 * 生产环境使用 outlines 库 或 json-schema-to-grammar
 */
function convertToGBNF(schema: any): string {
  // 这是极度简化的示意代码。实际生产中直接用 outlines 库：
  // import { outlines } from 'outlines'
  // const generator = outlines.generate.json(model, JSON.stringify(schema))
  // return generator(prompt)
  return `# GBNF grammar would be auto-generated from schema: ${JSON.stringify(schema).slice(0, 100)}...`;
}
```

---

## 3. Loose JSON Parser（容错解析）

**工程逻辑**：即使启用了 JSON Mode，模型仍可能包裹 Markdown、加注释、末尾多逗号。一个鲁棒的解析器是结构化输出的最后一道防线。

```typescript
// packages/core/src/llm/loose-json-parser.ts

/**
 * 容错 JSON 解析器
 *
 * 处理场景：
 * 1. Markdown 代码块包裹（```json ... ```）
 * 2. 前后多余文本
 * 3. 单引号 → 双引号
 * 4. Trailing comma
 * 5. 未转义的字符串内引号
 * 6. null/undefined/NaN 的不规范写法
 *
 * 返回: 解析成功返回对象/数组，失败返回 null
 */
export function parseLooseJson(raw: string): Record<string, unknown> | unknown[] | null {
  if (!raw || typeof raw !== 'string') return null;

  let text = raw.trim();

  // 步骤 1: 移除 markdown 代码块
  text = stripMarkdownCodeBlock(text);

  // 步骤 2: 提取最外层的 JSON 对象/数组
  text = extractJsonBoundary(text);
  if (!text) return null;

  // 步骤 3: 用 JSON.parse 尝试解析
  try {
    return JSON.parse(text);
  } catch {
    // 步骤 4: 依次应用修复策略
    return tryRepairParse(text);
  }
}

function stripMarkdownCodeBlock(text: string): string {
  // 匹配 ```json ... ``` 或 ``` ... ```
  const codeBlockTriple = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/;
  const match = text.match(codeBlockTriple);
  if (match) return match[1].trim();
  return text;
}

function extractJsonBoundary(text: string): string {
  const trimmed = text.trim();

  // 如果本身就是 { 或 [ 开头，大概率已经是 json
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // 提取到最后一个 } 或 ]
    const lastBrace = trimmed.lastIndexOf('}');
    const lastBracket = trimmed.lastIndexOf(']');

    const end = Math.max(lastBrace, lastBracket);
    if (end === -1) return trimmed;

    return trimmed.slice(0, end + 1);
  }

  // 否则在文本中找 { ... } 或 [ ... ]
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const start = firstBrace === -1 ? firstBracket :
                 firstBracket === -1 ? firstBrace :
                 Math.min(firstBrace, firstBracket);

  if (start === -1) return trimmed;

  // 从 start 开始寻找匹配的最外层括号
  const openChar = trimmed[start];
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let end = -1;

  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === openChar) depth++;
    if (trimmed[i] === closeChar) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end === -1) return trimmed.substring(start);  // 括号不匹配，截断场景
  return trimmed.substring(start, end + 1);
}

/**
 * 修复并重新尝试解析（按优先级依次尝试）
 */
function tryRepairParse(text: string): Record<string, unknown> | unknown[] | null {
  const repairs = [
    // 修复 1: Trailing comma —— 移除 }, 和 ], 中的逗号
    (t: string) => t.replace(/,(\s*[}\]])/g, '$1'),

    // 修复 2: 单引号 → 双引号（简单替换，不处理嵌套引号）
    (t: string) => t.replace(/'([^']*?)'/g, '"$1"'),

    // 修复 3: 无引号 key → 有引号 key —— {foo: "bar"} → {"foo": "bar"}
    (t: string) => t.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":'),

    // 修复 4: 控制字符（null, newline, tab 在字符串中未转义）
    (t: string) => t.replace(/(["\])[(][^"\][(]*?)([\n\r\t])/g, (match, prefix, content, control) => {
      const escaped = control === '\n' ? '\\n' : control === '\r' ? '\\r' : control === '\t' ? '\\t' : control;
      return prefix + content + escaped;
    }),

    // 修复 5: 未闭合的字符串（末尾遗漏了 " 或 }）
    (t: string) => {
      const braceCount = (t.match(/{/g) || []).length - (t.match(/}/g) || []).length;
      const quoteCount = (t.match(/"/g) || []).length;
      let result = t;
      if (quoteCount % 2 !== 0) result += '"';
      if (braceCount > 0) result += '}'.repeat(braceCount);
      return result;
    },
  ];

  // 先尝试逐个修复
  let current = text;
  for (const repair of repairs) {
    try {
      const repaired = repair(current);
      return JSON.parse(repaired);
    } catch {
      current = repair(current);  // 修复后留给下一个 repair
    }
  }

  // 再尝试组合所有修复
  try {
    let fullyRepaired = text;
    for (const repair of repairs) {
      fullyRepaired = repair(fullyRepaired);
    }
    return JSON.parse(fullyRepaired);
  } catch {
    return null;
  }
}

/** 构建"无法解析"的错误对象 */
function createParseError(raw: string): any {
  return {
    issues: [{
      code: 'custom',
      message: 'Response is not valid JSON',
      path: [],
      received: raw.slice(0, 200) + (raw.length > 200 ? '...' : ''),
    }],
  } as any;
}
```

---

## 4. Retry with Error Injection

**工程逻辑**：当模型第一次输出不符合 schema 时，把 Zod 错误转化为自然语言反馈给模型，让它"看到自己的错误"后自己修复。这比 top-down 的 prompt engineering 效果好得多（类似于 humain 犯错后的自我纠正）。

```typescript
// packages/core/src/llm/error-injection.ts

import { z } from 'zod';

/**
 * 把 ZodError 格式化为人类可读的错误信息
 *
 * 转化原则：
 * - 用поле名 → 人类能理解的字段描述
 * - 指出期望类型 ≠ 实际输入
 * - 指出具体的错误路径（嵌套对象用 a.b.c）
 */
export function formatZodError(error: z.ZodError): string[] {
  return error.issues.map(issue => {
    const path = issue.path.join('.');
    switch (issue.code) {
      case 'invalid_type':
        return `Field "${path}": expected ${issue.expected}, but got ${issue.received}`;
      case 'too_small':
        return `Field "${path}": value is too small (minimum: ${issue.minimum})`;
      case 'too_big':
        return `Field "${path}": value is too large (maximum: ${issue.maximum})`;
      case 'invalid_string':
        return `Field "${path}": invalid format (${issue.validation})`;
      case 'invalid_enum_value':
        return `Field "${path}": must be one of [${issue.options?.join(', ')}], got "${issue.received}"`;
      case 'unrecognized_keys':
        return `Unknown field(s): ${issue.keys.join(', ')}`;
      default:
        return `Field "${path}": ${issue.message}`;
    }
  });
}

/**
 * 构建修复提示 —— 把错误注入到对话中让模型自己修复
 *
 * 策略：在 user message 末尾追加"错误反馈"，让模型在下一轮"看到自己的错误"
 */
export function userMessageWithErrors(
  originalUserMessage: string,
  errorMessages: string[],
  rawResponse: string
): string {
  return `${originalUserMessage}

---
Your previous response failed validation with the following errors:
${errorMessages.map(e => `- ${e}`).join('\n')}

Previous response:
${rawResponse.slice(0, 500)}${rawResponse.length > 500 ? '...' : ''}

Please fix these errors and output ONLY valid JSON.`;
}

/**
 * 增量式结构化输出 —— 支持带 tool_call 的 Agent 场景
 *
 * Agent 输出结构化 JSON 的常见场景是 tool_call.arguments：
 * 模型返回 tool_call，但 arguments 字段不是合法 JSON
 * 此时通过 tool result 把错误信息反馈给模型让它重新生成 tool_call
 */
export class AgentToolOutputFixer {
  /**
   * 修复损坏的 tool_call arguments
   *
   * @param originalToolCall 原始的 tool_call（arguments 可能是无效 JSON）
   * @param schema 期望的 Zod schema
   * @returns 修复后的 arguments，或 null（修复失败）
   */
  static async fixToolArguments(
    originalToolCall: { name: string; arguments: string },
    schema: z.ZodTypeAny,
    llmClient: LLMClient
  ): Promise<Record<string, unknown> | null> {
    // 先尝试容错解析
    const parsed = parseLooseJson(originalToolCall.arguments);
    if (parsed) {
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
    }

    // 解析失败，用 LLM 修复
    const fixPrompt = `Fix this broken JSON to match the expected schema.

Tool: ${originalToolCall.name}
Schema: ${JSON.stringify(zodToJsonSchema(schema, { name: "args" }), null, 2)}

Broken arguments: ${originalToolCall.arguments}

Output ONLY valid JSON:`;

    const fixed = await llmClient.chat({
      messages: [
        { role: 'system', content: 'Output ONLY valid JSON matching the schema.' },
        { role: 'user', content: fixPrompt },
      ],
      temperature: 0.1,
    });

    const fixedParsed = parseLooseJson(fixed.content ?? '');
    if (!fixedParsed) return null;

    const result = schema.safeParse(fixedParsed);
    return result.success ? result.data : null;
  }
}
```

---

## 5. 前端：Output Schema Designer

```typescript
// apps/web/src/components/settings/SchemaDesigner.tsx

import { useState, useCallback } from 'react';
import { z } from 'zod';

interface SchemaField {
  id: string;
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required: boolean;
  description?: string;
  children?: SchemaField[];  // nested fields for object/array
  enumValues?: string[];
}

export function SchemaDesigner() {
  const [fields, setFields] = useState<SchemaField[]>([
    { id: '1', name: 'action', type: 'string', required: true, description: 'The action to take' },
    { id: '2', name: 'param', type: 'string', required: false, description: 'Optional parameter' },
  ]);
  const [testInput, setTestInput] = useState('');
  const [testResult, setTestResult] = useState<{ valid: boolean; data?: any; errors?: string[] } | null>(null);

  /**
   * 将字段定义转换为 Zod schema
   */
  const fieldsToSchema = useCallback((fields: SchemaField[]): string => {
    if (fields.length === 0) return 'z.object({})';

    const fieldSchemas = fields.map(f => {
      const required = f.required ? '' : '.optional()';
      const desc = f.description ? `.describe('${f.description}')` : '';
      let base: string;

      switch (f.type) {
        case 'string':
          base = f.enumValues
            ? `z.enum(${JSON.stringify(f.enumValues)})`
            : 'z.string()';
          break;
        case 'number':
          base = 'z.number()';
          break;
        case 'boolean':
          base = 'z.boolean()';
          break;
        default:
          base = 'z.string()';
      }

      return `${f.name}: ${base}${desc}${required}`;
    });

    return `z.object({\n  ${fieldSchemas.join(',\n  ')}\n})`;
  }, []);

  const handleTest = useCallback(async () => {
    if (!testInput.trim()) return;
    try {
      const res = await fetch('/api/structured/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema: fieldsToSchema(fields),
          userMessage: testInput,
        }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (error) {
      setTestResult({ valid: false, errors: ['Test request failed'] });
    }
  }, [fields, testInput, fieldsToSchema]);

  const handleAddField = useCallback(() => {
    setFields(prev => [...prev, {
      id: String(Date.now()),
      name: `field_${prev.length}`,
      type: 'string',
      required: false,
    }]);
  }, []);

  return (
    <div className="space-y-4">
      {/* Schema 编辑器 */}
      <div className="p-4 rounded-lg bg-surface/50 border border-border">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">JSON Schema 设计器</h3>
          <button
            onClick={handleAddField}
            className="px-2 py-1 text-xs rounded bg-accent/20 text-accent"
          >
            + 添加字段
          </button>
        </div>

        <div className="space-y-2">
          {fields.map(field => (
            <div key={field.id} className="flex items-center gap-2 p-2 rounded bg-surface">
              <input
                type="text"
                value={field.name}
                onChange={e => setFields(prev => prev.map(f => f.id === field.id ? { ...f, name: e.target.value } : f))}
                className="w-32 px-2 py-1 text-xs rounded border border-border bg-surface"
                placeholder="字段名"
              />
              <select
                value={field.type}
                onChange={e => setFields(prev => prev.map(f => f.id === field.id ? { ...f, type: e.target.value as any } : f))}
                className="px-2 py-1 text-xs rounded border border-border bg-surface"
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="object">object</option>
                <option value="array">array</option>
              </select>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={e => setFields(prev => prev.map(f => f.id === field.id ? { ...f, required: e.target.checked } : f))}
                />
                必填
              </label>
              <button
                onClick={() => setFields(prev => prev.filter(f => f.id !== field.id))}
                className="ml-auto text-xs text-red-400"
              >
                删除
              </button>
            </div>
          ))}
        </div>

        {/* 预览生成的 Zod Schema */}
        <details className="mt-3">
          <summary className="text-xs opacity-60 cursor-pointer">预览 Zod 代码</summary>
          <pre className="mt-2 p-2 text-xs bg-black/20 rounded overflow-auto">
            {fieldsToSchema(fields)}
          </pre>
        </details>
      </div>

      {/* 测试区域 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">测试结构化输出</h3>
        <textarea
          value={testInput}
          onChange={e => setTestInput(e.target.value)}
          placeholder="输入用户消息测试 LLM 结构化输出..."
          rows={3}
          className="w-full px-3 py-2 text-sm rounded-lg bg-surface border border-border resize-none"
        />
        <button
          onClick={handleTest}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-accent-foreground"
        >
          测试输出
        </button>

        {testResult && (
          <div className={`p-3 rounded-lg border ${testResult.valid ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
            <div className="text-xs font-medium mb-1">
              {testResult.valid ? '输出有效' : '输出无效'}
            </div>
            {testResult.errors && (
              <ul className="text-xs text-red-400 space-y-1">
                {testResult.errors.map((err, i) => <li key={i}>- {err}</li>)}
              </ul>
            )}
            {testResult.data && (
              <pre className="mt-2 text-xs overflow-auto">
                {JSON.stringify(testResult.data, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 6. AI 避坑汇总

> 🤖 **AI 常见错误**：
>
> 1. **JSON Mode 下模型仍包裹 Markdown**：即使设置了 `response_format: json_schema`，部分模型（特别是 gpt-4o-mini 和 Cla
ude Haiku）有时仍会在 JSON 外面加 ```或文字说明。必须先走 Loose JSON Parser 再 Zod 校验，不依赖 Model"完全配合"。
>
> 2. **长 JSON 被 max_tokens 截断**：当返回的 JSON 很大时（如复杂 tool_call 的 arguments），模型可能输出完整的 structure 但 values 被截断。比如数组只输出了前 5 个元素就被截掉。解决方案：在 Structured Output 请求的 system prompt 中强调"必须输出完整 JSON，不要省略任何字段"。给模型分配足够的 max_tokens（预估输出 token 的 2 倍）。
>
> 3. **Zod 的 too_big/too_small 边界场景**：AI 经常用 `z.string().min(1).max(100)` 约束字段长度，但忘了 `min(0)` 可能接受空字符串。LLM 输出 `"name": ""` 通过了 schema 校验但语义上无意义。需要在 Zod schema 中加 `.min(1, "Name cannot be empty")` 而非默认行为。
>
> 4. **重试时 temperature 过高导致不一致**：每次重试时都用 0.7 的 temperature，模型的每次输出都不同，导致错误信息也不一致，模型更难自我修正。Structured Output 应始终用 temperature ≤ 0.1，保证一致性。
>
> 5. **Error injection 时过长的历史消息**：把每次失败的原始 response 都塞回 prompt，3 次重试后原始消息 token 已超过 context window 的一半。应在 injection 中只保留错误摘要（字段名+错误类型），而非完整的原始输出。
>
> 6. **用 anyOf 而非 discriminatedUnion 做工具选择**：`z.union([z.object({...}), z.object({...})])` 在多个 schema 有相似字段时会让 Zod 总是匹配第一个。应使用 `z.discriminatedUnion('type', [...])` 保证按 type 字段正确区分。
>
> 7. **ZZod 默认 strip unknown keys**：默认 `z.object({ safeData: z.string() }).parse({ safeData: "ok", extra: "bypass" })` 不会报错，extra 字段被静默移除。这在安全场景下可能有风险——攻击者可能在 prompt 中注入多余字段来测试 schema 宽容度。用 `.strict()` 严
格模式或在 system prompt 中声明"不接受未定义字段"。
>
> 8. **流式场景的结构化输出**：在 SSE 流式响应中使用 JSON Mode 会有问题——模型输出的每个 chunk 可能不是完整 JSON，中间状态时 parseLooseJson 会提前"截获"半个 JSON 并误判为截断错误。流式场景应在 `done` event 触发后才做完整解析，中间 chunk 只做展示。
