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

### 11.1.1 一次工具循环的时序

```
User 消息 → streamText
  → 模型返回 tool_call（OpenAI function_call / Anthropic tool_use / Gemini FunctionDeclaration 被 SDK 归一化）
  → SDK 用 zod 校验参数
  → 并行执行 execute（一轮多个工具调用）
  → 成功：结果作为 tool 消息回喂模型
  → 失败：异常作为 tool_error 回喂模型
  → 模型修正后再次调用（受 maxSteps 约束）
```

### 11.1.2 SDK 职责边界

| 职责 | SDK 完成 | 业务代码 |
|------|---------|---------|
| 工具定义格式转换 | `tool()` + zod → 各厂 schema | 只写 `parameters` |
| 响应解析 | tool_call 帧 → 统一事件 | 不解析 |
| 参数校验 | zod 校验 | 只写 schema |
| 异常回喂 | `tool_error` 事件 | 抛异常即可 |
| 并行派发 | 一轮多调用自动并行 | 无 |
| 循环上限 | `maxSteps` | 设值 |
| 审计 | 不覆盖 | `[CUSTOM]` 薄层 |

### 11.1.3 LiteLLM 网关位置

```
apps/web → LiteLLM Proxy（OpenAI 兼容端点）→ openai / anthropic / gemini / 本地模型
```

LiteLLM 把多模型路由、fallback、限流、成本统计收敛到网关层（见 11.2.1），业务代码只面对一个 OpenAI 兼容 baseURL。

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

### 11.2.1 LiteLLM 网关部署（config.yaml）

LiteLLM Proxy 用一份 config.yaml 管理多模型、fallback、成本路由与限流：

```yaml
# server/litellm/config.yaml —— LiteLLM 网关配置（密钥用 __AKF__ 占位）
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: __AKF__
      rpm: 600
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4
      api_key: __AKF__
      rpm: 300
  - model_name: local-qwen
    litellm_params:
      model: openai/qwen2.5:72b
      api_base: http://localhost:8000/v1
      api_key: __AKF__
      rpm: 100

router_settings:
  routing_strategy: usage-based-routing-v2
  num_retries: 2
  request_timeout: 30
  allowed_fails: 3
  cooldown_time: 30
  max_parallel_requests: 32
  rpm_limit: 1000
  tpm_limit: 100000

litellm_settings:
  drop_params: true
  set_verbose: false
  callbacks: ["langfuse"]
  langfuse_public_key: os.environ/LANGFUSE_PUBLIC_KEY
  langfuse_secret_key: os.environ/LANGFUSE_SECRET_KEY
  langfuse_host: os.environ/LANGFUSE_BASE_URL
```

注意：`api_key` 字段在 yaml 中是 snake_case，占位值 `__AKF__` 由部署时的环境变量注入替换，代码仓库不保存真实密钥。

### 11.2.2 模型 fallback 与成本路由

```yaml
# server/litellm/config.yaml —— 追加 fallback 组与成本映射
model_group:
  - group_name: chat-primary
    models: [gpt-4o, claude-sonnet, local-qwen]
    fallbacks: [claude-sonnet, local-qwen]

cost_map:
  - model_name: gpt-4o
    input_cost_per_token: 0.0000025
    output_cost_per_token: 0.00001
  - model_name: claude-sonnet
    input_cost_per_token: 0.000003
    output_cost_per_token: 0.000015
```

业务代码只调用 `chat-primary`，LiteLLM 按路由策略选模型，主模型失败自动降级到 fallback 列表的下一个。

### 11.2.3 启动网关

```bash
docker run -d --name litellm \
  -p 4000:4000 \
  -v ./server/litellm/config.yaml:/app/config.yaml \
  ghcr.io/berriai/litellm:main-stable \
  --config /app/config.yaml
```

健康检查：`curl http://localhost:4000/health/liveliness` 返回 200 后，业务层才把 `LITELLM_BASE_URL` 指过来。

### 11.2.4 OpenAI 兼容调用

`createLiteLLMModel` 见本节开头的 `llm-litellm.ts`。业务层使用方式与直接 `createModel` 完全一致：

```typescript
// apps/web/src/app/api/chat/route.ts —— LiteLLM 网关调用示例
import { streamText, type UIMessage } from 'ai';
import { createLiteLLMModel } from '@agentcore/core/llm-litellm';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: createLiteLLMModel(process.env as Record<string, string | undefined>),
    system: '你是通用助手。',
    messages,
    maxSteps: 10,
  });

  return result.toDataStreamResponse();
}
```

### 11.2.5 网关侧观测与审计

LiteLLM 已把每次转发的模型名、耗时、token 成本写入 Langfuse（`callbacks: ["langfuse"]`）。业务侧 `[CUSTOM]` 审计（见 11.5）只记录**产品级语义**——用户做了什么、用了哪个工具、结果如何，两者不重复。

