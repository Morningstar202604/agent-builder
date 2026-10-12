# 13 — 结构化输出：Zod + AI SDK，不手写 JSON 解析

> 本 reference 覆盖 LLM 结构化输出的成熟方案：Zod Schema First + AI SDK `generateObject` / `streamObject`（早期版本名 `experimental_ObjectStream`），需要错误注入重试时用 instructor-js。不再手写 Loose JSON Parser 与重试循环。

> **⚠️ 本层铁律：不自研 JSON 容错解析，不自研重试注入。**
> - Schema 定义 → **Zod**（`z.object` 等），所有 tool / 结构化输出共用同一 schema
> - 结构化生成 → **AI SDK `generateObject` / `streamObject`**（`ai`），由 SDK 对接各厂商 JSON Mode / tool 模式
> - 错误注入重试 → **instructor-js**（内置 `maxRetries` + 错误回喂），不手写 retry 循环
> - 容错解析 → 不保留通用 Loose Parser；仅保留 `[CUSTOM]` 极薄一层剥离 markdown 围栏（见 §6）

---

## 目录

- [1 问题拆解：为什么不再手写解析器](#1-问题拆解为什么不再手写解析器)
- [2 Zod Schema First](#2-zod-schema-first)
- [3 非流式：generateObject](#3-非流式generateobject)
- [4 流式：streamObject / experimental_ObjectStream](#4-流式streamobject--experimental_objectstream)
- [5 需要错误注入重试时：instructor-js](#5-需要错误注入重试时instructor-js)
- [6 容错解析 [CUSTOM] 极薄层](#6-容错解析-custom-极薄层)
- [7 AI 避坑汇总](#7-ai-避坑汇总)
- [8 本层验收清单](#8-本层验收清单)

---

## 1. 问题拆解：为什么不再手写解析器

🔗 **工程逻辑**：LLM 输出\"看起来像 JSON 的文本\"——Markdown 围栏、尾逗号、字段缺失、类型漂移、截断都会发生。手写 Loose JSON Parser + 错误注入重试曾经是唯一出路，但 2026 年的成熟方案已经把这些能力内置：

- `generateObject` 用 provider 的结构化输出模式（OpenAI `json_schema`、Anthropic tool 强制、Gemini `response_schema`），从采样端约束格式；
- Zod 在 SDK 内部完成校验，失败由 SDK 重试（`maxRetries`）；
- instructor-js 把\"校验失败 → 错误回喂 → 重试\"闭环化。

**因此本层不再维护 `loose-json-parser.ts` 和 `error-injection.ts`**——它们的工作被 SDK 取代。

## 2. Zod Schema First

```typescript
// packages/core/src/llm/structured-output.ts —— Zod Schema First
import { z } from 'zod';

export const extractionSchema = z.object({
  action: z.enum(['reply', 'search', 'tool']),
  entities: z.array(z.object({ name: z.string(), type: z.string() })),
  confidence: z.number().min(0).max(1),
});

export type Extraction = z.infer<typeof extractionSchema>;
```

🔗 **工程逻辑**：同一个 `extractionSchema` 同时用于：
- `generateObject` / `streamObject` 的 `schema` 参数（结构化输出）；
- `tool()` 的 `parameters`（见 11-function-calling.md）；
- 服务端返回值类型 `Extraction`（前端 `UIMessage` 直接消费）。

契约见 00-types.md：`llm` 一律是 `ai` 的 `LanguageModel`，通过 01-foundation.md 的 `createModel` 获取。

> 🤖 **AI 常见错误**：在 prompt 里写\"只返回 JSON，不要解释\"这类格式约束——provider 的 JSON Mode / tool 模式已经保证格式，prompt 只描述语义；把 schema 形状写进 prompt 反而干扰模型。

## 3. 非流式：generateObject

```typescript
// apps/web/src/app/api/structured/route.ts
import { generateObject } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { extractionSchema } from '@agentcore/core/structured-output';

export async function POST(req: Request) {
  const { text }: { text: string } = await req.json();

  const { object } = await generateObject({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    schema: extractionSchema,
    prompt: `从以下文本提取结构化信息：\n${text}`,
  });

  return Response.json({ object });
}
```

说明：
- `generateObject` 自动选择 provider 支持的结构化输出模式（OpenAI 用 `response_format`，Anthropic 用 tool 模式），不需要手写两种 HTTP 调用；
- 返回的 `object` 已经通过 Zod 校验，类型为 `Extraction`；
- 需要模型\"看到\"字段语义时，在 Zod schema 上写 `description`（如 `z.string().describe('人名')`），SDK 会把它带进 schema。

## 4. 流式：streamObject / experimental_ObjectStream

服务端：

```typescript
// apps/web/src/app/api/structured/stream/route.ts
import { streamObject } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { extractionSchema } from '@agentcore/core/structured-output';

export async function POST(req: Request) {
  const { text }: { text: string } = await req.json();

  const result = streamObject({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    schema: extractionSchema,
    prompt: `从以下文本提取结构化信息：\n${text}`,
  });

  // 早期版本名为 experimental_ObjectStream，v4 统一为 streamObject + toUIMessageStreamResponse
  return result.toUIMessageStreamResponse();
}
```

前端用 `ai/react` 的 `useObject` 消费（不要手写 SSE 拼接）：

```tsx
// apps/web/src/components/ExtractionView.tsx
'use client';

import { useObject } from 'ai/react';

export function ExtractionView() {
  const { object, submit } = useObject({ api: '/api/structured/stream' });

  return (
    <div>
      <button onClick={() => submit({ text: '张三今年 25 岁' })}>提取</button>
      <pre>{JSON.stringify(object, null, 2)}</pre>
    </div>
  );
}
```

🤖 **AI 常见错误**：流式场景在中间态用 `JSON.parse` 解析每个 chunk——`streamObject` 的 partial object 不是完整 JSON，必须交给 `useObject` / `partialObjectStream` 处理。

## 5. 需要错误注入重试时：instructor-js

🔗 **工程逻辑**：如果团队已经在直连 OpenAI SDK（而不是 AI SDK 的 `generateObject`），需要\"校验失败 → 错误回喂 → 重试\"闭环，用 **instructor-js**，不要手写 retry 循环。

```typescript
// packages/core/src/llm/instructor.ts —— 仅直连 OpenAI SDK 时选用（可选）
import Instructor from '@instructor-ai/instructor';
import type OpenAI from 'openai';
import { z } from 'zod';

const retrySchema = z.object({
  action: z.enum(['reply', 'search', 'tool']),
  entities: z.array(z.string()),
});

export async function extractWithInstructor(client: OpenAI, text: string) {
  const patched = Instructor({ client, mode: 'JSON_SCHEMA' });
  return patched.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: text }],
    response_model: { schema: retrySchema, name: 'Extraction' },
    maxRetries: 3, // 内置错误注入重试：Zod 校验失败自动带错误信息重试
  });
}
```

> 注意：本仓库主路径（AI SDK）不创建裸 Provider 客户端实例，`client` 由使用方传入，避免与 00-types 契约冲突。

## 6. 容错解析 [CUSTOM] 极薄层

> `[CUSTOM]` 理由：`generateObject` / `streamObject` 已保证合法 JSON，**不保留**通用 Loose Parser。唯一例外是\"兜底用纯文本调用 LLM 再手动解析\"的极端场景——此时只做 markdown 围栏剥离，不做单引号 / 尾逗号等修复魔法（那些是 SDK 的职责）。

```typescript
// packages/core/src/llm/json-fallback.ts —— 极薄容错层 [CUSTOM]
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?\s*```$/.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}
```

使用方式：先 `schema.safeParse(extractJsonObject(raw))`，失败就重试或抛错，**不要**在这层做复杂的字符串修复。

## 7. AI 避坑汇总

> 🤖 **AI 常见错误**：
>
> 1. **继续手写 Loose JSON Parser / 错误注入**：`loose-json-parser`、`error-injection` 已被 `generateObject` / `streamObject` / instructor-js 取代。新增代码里出现手写 retry 循环 = 重造轮子。
> 2. **继续 import 旧的自定义 LLM 客户端类型（如 `../llm/types`）**：该文件已不存在，`llm` 一律用 `ai` 的 `LanguageModel`（`createModel` 返回值，见 01-foundation.md）。
> 3. **tool 参数用 `z.any()`**：`tool({ parameters: z.any() })` 会让参数校验失效。tool 参数与结构化输出共用 Zod schema，保持类型安全。
> 4. **JSON Mode 下忘记 `.strict()`**：`z.object({...})` 默认静默剥离未知字段，安全场景用 `.strict()` 拒绝注入字段。
> 5. **流式中间态手动 JSON.parse**：partial object 不完整，交给 `useObject`。
> 6. **每次请求都 `createModel(...)`**：模型实例模块级缓存，避免连接重建与 socket 泄漏（见 01）。

## 8. 本层验收清单

- [ ] **类型检查**：运行 `npx tsc --noEmit -p packages/core`，`structured-output.ts`、`instructor.ts`、`json-fallback.ts` 通过。
- [ ] **核心行为**：运行 `npx vitest run packages/core/src/llm/__tests__/structured-output.test.ts`，断言 `generateObject` 返回的数据通过 `extractionSchema.safeParse`，重试次数 ≤ `maxRetries`。
- [ ] **流式**：`POST /api/structured/stream` 返回 `toUIMessageStreamResponse`，前端 `useObject` 逐字段渲染，无中间态 JSON.parse 崩溃。
- [ ] **契约回归**：运行 `node tools/check-skill.mjs` 本文件 0 失败；本文件未出现旧自定义 LLM 客户端类型与手写解析器符号。
- [ ] **门禁回归**：本文件含 ≥3 条 🤖 避坑标记与 `## 本层验收清单`。

