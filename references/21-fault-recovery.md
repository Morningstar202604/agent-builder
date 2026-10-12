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

## 10. 本层验收清单

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/fault/*.ts` 全部通过。
- [ ] **检查点恢复**：运行 `pnpm vitest run fault/checkpoint`，构造含 `AbortController` 的输入，断言业务 state 序列化不抛错，恢复后消息历史与 token 预算一致。
- [ ] **幂等性**：运行 `pnpm vitest run fault/idempotency`，模拟「第一次超时、第二次成功」，断言远程函数只执行 1 次。
- [ ] **队列重试**：运行 `pnpm vitest run fault/queue`，断言 `attempts: 3` 的任务失败 3 次后进入 `failed`，指数退避间隔符合 `backoff.delay`。
- [ ] **降级**：运行 `pnpm vitest run fault/fallback`，mock 主模型抛错，断言返回 `model: 'claude-sonnet-4-20250514'`。
- [ ] **门禁回归**：`node tools/check-skill.mjs` 本文件 0 失败。

---

*本节点属于 Layer 4 可靠性工程层。容错的终极目标是"用户不应该感知到底层出了问题"。核心原则：**容错优先级高于性能**。实现上不再手写快照/重试/超时——检查点用 LangGraph checkpointer，异步任务用 BullMQ，幂等锁用 Redis，模型降级复用 01 的 `createModel`。演进路径：先接 checkpointer（解决 80% 断线场景），再加幂等（解决工具层），最后接 BullMQ 与降级链（解决 API 层）。*