🤖 **AI 常见错误**：在业务代码里再封装一层"网关客户端"——LiteLLM 已是统一入口，业务层再包一层只是给调用链增加故障点。

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

### 11.3.1 maxSteps 与终止条件

- `maxSteps` 默认无限制，生产必须显式设置（10-30）；
- 模型持续失败时，循环在 `maxSteps` 处终止并返回 `finishReason: 'error'`；
- `stopWhen` 可以提前终止：当步骤的 `finishReason` 满足条件时停止后续循环。

```typescript
// apps/web/src/app/api/chat/route.ts —— 带终止条件与步骤回调
import { streamText, tool, type UIMessage } from 'ai';
import { z } from 'zod';
import { createModel } from '@agentcore/core/llm';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    messages,
    tools: {
      lookupOrder: tool({
        description: '查询订单状态',
        parameters: z.object({ orderId: z.string() }),
        execute: async ({ orderId }) => {
          const res = await fetch(`https://api.example.com/orders/${encodeURIComponent(orderId)}`);
          if (!res.ok) throw new Error(`订单服务返回 ${res.status}`);
          return res.json();
        },
      }),
    },
    maxSteps: 8,
    stopWhen: step => step.finishReason === 'stop',
    onStepFinish: async step => {
      // [CUSTOM] 步骤级审计埋点，只记录不重试（见 11.5）
      await auditStep(step);
    },
  });

  return result.toDataStreamResponse();
}
```

`onStepFinish` 在每轮工具循环结束后触发，是审计、埋点的正确挂载点——不要用它做重试。

### 11.3.2 错误恢复的完整路径

1. `execute` 抛异常；
2. SDK 捕获异常，作为 `tool_error` 事件回喂模型；
3. 模型在下一轮看到错误消息，自行修正参数或换工具；
4. `maxSteps` 保证循环必然终止。

业务代码**不需要**在 `execute` 里做 while 重试——模型侧的修正比本地重放更可靠。

### 11.3.3 execute 超时与 abort

```typescript
// packages/core/src/tool/http-tool.ts —— [CUSTOM] 带超时的 HTTP 工具
import { tool } from 'ai';
import { z } from 'zod';

const fetchWithTimeout = (url: string, ms = 10_000): Promise<Response> =>
  fetch(url, { signal: AbortSignal.timeout(ms) });

