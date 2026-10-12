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

### 1.1 手写解析器的历史包袱

2023-2024 年，团队曾经长期维护三类"解析期魔法"：

- **`loose-json-parser.ts`**：处理 Markdown 围栏、尾逗号、单引号、截断 JSON；
- **`error-injection.ts`**：把校验错误拼回 prompt，让模型"再试一次"；
- **`schema-manual.json`**：手写 JSON Schema，且与 `tool()` 参数、Zod 校验各一份。

2026 年的结论是：这些代码**全部是负资产**。每一条修复规则都在放大模型行为漂移时的维护面，而且永远慢半拍覆盖新失败模式。SDK 已经把"约束输出 + 校验 + 错误回喂重试"做成了内置能力。

### 1.2 2026 成熟能力映射

| 旧模块 | 职责 | 2026 替代 | 说明 |
|--------|------|----------|------|
| `loose-json-parser.ts` | 容错解析 | `generateObject` / `streamObject` | 采样端约束格式，返回即合法对象 |
| `error-injection.ts` | 校验失败回喂重试 | SDK `maxRetries` / instructor-js | 错误回喂由 SDK / 库内置 |
| `schema-manual.json` | 手写 JSON Schema | Zod schema（一份多处复用） | 见 2.1 的组合复用 |
| `provider-format.ts` | 各厂格式转换 | SDK `mode: 'auto'` | 厂商差异由 SDK 归一化 |

### 1.3 淘汰决策与迁移路径

- **新增代码禁止**出现 `loose-json-parser` 与 `error-injection` 符号（门禁 grep 见 6.3）；
- **存量调用点**迁移到 `generateObject` / `streamObject`，行为差异在测试阶段用 08-eval-observability.md 的回归对比确认；
- 仅保留"纯文本调用 + 手动解析"的极端兜底场景，且只做 markdown 围栏剥离（见 §6）。

---

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

### 2.1 Schema 组合与复用

同一个 schema 同时服务 `generateObject`、`streamObject`、`tool()` 的 `parameters` 与服务端返回类型。设计时从"领域模型"出发，而不是从"这次请求的解析"出发：

```typescript
// packages/core/src/llm/structured-output.ts —— Schema 组合复用
import { z } from 'zod';

export const entitySchema = z.object({
  name: z.string().describe('实体名称'),
  type: z.enum(['person', 'org', 'product', 'location']).describe('实体类型'),
});

export const extractionSchemaV2 = z.object({
  action: z.enum(['reply', 'search', 'tool']).describe('下一步动作'),
  entities: z.array(entitySchema).describe('文本中出现的实体列表'),
  confidence: z.number().min(0).max(1).describe('整体置信度'),
  metadata: z
    .object({
      source: z.string().describe('来源文档 ID'),
      language: z.string().default('zh').describe('文本语言'),
    })
    .strict()
    .describe('元数据，未知字段将被拒绝'),
});

export type ExtractionV2 = z.infer<typeof extractionSchemaV2>;
```

### 2.2 .strict() 与未知字段

- `z.object({...})` 默认**剥离**未知字段，不会校验失败；
- 安全敏感场景用 `.strict()`：未知字段直接触发校验失败并进入 SDK 重试；
- **权衡**：`.strict()` 会放大模型幻觉字段导致的失败率。生产建议"外层剥离、内层 strict"——业务关键对象用 `.strict()`，辅助元数据用默认剥离。

### 2.3 discriminatedUnion 分支

输出是"多选一"时用 `z.discriminatedUnion`，让模型只能命中一个分支：

```typescript
// packages/core/src/llm/structured-output.ts —— 判别联合
import { z } from 'zod';

export const replyAction = z.object({
  kind: z.literal('reply'),
  text: z.string().describe('回复内容'),
});

export const searchAction = z.object({
  kind: z.literal('search'),
  query: z.string().describe('搜索词'),
  limit: z.number().int().min(1).max(50).default(10),
});

export const actionSchema = z.discriminatedUnion('kind', [replyAction, searchAction]);
```

### 2.4 Zod describe 如何进入 provider schema

- OpenAI `json_schema`：`describe()` 内容进入属性描述；
- Anthropic tool 模式：字段描述作为 `input_schema` 的属性注释；
- Gemini `response_schema`：description 进入属性说明。

因此 `describe()` 是"让模型看到字段语义"的**正规通道**——不要在 prompt 里复述 schema 形状。

### 2.5 Schema 设计通用规则

- 字段少而稳定：宁可用 5 个必填字段，不用 20 个可选字段；
- 枚举优先于自由字符串：`z.enum` 比 `z.string()` 稳定得多；
- 数值范围用 `min`/`max`，整数用 `int()`；
- 需要模型"看到"语义时写 `describe`，不需要就不写，省 token。

