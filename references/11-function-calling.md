# 11 — Function Calling · 工具循环由 SDK 处理 · 审计薄层 [CUSTOM]

> Layer 2 进阶模块：不同模型对 function calling 的实现差异很大（OpenAI function call、Anthropic tool_use、Gemini FunctionDeclaration）。**不要手写 Provider 适配器**——Vercel AI SDK 的 `tool()` + `streamText` 已把工具定义、格式转换、重试、并行调用全部归一化。本节点只保留一个 `[CUSTOM]` 审计薄层。

> **⚠️ 本层铁律：工具调用的格式转换、错误重试、并行派发是 SDK 能力，不手写 Adapter/Orchestrator。**
> - 多 Provider 适配 → `createModel`（01）+ SDK 的 `tools` 参数，不写 OpenAIAdapter/AnthropicAdapter
> - 重试 / 错误恢复 → SDK 把 tool 异常回喂模型，`maxSteps` 限制循环，不写 RetryEngine
> - 并行派发 → SDK 一轮多工具调用自动并行；并发控制写在工具 `execute` 内部 `[CUSTOM]`
> - 审计日志 → 保留 `[CUSTOM]` 薄层，只记录不重试

---

## 目录

- [11.1 架构总览](#111-架构总览)
- [11.2 多 Provider——统一模型入口](#112-多-provider统一模型入口)
- [11.3 工具调用与重试——全部交给 SDK](#113-工具调用与重试全部交给-sdk)
- [11.4 并行派发与部分失败](#114-并行派发与部分失败)
- [11.5 审计日志 [CUSTOM]](#115-审计日志-custom)
- [11.6 AI 避坑](#116-ai-避坑)
- [11.7 前端：Tool Call Tracer](#117-前端tool-call-tracer)
- [11.8 本层验收清单](#118-本层验收清单)

---

## 11.1 架构总览

工具调用链路不再有 "Orchestrator/Adapter" 层：

```
model = createModel('openai' | 'anthropic', env)   // 01 的 LanguageModel
model = createLiteLLMModel(env)                    // 可选：LiteLLM 统一代理
                     │
        streamText({ model, tools, maxSteps })
                     │
      ┌──────────────┼──────────────┐
      ▼              ▼              ▼
 工具定义          工具执行        错误回喂
 (zod→各厂格式)    execute()     (SDK 自动把异常作为 tool_error)
 由 SDK 转换        业务代码       由 SDK 完成
```

🔗 **工程逻辑**：为什么不再写 Provider 适配层？因为 Vercel AI SDK 已经做了**请求归一化**（zod schema → OpenAI/Anthropic/Gemini 格式）和**响应归一化**（tool_call 帧 → 统一工具调用事件）。手写 Adapter 只是复制 SDK 的内部逻辑，还引入新的格式漂移点。业务代码只需要关心 `execute` 里的真实逻辑。

---

## 11.2 多 Provider——统一模型入口

`llm` 一律是 `LanguageModel`（来自 `ai`），创建入口只用 01 的 `createModel`：

```typescript
// packages/core/src/llm.ts —— 见 01-foundation.md，全项目唯一模型创建入口
import type { LanguageModel } from 'ai';
export type Provider = 'openai' | 'anthropic';
export function createModel(provider: Provider, env: Record<string, string | undefined>): LanguageModel;
```

需要接入自有代理/国产模型时，用 OpenAI 兼容协议指向 **LiteLLM** 统一代理，不需要新的客户端：

```typescript
// packages/core/src/llm-litellm.ts —— 追加 LiteLLM 代理入口（可选）
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export function createLiteLLMModel(env: Record<string, string | undefined>): LanguageModel {
  // LiteLLM 把 OpenAI/Anthropic/Gemini/本地模型统一成 OpenAI 兼容端点
  return createOpenAICompatible({
    name: 'litellm',
    baseURL: env.LITELLM_BASE_URL ?? 'http://localhost:4000',
    apiKey: env.LITELLM_API_KEY,
  })(env.LITELLM_MODEL ?? 'gpt-4o');
}
```

> 🤖 **AI 避坑**：不要为了"统一 Provider"再包一层自己的 Provider 抽象（如 `ProviderAdapter` 接口 + 各厂实现）。工具定义、参数映射、响应解析都由 SDK 完成，`references/` 中不应再出现旧 Provider 类型名（见 00-types.md）。

---

## 11.3 工具调用与重试——全部交给 SDK

工具循环 = `streamText` + `tools` + `maxSteps`，ReAct 循环、异常重试、循环上限都是 SDK 能力：

```typescript
// apps/web/src/app/api/chat/route.ts —— 工具循环核心
import { streamText, tool, type UIMessage } from 'ai';
import { z } from 'zod';
import { createModel } from '@agentcore/core/llm';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    system: '你是通用助手。工具失败时根据错误信息修正后重试。',
    messages,
    tools: {
      getWeather: tool({
        description: '查询指定城市天气',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => {
          const res = await fetch(`https://api.example.com/weather?city=${encodeURIComponent(city)}`);
          if (!res.ok) throw new Error(`天气服务返回 ${res.status}`);
          return res.json();
        },
      }),
      searchRepo: tool({
        description: '搜索仓库代码',
        parameters: z.object({ query: z.string(), limit: z.number().default(10) }),
        execute: async ({ query, limit }) => runSearch(query, limit),
      }),
    },
    maxSteps: 10,   // 工具循环硬上限：模型可以反复"调用→失败→修正→再调用"
  });

  return result.toDataStreamResponse();
}
```

**错误恢复机制**（SDK 内部完成，业务代码不需要重试引擎）：

- `execute` 抛出的异常被 SDK 捕获，作为 `tool_error` 事件回喂模型；
- 模型在下一轮看到错误消息，自行修正参数或换工具；
- `maxSteps` 保证循环必然终止，不会无限烧 token。

**参数校验失败**：`tool()` 的 `parameters` 用 zod 定义，模型输出不符合 schema 时，SDK/Provider 会拒绝或触发校验错误并回喂模型修正——不要手写 `JSON.parse + try/catch + 错误注入`。

🤖 **AI 常见错误**：不设 `maxSteps`——模型反复调用同一个失败工具时，没有上限会无限循环烧 token。**正确做法**：`maxSteps` 设 10-30，并在 `execute` 的异常消息里说明失败原因，帮助模型下一轮修正。

---

## 11.4 并行派发与部分失败

模型在一轮中发出多个工具调用时，SDK **并行执行**这些 `execute`。业务代码不需要调度器。需要并发限制或部分失败策略时，在工具 `execute` 内部用一个 `[CUSTOM]` 助手：

```typescript
// packages/core/src/tool/run-batch.ts —— [CUSTOM] 工具内部并发控制
export interface BatchItemResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export async function runBatch<T>(
  items: T[],
  worker: (item: T) => Promise<unknown>,
  maxConcurrency = 5
): Promise<BatchItemResult[]> {
  const results: BatchItemResult[] = new Array(items.length);
  let next = 0;

  const workerFn = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i]) };
      } catch (e) {
        results[i] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, items.length) }, () => workerFn())
  );
  return results;
}
```

> 🤖 **并行工具调用的前提是无数据依赖**。若工具 B 的输入依赖工具 A 的输出，不要期望模型自动串行化——在 `execute` 里检测依赖并降级为串行，或让模型分多轮调用。

---

## 11.5 审计日志 [CUSTOM]

工具调用的审计是产品排查/合规需求，SDK 不覆盖，保留 **薄层**——只记录，不重试、不转换格式：

```typescript
// packages/core/src/agent/audit-logger.ts —— [CUSTOM] 审计薄层
export interface AuditEntry {
  sessionId: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  status: 'success' | 'error';
  durationMs: number;
  error?: string;
  promptVersion?: number;    // 关联 10：Langfuse prompt 版本
  timestamp: number;
}

