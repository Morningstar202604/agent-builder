# 17 — 流式性能与可靠性进阶

> 目标：01 已经用 Vercel AI SDK 把 SSE 流跑通。本文件解决生产级的"流式体验"——延迟指标怎么测、断线重连怎么处理、代理层怎么配、前端渲染怎么不卡顿。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - SSE 协议 / 心跳 / 重连 → **Vercel AI SDK 已内置**（`toDataStreamResponse` 处理流，`useChat` 自动重连），不要手写 EventSource 解析器或补发缓存
> - 延迟指标（TTFT/TPOT/E2E）→ **Langfuse** 观测，或 `performance.now()` 手动计时；不手写协议埋点
> - Nginx / 反向代理 → **配置模板**（声明式配置，保留）
> - 客户端渲染节流 → **React 内置能力**（`useDeferredValue` / `useChat` 状态合并），不手写 SSE 节流器
> 本层唯一保留的手写代码是**业务侧的计时封装**——它只是 `performance.now()` 的加减法，不是协议实现。

---

## 目录

- [工程逻辑：流式性能拆解](#工程逻辑流式性能拆解)
- [1. 延迟指标：TTFT / TPOT / E2E](#1-延迟指标ttft--tpot--e2e)
- [2. 智能重连：SDK 已内置](#2-智能重连sdk-已内置)
- [3. Nginx / 反向代理配置模板](#3-nginx--反向代理配置模板)
- [4. 客户端流式渲染优化](#4-客户端流式渲染优化)
- [5. 可观测性：Langfuse](#5-可观测性langfuse)
- [6. AI 避坑](#6-ai-避坑)
- [7. 本层验收清单](#7-本层验收清单)

---

## 工程逻辑：流式性能拆解

用户听到的"Agent 回复快不快"不是一个指标，而是三个独立指标，各自的影响因素完全不同：

```
┌────────────────────────────────────────────────────────────────────┐
│                   流式延迟三指标拆解                                  │
│                                                                      │
│  TTFT (Time To First Token)                                         │
│  ┌──────────┐                                                        │
│  │ 用户发送  │─── prompt 处理 + 模型首 token ──────────────────▶ 首字符│
│  └──────────┘    (通常 200-800ms)                    出现            │
│                                                                      │
│  TPOT (Time Per Output Token)                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 首字符 ──────────────────────────────────────────────── 末尾  │   │
│  │         (每 token 间隔，通常 10-50ms/token)                    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  E2E Latency (End-to-End)                                           │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 用户发送 ───────────────────────────────────────────── 完    │   │
│  │         = TTFT + TPOT × 总 token 数                         │   │
│  └────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

| 指标 | 瓶颈 | 优化手段 |
|------|------|---------|
| TTFT | prompt 长度、模型冷启动、网络 RTT | prompt 缓存、长 prompt 迁移到服务端、预热 |
| TPOT | 模型推理速度、GPU 内存带宽 | 换更快模型、量化、KV Cache |
| E2E | TTFT + TPOT × token 数 | 减少总 token（精简输出）、前置关键信息 |

---

## 1. 延迟指标：TTFT / TPOT / E2E

### 1.1 手动计时：`performance.now()` 包一圈 `streamText`

如果你只需要一个简单的上报字段，用 `performance.now()` 记录三个时间点即可——这只是加减法，不涉及任何协议实现：

```typescript
// packages/core/src/streaming/latency.ts —— 业务侧计时封装，只做加减法
import { streamText } from 'ai';
import type { LanguageModel, UIMessage } from 'ai';

export interface LatencyMetrics {
  ttft: number;        // 首 token 延迟 (ms)
  tpot: number;        // 每 token 平均输出间隔 (ms)
  e2e: number;          // 端到端延迟 (ms)
  totalTokens: number;
}

export async function streamWithLatency(
  model: LanguageModel,
  messages: UIMessage[],
  onToken: (text: string) => void,
): Promise<LatencyMetrics> {
  const start = performance.now();
  let firstTokenAt = 0;
  let lastTokenAt = 0;
  let tokenCount = 0;

  const result = streamText({ model, messages });
  for await (const chunk of result.textStream) {
    const now = performance.now();
    if (tokenCount === 0) firstTokenAt = now;
    lastTokenAt = now;
    tokenCount++;
    onToken(chunk);
  }

  const e2e = performance.now() - start;
  const ttft = firstTokenAt - start;
  const tpot = tokenCount > 1 ? (lastTokenAt - firstTokenAt) / (tokenCount - 1) : 0;
  return { ttft, tpot, e2e, totalTokens: tokenCount };
}

export function diagnoseLatency(m: LatencyMetrics): {
  health: 'healthy' | 'warning' | 'critical';
  issues: string[];
} {
  const issues: string[] = [];
  if (m.ttft > 1000) issues.push(`TTFT ${m.ttft.toFixed(0)}ms > 1000ms`);
  if (m.tpot > 50) issues.push(`TPOT ${m.tpot.toFixed(0)}ms > 50ms`);
  const health = issues.length === 0 ? 'healthy' : issues.length === 1 ? 'warning' : 'critical';
  return { health, issues };
}
```

🤖 **AI 常见错误**：发现 TTFT 高就怪模型慢。实际上 80% 的 TTFT 瓶颈来自：
1. prompt 太长（注入了 5000 token 的 RAG 上下文）
2. 反向代理缓冲（Nginx `proxy_buffering on` 把 SSE 流缓存后再转发，引入 1-5s 延迟）
3. 客户端 DNS 解析慢
先排查这三个，再怀疑模型。

### 1.2 生产观测：Langfuse

手动计时适合"知道大概"，生产环境用 **Langfuse** 统一采集 TTFT/TPOT、token 用量与成本——不要自己搭时序数据库：

```typescript
// packages/core/src/streaming/observability.ts —— 观测走平台，不手写协议
import { Langfuse } from 'langfuse';

export const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST,
});
```

用 `langfuse.trace()` / `langfuse.span()` 包裹 `streamText` 调用，Langfuse 自动记录每个 span 的输入、输出、耗时与 token 数，TTFT/TPOT 可以直接在 Langfuse UI 里按模型、按会话筛选，并配置告警。

### 1.3 调优清单

| 场景 | 做法 |
|------|------|
| prompt 缓存 | system prompt 必须放在 messages 最前且逐字节一致，命中后 TTFT 从 ~500ms 降到 ~50ms |
| RAG 注入量 | 控制注入 token < 2000，只注入最相关的 3-5 条 |
| 代理层 | 关闭 `proxy_buffering`，`proxy_read_timeout` 放宽到 600s+ |
| 模型侧 | 长输出场景换更快模型，或开启 KV Cache 持久化 |

---


### 1.4 路由层测量：`onChunk` / `fullStream`（推荐）

手动计时包装 `streamText` 只能覆盖“业务侧看到的时间”，生产环境更推荐在路由层用 `onChunk` 回调测量——它能精确区分首 token 时刻与每个 `text-delta` 的到达时刻，且不侵入 `useChat` 的客户端逻辑：

```typescript
// packages/core/src/streaming/server-latency.ts —— 路由层计时，不手写协议
import { streamText } from 'ai';
import type { LanguageModel, UIMessage } from 'ai';

export interface ServerLatency {
  ttftMs: number;
  tpotMs: number;
  textDeltaCount: number;
}

export async function measureStreamLatency(
  model: LanguageModel,
  messages: UIMessage[],
): Promise<ServerLatency> {
  const startedAt = performance.now();
  let firstDeltaAt = 0;
  let lastDeltaAt = 0;
  let textDeltaCount = 0;

  const result = streamText({
    model,
    messages,
    onChunk: ({ chunk }) => {
      if (chunk.type !== 'text-delta') return;
      const now = performance.now();
      if (textDeltaCount === 0) firstDeltaAt = now;
      lastDeltaAt = now;
      textDeltaCount += 1;
    },
  });

  // 消费流：onChunk 已记录时间戳，这里不再做业务处理
  for await (const _text of result.textStream) {
    // 空循环：驱动底层流开始产出
  }

  const e2eMs = performance.now() - startedAt;
  const ttftMs = firstDeltaAt - startedAt;
  const tpotMs = textDeltaCount > 1 ? (lastDeltaAt - firstDeltaAt) / (textDeltaCount - 1) : 0;
  return { ttftMs, tpotMs, textDeltaCount };
}
```

```text
# 服务端一次采样输出（示例）
# ttftMs=412  tpotMs=18  textDeltaCount=96
```

- **TTFT**：`firstDeltaAt - startedAt`，包含网络接收、prompt 处理、模型首 token。
- **TPOT**：`(lastDeltaAt - firstDeltaAt) / (textDeltaCount - 1)`，只统计“输出密集期”的平均 token 间隔，避免被首 token 前的空闲稀释。
- **注意**：`onChunk` 的 `text-delta` 只覆盖文本输出；工具调用帧走 `tool-call`/`tool-result` 类型，计时逻辑应单独记录工具阶段耗时（见 [05-multi-agent](./05-multi-agent.md) 与 [11-function-calling](./11-function-calling.md)）。

### 1.5 客户端 TTFT 感知：`useChat` 时间戳

服务端计时反映“模型多快”，客户端计时反映“用户感知多快”——两者差值是网络 RTT 与代理缓冲。用 `useChat` 的 `onFinish` 回调结合 `UIMessage.createdAt` 计算感知 TTFT，数值上报 Langfuse 或自有指标端点：

```tsx
// apps/web/src/components/chat/ChatWithLatency.tsx —— 客户端 TTFT 感知
'use client';

import { useChat } from 'ai/react';
import { useRef } from 'react';

export function ChatWithLatency() {
  const sentAtRef = useRef(0);

  const { input, handleInputChange, handleSubmit } = useChat({
    api: '/api/chat',
    onFinish: (message) => {
      if (sentAtRef.current === 0 || !message.createdAt) return;
      const ttftMs = message.createdAt.getTime() - sentAtRef.current;
      void ttftMs; // 上报 Langfuse Web SDK / 自有指标端点
    },
  });

  return (
    <form
      onSubmit={(e) => {
        sentAtRef.current = Date.now();
        handleSubmit(e);
      }}
    >
      <input value={input} onChange={handleInputChange} className="border p-2" />
      <button type="submit" className="rounded bg-black px-4 text-white">发送</button>
    </form>
  );
}
```

🤖 **AI 常见错误**：同时实现“服务端计时”和“客户端计时”两套口径却忘记标注差异——排查时把两者混在一起，得到自相矛盾的延迟报告。**约定口径**：数据库、Langfuse 指标一律存 `ttft_ms`（服务端，`onChunk` 测量）与 `perceived_ttft_ms`（客户端，`useChat` 测量），字段名固定，避免后续拼装节点改口径。

### 1.6 工具调用阶段的延迟分解

Agent 流式响应往往不是“一条文本到底”：模型可能先输出一段推理，再触发工具调用，等待工具结果后继续输出。此时单一 TTFT/TPOT 没有意义，需要用 `fullStream` 事件流把阶段拆开：

```typescript
// packages/core/src/streaming/step-latency.ts —— 分阶段延迟统计
import { streamText } from 'ai';
import type { LanguageModel, UIMessage } from 'ai';

export interface StepTiming {
  stepId: string;
  toolCalls: number;
  durationMs: number;
}

export async function traceStepTimings(
  model: LanguageModel,
  messages: UIMessage[],
): Promise<StepTiming[]> {
  const timings: StepTiming[] = [];
  let current: StepTiming | undefined;

  const result = streamText({ model, messages });
  for await (const event of result.fullStream) {
    if (event.type === 'step-start') {
      current = { stepId: String(event.stepId), toolCalls: 0, durationMs: 0 };
    } else if (event.type === 'tool-call' && current) {
      current.toolCalls += 1;
    } else if (event.type === 'step-finish' && current) {
      current.durationMs = event.durationMs ?? 0;
      timings.push(current);
      current = undefined;
    }
  }
  return timings;
}
```

`event.stepId` 与 `event.durationMs` 是 AI SDK `fullStream` 事件自带字段——**步骤边界与耗时由 SDK 计算，本层只做聚合**。工具延迟的根因分析（超时、重试、并发）继续复用 [21-fault-recovery](./21-fault-recovery.md) 的幂等与重试策略。


## 2. 智能重连：SDK 已内置

`ai/react` 的 `useChat` 内置了连接状态管理与重连能力：断线后 `status` 变为 `error`，调用 `reconnect()` 即可恢复同一会话；`toDataStreamResponse` 生成的流天然支持消费端从中断处继续。**不需要手写 `EventSource` 解析器、补发缓存或指数退避**——这些是浏览器和 SDK 的职责。

```tsx
// apps/web/src/app/page.tsx —— useChat 自带重连，不要手写 EventSource
'use client';

import { useChat } from 'ai/react';

export function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, stop, reconnect, status } =
    useChat({ api: '/api/chat' });

  return (
    <div className="mx-auto max-w-3xl p-4">
      {messages.map((m) => (
        <p key={m.id}>{m.content}</p>
      ))}
      {status === 'error' && (
        <button onClick={() => reconnect()} className="rounded bg-red-500 px-3 py-1 text-white">
          连接中断，点击重连
        </button>
      )}
      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input value={input} onChange={handleInputChange} disabled={isLoading} className="flex-1 border p-2" />
        <button type="submit" disabled={isLoading} className="rounded bg-black px-4 text-white">
          发送
        </button>
        {isLoading && (
          <button type="button" onClick={stop} className="rounded bg-gray-500 px-4 text-white">
            停止
          </button>
        )}
      </form>
    </div>
  );
}
```

🤖 **工程逻辑**：手写重连缓存（服务端保存未确认 chunk、客户端带 `Last-Event-ID` 重连）是典型的过度设计——`useChat` 已经在断线后自动恢复，服务端不需要为"补发"维护会话级内存缓存。省掉这块，同时省掉了缓存淘汰、LRU、内存上限等一系列复杂度。

---


### 2.1 数据流协议：`toDataStreamResponse` 发出的帧

`toDataStreamResponse` 不是普通的 `data:` 文本拼接——它实现 **AI SDK 数据流协议**：每行以数字前缀标记类型，`useChat` 原生解析这些帧并驱动 `messages` / `status` / `data` 更新。**这是本仓库所有流式响应的唯一允许出口**（见 [00-types.md](./00-types.md) 契约第 7 条）。

| 行前缀 | 载荷类型 | 说明 |
|--------|---------|------|
| `0` | text | 文本增量，对应 `text-delta` |
| `1` | data | 任意 JSON 数据（`data` 通道，如 RAG 引用、业务指标） |
| `2` | message | 完整消息帧（`UIMessage` 的 JSON 表达） |
| `3` | error | 错误帧，触发 `useChat` 的 `error` 状态 |
| `4` | abort | 客户端停止请求 |
| `8` | finish | 结束帧，携带 `finishReason` 与 token 用量 |
| `9` | start | 起始帧，标记一次流式开始 |

```text
# 开发模式查看 /api/chat 响应的原始帧（示意，字段随 SDK 版本演进）
9:"start"
0:"你好"
0:"，"
2:{"id":"msg_xxx","role":"assistant","parts":[{"type":"text","text":"你好，"}]}
8:{"finishReason":"stop","usage":{"inputTokens":12,"outputTokens":8}}
```

客户端永远不要自己拼这些帧。`useChat` 消费后自动做状态合并、工具调用恢复与 `status` 切换；如果需要在 `data` 通道下发自定义业务事件（如进度百分比），用 `streamText` 的 `experimental_createDataStream` 或 `result.mergeIntoDataStream` 追加——框架提供通道，业务只填 JSON。

### 2.2 重连语义与状态机

`useChat` 的 `status` 是四态机：`submitted → streaming → ready`，异常时进入 `error`。断线后调用 `reconnect()` 会**基于当前消息历史重新发起请求**，而不是从服务端“补发”未确认的 chunk：

```
提交消息 ──▶ submitted ──▶ streaming ──▶ ready
                  │            │
                  ▼            ▼
                error ◀──── 网络中断 / 服务端 5xx
                  │
                  └── reconnect()：重发最后一条消息，回到 streaming
```

服务端不需要为“补发”维护会话级内存缓存：`reconnect()` 重发完整 `messages`，路由层重新调用 `streamText` 即可。这意味着：

1. 后端可以**无状态水平扩展**，重连请求落到任意实例。
2. 不需要 `Last-Event-ID` 补发逻辑——那是 EventSource 时代为“事件溯源”设计的，`useChat` 的重连语义是“重放对话”，不是“续传事件流”。
3. 幂等由消息 ID 保证：`UIMessage.id` 由客户端生成，服务端只读不回写。

🤖 **AI 常见错误**：看到断线重连就设计“服务端保存未确认 chunk + 客户端带游标续传”的缓存层。这既引入 LRU/淘汰/内存上限复杂度，又与 `useChat` 的重放语义冲突。**正确姿势**：后端无状态，前端 `reconnect()`，数据源（模型 API）本身幂等重试。

### 2.3 `stop()` 与取消语义

`stop()` 通过 `AbortController` 中止当前流：浏览器收到 `abort` 帧后断开连接，服务端 `streamText` 抛出 `AI_APICallError` 或直接结束。需要在服务端做“取消后清理”（如终止子任务、回滚临时状态）时，用 `streamText` 的 `abortSignal` 选项传入路由层自己的 `AbortController`：

```typescript
// packages/core/src/streaming/abortable-stream.ts —— 取消语义的胶水封装
import { streamText } from 'ai';
import type { LanguageModel, UIMessage } from 'ai';

export function createAbortableStream(
  model: LanguageModel,
  messages: UIMessage[],
  signal: AbortSignal,
) {
  const result = streamText({ model, messages, abortSignal: signal });
  return {
    response: result.toDataStreamResponse(),
    onCancelled: (handler: () => void) => {
      signal.addEventListener('abort', handler, { once: true });
    },
  };
}
```

`abortSignal` 是 `streamText` 的标准选项——取消传播、底层请求中断、资源释放都由 SDK 处理，本层只把它接到路由层信号上。取消后的补偿事务（幂等键、任务状态回滚）见 [21-fault-recovery](./21-fault-recovery.md)。


## 3. Nginx / 反向代理配置模板

SSE 在代理层唯一要做的事是**关闭缓冲**。下面是配置模板——声明式配置，不属于代码：

```nginx
# /etc/nginx/conf.d/agent-core.conf —— 配置模板
upstream agent_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 443 ssl;
    server_name agent.example.com;

    location /api/chat {
        proxy_pass http://agent_backend;

        # ★ 关键：关闭缓冲——否则 Nginx 缓存整段响应再转发，SSE 失去实时性
        proxy_buffering off;
        proxy_http_version 1.1;
        proxy_set_header Connection '';

        # Agent 长分析场景：超时放宽到 1 小时
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # 不要 gzip SSE——gzip 需要攒包，会延迟 chunk 到达
        gzip off;

        add_header Cache-Control no-cache;
        add_header X-Accel-Buffering no;  # 告诉 Nginx 不要缓冲
    }

    # 静态资源可以正常 gzip
    location /static/ {
        gzip on;
        gzip_types text/plain text/css application/json application/javascript;
        gzip_min_length 1000;
    }
}
```

🤖 **AI 常见错误**：只关 `proxy_buffering` 不设 `proxy_read_timeout`——LLM 推理超过 60s 时连接被 Nginx 切断，前端看起来像"断流"。Agent 场景建议 `proxy_read_timeout 600s+`；Cloudflare 还要关闭 "Rocket Loader" 和 "Auto Minify"。

---


### 3.1 多实例部署：`least_conn` + 无状态后端

SSE 的“断线续传”依赖客户端重发消息（见 2.2），而不是服务端保存会话内存——因此 `useChat` 重连可以落到**任意实例**，upstream 不需要 sticky session：

```nginx
# /etc/nginx/conf.d/agent-core-multi.conf —— 多实例配置模板
upstream agent_backend {
    least_conn;
    server 127.0.0.1:3000 max_fails=3 fail_timeout=10s;
    server 127.0.0.1:3001 max_fails=3 fail_timeout=10s;
    keepalive 128;
}

server {
    listen 443 ssl http2;
    server_name agent.example.com;

    location /api/chat {
        proxy_pass http://agent_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流式三件套：关闭缓冲、关闭缓存、放宽读超时
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_connect_timeout 5s;

        gzip off;
        chunked_transfer_encoding on;

        add_header X-Accel-Buffering no;
        add_header Cache-Control no-cache;
    }
}
```

**逐行解释**：

- `least_conn`：SSE 长连接占住 worker，按活跃连接数分发比轮询更公平。
- `keepalive 128`：upstream 连接复用，避免每个 SSE 请求都新建 TCP/TLS 握手。
- `proxy_set_header Connection ''`：把 HTTP/1.1 keep-alive 交给 Nginx 管理，否则 SSE 长连接会被上游误判为 Connection: close。
- `proxy_read_timeout 3600s`：LLM 长分析场景（工具调用循环、多步推理）经常超过默认 60s，超时会被 Nginx 掐断，前端表现为“断流”。
- `X-Accel-Buffering: no`：显式告诉 Nginx 这一响应不要缓冲，即使全局配置开了缓冲。

### 3.2 边缘代理（Cloudflare / Vercel Edge / 自建 CDN）清单

经过 CDN 时，SSE 最大的敌人是**响应缓冲**和**资源改写**。以 Cloudflare 为例的检查清单：

| 配置项 | 值 | 原因 |
|--------|----|----|
| Rocket Loader | 关闭 | 会改写 HTML 中的脚本加载，破坏 `EventSource` 时序 |
| Auto Minify | 关闭 | 压缩 JS 可能破坏 `useChat` 的流式解析 |
| Brotli / gzip | `/api/chat` 关闭 | 压缩需要攒包，延迟 chunk 到达 |
| Cache Level | Bypass `/api/chat` | SSE 响应不应被边缘缓存 |
| 浏览器缓存 TTL | 0 | `Cache-Control: no-cache` 由源站下发 |
| Proxy Read Timeout | 100s+ | 默认 100s 对长分析不够，设上限或按业务调整 |
| WebSocket | 不需要 | SSE 走普通 HTTP，无需开启 WS 代理 |

**Vercel Edge / Cloudflare Workers** 场景：`toDataStreamResponse` 返回标准 `Response`，可以直接在 Edge Runtime 使用。唯一的注意点是**不要把整段响应读入内存再返回**——必须保持 `ReadableStream` 透传。以下模板用于 Node 与 Edge 双环境：

```typescript
// apps/web/src/app/api/chat-stream/route.ts —— Edge 可用的流式路由
import { streamText } from 'ai';
import { createModel } from '@agentcore/core/llm';
import type { UIMessage } from 'ai';

export const runtime = 'edge';

export async function POST(req: Request) {
  const { messages } = (await req.json()) as { messages: UIMessage[] };
  const model = createModel('anthropic', process.env);
  const result = streamText({ model, messages });
  return result.toDataStreamResponse();
}
```

`runtime = 'edge'` 与 `toDataStreamResponse()` 组合即可：Response 的 body 是 `ReadableStream`，边缘节点逐块转发，不需要任何 SSE 手写代码。

### 3.3 代理层排障命令

验证代理是否在缓冲 SSE，用 `curl -N`（`--no-buffer`）观察 chunk 到达间隔：

```bash
# 每秒打印一行时间戳，观察数据是否实时到达
curl -N --no-buffer -H 'Accept: text/event-stream' \
  -w '\n[time_total: %{time_total}s]\n' \
  https://agent.example.com/api/chat
```

```bash
# 检查响应头：应包含 X-Accel-Buffering: no 与 Cache-Control: no-cache
curl -sI https://agent.example.com/api/chat
```

如果 chunk 是“攒一批一次性到达”，优先检查 `proxy_buffering` 与 CDN 缓存；如果连接在 60s 左右断开，检查 `proxy_read_timeout`。


## 4. 客户端流式渲染优化

流式渲染卡顿的根因是"每个 SSE chunk 都触发一次 React 重渲染"。`useChat` 内部已经做了状态合并，前端不需要再写节流器；剩下的两个成熟手段是：

1. **`useDeferredValue`**（React 18+）：让长文本的 Markdown 渲染以低优先级进行，不阻塞输入框。
2. **`@tanstack/react-virtual`**：1000+ 消息时只渲染可视区域，避免 DOM 节点爆炸。

```tsx
// apps/web/src/components/chat/StreamingText.tsx —— React 内置能力
'use client';

import { useDeferredValue } from 'react';
import ReactMarkdown from 'react-markdown';

export function StreamingText({ text }: { text: string }) {
  const deferred = useDeferredValue(text); // 低优先级渲染，避免阻塞输入
  return <ReactMarkdown>{deferred}</ReactMarkdown>;
}
```

🔗 **工程逻辑**：虚拟列表的用法在 01-foundation.md 1.6 节已经给出（`@tanstack/react-virtual`），本文件不重复。流式场景的差异只在"滚动跟随"——只有当用户位于底部时才自动滚动，这个判断逻辑是业务 UI 细节，可以在组件内保留（约 20 行），不属于轮子。

---

## 5. 可观测性：Langfuse

除了延迟指标，流式的**事件级观测**（哪些事件、多大、耗时多少）也用 Langfuse 的 UI 完成，不需要自建调试面板。在开发模式想看原始 SSE 帧时，直接看浏览器 DevTools 的 Network 面板——`Content-Type: text/event-stream` 的响应里就是 `data:` 分块。

如果需要将 Langfuse 的 trace 关联到业务会话，在 `createTrace` 时带上 `sessionId` 即可：

```typescript
// packages/core/src/streaming/trace.ts —— 业务 trace 关联
import { langfuse } from './observability';

export function createAgentTrace(sessionId: string, input: string) {
  return langfuse.trace({
    name: 'agent-run',
    sessionId,
    input,
  });
}
```

---

## 6. AI 避坑

### 6.1 SSE 流被反向代理缓冲

**问题**：Nginx / Cloudflare 默认缓冲整个响应，SSE chunk 不是实时到达，而是攒满 4KB 或 1 秒才推。

**解决**：Nginx 设置 `proxy_buffering off` + `X-Accel-Buffering: no` header（见第 3 节模板）；Cloudflare 关闭 "Rocket Loader" 和 "Auto Minify"。

### 6.2 首 token 延迟过高是 prompt 太长

**问题**：TTFT = 3000ms+，排查半天发现是 10 条 RAG 文档（每条 500 token）被注入 system prompt，模型要先计算 5000 token 的 KV Cache 才能输出第一个 token。

**解决**：
1. 控制 RAG 注入总量（建议 < 2000 token）。
2. 使用 prompt 缓存减少重复 system prompt 的计算。
3. 只注入最相关的 3-5 条文档。

### 6.3 客户端 useEffect 依赖流式文本导致过度渲染

**问题**：`useEffect(() => {...}, [streamingContent])` 中 `streamingContent` 每秒变化 20-50 次，每次都触发 effect，导致内存泄漏 + UI 卡顿。

**解决**：用 `useDeferredValue` 降低流式内容的渲染优先级，或把渲染交给 `useChat` 的状态合并（见第 4 节）。

### 6.4 断流后静默失败

**问题**：网络断开后没有任何提示，用户看到"AI 说了一半就不说了"。

**解决**：用 `useChat` 的 `status` 显示连接状态，断线时展示"连接中断，点击重连"按钮（`reconnect()`），而不是静默失败。

---

## 7. 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：运行 `pnpm typecheck`，确认 `packages/core/src/streaming/*.ts` 与 `apps/web/src/components/chat/StreamingText.tsx` 全部 0 错误。
- [ ] **计时器**：用 mock 时间序列（首 token 300ms、后续每 50ms）调用 `streamWithLatency`，断言 `diagnoseLatency` 返回 `warning`，且 `ttft/tpot/e2e` 与预期误差小于 1ms。
- [ ] **重连**：模拟断网，断言 `useChat` 的 `status` 变为 `error`，调用 `reconnect()` 后同一会话恢复、消息不重复。
- [ ] **代理回归**：用 `curl -N --no-buffer https://agent.example.com/api/chat` 验证响应头含 `Content-Type: text/event-stream` 与 `X-Accel-Buffering: no`，chunk 到达间隔小于 1s。
- [ ] **渲染**：1000 条消息滚动不卡顿；流式长文本输入框不阻塞；断流时出现重连按钮。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 标记与本层验收清单。

---


## 8. Langfuse 延迟指标与告警

### 8.1 自动埋点：`experimental_telemetry`

`streamText` 支持 OTel 遥测（`experimental_telemetry`），Langfuse 通过 OpenTelemetry 自动采集输入、输出、耗时与 token 用量——**不需要在业务代码里手动创建 span**：

```typescript
// apps/web/src/app/api/chat-langfuse/route.ts —— OTel 遥测接入 Langfuse
import { streamText } from 'ai';
import { createModel } from '@agentcore/core/llm';
import type { UIMessage } from 'ai';

export async function POST(req: Request) {
  const { messages, tenantId } = (await req.json()) as { messages: UIMessage[]; tenantId?: string };

  const result = streamText({
    model: createModel('openai', process.env),
    messages,
    experimental_telemetry: {
      isEnabled: true,
      functionId: 'chat-stream',
      recordInputs: true,
      recordOutputs: true,
      metadata: {
        tenantId: tenantId ?? 'anonymous',
        feature: 'streaming-chat',
      },
    },
  });

  return result.toDataStreamResponse();
}
```

配置项说明：

- `isEnabled: true`：开启 OTel 导出（默认关闭，避免无谓开销）。
- `functionId`：Langfuse 中显示的“功能名”，用于按功能聚合延迟。
- `recordInputs / recordOutputs`：记录完整 prompt 与输出；敏感环境可关。
- `metadata`：透传业务字段（租户、渠道），Langfuse 侧按这些字段筛选与告警。

`metadata.tenantId` 字段与 [19-multi-tenancy](./19-multi-tenancy.md) 的租户上下文打通后，可以按租户维度分析“是不是某个大客户拖慢了整体延迟”。

### 8.2 手动观测：generation + flushAsync

需要自定义时序（例如把 TTFT 拆出来单独上报）时，用 `langfuse.generation` 手动包裹一次流式调用：

```typescript
// packages/core/src/streaming/langfuse-latency.ts —— 手动观测生成耗时
import { langfuse } from './observability';
import { streamText } from 'ai';
import type { LanguageModel, UIMessage } from 'ai';

export async function streamWithLangfuseSpan(
  model: LanguageModel,
  messages: UIMessage[],
  traceId: string,
): Promise<string> {
  const generation = langfuse.generation({
    name: 'llm-stream',
    model: 'unknown',
    input: messages,
    startTime: new Date(),
  });

  const result = streamText({ model, messages });
  const chunks: string[] = [];
  for await (const chunk of result.textStream) {
    chunks.push(chunk);
  }

  generation.update({
    output: chunks.join(''),
    endTime: new Date(),
    usage: result.usage,
  });
  await langfuse.flushAsync();
  void traceId;
  return chunks.join('');
}
```

> 说明：`langfuse` 实例来自 1.2 节的 `observability.ts`。`generation` 是 Langfuse 的“LLM 生成”观测类型，`update` 补上结束时间与用量后 `flushAsync` 确保落盘。

### 8.3 延迟告警阈值

Langfuse 支持基于 trace 耗时/成本的自定义告警。建议从以下阈值起步，再按业务收紧：

| 指标 | warning 阈值 | critical 阈值 | 告警对象 |
|------|-------------|--------------|---------|
| TTFT p95 | 1000ms | 3000ms | 模型、prompt 长度、代理缓冲 |
| TPOT p95 | 50ms/token | 100ms/token | 模型推理、量化、GPU 带宽 |
| E2E p95 | 30s | 60s | 输出长度、工具链延迟 |
| 每会话错误率 | 1% | 5% | 重连、5xx、超时 |

告警触发后的排查顺序遵循 1.3 调优清单：先查 prompt 缓存命中 → 再查代理缓冲 → 最后查模型冷启动。

## 9. 淘汰：手写 SSE 拼接

**本仓库禁止手写 SSE 拼接**。`data: ${JSON.stringify(...)}` 的“简易流”会丢掉 AI SDK 数据流协议的所有能力：工具调用帧、`data` 通道、错误帧、取消语义、`finish` 用量——任何一帧缺了，`useChat` 的 `status` 与 `messages` 就会错乱。

```typescript
// ❌ 禁止：手写 SSE 拼接（历史反例，仅供排障识别，不得复制）
interface LegacyResponseLike {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  write(chunk: string): void;
}

function legacySseResponse(res: LegacyResponseLike) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  return (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
}
```

**为什么必须淘汰**：

1. **协议漂移**：`useChat` 期望的是数字前缀帧（见 2.1），`data:` 文本无法驱动工具调用状态与 `finish` 事件。
2. **无取消/错误语义**：手写方案没有 `abort` 帧、没有错误帧类型，前端只能靠“流意外结束”猜测状态。
3. **无用量数据**：`finish` 帧携带 `inputTokens/outputTokens`，手写拼接拿不到，成本统计与限流（[19](./19-multi-tenancy.md)）都受影响。
4. **契约违规**：`grep -rn "text/event-stream" references/` 只允许出现在“如何接入 SDK”的说明中（见 [00-types.md](./00-types.md) 契约第 7 条）。

**正确出口只有一个**：路由层调用 `result.toDataStreamResponse()`。前端永远使用 `ai/react` 的 `useChat`，两侧都不要再碰 `EventSource` 解析。

🤖 **AI 常见错误**：为了“兼容老客户端”在 `toDataStreamResponse` 之外另写一个 `data:` 通道。正确做法是让老客户端升级到 `useChat`，或通过 `mergeIntoDataStream` 在标准数据流里加自定义 `data` 帧——而不是开第二条流。

## 10. 产品级延迟预算（SLO）

延迟指标必须落地成可考核的 SLO，否则调优无法收敛。以下是三种常见产品形态的参考预算：

| 产品形态 | TTFT p95 | TPOT p95 | E2E p95 | 说明 |
|---------|----------|----------|---------|------|
| 对话式 Chat | 800ms | 30ms | 20s | 文本为主，长输出允许放宽 E2E |
| 语音/实时助手 | 300ms | 15ms | 5s | 需要更快的首 token 与输出节奏 |
| 深度分析 Agent | 1500ms | 60ms | 120s | 多步工具调用，E2E 由任务决定 |

**落地方式**：

1. 用 8.1 的 `experimental_telemetry` 把延迟指标全部进 Langfuse。
2. 在 Langfuse 配置 p95 告警，阈值取上表。
3. 在 CI 里用 mock 数据跑 1.1 节的 `streamWithLatency`，防止回归（见 7 节验收）。
4. 每次模型升级/提示词变更后重跑基准，记录 TTFT/TPOT 漂移。

## 11. AI 避坑追加

> 🤖 **AI 常见错误**：

> 1. **对 `textStream` 做二次节流** — 以为“每帧渲染一次太卡”，在 `onChunk` 里做 `setTimeout` 合并。`useChat` 内部已做状态合并，前端 `useDeferredValue` 负责渲染优先级（见第 4 节）。**检查方式**：`grep -rn "setTimeout" apps/web/src/components/chat/` 不应出现流式节流逻辑。

> 2. **在 Nginx 开启 `gzip on` 且未排除 `/api/chat`** — gzip 需要攒包，把实时流变成 4KB 一跳。**检查方式**：`location /api/chat` 内必须 `gzip off`。

> 3. **把 `data` 通道当数据库用** — 在 `mergeIntoDataStream` 里塞大体积 JSON（如整段 RAG 文档）。`data` 通道每帧都会随流下发，大载荷拉高 TTFT 且无法检索。**正确做法**：只下发轻量事件（进度、工具名、引用 ID），全文走常规消息。

> 4. **忽略 `finish` 帧的 `usage`** — 在客户端重新统计 token，或依赖模型返回的 usage 字符串。`finish` 帧的 `usage` 就是计费与配额（[19](./19-multi-tenancy.md)）的输入，直接透传即可。

> 5. **`reconnect()` 后消息重复** — 如果路由层把 `UIMessage.id` 当作“需要去重”的键而丢弃重放请求，反而会丢失最后的用户消息。`useChat` 重发的是同一批消息，服务端应**原样处理**，不做去重。

## 12. 本层验收清单（追加）

- [ ] **数据流协议**：用 `curl -N` 请求 `/api/chat`，确认响应帧以数字前缀开头（`0:`/`8:`），且不存在手写 `data:` 拼接。
- [ ] **取消语义**：调用 `stop()` 后，服务端收到 abort，`streamText` 正常结束而非悬挂。
- [ ] **边缘代理**：在 Cloudflare/Vercel Edge 环境复跑 3.2 节路由，`Content-Type` 为 `text/event-stream`，`Cache-Control` 为 `no-cache`。
- [ ] **Langfuse 指标**：开启 `experimental_telemetry` 后，Langfuse 中出现 `chat-stream` 功能名，且包含 `ttft` 相关 span 与 token 用量。
- [ ] **SLO 告警**：Langfuse 中配置 TTFT/TPOT/E2E 三组告警，阈值不低于 8.3 表。
- [ ] **门禁回归**：`node tools/check-skill.mjs` 本文件 0 失败；`grep -rn "text/event-stream" references/17-streaming-advanced.md` 只命中接入说明与淘汰说明。


---

> **与后续节点的衔接**：本文件的计时封装 `streamWithLatency` 可被 08（Eval & Observability）接入 Langfuse / promptfoo 的测试集；Nginx 配置模板与 09（Deploy）的部署清单合并；`useChat` 重连是前端通用能力，05/06 的 HITL 与多 Agent 界面直接复用。所有代码中的 `llm` 类型仍遵循 00 契约（`LanguageModel`），不引入自定义流式协议抽象。