🤖 **AI 常见错误**：把 schema 形状写进 prompt（"只返回 JSON，字段有 action、entities..."）。provider 的 JSON Mode / tool 模式已经把 schema 传给模型，prompt 里的复述只会干扰生成。

---

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

### 3.1 mode 选择

`generateObject` 的 `mode` 控制底层实现：

| mode | 行为 | 适用 |
|------|------|------|
| `auto` | SDK 按 provider 能力自动选择 | 默认 |
| `json` | 强制 JSON Mode（`response_format`） | OpenAI / Gemini |
| `tool` | 用 tool 模式约束输出 | Anthropic 等 |

```typescript
// apps/web/src/app/api/structured/route.ts —— 显式 mode
import { generateObject } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { extractionSchemaV2 } from '@agentcore/core/structured-output';

export async function POST(req: Request) {
  const { text }: { text: string } = await req.json();

  const { object } = await generateObject({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    schema: extractionSchemaV2,
    schemaName: 'Extraction',
    schemaDescription: '从文本中提取动作、实体与置信度',
    mode: 'json',
    prompt: `从以下文本提取结构化信息：\n${text}`,
  });

  return Response.json({ object });
}
```

### 3.2 maxRetries 与 NoObjectGeneratedError

- SDK 默认 `maxRetries: 2`（provider 调用级重试，含校验失败回喂）；
- 最终失败抛 `NoObjectGeneratedError`，业务必须显式处理：

```typescript
// apps/web/src/app/api/structured/route.ts —— 错误处理
import { generateObject, NoObjectGeneratedError } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { extractionSchemaV2 } from '@agentcore/core/structured-output';

export async function POST(req: Request) {
  const { text }: { text: string } = await req.json();

  try {
    const { object } = await generateObject({
      model: createModel('openai', process.env as Record<string, string | undefined>),
      schema: extractionSchemaV2,
      prompt: `从以下文本提取结构化信息：\n${text}`,
    });
    return Response.json({ object });
  } catch (error) {
    if (error instanceof NoObjectGeneratedError) {
      return Response.json({ error: '模型未返回合法对象' }, { status: 422 });
    }
    throw error;
  }
}
```

### 3.3 seed 与 temperature

- `seed` 固定采样，便于回归复现与测试；
- `temperature` 建议 0-0.2，利于稳定输出；
- 注意：不要依赖 `seed` 保证完全一致——模型版本变化仍会改变输出。

### 3.4 generateObject 的底层机制

- OpenAI：`response_format: { type: 'json_schema', json_schema: {...} }`；
- Anthropic：tool 模式强制（只暴露一个 output tool）；
- Gemini：`response_schema` + `response_mime_type: 'application/json'`。

SDK 的 `mode: 'auto'` 负责选择，业务代码不需要写任何厂商分支。

🤖 **AI 常见错误**：`generateObject` 失败后直接返回 500。结构化输出是模型行为，失败是常态——显式处理 `NoObjectGeneratedError`，返回 422 让前端提示重试。

---

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

### 4.1 useObject 完整用法

`useObject` 消费 `streamObject` 的响应流，管理 loading、error、stop：

```tsx
// apps/web/src/components/ExtractionView.tsx —— 状态与错误
'use client';

import { useObject } from 'ai/react';

export function ExtractionView() {
  const { object, submit, isLoading, error, stop } = useObject({
    api: '/api/structured/stream',
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button onClick={() => submit({ text: '张三今年 25 岁' })}>提取</button>
        {isLoading && <button onClick={stop}>停止</button>}
      </div>
      {error && <p className="text-destructive text-sm">{String(error)}</p>}
      <pre>{JSON.stringify(object, null, 2)}</pre>
    </div>
  );
}
```

### 4.2 partialObjectStream 与 objectStream

- `partialObjectStream`：逐字段增量，适合实时渲染；
- `objectStream`：完整对象流；
- 两者都由 `useObject` 消费，**不要**在中间态 `JSON.parse`。

### 4.3 流式后端完整示例

```typescript
// apps/web/src/app/api/structured/stream/route.ts —— 完整版
import { streamObject } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { extractionSchemaV2 } from '@agentcore/core/structured-output';

export async function POST(req: Request) {
  const { text }: { text: string } = await req.json();

  const result = streamObject({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    schema: extractionSchemaV2,
    prompt: `从以下文本提取结构化信息：\n${text}`,
    onFinish: async ({ object }) => {
      // [CUSTOM] 最终对象已通过 Zod 校验，可在此落库
      await saveExtraction(object);
    },
  });

  return result.toUIMessageStreamResponse();
}
```