export const searchWeb = tool({
  description: '搜索网页',
  parameters: z.object({ q: z.string() }),
  execute: async ({ q }) => {
    const res = await fetchWithTimeout(`https://api.example.com/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`搜索服务返回 ${res.status}`);
    return res.json();
  },
});
```

超时抛错同样被 SDK 作为 `tool_error` 回喂；不要写死循环等待。

### 11.3.4 强制工具调用 toolChoice

```typescript
// apps/web/src/app/api/chat/route.ts —— 强制走工具（如路由分类）
import { streamText } from 'ai';
import { createModel } from '@agentcore/core/llm';

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamText({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    messages,
    tools: { /* 工具定义 */ },
    toolChoice: 'required',
    maxSteps: 5,
  });
  return result.toDataStreamResponse();
}
```

`toolChoice` 取值：`'auto'`（默认）、`'none'`（禁用）、`'required'`（至少一次）。`'required'` 适合路由分类场景：模型必须先调用分类工具，再根据结果回答。

🤖 **AI 常见错误**：`toolChoice: 'required'` 但工具会失败——强制调用 + 持续失败会快速耗尽 `maxSteps`。只有确认工具可用性时才用 `required`。

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

### 11.4.1 SDK 并行语义

模型在一轮中发出多个工具调用时，SDK 用 `Promise.all` 语义**并行执行**这些 `execute`。业务代码不需要调度器。需要并发限制时，在工具 `execute` 内部使用 `[CUSTOM]` 助手。

### 11.4.2 工具内部分批并发与超时

```typescript
// packages/core/src/tool/run-batch.ts —— 扩展：逐项超时与部分失败
export interface BatchItem {
  id: string;
  run: () => Promise<unknown>;
}

export async function runBatchWithTimeout(
  items: BatchItem[],
  timeoutMs = 5_000,
  maxConcurrency = 5
): Promise<Map<string, { ok: boolean; value?: unknown; error?: string }>> {
  const results = new Map<string, { ok: boolean; value?: unknown; error?: string }>();
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        const value = await Promise.race([
          item.run(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`工具超时 ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);
        results.set(item.id, { ok: true, value });
      } catch (e) {
        results.set(item.id, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => worker()));
  return results;
}
```

注意 `Promise.allSettled` 语义：单项失败只在该项记录 `ok: false`，不丢弃成功结果。

### 11.4.3 部分失败策略

- 把 `{ ok: false, error }` 作为工具返回值交回模型；
- 模型看到部分成功、部分失败，决定是否重试失败项；
- 不要把整批结果丢弃或抛异常——那会让成功的项也丢失。

### 11.4.4 依赖工具的串行化

并行调用的前提是**无数据依赖**。若工具 B 的输入依赖工具 A 的输出：

1. 在 B 的 `execute` 内检测 A 是否已执行，未执行则返回"请先调用工具 A"；
2. 或让模型分多轮调用（SDK 的 step 循环天然支持）；
3. 不要写全局调度器——那是 SDK 的职责。

🤖 **AI 常见错误**：让模型"记住"并行工具的输出顺序。模型的记忆不可靠，依赖关系必须显式表达在工具返回值里。

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

### 11.5.1 审计薄层职责

- **只记录，不重试**：重试是 SDK 的职责；
- **产品语义**：session、工具名、参数、耗时、状态；
- **落库**：Postgres 审计表 + Langfuse span；
- **不进入 LLM 上下文**：审计是业务数据，喂回模型会污染上下文并扩大注入面。

### 11.5.2 落库实现

```typescript
// packages/core/src/agent/audit-store.ts —— [CUSTOM] 审计落库（Postgres）
export interface AuditRow {
  session_id: string;
  tool_name: string;
  tool_call_id: string;
  args_json: string;
  status: 'success' | 'error';
  duration_ms: number;
  error_text?: string;
  prompt_version?: number;
  created_at: string;
}

export class PostgresAuditStore {
  constructor(private readonly db: { execute: (sql: string, params: unknown[]) => Promise<void> }) {}

  async insert(row: AuditRow): Promise<void> {
    await this.db.execute(
      `INSERT INTO audit_logs
        (session_id, tool_name, tool_call_id, args_json, status, duration_ms, error_text, prompt_version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.session_id,
        row.tool_name,
        row.tool_call_id,
        row.args_json,
        row.status,
        row.duration_ms,
        row.error_text ?? null,
        row.prompt_version ?? null,
        row.created_at,
      ]
    );
  }
}
```

### 11.5.3 自动包装工具

给工具注册加一层审计包装，避免每个 `execute` 手工写计时：

```typescript
// packages/core/src/agent/with-audit.ts —— [CUSTOM] 工具自动审计包装
import type { Tool } from 'ai';

export function withAudit<T extends Tool>(
  toolDef: T,
  audit: { log: (entry: { status: 'success' | 'error'; durationMs: number; error?: string }) => Promise<void> }
): T {
  const original = toolDef.execute;
  if (!original) return toolDef;

  return {
    ...toolDef,
    execute: async (args, options) => {
      const startedAt = Date.now();
      try {
        const result = await original(args, options);
        await audit.log({ status: 'success', durationMs: Date.now() - startedAt });
        return result;
      } catch (e) {
        await audit.log({
          status: 'error',
          durationMs: Date.now() - startedAt,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    },
  };
}
```

`args` 与 `options` 的类型由 `tool()` 推导，`withAudit` 不改动签名——只包执行与计时。

### 11.5.4 审计数据消费

- 管理后台按 session 聚合工具调用链；
- 合规导出为 CSV/JSON；
- Langfuse 看板按 `toolName` 聚合错误率与耗时；
- 审计表不参与任何 prompt 拼装（见 11.6 避坑 #5）。

🤖 **AI 常见错误**：审计写入失败时直接 `throw`，让工具调用跟着失败——审计是旁路，写库失败应记录到独立错误通道，不影响主流程。

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

### 11.6.1 工程逻辑

| 设计决策 | 理由 |
|---------|------|
| 用 LiteLLM 统一网关 | 多模型切换、fallback、限流、成本统计是网关能力 |
| 并发限制放 execute 内 | SDK 只保证并行，不保证业务侧限流 |
| 超时用 AbortSignal | 避免 execute 挂起导致工具循环卡死 |
| 审计薄层只记录 | 审计是产品语义，SDK 不覆盖 |
| 不手写重试引擎 | 模型侧修正比本地补 JSON 更可靠 |

### 11.6.2 更多 AI 避坑

> 🤖 **AI 常见错误（续）**：

6. **在 execute 内写 while 重试循环**：把失败重试写死在工具里，模型永远看不到错误。重试决策应该由模型基于 `tool_error` 做出，execute 只负责"一次"执行。
7. **LiteLLM 网关无鉴权暴露公网**：任何人可用你的模型额度。LiteLLM 配置 `master_key` 并开启虚拟密钥，业务层通过请求头传递。
8. **用随机数做幂等键**：工具重复执行时幂等键必须可复现（如 `toolCallId`），否则重试会重复扣款。`tool()` 的 `options.toolCallId` 是现成幂等键。
9. **忽略 abortSignal**：用户取消对话后，`execute` 仍在跑。在长任务工具里监听 `options.abortSignal`，提前终止。
10. **审计异步失败吞掉工具结果**：审计是旁路，写失败不应改变工具返回值；但要用独立通道记录审计失败，避免静默丢失合规数据。

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

### 11.7.1 展示参数、结果与错误

```tsx
// apps/web/src/components/chat/ToolCallDetail.tsx —— 工具调用详情
'use client';

import type { UIMessage } from 'ai';

export function ToolCallDetail({ message }: { message: UIMessage }) {
  const invocations = (message.parts ?? [])
    .filter(p => p.type === 'tool-invocation')
    .map(p => p.toolInvocation);

  if (invocations.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 p-2 rounded-md bg-surface/50 border border-border text-xs">
      {invocations.map(inv => (
        <details key={inv.toolCallId} className="group">
          <summary className="flex items-center gap-2 cursor-pointer">
            <span className="font-mono text-accent">{inv.toolName}</span>
            <span className="text-muted">
              {inv.state === 'result' ? '成功' : inv.state === 'error' ? '失败' : '执行中…'}
            </span>
          </summary>
          {inv.state === 'result' && (
            <pre className="mt-1 whitespace-pre-wrap text-muted">{JSON.stringify(inv.result, null, 2)}</pre>
          )}
          {inv.state === 'error' && (
            <pre className="mt-1 whitespace-pre-wrap text-destructive">{String(inv.error)}</pre>
          )}
        </details>
      ))}
    </div>
  );
}
```

### 11.7.2 自动滚动与折叠策略

- 工具卡片默认折叠，只显示工具名 + 状态；
- 结果超过 3 行时内部 `details` 折叠，避免时间线无限拉长；
- 新工具调用出现时，容器 `scrollIntoView({ block: 'end' })`，但不要打断用户阅读历史。

### 11.7.3 从审计 API 补充步骤级信息

`tool-invocation` 只携带 SDK 会话内的结果；需要查看审计字段（耗时、prompt 版本、重试次数）时，前端从只读审计 API 拉取：

```tsx
// apps/web/src/components/chat/ToolCallMeta.tsx —— 审计元信息（只读）
'use client';

import { useEffect, useState } from 'react';

interface ToolMeta {
  toolName: string;
  toolCallId: string;
  durationMs: number;
  promptVersion?: number;
  status: 'success' | 'error';
}

export function ToolCallMeta({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<ToolMeta[]>([]);

  useEffect(() => {
    fetch(`/api/audit?sessionId=${encodeURIComponent(sessionId)}`)
      .then(r => r.json())
      .then(setRows);
  }, [sessionId]);

  return (
    <ul className="text-xs text-muted">
      {rows.map(row => (
        <li key={row.toolCallId} className="flex gap-2">
          <span>{row.toolName}</span>
          <span>{row.durationMs}ms</span>
          {row.promptVersion && <span>v{row.promptVersion}</span>}
        </li>
      ))}
    </ul>
  );
}
```

只读、分页、按 session 过滤——审计 API 不做任何写操作，也不返回参数原文（合规最小化）。

🤖 **AI 常见错误**：把工具调用的原始 `parts` 直接渲染成 JSON 文本。用 `UIMessage.parts` 的 `tool-invocation` 结构渲染卡片，保留状态机（loading/success/error），不要重新解析消息体。

### 11.7.4 与 Langfuse 的跳转

每条工具卡片右上角提供"在 Langfuse 查看 trace"链接，用 `traceId` 深链：

```tsx
// apps/web/src/components/chat/ToolCallTracer.tsx —— 追加 Langfuse 深链
<a
  href={`https://cloud.langfuse.com/trace/${traceId}`}
  target="_blank"
  rel="noreferrer"
  className="text-accent"
>
  查看 trace
</a>
```

`traceId` 由 `useChat` 的 `onFinish` 回调从 `result.experimental_providerMetadata` 或服务端响应头获取，前端不自行生成。

---

## 11.8 本层验收清单

- [ ] `references/` 中无旧 Provider 类型引用；`llm` 类型全部是 `LanguageModel`（见 00-types.md）
- [ ] `streamText` + `tools` + `maxSteps` 完成"调用→失败→修正→成功"全流程：工具抛错后模型在下一轮收到错误并修正
- [ ] `maxSteps` 生效：工具持续失败时循环在 `maxSteps` 处终止，不无限烧 token
- [ ] 一轮多工具调用被 SDK 并行执行；`runBatch` 并发上限生效且部分失败不丢成功结果
- [ ] `ToolCallAuditLogger` 记录每次调用的 session/工具/耗时/状态
- [ ] 前端 `ToolCallTracer` 从 `UIMessage.parts` 渲染工具调用时间线
- [ ] 门禁：运行 `node tools/check-skill.mjs`，本文件 0 失败