export class ToolCallAuditLogger {
  private entries: AuditEntry[] = [];

  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    this.entries.push({ ...entry, timestamp: Date.now() });
    // [MOCK] 生产：写入 Postgres (audit_logs) 或发往 Langfuse span
  }

  bySession(sessionId: string): AuditEntry[] {
    return this.entries.filter(e => e.sessionId === sessionId);
  }
}
```

> 🤖 **AI 避坑**：审计是业务数据，不进 LLM 请求；不要为了"让模型看到历史错误"而把审计日志拼回 prompt——既污染上下文又扩大注入面。

---

## 11.6 AI 避坑

> 🤖 **AI 常见错误**：
>
> 1. **手写 Provider Adapter**：为 OpenAI/Anthropic/Gemini 各写一个 `buildToolDefinitions`/`parseToolCalls`。这些是 SDK 内部逻辑，手写后一旦上游格式变化（如新版 tool_use 字段调整），所有适配器都要跟着改。**正确做法**：只用 `tool()` + `streamText`，让 SDK 归一化。
>
> 2. **不设 `maxSteps`**：模型反复调用同一个失败工具时，没有上限会无限循环烧 token。**正确做法**：`maxSteps` 设 10-30，并在 `execute` 的异常消息里说明失败原因，帮助模型下一轮修正。
>
> 3. **手写 JSON 修复器**：模型输出截断的 `arguments` 时，自己写 `attemptJsonRepair` 补括号补引号。**正确做法**：把原始错误回喂模型让它重新生成参数（SDK 已支持），不要信任本地补全结果。
>
> 4. **用 `Promise.all` 而不是 `Promise.allSettled`**：并行执行一批工具时，一个失败会让整批 reject 且丢失其他成功结果。**正确做法**：`[CUSTOM]` 的 `runBatch` 用 `Promise.allSettled` 语义，逐项返回 `{ ok, value, error }`。
>
> 5. **把审计日志当消息历史**：把 `AuditEntry` 转成 user/assistant 消息喂回模型，污染上下文还引入注入面。**正确做法**：审计只进存储/面板，模型侧的错误恢复用 SDK 的 `tool_error` 事件。

---

## 11.7 前端：Tool Call Tracer

`useChat` 的消息 `parts` 已包含 `tool-invocation`（见 01 的 MessageBubble）。产品 UI 只需把工具调用渲染成时间线卡片，状态机（loading → 成功/失败）、取消、重连都由 `useChat` 和 SDK 管理，前端不手写轮询：

```tsx
// apps/web/src/components/chat/ToolCallTracer.tsx —— 复用 UIMessage.parts
'use client';