### 4.4 experimental_ObjectStream 命名演变

- v3 早期：`experimental_ObjectStream`，仅服务端；
- v4：统一为 `streamObject` + `toUIMessageStreamResponse`，前端用 `useObject`；
- 遇到旧文档中的 `experimental_ObjectStream`，按 v4 名称迁移，不要混用。

🤖 **AI 常见错误**：流式场景在中间态用 `JSON.parse` 解析每个 chunk——`streamObject` 的 partial object 不是完整 JSON，必须交给 `useObject` / `partialObjectStream` 处理。

---

### 3.5 结构化输出与观测：Langfuse 记录 schema

`generateObject` 通过 `@ai-sdk/observability` 接入 Langfuse（见 08-eval-observability.md），每次生成在 trace 中记录 schema 名与重试次数：

```typescript
// apps/web/src/app/api/structured/route.ts —— 观测
import { generateObject } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { extractionSchemaV2 } from '@agentcore/core/structured-output';

export async function POST(req: Request) {
  const { text }: { text: string } = await req.json();

  const { object } = await generateObject({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    schema: extractionSchemaV2,
    schemaName: 'ExtractionV2',
    prompt: `从以下文本提取结构化信息：\n${text}`,
    experimental_telemetry: { isEnabled: true, functionId: 'generateObject/extraction-v2' },
  });

  return Response.json({ object });
}
```

成本与失败率进入 Langfuse 面板，灰度期用 10-prompt-protocol.md 的 label 对比不同模型版本的结构化失败率。

### 4.5 useObject 进阶：setInput 与键盘提交

```tsx
// apps/web/src/components/ExtractionView.tsx —— setInput 与 Enter 提交
'use client';

import { useState } from 'react';
import { useObject } from 'ai/react';

export function ExtractionView() {
  const { object, submit, setInput, isLoading, error } = useObject({
    api: '/api/structured/stream',
  });
  const [text, setText] = useState('张三今年 25 岁');

  return (
    <div className="flex flex-col gap-2">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setInput({ text: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            submit({ text });
          }
        }}
      />
      <button disabled={isLoading} onClick={() => submit({ text })}>
        提取
      </button>
      {error && <p className="text-destructive text-sm">{String(error)}</p>}
      <pre>{JSON.stringify(object, null, 2)}</pre>
    </div>
  );
}
```

### 4.6 partialObjectStream 实时渲染

`streamObject` 返回 `partialObjectStream`：字段逐个出现。渲染时对未出现的字段给占位，避免闪烁：

```tsx
// apps/web/src/components/ExtractionView.tsx —— 占位渲染
<pre>
  {JSON.stringify(
    {
      action: object?.action ?? '待生成',
      entities: object?.entities ?? [],
      confidence: object?.confidence ?? '待生成',
    },
    null,
    2
  )}
</pre>
```

不要把 partial object 当作最终结果入库——只有 `onFinish` 里的 `object` 是完整且通过校验的。

---

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

### 5.1 instructor-js 错误注入重试流程

```
1. 模型输出 → response_model 校验（Zod）
2. 校验失败 → instructor 把错误信息注入 messages
3. 带错误重试 → maxRetries 上限
4. 仍失败 → 抛 ValidationError，由调用方决定兜底
```

`maxRetries` 的语义是"重试次数"还是"总尝试次数"，以当前版本文档为准；生产建议把该值暴露为配置项，便于评测阶段调参（见 08-eval-observability.md）。

### 5.2 JSON Mode 对比表（2026）

| Provider | 机制 | 关键参数 | Schema 约束 | 流式 | 注意事项 |
|----------|------|---------|------------|------|---------|
| OpenAI | JSON Schema | `response_format: { type: 'json_schema' }` | 支持字段描述、`$schema` | 支持 | 部分模型要求提示词提及 JSON |
| Anthropic | tool 模式强制 | 单个 output tool + `tool_choice` | 字段描述进 `input_schema` | 支持 | 不要与业务工具混用 |
| Gemini | `response_schema` | `response_mime_type: 'application/json'` + `response_schema` | 支持 OpenAPI 子集 | 支持 | 低版本模型对 strict 支持有限 |

### 5.3 AI SDK 如何统一差异

- `mode: 'auto'` 按 provider 能力选择机制；
- 同一 Zod schema 自动转换为各厂格式；
- 业务代码不感知厂商差异，也不写 provider 分支。

### 5.4 何时仍需 instructor-js

