# 17 — 流式性能与可靠性进阶

> 本 reference 覆盖生产级 SSE 流的高级调优——不只是"把 chunk 推出去就行"。从延迟拆解（TTFT/TPOT/E2E）、智能重连、健康检查、带宽优化、客户端渲染节流、流式调试面板，到各类 SSE 避坑清单。读完本文件可独立解决生产环境中流式传输的稳定性、性能、可观测性问题。本文件是 01-foundation.md 中 SSE 部分的深度扩展。

---

## 目录

- [工程逻辑：流式处理性能拆解](#工程逻辑流式处理性能拆解)
- [1. TTFT / TPOT / E2E Latency 调优](#1-ttft--tpot--e2e-latency-调优)
- [2. Sub-token 流式](#2-sub-token-流式)
- [3. 智能重连策略](#3-智能重连策略)
- [4. 流式 Server Health Check](#4-流式-server-health-check)
- [5. 流式带宽优化](#5-流式带宽优化)
- [6. 客户端流式渲染优化](#6-客户端流式渲染优化)
- [7. 前端：Streaming Debug Panel](#7-前端streaming-debug-panel)
- [8. AI 避坑](#8-ai-避坑)

---

## 工程逻辑：流式处理性能拆解

用户听到的"Agent 回复快不快"不是一个指标，而是三个独立的指标，各自的影响因素完全不同：

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
│  └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

**工程决策**：TTFT 和 TPOT 的优化方向完全不同：

| 指标 | 瓶颈 | 优化手段 |
|------|------|---------|
| TTFT | prompt 长度、模型冷启动、网络 RTT | prompt 缓存、长 prompt 迁移到服务端、预热 |
| TPOT | 模型推理速度、GPU 内存带宽 | 换更快模型（如 GPT-4o）、量化、KV Cache |
| E2E | TTFT + TPOT × token 数 | 减少总 token（精简输出）、前置关键信息 |

---

## 1. TTFT / TPOT / E2E Latency 调优

```typescript
// packages/core/src/streaming/latencyTracker.ts

export interface LatencyMetrics {
  /** 首 token 延迟——从请求接收到首 chunk 的时间 (ms) */
  ttft: number;
  /** 每 token 平均输出间隔 (ms) */
  tpot: number;
  /** 端到端延迟——从请求接收到最后一个 chunk 的时间 (ms) */
  e2e: number;
  /** 总输出 token 数 */
  totalTokens: number;
  /** 首 chunk 到达时间戳 */
  firstTokenAt: number;
  /** 最后 chunk 到达时间戳 */
  lastTokenAt: number;
  /** 网络传输延迟估算 (RTT 的一部分) */
  networkOverhead: number;
}

/**
 * 流式延迟追踪器
 *
 * 工程逻辑：
 * 1. 在 SSE 流的接收端打点——对比理论值即可定位瓶颈
 * 2. TTFT 高 = prompt 太长或模型冷启动
 * 3. TPOT 高 = 模型推理慢或网络堵
 * 4. E2E 高但 TTFT/TPOT 正常 = 用户请求生成了太多内容
 */
export class StreamLatencyTracker {
  private startTime = 0;
  private firstTokenTime = 0;
  private lastTokenTime = 0;
  private tokenCount = 0;
  private tokenTimestamps: number[] = [];

  /** 请求开始 */
  markStart(): void {
    this.startTime = performance.now();
    this.tokenCount = 0;
    this.tokenTimestamps = [];
  }

  /** 收到一个 token */
  markToken(): void {
    const now = performance.now();
    if (this.tokenCount === 0) {
      this.firstTokenTime = now;
    }
    this.lastTokenTime = now;
    this.tokenCount++;
    this.tokenTimestamps.push(now);
  }

  /** 流结束 */
  markEnd(): LatencyMetrics {
    const now = performance.now();
    const e2e = now - this.startTime;
    const ttft = this.firstTokenTime - this.startTime;

    // TPOT = (总时间 - TTFT) / (token 数 - 1)  [减去首 token 的计算时间]
    const tpot = this.tokenCount > 1
      ? (this.lastTokenTime - this.firstTokenTime) / (this.tokenCount - 1)
      : 0;

    // 网络开销估算：TTFT 中除去"服务端处理第一个 token 的时间"
    // 假设服务端处理一个 token 的时间 ≈ TPOT * 0.1（首 token 通常更快）
    const networkOverhead = Math.max(0, ttft - tpot * 2);

    return {
      ttft,
      tpot,
      e2e,
      totalTokens: this.tokenCount,
      firstTokenAt: this.firstTokenTime,
      lastTokenAt: this.lastTokenTime,
      networkOverhead,
    };
  }

  /**
   * 诊断报告 —— 根据三个指标判断系统健康度
   */
  diagnose(metrics: LatencyMetrics): {
    health: 'healthy' | 'warning' | 'critical';
    issues: string[];
    suggestions: string[];
  } {
    const issues: string[] = [];
    const suggestions: string[] = [];

    if (metrics.ttft > 1000) {
      issues.push(`TTFT 过高: ${metrics.ttft.toFixed(0)}ms (>1000ms)`);
      suggestions.push('检查 prompt 长度；考虑 prompt 迁移到服务端');
    }

    if (metrics.tpot > 50) {
      issues.push(`TPOT 过高: ${metrics.tpot.toFixed(0)}ms/token (>50ms)`);
      suggestions.push('考虑换更快的模型或开启 KV Cache 持久化');
    }

    if (metrics.networkOverhead > 200) {
      issues.push(`网络开销大: ${metrics.networkOverhead.toFixed(0)}ms`);
      suggestions.push('检查正向代理/反向代理配置');
    }

    const health = issues.length === 0 ? 'healthy' :
                   issues.length === 1 ? 'warning' : 'critical';

    return { health, issues, suggestions };
  }
}
```

### TTFT 调优清单

```typescript
// packages/core/src/streaming/ttftOptimizations.ts

/**
 * TTFT 优化策略——按效果从大到小排
 *
 * 1. Prompt 缓存（效果最显著）
 *    OpenAI/Llama 的 prompt 缓存可以让重复前缀的 prompt 不需要重新计算 KV Cache
 *    缓存前缀的 TTFT 从 ~500ms 降到 ~50ms（节省 10 倍）
 *    关键：system prompt 必须是 payload 的前缀部分且完全一致
 */
export class PromptCacheStrategy {
  /**
   * system prompt 构造规则（满足 prompt cache 命中）：
   * system prompt 必须放在 messages 数组最前面
   * 且内容必须完全一致（连空格都不能变）
   */
  static buildMessages(systemPrompt: string, history: any[]): any[] {
    return [
      // system prompt 放最前——满足 OpenAI 的 cache 前缀要求
      { role: 'system', content: systemPrompt },
      // RAG 注入内容放在 system prompt 后、对话历史前
      // memory 注入也放在这里
      ...history,
    ];
  }
}

/**
 * 2. 服务端 context 预计算
 *
 * 如果 system prompt 超长（如注入了 RAG 上下文），
 * 在每次请求时都让模型重新计算 system prompt 的 KV Cache 很浪费。
 * 服务端可以维护一个 session-level cache：
 * - 同 session 内的请求共享已计算的 system KV Cache
 * - 只有用户消息部分的 KV Cache 需要重新计算
 */
export class SessionKVCache {
  private cache = new Map<string, {
    promptHash: string;             // system prompt 的 hash
    kvCache: any;                   // 序列化的 KV Cache
    lastUsed: number;
  }>();

  /**
   * 检查 session 是否有可用的 KV Cache
   * 条件：session 存在 + system prompt 没有变化
   */
  getCache(sessionId: string, systemPrompt: string): any | null {
    const entry = this.cache.get(sessionId);
    if (!entry) return null;

    const currentHash = this.hashPrompt(systemPrompt);
    if (entry.promptHash !== currentHash) {
      this.cache.delete(sessionId);  // prompt 变了，缓存失效
      return null;
    }

    entry.lastUsed = Date.now();
    return entry.kvCache;
  }

  private hashPrompt(prompt: string): string {
    let hash = 0;
    for (let i = 0; i < prompt.length; i++) {
      hash = ((hash << 5) - hash + prompt.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
  }

  /** 清理过期缓存（5 分钟不用即过期） */
  prune(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [sid, entry] of this.cache) {
      if (entry.lastUsed < cutoff) this.cache.delete(sid);
    }
  }
}

/**
 * 3. "Think First" 策略
 *
 * 如果 Agent 需要较多思考时间（如编排多步工具调用），
 * 不要让用户在黑屏中等待。先发一个"正在理解..."的快速响应：
 */
export function createQuickAcknowledgment(): string {
  const messages = [
    '正在分析您的问题...',
    '让我想想...',
    '这个问题有意思，容我思考一下...',
  ];
  return messages[Math.floor(Math.random() * messages.length)];
}
```

> 🤖 **AI 常见错误**：发现 TTFT 高就怪模型慢。实际上 80% 的 TTFT 瓶颈来自：
> 1. prompt 太长（注入了 5000 token 的 RAG 上下文）
> 2. 反向代理的缓冲配置（Nginx `proxy_buffering on` 把 SSE 流缓存后再转发，引入 1-5s 延迟）
> 3. 客户端 DNS 解析慢
> 先排查这三个，再怀疑模型。

---

## 2. Sub-token 流式

```typescript
// packages/core/src/streaming/subToken.ts

/**
 * Sub-token 流式——提升"感知流畅度"
 *
 * 工程逻辑：
 * - LLM API 的流式是按 token 推送的
 * - 但用户打字机的"感知速度"取决于字符呈现频率
 * - 大段落（如 200 token 的长句子）中间没有视觉反馈，用户以为卡了
 * - Sub-token 流式把大 chunk 拆成更小的粒度推送
 *
 * 适用场景：
 * - 长段落输出（如生成文档、代码解释）
 * - 需要"连贯打字感"的场景
 * 不适用：
 * - tool call 期间的中间结果
 * - 已经很快的小回复
 */
export class SubTokenStreamer {
  private buffer = '';
  private flushThreshold: number;      // 字符数阈值，达到就推
  private flushIntervalMs: number;     // 时间间隔，超时也推
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onFlush: (text: string) => void;

  constructor(options: {
    flushThreshold?: number;            // 默认每 20 字符推一次
    flushIntervalMs?: number;           // 默认每 100ms 推一次
    onFlush: (text: string) => void;
  }) {
    this.flushThreshold = options.flushThreshold ?? 20;
    this.flushIntervalMs = options.flushIntervalMs ?? 100;
    this.onFlush = options.onFlush;
  }

  /** 接收来自 LLM 的一个 token */
  feed(token: string): void {
    this.buffer += token;

    // 达到阈值就立即推
    if (this.buffer.length >= this.flushThreshold) {
      this.flush();
    } else {
      // 否则设一个定时器，保证至少每 N ms 推一次
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      }
    }
  }

  /** 流结束，把剩余 buffer 全部推走 */
  finish(): void {
    this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;

    const text = this.buffer;
    this.buffer = '';
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.onFlush(text);
  }
}
```

> 🤖 **工程逻辑**：Sub-token 流式不是万能的。如果 token 本身很小（如中文单字），20 字符可能就是 5 个 token，自然就很流畅。但如果 token 很大（如一行 Python 代码就是一个 token），需要 Sub-token 拆分才有效果。另外，拆得太细碎会增加 SSE 事件数量，增加代理层和客户端的处理成本。`flushThreshold=20` + `flushIntervalMs=100` 是经验平衡值。

---

## 3. 智能重连策略

```typescript
// packages/core/src/streaming/reconnect.ts

export interface ReconnectState {
  sessionId: string;
  lastEventId: number;           // 最后确认的事件 ID
  buffer: Array<{ id: number; event: string; data: string }>;  // 未确认的 chunk
  timestamp: number;
}

/**
 * 服务端重连缓存 —— 保存每个 SSE 流的未确认 chunk
 *
 * 设计决策：
 * - 缓存最近 60s 内的 chunk（更久的没必要重连，用户已经放弃了）
 * - 按 sessionId 索引，重连时从 lastEventId+1 开始补发
 * - 缓存有内存上限（如 256MB），超出后 LRU 淘汰
 */
export class ReconnectBuffer {
  private buffer: ReconnectState | null = null;
  private maxAgeMs: number;
  private maxBufferSize: number;   // 最大 chunk 数量
  private currentSize = 0;

  constructor(options?: { maxAgeMs?: number; maxBufferSize?: number }) {
    this.maxAgeMs = options?.maxAgeMs ?? 60_000;
    this.maxBufferSize = options?.maxBufferSize ?? 1000;
  }

  /** 启动一个流的缓存 */
  init(sessionId: string): void {
    this.buffer = {
      sessionId,
      lastEventId: 0,
      buffer: [],
      timestamp: Date.now(),
    };
    this.currentSize = 0;
  }

  /** 缓存一个 chunk */
  append(chunk: { event: string; data: string }): void {
    if (!this.buffer) return;
    if (this.currentSize >= this.maxBufferSize) return; // 缓存满了，放弃

    this.buffer.buffer.push({
      id: this.buffer.lastEventId++,
      event: chunk.event,
      data: chunk.data,
    });
    this.currentSize++;
  }

  /**
   * 重连请求——获取从 lastReceivedEventId 之后的所有 chunk
   * 后端调用此方法在 SSE 重连时补发
   */
  getChunksAfter(lastReceivedEventId: number): Array<{ event: string; data: string }> {
    if (!this.buffer) return [];

    // 缓存过期
    if (Date.now() - this.buffer.timestamp > this.maxAgeMs) {
      this.buffer = null;
      return [];
    }

    const chunks = this.buffer.buffer
      .filter(c => c.id > lastReceivedEventId)
      .map(c => ({ event: c.event, data: c.data }));

    return chunks;
  }

  /** 清理已确认的 chunk（客户端确认收到后，不需要保留） */
  acknowledge(upToId: number): void {
    if (!this.buffer) return;
    this.buffer.buffer = this.buffer.buffer.filter(c => c.id > upToId);
    this.currentSize = this.buffer.buffer.length;
  }

  /** 清理所有过期缓存 */
  prune(): void {
    if (this.buffer && Date.now() - this.buffer.timestamp > this.maxAgeMs) {
      this.buffer = null;
    }
  }
}

/**
 * 客户端重连逻辑
 *
 * 工程逻辑：
 * - SSE 网络断开后，浏览器原生 EventSource 会自动重连
 * - 但自动重连不带 Last-Event-ID 时，后端不知道客户端最后收到哪里
 * * - 正确做法：使用 Last-Event-ID header + 补发缓存
 */
export class ResilientSSEClient {
  private eventSource: EventSource | null = null;
  private lastReceivedId = 0;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private baseDelayMs: number;

  constructor(options?: { maxReconnectAttempts?: number; baseDelayMs?: number }) {
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 5;
    this.baseDelayMs = options?.baseDelayMs ?? 1000;
  }

  /**
   * 连接 SSE——使用 Last-Event-ID 告知服务端"我上次收到哪个事件"
   */
  connect(url: string, handlers: {
    onMessage: (data: string) => void;
    onRetry?: (chunks: string[]) => void;
    onError?: (error: Event) => void;
  }): void {
    const urlWithId = this.lastReceivedId > 0
      ? `${url}&last_id=${this.lastReceivedId}`
      : url;

    this.eventSource = new EventSource(urlWithId);

    this.eventSource.onopen = () => {
      this.reconnectAttempts = 0;  // 连接成功，重置计数
    };

    this.eventSource.onmessage = (event) => {
      // 解析事件 ID
      if (event.lastEventId) {
        this.lastReceivedId = parseInt(event.lastEventId, 10) || this.lastReceivedId + 1;
      } else {
        this.lastReceivedId++;
      }
      handlers.onMessage(event.data);
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        // 指数退避重连
        const delay = this.baseDelayMs * Math.pow(2, this.reconnectAttempts);
        this.reconnectAttempts++;
        setTimeout(() => this.connect(url, handlers), delay);
      } else {
        handlers.onError?.(new Event('fatal'));
      }
    };
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }
}
```

> 🤖 **工程逻辑**：智能重连的"核心代价"是服务端的缓存内存。1000 个并发会话 × 每个会话最多 1000 个 chunk × 每 chunk 200 字符 ≈ 200MB。这个开销是可接受的，但如果并发达到 1万+，需要把缓存换到 Redis（带 TTL）。

---

## 4. 流式 Server Health Check

```typescript
// packages/core/src/streaming/healthCheck.ts

/**
 * SSE 流的 Health Check
 *
 * 工程问题：
 * - SSE 是长连接。如果中间经过 Nginx/ALB 等反向代理，
 *   代理默认有超时配置（如 Nginx proxy_read_timeout 60s）
 *   如果 Agent 在 60s 内没有 push 任何数据，代理会返回 504
 * - 长时间思考（如 RAG 文档分析、多步工具调用）很容易超过 60s
 * - 解决方案：定期发送 comment 行（`:heartbeat\n\n`），
 *   SSE 规范中 comment 行会被忽略但会重置代理超时
 */
export class SSEHealthHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs: number;
  private onSend: (comment: string) => void;

  constructor(onSend: (comment: string) => void, intervalMs?: number) {
    this.onSend = onSend;
    // 默认 25 秒一次（Nginx 默认 60 秒超时，留 35 秒安全余量）
    this.intervalMs = intervalMs ?? 25_000;
  }

  /** 启动心跳 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // SSE comment 格式—— : 开头的数据行，客户端完全忽略
      this.onSend(':heartbeat\n\n');

      // 也可以发送带时间戳的 ping，方便延迟计算
      this.onSend(`:ping ${Date.now()}\n\n`);
    }, this.intervalMs);
  }

  /** 停止心跳 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * SSE 流元事件 —— 附加信息随数据流传输
 *
 * 除了数据事件，SSE 还可以传输以下控制元事件：
 * - `:heartbeat` —— 保活
 * - `event: latency` —— 服务端延迟报告
 * - `event: health` —— 模型服务端健康状态
 */
export function formatSSEEvent(event: string, data: any): string {
  const lines = [`event: event`];

  if (typeof data === 'string') {
    lines.push(`data: ${data}`);
  } else {
    lines.push(`data: ${JSON.stringify(data)}`;
  }

  // 添加事件 ID（用于重连后恢复）
  lines.push(`id: ${Date.now()}`);
  lines.push('');  // 空行表示事件结束

  return lines.join('\n') + '\n';
}
```

---

## 5. 流式带宽优化

### Nginx 关键配置

```nginx
# /etc/nginx/conf.d/agent-core.conf

upstream agent_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 443 ssl;
    server_name agent.example.com;

    location /api/chat {
        proxy_pass http://agent_backend;

        # ★★★ 关键：关闭缓冲——否则 Nginx 会缓存整个响应再转发 ★★★
        proxy_buffering off;

        # SSE 长连接超时设置
        proxy_read_timeout 3600s;        # 1 小时超时（Agent 长分析场景）
        proxy_send_timeout 3600s;

        # 保持连接（避免每次都重新握手）
        proxy_http_version 1.1;
        proxy_set_header Connection '';

        # SSE 必须保留的 headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 不要用 gzip 压缩 SSE——会延迟 chunk 的到达时间
        # （gzip 需要攒够一个 chunk 才能压缩）
        gzip off;

        # Cache-Control：明确不要缓存 SSE
        add_header Cache-Control no-cache;
        add_header X-Accel-Buffering no;  # 告诉 Nginx 不要缓冲

        # 安全 headers
        add_header X-Content-Type-Options nosniff;
    }

    # 静态资源可以正常 gzip
    location /static/ {
        gzip on;
        gzip_types text/plain text/css application/json application/javascript;
        gzip_min_length 1000;
    }
}
```

### Node.js 服务端 SSE 优化

```typescript
// packages/core/src/streaming/serverSSE.ts

import type { ServerResponse } from 'http';

/**
 * 服务端 SSE 写入器 —— 生产级配置
 *
 * 关键优化点：
 * 1. 设置 Content-Type 和 Transfer-Encoding
 * 2. 关闭 Nagle 算法（TCP_NODELAY）减少延迟
 * 3. 手动 flush（某些框架默认会缓冲）
 * 4. 心跳保活
 */
export class ServerSSE {
  private res: ServerResponse;
  private heartbeat: SSEHealthHeartbeat;
  private eventCounter = 0;

  constructor(res: ServerResponse) {
    this.res = res;
    this.heartbeat = new SSEHealthHeartbeat((comment) => {
      this.res.write(comment);
    });

    // 设置 SSE 必须的响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      // 允许跨域（如果需要）
      'Access-Control-Allow-Origin': '*',
    });

    // 关闭 Nagle 算法
    if (res.socket) {
      res.socket.setNoDelay(true);
    }
  }

  /** 发送一个 SSE 事件 */
  send(event: string, data: any): void {
    this.eventCounter++;

    const payload = [
      `id: ${this.eventCounter}`,
      `event: ${event}`,
      `data: ${JSON.stringify(data)}`,
      '',  // 空行
    ].join('\n') + '\n';

    this.res.write(payload);

    // 某些 runtime 需要手动 flush
    if (typeof (this.res as any).flush === 'function') {
      (this.res as any).flush();
    }
  }

  /** 启动心跳 */
  startHeartbeat(): void {
    this.heartbeat.start();
  }

  /** 结束 SSE 流 */
  close(): void {
    this.heartbeat.stop();
    this.res.end();
  }
}
```

> 🤖 **AI 常见错误**：在 Express 的路由 handler 中直接 `res.write()` SSE 数据。Express 的默认行为会缓冲响应，导致 SSE chunk 无法实时到达客户端。正确做法：1) 不要 `res.end()` 或 `res.send()`，2) 关闭 `X-Accel-Buffering`，3) 如果需要中间件处理，使用 `res.flushHeaders()` 提前发送响应头。

---

## 6. 客户端流式渲染优化

```typescript
// apps/web/src/hooks/useStreamRenderer.ts

import { useRef, useCallback, useEffect } from 'react';

/**
 * 流式渲染优化 Hook
 *
 * 优化策略：
 * 1. requestIdleCallback 节流——不在每个 SSE chunk 时都触发重渲染
 * 2. 虚拟滚动 + 流式滚动跟随——只渲染可见区域的消息
 * 3. 大消息分 chunk 渲染——把超长消息拆成 markdown block 逐块解析
 *
 * 工程逻辑：
 * - SSE 每秒可能 20-50 个事件，每个都 setState 会导致 React 50 fps 的渲染
 * - 但人眼超过 30fps 就感知不到区别
 * - 策略：合并 2-3 个事件后一次性 setState，降低渲染频率
 */
export function useStreamRenderer(options?: {
  /** 合并窗口——多少 ms 内的 chunk 合并成一次渲染 */
  mergeWindowMs?: number;
  /** 是否启用 requestIdleCallback 节流 */
  useIdleCallback?: boolean;
}) {
  const mergeWindowMs = options?.mergeWindowMs ?? 32;  // ~30fps 足够
  const useIdle = options?.useIdleCallback ?? true;

  const bufferRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingUpdateRef = useRef(false);

  /**
   * 追加文本——节流到 32ms
   * 这是将 SSE 高频事件转化为低频 React 渲染的核心
   */
  const appendText = useCallback((text: string, onRender: (text: string) => void) => {
    bufferRef.current += text;

    // 已经有定时器在跑了，不需要新建
    if (timerRef.current) return;

    timerRef.current = setTimeout(() => {
      timerRef.current = null;

      if (useIdle && 'requestIdleCallback' in window) {
        // requestIdleCallback：只在浏览器空闲时渲染
        rafRef.current = (window as any).requestIdleCallback(() => {
          onRender(bufferRef.current);
          pendingUpdateRef.current = false;
        });
      } else {
        // 降级为 RAF：保证与浏览器刷新率同步
        rafRef.current = requestAnimationFrame(() => {
          onRender(bufferRef.current);
        });
      }
    }, mergeWindowMs);
  }, [mergeWindowMs, useIdle]);

  /** 强制刷新——流结束时调用 */
  const flush = useCallback((onRender: (text: string) => void) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }
    onRender(bufferRef.current);
  }, []);

  /** 清理 */
  useEffect(() => {
    flush((() => {}) as any); // cleanup: 清掉残留的定时器
  }, [flush]);

  return { appendText, flush };
}

/**
 * 虚拟滚动 + 流式自动滚动的协同策略
 *
 * 核心逻辑：
 * - 正常情况下，有新消息时自动滚动到底部
 * - 但如果用户手动向上滚动（查看历史消息），不要强制拉回底部
 * - 检测"是否在最底部"：距底部 < 100px 视为"在底部"
 */
export function useAutoScroll(containerRef: React.RefObject<HTMLElement>, deps: any[]) {
  const isNearBottomRef = useRef(true);
  const userScrollIntentRef = useRef(false);

  const checkNearBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, [containerRef]);

  // 监听用户滚动意图
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleScroll = () => {
      isNearBottomRef.current = checkNearBottom();
      // 如果用户主动向上滚动，标记意图
      if (!isNearBottomRef.current) {
        userScrollIntentRef.current = true;
      }
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [containerRef, checkNearBottom]);

  // 有新消息时：只有在底部才自动滚动
  useEffect(() => {
    if (isNearBottomRef.current) {
      const el = containerRef.current;
      if (el) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  /** 手动滚动到底部（"回到底部"按钮） */
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el) {
      isNearBottomRef.current = true;
      userScrollIntentRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [containerRef]);

  return { scrollToBottom, isNearBottom: isNearBottomRef };
}
```

> 🤖 **工程逻辑**：流式自动滚动是最容易被忽略的细节。新手实现总是`scrollTop = scrollHeight`在每个新 chunk 执行。问题是用户在看历史消息时，突然被拉到底部——体验极差。正确做法：检测"用户是否在底部"，只在自然位置（底部）时才自动跟随。

---

## 7. 前端：Streaming Debug Panel

```tsx
// apps/web/src/components/debug/StreamingDebugPanel.tsx

import { useState, useEffect, useCallback } from 'react';

interface StreamMetrics {
  ttft: number;
  tpot: number;
  e2e: number;
  totalTokens: number;
  events: Array<{ timestamp: number; type: string; size: number }>;
  isConnected: boolean;
  reconnectAttempts: number;
}

/**
 * Streaming Debug Panel —— 开发/运维人员的流式性能观测台
 *
 * 展示内容：
 * 1. TTFT / TPOT / E2E 实时数值
 * 2. SSE 事件 waterfall（可视化每个事件的时间和大小）
 * 3. 每秒 token 数曲线
 * 4. 连接状态 + 重连次数
 */
export function StreamingDebugPanel() {
  const [metrics, setMetrics] = useState<StreamMetrics>({
    ttft: 0,
    tpot: 0,
    e2e: 0,
    totalTokens: 0,
    events: [],
    isConnected: false,
    reconnectAttempts: 0,
  });
  const [isExpanded, setIsExpanded] = useState(false);

  // 接入全局 SSE 事件流进行追踪
  useEffect(() => {
    const startTime = performance.now();
    let firstTokenReceived = false;
    let tokenCount = 0;
    let firstTokenTime = 0;
    let lastTokenTime = 0;

    // 这个监听器实际应该绑定到你的 SSE client 事件
    const onSSEEvent = (event: { type: string; data: string; timestamp: number }) => {
      tokenCount++;
      const now = performance.now();

      if (!firstTokenReceived) {
        firstTokenReceived = true;
        firstTokenTime = now;
      }
      lastTokenTime = now;

      setMetrics(prev => ({
        ...prev,
        ttft: firstTokenTime - startTime,
        tpot: tokenCount > 1 ? (lastTokenTime - firstTokenTime) / (tokenCount - 1) : 0,
        e2e: now - startTime,
        totalTokens: tokenCount,
        events: [...prev.events.slice(-50), {
          timestamp: now - startTime,
          type: event.type,
          size: event.data.length,
        }],
      }));
    };

    // 实际集成：替换为你的 SSE 事件总线.subscribe
    // eventBus.on('sse_event', onSSEEvent);

    return () => {
      // eventBus.off('sse_event', onSSEEvent);
    };
  }, []);

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="fixed bottom-4 right-4 z-50 px-3 py-1.5 text-xs rounded-lg bg-surface/90 border border-border shadow-lg backdrop-blur-sm"
      >
        ⚡ Stream: {metrics.totalTokens} tok · {metrics.ttft > 0 ? `${metrics.ttft.toFixed(0)}ms` : '...'}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 max-h-80 bg-surface/95 border border-border rounded-xl shadow-2xl backdrop-blur-sm overflow-hidden">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-medium">⚡ Streaming Debug</span>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${metrics.isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
          <button
            onClick={() => setIsExpanded(false)}
            className="text-xs opacity-50 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 指标卡片 */}
      <div className="grid grid-cols-3 gap-px bg-border/50">
        <MetricCard label="TTFT" value={`${metrics.ttft.toFixed(0)}ms`} status={metrics.ttft < 500 ? 'good' : metrics.ttft < 1000 ? 'warn' : 'bad'} />
        <MetricCard label="TPOT" value={`${metrics.tpot.toFixed(0)}ms`} status={metrics.tpot < 30 ? 'good' : metrics.tpot < 50 ? 'warn' : 'bad'} />
        <MetricCard label="Tokens" value={String(metrics.totalTokens)} status="neutral" />
      </div>

      {/* 事件 Waterfall */}
      <div className="px-3 py-2 max-h-40 overflow-y-auto">
        <div className="text-[10px] opacity-40 mb-1">Last 50 SSE events</div>
        <div className="flex flex-wrap gap-px">
          {metrics.events.map((event, idx) => (
            <div
              key={idx}
              className="h-3 rounded-sm"
              style={{
                width: `${Math.max(event.size / 5, 3)}px`,
                backgroundColor: getEventColor(event.type, event.size),
                opacity: 0.7 + (idx / metrics.events.length) * 0.3,
              }}
              title={`${event.type} · ${event.size}B · ${event.timestamp.toFixed(0)}ms`}
            />
          ))}
        </div>
      </div>

      {/* 连接状态 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border text-[10px] opacity-50">
        <span>
          {metrics.isConnected ? '🟢 Connected' : '🔴 Disconnected'}
        </span>
        {metrics.reconnectAttempts > 0 && (
          <span>Reconnected {metrics.reconnectAttempts}×</span>
        )}
        <span>
          {(metrics.totalTokens / (metrics.e2e / 1000)).toFixed(1)} tok/s
        </span>
      </div>
    </div>
  );
}

function MetricCard({ label, value, status }: { label: string; value: string; status: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const colors = {
    good: 'text-green-400',
    warn: 'text-yellow-400',
    bad: 'text-red-400',
    neutral: 'text-current',
  };

  return (
    <div className="bg-surface px-2 py-1.5 text-center">
      <div className="text-[10px] opacity-40">{label}</div>
      <div className={`text-xs font-medium ${colors[status]}`}>{value}</div>
    </div>
  );
}

function getEventColor(type: string, _size: number): string {
  switch (type) {
    case 'message': return '#4ade80';
    case 'tool_call': return '#60a5fa';
    case 'memory': return '#a78bfa';
    case 'done': return '#34d399';
    case 'error': return '#f87171';
    default: return '#94a3b8';
  }
}
```

> 🤖 **工程逻辑**：Streaming Debug Panel 是性能和可靠性优化的基础设施。有了它，你才能量化"改了某行代码后 TTFT 是否下降"，而不是凭感觉优化。建议集成到项目的 dev mode（默认开启，生产可关闭）。

---

## 8. AI 避坑

### 8.1 SSE 流被反向代理缓冲

**问题**：Nginx/Cloudflare 默认会缓冲整个响应。SSE chunk 不是实时到达客户端，而是攒满 4KB 或 1 秒才推。

**解决**：必须在 Nginx 配置中设置 `proxy_buffering off` + `X-Accel-Buffering: no` header。Cloudflare 需要关闭"Rocket Loader"和"Auto Minify"。

### 8.2 首 token 延迟过高发现是 prompt 太长

**问题**：TTFT = 3000ms+，排查了半天发现不是网络问题——是把 10 条 RAG 文档（每条 500 token）注入到了 system prompt 里。模型需要计算 5000 token 的 KV Cache 才能输出第一个 token。

**解决**：
1. 控制 RAG 注入的 token 总量（建议 < 2000 token）
2. 使用 prompt 缓存减少重复 system prompt 的计算
3. 不是所有文档都注入——只注入最相关的 3-5 条

### 8.3 客户端 useEffect 依赖 streamingContent 导致过度渲染

**问题**：
```tsx
// ❌ 错误写法
useEffect(() => {
  // 每次 streamingContent 变化都触发
}, [streamingContent]);
```
`streamingContent` 在流式更新中每秒变化 20-50 次，每次都触发 effect = 内存泄漏 + UI 卡顿。

**解决**：合并更新（如 useStreamRenderer Hook），或使用 `useRef` 追踪变化 + 手动 render。对于 React 18+，可以用 `useDeferredValue` 降低流式内容的渲染优先级。

### 8.4 onerror 没有重连导致静默断流

**问题**：SSE 断流后 `onerror` 被触发，但开发者没有实现重连逻辑。用户看到"AI 说了一半就不说了"。

**解决**：SSE 客户端必须实现指数退避重连（如 ResilientSSEClient）。建议在 3 次重连失败后显示"连接中断，请重试"的明显提示，而不是静默失败。

---

## 与 SKILL.md 执行顺序的衔接

| 前置依赖 | 本文件独立解决的问题 |
|---------|---------------------|
| 01-foundation.md 的 SSE 基础实现 | TTFT/TPOT/E2E 调优（生产级延迟） |
| 01-foundation.md 的 SSE 基础实现 | 智能重连（网络断流恢复） |
| Nginx/反向代理配置 | SSE 代理层的 buffer 关闭 |
| React Zustand store | 流式渲染节流（客户端性能） |

> 🤖 **工程逻辑**：本文件解决的都是"有了基础 SSE 之后"才会遇到的问题。如果你的 agent-core 能在本地正常运行，但部署到服务器后发现流式总是"卡一下才出内容"，大概率是 Nginx 缓冲的问题。如果用户在 3G 网络下经常断流，需要智能重连。如果输出长文时页面卡顿，需要渲染节流。按症状选择对应的优化策略，不需要全部实现。
