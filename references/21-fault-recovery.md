# 21 — 容错与恢复 · Agent 可靠性工程

> 目标：Agent 在一次 30 分钟对话中途崩溃时，用户不应承受"一切重来"的代价。本章从状态检查点、断线重连、幂等、降级、超时五个角度构建完整的容错体系。

> **⚠️ 本层铁律：不自研可靠性基础设施，直接接成熟方案。**
> - 会话状态快照 → **LangGraph checkpointer**（Redis/Postgres Saver）
> - 任务队列 / 重试 / 退避 → **BullMQ**（配置化，不手写 retry loop）
> - 幂等锁、事件流、计数器 → **Redis 官方客户端**（ioredis / @upstash/redis）
> - 模型降级 → 复用 01 的 `createModel`（`LanguageModel`），不手写 provider 客户端
>
> 唯一允许手写的 `[CUSTOM]` 是**业务幂等规则**与**错误分类策略**——哪些工具要幂等、哪些错误可重试，是产品语义。

---

## 目录

- [1. 会话状态快照：LangGraph checkpointer](#1-会话状态快照langgraph-checkpointer)
- [2. 断线重连恢复](#2-断线重连恢复)
- [3. 工具调用幂等性](#3-工具调用幂等性)
- [4. 降级模型切换](#4-降级模型切换)
- [5. 超时与重试：BullMQ](#5-超时与重试bullmq)
- [6. 错误分类策略 [CUSTOM]](#6-错误分类策略-custom)
- [7. 前端：Recovery UI](#7-前端recovery-ui)
- [8. 避坑汇总](#8-避坑汇总)
- [9. AI 避坑追加](#9-ai-避坑追加)
- [10. 本层验收清单](#10-本层验收清单)

---

## 1. 会话状态快照：LangGraph checkpointer

**不要手写快照存储。** LangGraph 的 checkpointer 负责把会话状态持久化到 Redis/Postgres，支持断点续跑、`getState`/`updateState`。你的工作只剩两件：
1. 用 Saver 配置存储（Redis/Postgres 官方连接）；
2. 定义 `[CUSTOM]` 业务状态字段（intent/plan 等产品语义）。

```typescript
// packages/core/src/fault/checkpointer.ts
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

// 会话状态检查点：LangGraph 官方 Postgres Saver，不手写快照存储
export async function createCheckpointer(): Promise<PostgresSaver> {
  const saver = PostgresSaver.fromConnString(process.env.DATABASE_URL ?? '');
  await saver.setup();
  return saver;
}
```

```typescript
// packages/core/src/fault/agent-checkpoint.ts
import { Annotation } from '@langchain/langgraph';

// [CUSTOM] 业务状态字段：框架负责持久化/恢复，字段语义由产品定义
export const AgentState = Annotation.Root({
  messages: Annotation<string[]>,
  currentIntent: Annotation<string>,
  partialPlan: Annotation<string>,
  tokenBudgetUsed: Annotation<number>,
});
```

🔗 **工程逻辑**：05 多 Agent 编排（[05-multi-agent](./05-multi-agent.md)）如果已经用 LangGraph，checkpointer 是现成的；即使主循环用 AI SDK `streamText`（[01-foundation](./01-foundation.md)），也可以把 `messages` 写入同一 checkpointer 供恢复使用。快照时机仍是业务决策：每次工具调用完成后、每 N 条消息后。

## 2. 断线重连恢复

断线重连需要"补发客户端错过的事件"。事件流用 **Redis Stream**（官方客户端），客户端带 `Last-Event-Id` 重连时从该位置续读。

```typescript
// packages/core/src/fault/event-store.ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? '');

// 事件流：Redis Stream 官方客户端，MAXLEN 自动裁剪，保留 24h
export async function appendEvent(sessionId: string, event: { type: string; data: unknown }): Promise<string> {
  return redis.xadd(
    `events:${sessionId}`,
    'MAXLEN', '~', 1000,
    '*',
    'type', event.type,
    'payload', JSON.stringify(event.data),
  );
}

export async function readEventsAfter(
  sessionId: string,
  after: string,
  count = 500,
): Promise<Array<{ id: string; type: string; data: unknown }>> {
  const entries = await redis.xrange(`events:${sessionId}`, after, '+', 'COUNT', count);
  return entries.map((entry) => ({
    id: entry[0],
    type: String(entry[1][entry[1].indexOf('type') + 1] ?? ''),
    data: JSON.parse(entry[1][entry[1].indexOf('payload') + 1]),
  }));
}
```

> 🤖 **AI 常见错误**：SSE 重连时从 0 开始重放所有历史事件，客户端渲染重复、体验卡顿。正确做法：用 `Last-Event-Id` 从 Redis Stream 断点续读，只补发缺失事件。

## 3. 工具调用幂等性

**幂等机制 = Redis `SET NX`（原子锁）**；**幂等规则 = `[CUSTOM]` 配置表**（哪些工具需要幂等、幂等键怎么生成）。

```typescript
// packages/core/src/fault/idempotency.ts
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? '');

// [CUSTOM] 业务幂等规则：哪些工具需要幂等，由产品定义（配置表）
const IDEMPOTENT_TOOLS = new Set(['send_email', 'write_file', 'create_order']);

export function isIdempotent(toolName: string): boolean {
  return IDEMPOTENT_TOOLS.has(toolName);
}

// 幂等锁：Redis 官方客户端 SET NX（原子），不手写分布式锁
export async function withIdempotency<T>(
  toolName: string,
  args: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `idempotency:${toolName}:${JSON.stringify(args)}`;
  const acquired = await redis.set(key, 'pending', 'EX', 24 * 60 * 60, 'NX');
  if (acquired === 'OK') {
    try {
      const result = await fn();
      await redis.set(key, JSON.stringify({ status: 'done', result }), 'EX', 24 * 60 * 60);
      return result;
    } catch (e) {
      await redis.del(key);
      throw e;
    }
  }
  const raw = await redis.get(key);
  const cached = raw ? (JSON.parse(raw) as { status: string; result?: T }) : null;
  if (cached?.status === 'done') return cached.result as T;
  throw new Error('Idempotency lock held by in-flight call');
}
```

> 🤖 **AI 常见错误**：重试时直接再次执行 `fn()`，导致重复扣费或重复写入。正确做法：重试前必须读幂等缓存，`done` 直接返回结果，`pending` 超过 TTL 才归还锁；单测模拟「第一次超时、第二次成功」断言远程函数只执行一次。

## 4. 降级模型切换

**降级链是配置，模型类型是 `ai` 的 `LanguageModel`**（01 层 `createModel`）。不手写 `LLMClient` 抽象——全项目统一用 `LanguageModel`。

```typescript
// packages/core/src/fault/model-fallback.ts
import { generateText, type LanguageModel } from 'ai';
import { createModel } from '@agentcore/core/llm';

// [CUSTOM] 降级链：产品决定主备模型顺序（01 层 createModel 提供统一类型）
const FALLBACK_CHAIN: Array<{ name: string; model: LanguageModel }> = [
  { name: 'gpt-4o', model: createModel('openai', process.env) },
  { name: 'claude-sonnet-4-20250514', model: createModel('anthropic', process.env) },
];

export async function generateWithFallback(prompt: string): Promise<{ content: string; model: string }> {
  let lastError: unknown;
  for (const tier of FALLBACK_CHAIN) {
    try {
      const result = await generateText({ model: tier.model, prompt });
      return { content: result.text, model: tier.name };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`All models failed: ${String(lastError)}`);
}
```

## 5. 超时与重试：BullMQ

**任务队列、重试次数、指数退避、并发上限都是 BullMQ 配置**——不手写 `withRetry` 循环。

```typescript
// packages/core/src/fault/task-queue.ts
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis(process.env.REDIS_URL ?? '', { maxRetriesPerRequest: null });

export const agentTasks = new Queue('agent-tasks', { connection });

export const worker = new Worker(
  'agent-tasks',
  async (job) => {
    switch (job.name) {
      case 'tool_call':
        return executeToolCall(job.data);
      case 'archive_snapshot':
        return archiveSnapshot(job.data);
      default:
        throw new Error(`Unknown job: ${job.name}`);
    }
  },
  { connection, concurrency: 5 },
);

export async function enqueueToolCall(payload: unknown): Promise<void> {
  await agentTasks.add('tool_call', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
  });
}
```

🔗 **工程逻辑**：工具调用、快照归档这些异步任务入队后，`attempts`/`backoff` 由 BullMQ 调度；结合 Worker `concurrency` 控制并发。超时可以用 `AbortSignal.timeout()` 包住 job 处理函数，把"超时后怎么收尾"留给业务回调。

## 6. 错误分类策略 [CUSTOM]

哪些错误可重试、哪些要降级、哪些直接终止——这是**业务策略**，做成配置表，不属于基础设施。

```typescript
// packages/core/src/fault/error-policy.ts
// [CUSTOM] 错误分类策略：产品定义的业务规则（配置表），不是基础设施
export const ERROR_POLICY = {
  retryable: new Set(['429', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']),
  serverError: new Set(['500', '502', '503']),
  fatal: new Set(['401', '403', '400']),
} as const;

export type RecoveryAction = 'retry' | 'fallback' | 'fatal';

export function classifyError(status: number, code: string): RecoveryAction {
  if (status >= 500 || ERROR_POLICY.retryable.has(code)) return 'retry';
  if (ERROR_POLICY.fatal.has(String(status))) return 'fatal';
  return 'fallback';
}
```

## 7. 前端：Recovery UI

Recovery UI（断线提示条、模型降级通知、进度条）是产品界面，用现有组件库组装；事件来自 01 层的流式协议（`AgentEvent`）与上面的 Redis Stream 补发。具体视觉设计属于产品设计，不在本 reference 展开。

## 8. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| 快照序列化 crash | 快照含不可序列化对象（AbortController/Socket） | LangGraph checkpointer 只存可序列化 state；业务字段保持 JSON-safe |
| 重连后事件不连续 | lastEventId 被 MAXLEN 裁剪 | Redis Stream 保留 24h；超出边界告知用户"无法恢复到之前的对话" |
| 工具重试导致重复执行 | 没有幂等保护 | `SET NX` + `[CUSTOM]` 幂等工具表 |
| 降级后用户无感知、质量下降 | 未通知前端 | SSE 发 `model_switched` 事件，前端 toast |
| 超时只返回 error 丢内容 | 超时直接 throw | BullMQ 重试 + `AbortSignal.timeout()` 包装，超时返回 partial result |
| 降级链全部同厂商 | 一次厂商故障全挂 | 主备模型跨厂商（OpenAI + Anthropic） |

## 9. AI 避坑追加

> 🤖 **AI 常见错误**：
>
> 1. **快照包含不可序列化字段** — `JSON.stringify` 遇到 `AbortController`/`Socket` 直接抛错。**检查方式**：业务 state 只保留 JSON-safe 字段；写入前用 `structuredClone()` 做兼容性断言。
>
> 2. **SSE 重连后 last-event-id 不连续** — Redis Stream 被裁剪后服务端找不到事件 ID，静默跳历史。**ESLint 规则**：重连逻辑必须检查 `resumed` 响应字段，`resumed: false` 时丢弃旧 buffer 做全量恢复。
>
> 3. **模型降级后 token 预算未重算** — 从大上下文模型降到小上下文模型，ContextManager 仍按旧预算构建 prompt，第一条就报 `context_length_exceeded`。**检查方式**：切换模型必须同步 `resizeBudget(newMaxTokens)`；`buildContext()` 断言 `estimatedTokens <= model.maxContextTokens * 0.9`。


---

## 9.1 会话状态快照：Postgres 持久化（生产级）

### checkpointer 选型：Redis vs Postgres

| 场景 | 用哪个 | 理由 |
|------|--------|------|
| 短会话、高并发、可容忍丢失 | **Redis checkpointer**（TTL 24h） | 快、热数据在内存 |
| 长会话、审计要求、跨会话恢复 | **Postgres checkpointer**（LangGraph 官方支持） | 持久、可查询、可审计 |
| 生产标准做法 | **Postgres 冷归档 + Redis 热快照** 双层 | 兼顾性能与可靠性 |

### LangGraph Postgres checkpointer 完整示例

```typescript
// packages/core/src/orchestrator/checkpointer.ts —— 生产用 Postgres 持久化会话状态
import { PostgresCheckpointer } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';

export async function createPostgresCheckpointer() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10, // 连接池上限，避免打爆数据库
  });
  return PostgresCheckpointer.fromPool(pool, { tableName: 'agent_checkpoints' });
}
```

- 每轮 `streamText` 结束后写入一个 checkpoint，恢复时从 `thread_id` 取回。
- `thread_id` 用 `sessionId`：前端 `useChat({ id: sessionId })` 与后端 `thread_id` 对齐。
- 冷归档表建议加 `created_at` 索引，按租户分区（配合 19 的 RLS）。

### 恢复流程时序（断线重连）

```
用户断线
  → 前端收到 SSE 中断（或 30s 无数据）
  → 指数退避重连（1s→2s→4s→最大30s）
  → 重连成功，携带 thread_id 恢复会话
  → 后端从 Postgres 读最新 checkpoint
  → 重建上下文并继续流式输出（不重复已完成的工具调用）
```

🤖 **AI 常见错误**：恢复时把"已完成的工具调用"又执行了一遍——工具有副作用（发邮件、扣费）。**checkpoint 里必须记录已完成工具调用的幂等键**，恢复时跳过这些键（见 9.3）。

## 9.2 工具幂等性的完整设计

### 幂等键模式

```typescript
// packages/core/src/tools/idempotency.ts —— Redis SETNX 实现幂等
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const TTL_SECONDS = 60 * 60 * 24; // 24h 幂等窗口

export async function tryAcquireIdempotencyKey(toolName: string, args: object): Promise<string | null> {
  const key = `idem:${toolName}:${hash(JSON.stringify(args))}`;
  const token = crypto.randomUUID();
  const ok = await redis.setNX(key, token, { EX: TTL_SECONDS });
  return ok ? token : null; // null = 重复调用，直接返回上次结果
}

export async function getCachedResult(key: string): Promise<unknown | null> {
  const raw = await redis.get(`result:${key}`);
  return raw ? JSON.parse(raw) : null;
}
```

### 三种工具语义

| 工具类型 | 重试语义 | 实现 |
|---------|---------|------|
| 只读工具（search、read） | at-least-once，重复无害 | 不设幂等键 |
| 幂等工具（create with id） | 天然幂等 | 用 client 提供的 id |
| 副作用工具（send_email、execute_code） | exactly-once | **必须**幂等键 + 缓存结果 |

🤖 **AI 常见错误**：所有工具都加幂等键——只为副作用工具加，否则读操作也走 Redis 写路径，白增延迟。

## 9.3 降级模型链：LiteLLM fallback 配置

不要手写 `try modelA catch modelB`。用 LiteLLM Proxy 的 `fallbacks` 声明式完成。

```yaml
# litellm-config.yaml（节选）
model_list:
  - model_name: primary
    litellm_params:
      model: gpt-4o
      api_key: ${OPENAI_API_KEY}
  - model_name: fallback
    litellm_params:
      model: claude-sonnet-4-20250514
      api_key: ${ANTHROPIC_API_KEY}
router_settings:
  fallbacks:
    - { model: primary, fallbacks: [fallback] }
  num_retries: 2
  retry_policy:
    HTTPStatusError: true
    TimeoutError: true
```

业务代码只调 `baseURL = process.env.LITELLM_BASE_URL` 的 OpenAI 兼容端点，路由与降级全在网关。成本路由：`routing_strategy: "cost-based-routing"` 自动优先便宜模型。

## 9.4 BullMQ 超时与重试的工程细节

```typescript
// packages/core/src/jobs/agent-job.ts —— 长任务用 BullMQ，不要 setTimeout 硬扛
import { Queue, Worker } from 'bullmq';

export const agentQueue = new Queue('agent-tasks', {
  connection: { url: process.env.REDIS_URL },
  defaultJobOptions: {
    attempts: 3,               // 重试次数
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 },
  },
});

new Worker('agent-tasks', async (job) => {
  // job.data: { sessionId, message }
  // 幂等：job.id 作为幂等键
  const result = await runAgentLoop(job.data);
  return result;
}, { concurrency: 5 });
```

- **重试幂等**：BullMQ 重试会重复执行 job，务必用 `job.id` 做幂等键。
- **死信队列**：`removeOnFail` 保留失败任务供人工排查；配合 `DLQ` 告警（Langfuse 看板）。
- **超时**：`job.updateProgress` 心跳 + `Worker` 的 `lockDuration`，避免长任务被误判死锁。

## 9.5 生产故障演练清单

- [ ] 模拟 SSE 中断 30s，验证指数退避重连与 checkpoint 恢复，消息无重复无遗漏
- [ ] 模拟模型 500/超时，验证 LiteLLM fallback 自动切换且前端不感知
- [ ] 模拟重复 webhook/工具调用，验证幂等键去重（结果缓存命中）
- [ ] 模拟 Redis 宕机，验证 Postgres 冷归档仍可恢复会话
- [ ] 压测：100 并发长任务下 BullMQ 队列积压与 worker 扩展


## 9.6 前端 Recovery UI 与用户感知

断线重连不应该让用户看到"报错"。前端要区分三种状态：**重连中**、**已恢复**、**不可恢复（需手动重发）**。

```tsx
// apps/web/src/hooks/useRecoveryStatus.ts —— 基于 useChat 的断线状态机
import { useChat } from 'ai/react';

export type RecoveryState = 'streaming' | 'reconnecting' | 'recovered' | 'failed';

export function useRecoveryStatus() {
  const chat = useChat({ api: '/api/chat', sendExtraMessageFields: true });
  // 依据 chat.status（'streaming' | 'ready' | 'error'）+ 自研心跳事件推断状态
  // 通过 AI SDK 的 onError 回调 + 指数退避重试（SDK 内置）驱动状态迁移
  return { ...chat };
}
```

- **重连中**：顶部显示"连接中断，正在重连…"（不阻塞输入框）。
- **已恢复**：自动补发 `Last-Event-ID` 之后的消息，渲染不重复。
- **不可恢复**：显示"请重发"按钮，并把未发送消息保留在输入框，不丢用户输入。

🤖 **AI 常见错误**：重连成功后把整段历史重新发送一遍——会触发重复工具调用。正确做法是只补发断点之后的消息，并用幂等键去重。

## 9.7 错误分类策略表 [CUSTOM]

把错误分成可重试/不可重试，避免无脑重试浪费 token。

| 错误类别 | 例子 | 策略 |
|---------|------|------|
| 可瞬时重试 | 429、5xx、网络超时 | 指数退避重试（BullMQ/LiteLLM） |
| 不可重试（输入侧） | 参数校验失败、工具不存在 | 立即返回 tool_error 给 LLM，不重试 |
| 不可重试（安全） | guardrail 拦截、注入检测触发 | tripwire 终止，不重试，审计 |
| 降级 | 主模型不可用 | fallback 模型，不重试原模型 |

```typescript
// packages/core/src/errors/policy.ts
export function classifyError(error: unknown): 'retryable' | 'fatal' | 'fallback' {
  if (error instanceof TimeoutError || error instanceof RateLimitError) return 'retryable';
  if (error instanceof ValidationError || error instanceof ToolNotFoundError) return 'fatal';
  if (error instanceof ModelUnavailableError) return 'fallback';
  return 'fatal';
}
```

## 9.8 与 LangGraph checkpointer 深度结合

`createReactAgent` 直接支持 checkpointer，恢复会话时从 `thread_id` 续跑，无需自己存消息历史。

```typescript
// packages/core/src/orchestrator/react-agent.ts —— 用 checkpointer 实现断点续跑
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { createPostgresCheckpointer } from './checkpointer';

export async function createResumableAgent() {
  const checkpointer = await createPostgresCheckpointer();
  return createReactAgent({
    llm: new ChatOpenAI({ model: process.env.OPENAI_MODEL ?? 'gpt-4o' }) // 生产：经 LangChain 桥接，或直接喂 AI SDK 模型
      /* 说明：createReactAgent 需要 LangChain BaseChatModel；AI SDK LanguageModel 可经 @langchain/ai 的包装器转换，见 18 */,
    tools: [],
    checkpointer,
  });
}
```

- `thread_id` = `sessionId`；每次工具调用后自动落 checkpoint。
- 会话中断后，用 `graph.getState({ thread_id })` 查询进度，恢复时从断点继续。
- 这比手写"消息历史 + 快照"更省事，且状态一致性由框架保证。

## 9.9 超时与取消的优雅处理（深入）

### 三层超时

| 层 | 超时 | 实现 |
|----|------|------|
| HTTP 层 | 300s（SSE 长响应） | Nginx `proxy_read_timeout 600s` + `AbortController` |
| Agent 循环 | `maxSteps` + 全局超时 | `streamText({ maxSteps })` + `Promise.race` |
| 工具调用 | 30s 每工具 | MCP 客户端 timeout + `AbortSignal.timeout(30000)` |

```typescript
// 工具级超时示例：AbortSignal.timeout 而非手写 setTimeout 清理
const result = await tool.execute(args, { signal: AbortSignal.timeout(30_000) });
```

### 取消语义

用户点"停止" → `useChat` 发送 abort → 后端 `AbortController.abort()` → `streamText` 立即停止 → 已完成的工具调用结果**不落库**（未完成事务），未发送的 token 不消耗。

## 10. 本层验收清单

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/fault/*.ts` 全部通过。
- [ ] **检查点恢复**：运行 `pnpm vitest run fault/checkpoint`，构造含 `AbortController` 的输入，断言业务 state 序列化不抛错，恢复后消息历史与 token 预算一致。
- [ ] **幂等性**：运行 `pnpm vitest run fault/idempotency`，模拟「第一次超时、第二次成功」，断言远程函数只执行 1 次。
- [ ] **队列重试**：运行 `pnpm vitest run fault/queue`，断言 `attempts: 3` 的任务失败 3 次后进入 `failed`，指数退避间隔符合 `backoff.delay`。
- [ ] **降级**：运行 `pnpm vitest run fault/fallback`，mock 主模型抛错，断言返回 `model: 'claude-sonnet-4-20250514'`。
- [ ] **门禁回归**：`node tools/check-skill.mjs` 本文件 0 失败。

---

*本节点属于 Layer 4 可靠性工程层。容错的终极目标是"用户不应该感知到底层出了问题"。核心原则：**容错优先级高于性能**。实现上不再手写快照/重试/超时——检查点用 LangGraph checkpointer，异步任务用 BullMQ，幂等锁用 Redis，模型降级复用 01 的 `createModel`。演进路径：先接 checkpointer（解决 80% 断线场景），再加幂等（解决工具层），最后接 BullMQ 与降级链（解决 API 层）。*