- 直连 OpenAI SDK 的存量代码（尚未迁移到 AI SDK）；
- 需要把校验错误注入对话历史的重试语义；
- 否则优先 `generateObject` / `streamObject`。

🤖 **AI 常见错误**：在 `generateObject` 之上再套 instructor-js——两套重试机制叠加，行为不可预测。选一条主路径，别混用。

---

### 5.5 instructor-js 迁移路径

存量直连 OpenAI SDK 的调用，建议分四步收敛到 AI SDK：

1. 用 `extractWithInstructor` 包装存量调用，锁住行为；
2. 用 08-eval-observability.md 的回归对比确认输出质量无回退；
3. 逐个调用点迁移到 `generateObject` / `streamObject`；
4. 全部迁移后删除 `instructor.ts` 与依赖。

```bash
npm uninstall @instructor-ai/instructor
```

迁移完成后，错误注入重试由 AI SDK `maxRetries` 承担，行为归一到 3.2 的主路径。

### 5.6 失败分类与告警

结构化输出的失败需要区分两类：

| 异常 | 含义 | 告警级别 |
|------|------|---------|
| `NoObjectGeneratedError` | 未生成合法对象 | warning，前端提示重试 |
| `ValidationError` | 多次重试后仍校验失败 | error，记录 schema 与模型版本 |

两者都应记录到 Langfuse trace（08-eval-observability.md），灰度期按 label 分组观察失败率。

---

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

### 6.1 何时走到兜底解析

- 供应商结构化输出不可用（如某些本地模型）；
- 纯文本调用 LLM 后需要手动提取 JSON；
- 这是**极端兜底**，不是默认路径。

### 6.2 兜底解析 + safeParse 使用方式

```typescript
// packages/core/src/llm/json-fallback.ts —— 使用方式
import { z } from 'zod';
import { extractJsonObject } from './json-fallback';

const fallbackSchema = z.object({
  action: z.enum(['reply', 'search', 'tool']),
  entities: z.array(z.string()),
});

export function parseFallback(
  raw: string
): { ok: true; data: z.infer<typeof fallbackSchema> } | { ok: false; error: string } {
  try {
    const parsed = extractJsonObject(raw);
    const result = fallbackSchema.safeParse(parsed);
    if (!result.success) return { ok: false, error: result.error.message };
    return { ok: true, data: result.data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

`extractJsonObject` 只剥离 markdown 围栏，不做单引号、尾逗号修复——那些是 SDK 的职责。

### 6.3 淘汰旧模块的 grep 检查

```bash
grep -rn "loose-json-parser\|error-injection" references/ || echo "clean"
```

输出 `clean` 表示旧符号已清除；任何新增出现都会让门禁失败（见 7.2 与 8）。

---

### 6.4 兜底路径的重试策略

兜底解析本身**不重试**，由调用方决定是否重试：

- 解析失败后最多重试 1 次（成本控制）；
- 重试时把校验错误注入 messages，而不是简单重复原 prompt；
- 仍失败则返回 503，交给上层降级（如返回给用户提示，见 09-error-handling.md）。

```typescript
// packages/core/src/llm/json-fallback.ts —— 调用方重试
import { z } from 'zod';
import { extractJsonObject } from './json-fallback';

const retrySchema = z.object({ action: z.enum(['reply', 'search', 'tool']) });

export async function extractWithRetry(llmCall: (messages: string[]) => Promise<string>) {
  let raw = await llmCall([]);
  let result = retrySchema.safeParse(extractJsonObject(raw));
  if (result.success) return result.data;

  raw = await llmCall([`上一次输出未通过校验：${result.error.message}\n请重新输出。`]);
  result = retrySchema.safeParse(extractJsonObject(raw));
  if (!result.success) throw new Error('兜底解析重试后仍失败');
  return result.data;
}
```

### 6.5 兜底层单元测试

`json-fallback.ts` 必须覆盖：

- markdown 围栏剥离（` ```json` / ` ``` `）；
- 非法 JSON 抛错；
- `safeParse` 失败返回 `{ ok: false, error }`。

```typescript
// packages/core/src/llm/__tests__/json-fallback.test.ts
import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '../json-fallback';

