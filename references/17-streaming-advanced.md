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

> **与后续节点的衔接**：本文件的计时封装 `streamWithLatency` 可被 08（Eval & Observability）接入 Langfuse / promptfoo 的测试集；Nginx 配置模板与 09（Deploy）的部署清单合并；`useChat` 重连是前端通用能力，05/06 的 HITL 与多 Agent 界面直接复用。所有代码中的 `llm` 类型仍遵循 00 契约（`LanguageModel`），不引入自定义流式协议抽象。