import type { UIMessage } from 'ai';

export function ToolCallTracer({ message }: { message: UIMessage }) {
  const invocations = (message.parts ?? [])
    .filter(p => p.type === 'tool-invocation')
    .map(p => p.toolInvocation);

  if (invocations.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-md bg-surface/50 border border-border text-xs">
      {invocations.map(inv => (
        <div key={inv.toolCallId} className="flex items-center gap-2">
          <span className="font-mono text-accent">{inv.toolName}</span>
          <span className="text-muted">
            {inv.state === 'result' ? `→ ${JSON.stringify(inv.result).slice(0, 80)}` : '执行中…'}
          </span>
        </div>
      ))}
    </div>
  );
}
```

---

## 11.8 本层验收清单

- [ ] `references/` 中无旧 Provider 类型引用；`llm` 类型全部是 `LanguageModel`（见 00-types.md）
- [ ] `streamText` + `tools` + `maxSteps` 完成"调用→失败→修正→成功"全流程：工具抛错后模型在下一轮收到错误并修正
- [ ] `maxSteps` 生效：工具持续失败时循环在 `maxSteps` 处终止，不无限烧 token
- [ ] 一轮多工具调用被 SDK 并行执行；`runBatch` 并发上限生效且部分失败不丢成功结果
- [ ] `ToolCallAuditLogger` 记录每次调用的 session/工具/耗时/状态
- [ ] 前端 `ToolCallTracer` 从 `UIMessage.parts` 渲染工具调用时间线
- [ ] 门禁：运行 `node tools/check-skill.mjs`，本文件 0 失败