describe('extractJsonObject', () => {
  it('剥离 markdown 围栏', () => {
    const raw = '```json\n{"action": "reply"}\n```';
    expect(extractJsonObject(raw)).toEqual({ action: 'reply' });
  });

  it('非法 JSON 抛错', () => {
    expect(() => extractJsonObject('{oops')).toThrow();
  });
});
```

### 6.6 与 02-tools-skills 的边界

- **tool 调用返回的结构化数据**由 02-tools-skills.md 负责，tool 参数校验见 11-function-calling.md；
- 本文 §6 只覆盖"纯文本调用 LLM 后手动提取 JSON"的极端兜底；
- 新代码默认走 `generateObject` / `streamObject`，不要用 §6 作为默认路径。

| 场景 | 归属 |
|------|------|
| tool 返回结构化数据 | 02-tools-skills.md |
| 结构化输出（主路径） | 本文 §3 / §4 |
| 纯文本 + 手动解析（兜底） | 本文 §6 |

---

## 7. AI 避坑汇总

> 🤖 **AI 常见错误**：
>
> 1. **继续手写 Loose JSON Parser / 错误注入**：`loose-json-parser`、`error-injection` 已被 `generateObject` / `streamObject` / instructor-js 取代。新增代码里出现手写 retry 循环 = 重造轮子。
> 2. **继续 import 旧的自定义 LLM 客户端类型（如 `../llm/types`）**：该文件已不存在，`llm` 一律用 `ai` 的 `LanguageModel`（`createModel` 返回值，见 01-foundation.md）。
> 3. **tool 参数用 `z.any()`**：`tool({ parameters: z.any() })` 会让参数校验失效。tool 参数与结构化输出共用 Zod schema，保持类型安全。
> 4. **JSON Mode 下忘记 `.strict()`**：`z.object({...})` 默认静默剥离未知字段，安全场景用 `.strict()` 拒绝注入字段。
> 5. **流式中间态手动 JSON.parse**：partial object 不完整，交给 `useObject`。
> 6. **每次请求都 `createModel(...)`**：模型实例模块级缓存，避免连接重建与 socket 泄漏（见 01）。

### 7.1 更多避坑

> 🤖 **AI 常见错误（续）**：

7. **在 `.strict()` 与模型幻觉之间不做权衡**：业务关键对象用 `.strict()`，辅助元数据用默认剥离——不要一刀切。
8. **把枚举写进 prompt 而不写进 schema**：枚举约束必须进 Zod，prompt 复述只是辅助。
9. **忽略 seed 导致回归不稳定**：评测与测试用固定 `seed`，生产可以不设。
10. **手写 SSE 消费 `streamObject`**：用 `useObject`，不要自己拼 `text/event-stream`。
11. **`generateObject` 的 schema 与 `tool()` 参数不一致**：同一领域对象必须复用同一 schema（见 2.1），避免服务端类型与工具参数漂移。

### 7.2 与相邻 reference 的关系

| 场景 | 用哪个 reference |
|------|-----------------|
| 工具参数校验 | 11-function-calling.md 的 `tool()` + 本文 2.1 的 schema 复用 |
| 多智能体结构化决策 | 05-multi-agent.md 的 `generateObject` + Zod |
| 流式渲染进阶 | 17-streaming-advanced.md 的 `useObject` |
| 评测与回归 | 08-eval-observability.md 的固定 seed 对比 |

---

### 7.3 2026 年能力演进观察点

- 各 provider 的 JSON Schema 支持持续升级（严格模式、字段描述、嵌套约束）；
- AI SDK `mode: 'auto'` 的选择逻辑随 provider 能力更新而成熟；
- 本节内容以 docs/TECH_LANDSCAPE.md 为准，新能力落地后再更新表格，不要凭印象写厂商差异。

### 7.4 决策记录

| 决策 | 理由 |
|------|------|
| 统一 Zod schema | 一份 schema 服务结构化输出、tool 参数与类型 |
| 不保留 Loose Parser | 解析容错是 SDK 职责 |
| 主路径 AI SDK | 归一化 OpenAI / Anthropic / Gemini 差异 |
| instructor-js 可选 | 仅存量直连 OpenAI 场景需要 |

---

## 8. 本层验收清单

- [ ] **类型检查**：运行 `npx tsc --noEmit -p packages/core`，`structured-output.ts`、`instructor.ts`、`json-fallback.ts` 通过。
- [ ] **核心行为**：运行 `npx vitest run packages/core/src/llm/__tests__/structured-output.test.ts`，断言 `generateObject` 返回的数据通过 `extractionSchema.safeParse`，重试次数 ≤ `maxRetries`。
- [ ] **流式**：`POST /api/structured/stream` 返回 `toUIMessageStreamResponse`，前端 `useObject` 逐字段渲染，无中间态 JSON.parse 崩溃。
- [ ] **契约回归**：运行 `node tools/check-skill.mjs` 本文件 0 失败；本文件未出现旧自定义 LLM 客户端类型与手写解析器符号。
- [ ] **门禁回归**：本文件含 ≥3 条 🤖 避坑标记与 `## 本层验收清单`。

