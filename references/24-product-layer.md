# 24 — 产品化层 · Playground · 多模型路由 · 限流 · Agent-as-a-Service

> 目标：把"能跑的 Agent 代码"变成"用户愿意每天用的产品"。本层覆盖产品化的最后三公里：Playground 交互界面、多模型智能路由、限流与配额治理、Webhook 计费事件，以及 Agent-as-a-Service 的 REST/SSE API。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - 多模型路由 / Fallback / 全局并发上限 → **LiteLLM Proxy**（声明式 `config.yaml` + OpenAI 兼容端点），不要手写 `ModelRouter` / `FallbackExecutor` / token bucket
> - 用户级限流与配额 → **Upstash Ratelimit**（`@upstash/ratelimit` + Redis），不要手写 Lua 脚本
> - Webhook 计费事件 → **Stripe Webhook**（`stripe.webhooks.constructEvent` + 事件 `id` 幂等），不要手写 HMAC 签名中间件
> - Playground UI → `ai/react` 的 `useChat` + **shadcn/ui** 组件，不要手写 SSE 拼接 / AbortController
>
> 本层唯一允许手写的 `[CUSTOM]` 是**业务策略**：路由规则、配额预算、Webhook 事件类型。这些是产品差异点，没有现成替代。

---

## 目录

- [1. Playground Web UI](#1-playground-web-ui)
  - [1.1 useChat 接入](#11-usechat-接入)
  - [1.2 三栏布局与 Compare Mode](#12-三栏布局与-compare-mode)
  - [1.3 Token 与成本显示 [CUSTOM]](#13-token-与成本显示-custom)
- [2. 多模型路由——LiteLLM Proxy](#2-多模型路由litellm-proxy)
  - [2.1 Proxy 配置（声明式）](#21-proxy-配置声明式)
  - [2.2 业务路由规则 [CUSTOM]](#22-业务路由规则-custom)
  - [2.3 应用层只保留 llm 契约](#23-应用层只保留-llm-契约)
- [3. 限流与配额治理——Upstash Ratelimit](#3-限流与配额治理upstash-ratelimit)
  - [3.1 用户级限流](#31-用户级限流)
  - [3.2 配额预算 [CUSTOM]](#32-配额预算-custom)
- [4. Webhook 事件与计费——Stripe](#4-webhook-事件与计费stripe)
  - [4.1 业务事件类型 [CUSTOM]](#41-业务事件类型-custom)
  - [4.2 Stripe Webhook 接入](#42-stripe-webhook-接入)
  - [4.3 幂等与重试](#43-幂等与重试)
- [5. Agent-as-a-Service API](#5-agent-as-a-service-api)
- [6. 本层验收清单](#6-本层验收清单)

---

## 1. Playground Web UI

### 1.1 useChat 接入

🔗 **工程逻辑**：Playground 是产品的主入口，但它不需要任何自定义流式协议。`useChat` 已经处理发送、流式接收、工具调用状态、取消与重连。你只需要做**布局与组件**，而不是传输逻辑。

```tsx
// apps/web/src/app/page.tsx
'use client';

import { useChat } from 'ai/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export default function PlaygroundPage() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, stop } = useChat({
    api: '/api/chat',
    body: { model: 'gpt-4o' }, // 默认模型；实际由 LiteLLM Proxy 路由（见第 2 节）
  });

  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col p-4">
      <div className="flex-1 space-y-4 overflow-y-auto">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <Input value={input} onChange={handleInputChange} placeholder="输入消息…" disabled={isLoading} />
        <Button type="submit" disabled={isLoading}>发送</Button>
        {isLoading && (
          <Button type="button" variant="destructive" onClick={stop}>停止</Button>
        )}
      </form>
    </div>
  );
}
```

🤖 **AI 常见错误**：不要在前端手写 `fetch` + `ReadableStream` + `AbortController` 拼接 SSE。`useChat` 原生消费 `toDataStreamResponse()` 的输出，手写只会引入重连、取消、工具帧解析三类 bug。

消息气泡用 `react-markdown` 渲染流式 Markdown，用 shadcn/ui 的 `Card` 呈现工具调用三态（loading / 成功 / 失败）：

```tsx
// apps/web/src/components/playground/MessageBubble.tsx
'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UIMessage } from 'ai';
import { Card } from '@/components/ui/card';

type ToolPart = Extract<NonNullable<UIMessage['parts']>[number], { type: 'tool-invocation' }>;

export function MessageBubble({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <Card className="bg-primary px-3 py-2 text-primary-foreground">{message.content}</Card>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <Card className="max-w-full px-3 py-2">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        {message.parts
          ?.filter((p): p is ToolPart => p.type === 'tool-invocation')
          .map((p) => (
            <ToolCallCard key={p.toolInvocation.toolCallId} invocation={p.toolInvocation} />
          ))}
      </Card>
    </div>
  );
}
```

### 1.2 三栏布局与 Compare Mode

经典三栏布局（System Prompt | Chat | 参数）用 shadcn/ui 的 `ResizablePanelGroup` / `Card` 拼装即可。**Compare Mode 不是并行流协议**——它是两个独立的 `useChat` 实例，各自拥有自己的连接与取消信号：

```tsx
// apps/web/src/components/playground/CompareView.tsx
'use client';

import { useChat } from 'ai/react';
import { PlaygroundChat } from './PlaygroundChat';

export function CompareView({ models }: { models: [string, string] }) {
  const left = useChat({ api: '/api/chat', body: { model: models[0] } });
  const right = useChat({ api: '/api/chat', body: { model: models[1] } });

  return (
    <div className="grid h-full grid-cols-2 divide-x">
      <PlaygroundChat chat={left} title={models[0]} />
      <PlaygroundChat chat={right} title={models[1]} />
    </div>
  );
}
```

🤖 **AI 常见错误**：Compare Mode 手写"两个 AbortController + 并行 fetch + 手动拼接 token"——一旦一边失败，还要手写错误隔离。`useChat` 的两个实例天然独立，取消/失败互不影响。

### 1.3 Token 与成本显示 [CUSTOM]

> 为什么这里允许手写：**展示哪些指标、按什么颜色警告**是产品 UX 的差异点；但**数字从哪来**不是——不要在前端跑 tokenizer，让服务端把 LiteLLM 返回的 `usage` 透传给前端。

```ts
// packages/core/src/product/cost-display.ts —— 成本展示口径 [CUSTOM]
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function formatCostForTier(usage: Usage, tier: 'free' | 'pro'): string {
  // 免费档只显示 token 数，不显示金额，避免误导；Pro 档显示精确到 $0.0001
  if (tier === 'free') return `${usage.inputTokens + usage.outputTokens} tokens`;
  return `$${usage.costUsd.toFixed(4)}`;
}
```

---

## 2. 多模型路由——LiteLLM Proxy

### 2.1 Proxy 配置（声明式）

🔗 **工程逻辑**：多模型路由、fallback、全局并发上限、成本记录都是**平台能力**，不是业务代码。LiteLLM Proxy 把应用与供应商 SDK 隔离：应用只调 OpenAI 兼容端点，加模型 = 改配置，不是改代码。

```yaml
# 供应商凭证从环境变量读取（见 09-deploy 的密钥管理），LiteLLM 自动识别
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
  - model_name: gpt-4o-mini
    litellm_params:
      model: openai/gpt-4o-mini
  - model_name: claude-sonnet-4
    litellm_params:
      model: anthropic/claude-sonnet-4-20250514

litellm_settings:
  drop_params: true
  num_retries: 2
  request_timeout: 30
  fallbacks:
    - gpt-4o:
        - gpt-4o-mini
        - claude-sonnet-4

router_settings:
  routing_strategy: cost-based-routing
  model_group_alias:
    cheap: gpt-4o-mini
    flagship: gpt-4o

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
  database_url: os.environ/DATABASE_URL   # 成本记录与预算持久化
  max_parallel_requests: 50
```

- `fallbacks`：主模型 429 / 5xx / 超时 → 自动切换，替代手写 `FallbackExecutor`
- `routing_strategy: cost-based-routing`：按成本优先路由
- `max_parallel_requests`：全局并发上限，替代手写分布式信号量
- `database_url`：LiteLLM 把每次调用的 token 与成本写入 Postgres，替代手写 `CostTracker`

🤖 **AI 常见错误**：在应用代码里再包一层"路由抽象"（`LLMProvider` 接口 + `ModelRouter` 类）。LiteLLM Proxy 已经是 OpenAI 兼容端点，`LanguageModel` 直接指向它即可；多包一层只会让类型签名漂移、换模型时两头改。

### 2.2 业务路由规则 [CUSTOM]

路由的**执行**由 LiteLLM 负责，但**哪档用户用哪个模型组、预算多少**是产品策略，保留为 `[CUSTOM]` 配置：

```ts
// packages/core/src/product/routing-policy.ts —— 业务路由规则 [CUSTOM]
// 为什么没有现成替代：套餐定价与体验分级是产品差异点，LiteLLM 只提供执行引擎。
export const ROUTING_POLICY = {
  free: { modelGroup: 'cheap', rpm: 10, dailyBudgetUsd: 1 },
  pro: { modelGroup: 'flagship', rpm: 60, dailyBudgetUsd: 10 },
  enterprise: { modelGroup: 'flagship', rpm: 300, dailyBudgetUsd: 100 },
} as const;

export type Tier = keyof typeof ROUTING_POLICY;
```

`modelGroup` 对应 `config.yaml` 里的 `model_group_alias`。请求时把 `model` 字段设为 `cheap` / `flagship`，LiteLLM Proxy 负责解析成真实模型。

### 2.3 应用层只保留 llm 契约

跨层契约：本 Skill 所有 `llm` 都指 `ai` 的 `LanguageModel`（见 01-foundation 的 `createModel`）。产品化层不引入新的 LLM 抽象——把 `createModel` 的 `baseURL` 指向 LiteLLM Proxy 即可：

```ts
// apps/web/src/app/api/chat/route.ts
import { streamText } from 'ai';
import { createModel } from '@agentcore/core/llm';

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamText({
    model: createModel('openai', process.env), // OPENAI_BASE_URL 指向 LiteLLM Proxy
    messages,
    maxSteps: 10,
  });
  return result.toDataStreamResponse();
}
```

---

## 3. 限流与配额治理——Upstash Ratelimit

### 3.1 用户级限流

🔗 **工程逻辑**：LLM API 的限流针对整个账户，一个用户暴刷会拖垮全租户。必须做**用户级二次限流**。`@upstash/ratelimit` 基于 Redis，支持滑动窗口，是成熟库——不要手写 token bucket / Lua。

```ts
// packages/core/src/rate-limit/index.ts —— 全项目唯一的限流入口
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

export const redis = Redis.fromEnv();

export const userRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '1 m'), // 每用户每分钟 10 次
  prefix: 'agent:ratelimit',
});
```

在 API 路由里使用：

```ts
// apps/web/src/app/api/chat/route.ts（续：限流拦截）
import { NextResponse } from 'next/server';
import { userRatelimit } from '@agentcore/core/rate-limit';

export async function enforceRateLimit(userId: string) {
  const { success, limit, reset, remaining } = await userRatelimit.limit(userId);
  if (!success) {
    return NextResponse.json(
      { error: 'rate_limit', message: `每分钟最多 ${limit} 次请求，请稍后重试。` },
      { status: 429, headers: { 'X-RateLimit-Remaining': String(remaining), 'X-RateLimit-Reset': String(reset) } },
    );
  }
  return null;
}
```

🤖 **AI 常见错误**：手写 Redis + Lua 的 token bucket（窗口计算、原子 INCR、退款逻辑）。`@upstash/ratelimit` 的 `slidingWindow` / `tokenBucket` 已经覆盖这些场景，且天然支持多实例部署；手写版本几乎必然有竞态或窗口边界 bug。

### 3.2 配额预算 [CUSTOM]

> 配额是业务策略：`ROUTING_POLICY` 里的 `rpm` / `dailyBudgetUsd` 是配置，不是代码逻辑。**执行**交给平台：`rpm` 由 Upstash 滑动窗口执行，`dailyBudgetUsd` 硬上限由 LiteLLM 虚拟密钥的 `max_budget` 执行（超过即拒绝，次日自动重置）。

应用层只保留 `[CUSTOM]` 的预算数值与告警阈值：

```ts
// packages/core/src/product/quota.ts —— 预算告警阈值 [CUSTOM]
export const BUDGET_ALERT_RATIO = 0.8; // 使用 80% 时通知管理员
```

---

## 4. Webhook 事件与计费——Stripe

### 4.1 业务事件类型 [CUSTOM]

> 事件类型是产品语义，`[CUSTOM]` 保留；事件的**安全传输、验签、重试**是平台能力：计费事件走 Stripe Webhook（见 4.2），对外投递产品事件（如 `run.completed` 给客户回调）走 **svix**（托管签名、重试、死信），都不手写。

```ts
// packages/core/src/product/webhook-events.ts —— 业务事件类型 [CUSTOM]
export type ProductWebhookEvent =
  | { type: 'run.completed'; runId: string; tenantId: string; costUsd: number }
  | { type: 'run.failed'; runId: string; tenantId: string; error: string }
  | { type: 'guardrail.triggered'; tenantId: string; ruleId: string };
```

### 4.2 Stripe Webhook 接入

计费事件（`invoice.paid` / `invoice.payment_failed`）用 Stripe 官方 SDK 验签——`constructEvent` 完成 HMAC 校验与 payload 解析，**不要手写签名中间件**：

```ts
// apps/web/src/app/api/webhooks/stripe/route.ts
import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { upsertProcessedEvent } from '@agentcore/core/webhook/idempotency';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '');
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature');
  if (!signature) return NextResponse.json({ error: 'missing signature' }, { status: 401 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, endpointSecret);
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  // 幂等：同一 event.id 只处理一次（见 4.3）
  const isNew = await upsertProcessedEvent(event.id, event.type);
  if (!isNew) return NextResponse.json({ received: true, duplicate: true });

  switch (event.type) {
    case 'invoice.paid':
      await upgradeTenantToPro(event.data.object.customer);
      break;
    case 'invoice.payment_failed':
      await downgradeTenant(event.data.object.customer);
      break;
  }

  return NextResponse.json({ received: true });
}
```

### 4.3 幂等与重试

Stripe 会重试投递，事件自带唯一 `id`。幂等 = Postgres 唯一索引 + `INSERT ... ON CONFLICT DO NOTHING`。这是胶水层，不是轮子：

```sql
CREATE TABLE processed_events (
  event_id      TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```ts
// packages/core/src/webhook/idempotency.ts —— 幂等锁（胶水层）
import { sql } from 'drizzle-orm';
import { db } from '@agentcore/core/db';

export async function upsertProcessedEvent(eventId: string, eventType: string): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO processed_events (event_id, event_type)
    VALUES (${eventId}, ${eventType})
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `);
  return result.rows.length > 0; // true = 首次处理
}
```

🤖 **AI 常见错误**：手写 HMAC-SHA256 签名 + 时间戳 + `timingSafeEqual` + 指数退避重试。Stripe Webhook 的 `constructEvent` 已内置验签，投递重试由 Stripe 负责；自定义签名只会增加被绕过的面。

---

## 5. Agent-as-a-Service API

对外 API 与 Playground 共用同一套 `createModel` + LiteLLM Proxy + Upstash 限流。认证与租户隔离来自 19-multi-tenancy（`requireTenant`），不在此层手写：

```ts
// apps/web/src/app/api/runs/route.ts
import { streamText } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { requireTenant } from '@agentcore/core/auth';
import { userRatelimit } from '@agentcore/core/rate-limit';

export async function POST(req: Request) {
  const tenant = await requireTenant(req); // 认证见 19-multi-tenancy
  const { messages, model = 'gpt-4o', stream = false } = await req.json();

  const { success } = await userRatelimit.limit(tenant.userId);
  if (!success) return Response.json({ error: 'rate_limit' }, { status: 429 });

  const result = streamText({
    model: createModel('openai', process.env), // 指向 LiteLLM Proxy
    messages,
    maxSteps: 10,
  });

  if (stream) return result.toDataStreamResponse(); // SSE，useChat 直接消费

  const text = await result.text; // 非流式：等完整输出
  return Response.json({ output: text, tenant: tenant.id });
}
```

🔗 **工程逻辑**：`result.toDataStreamResponse()` 输出的就是标准数据流，`useChat` 与外部 SDK 都能消费——产品 API 与 Playground 共享一条链路，不需要维护两套协议。

---


---

## 1.1 Playground 组件化：useChat + shadcn/ui

Playground 不是手写聊天逻辑，而是把 `useChat` 与 shadcn/ui 组件拼装成产品 UI。

```tsx
// apps/web/src/app/playground/page.tsx —— 组件化 Playground
'use client';
import { useChat } from 'ai/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export default function Playground() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, stop } = useChat({
    api: '/api/chat',
    body: { model: 'router:default' }, // 交给 LiteLLM 路由
  });

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">Playground</h1>
        <Badge variant="secondary">模型：LiteLLM 路由</Badge>
      </div>
      <Card>
        <CardContent className="h-[60vh] space-y-2 overflow-auto">
          {messages.map((m) => <MessageBubble key={m.id} message={m} />)}
        </CardContent>
      </Card>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <Input value={input} onChange={handleInputChange} placeholder="输入消息…" disabled={isLoading} />
        <Button type="submit" disabled={isLoading}>{isLoading ? '生成中' : '发送'}</Button>
        {isLoading && <Button type="button" variant="destructive" onClick={stop}>停止</Button>}
      </form>
    </div>
  );
}
```

🤖 **AI 常见错误**：前端直连 LLM 并携带 API Key——等于把 Key 公开给所有访问者。**所有 LLM 调用必须走后端代理（`/api/chat`），Key 只存在于服务端环境变量**（LiteLLM 或后端进程）。

## 2.1 LiteLLM Proxy 完整路由配置

```yaml
# litellm-config.yaml —— 多模型路由 + 成本路由 + fallback
model_list:
  - model_name: router:default
    litellm_params:
      model: gpt-4o
      api_key: ${OPENAI_API_KEY}
  - model_name: router:cheap
    litellm_params:
      model: gpt-4o-mini
      api_key: ${OPENAI_API_KEY}
  - model_name: router:claude
    litellm_params:
      model: claude-sonnet-4-20250514
      api_key: ${ANTHROPIC_API_KEY}

router_settings:
  routing_strategy: cost-based-routing   # 优先便宜模型
  fallbacks:
    - { model: router:default, fallbacks: [router:claude, router:cheap] }
  num_retries: 2
  retry_policy:
    TimeoutError: true
    HTTPStatusError: true
  budget_limit: 1000                     # 月度成本上限（美元）
```

业务侧所有 `/api/chat` 调用 `baseURL = LITELLM_BASE_URL`，模型名写 `router:default`，具体模型由网关决定。**不要手写模型路由/fallback/成本追踪**——这些是 LiteLLM 的能力。

## 3.1 Upstash Ratelimit 限流集成

```typescript
// packages/core/src/ratelimit.ts —— 租户/用户级限流
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });

export const tenantRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(100, '1 h'), // 每租户每小时 100 次
  analytics: true,
});

export const userRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 m'),
});
```

- 429 响应体返回 `X-RateLimit-Limit/Remaining/Reset`，前端据此展示配额。
- **配额预算**：超过预算自动拒绝并写入审计日志；`budget_limit` 在 LiteLLM 侧同步兜底。

## 4.1 Stripe Webhook 幂等与签名

```typescript
// apps/web/src/app/api/webhooks/stripe/route.ts —— 签名验证 + 幂等
import Stripe from 'stripe';
import { NextResponse } from 'next/server';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(req: Request) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature')!;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret);
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }
  // 幂等：以 event.id 去重（Redis SETNX + TTL 7 天）
  const processed = await redis.setNX(`stripe:${event.id}`, '1', { EX: 604800 });
  if (!processed) return NextResponse.json({ ok: true, duplicate: true });
  // 处理 event.type === 'invoice.paid' 等业务逻辑
  return NextResponse.json({ ok: true });
}
```

🤖 **AI 常见错误**：webhook 不验签、不去重——攻击者可伪造事件触发发积分/扣款；网络重试会导致业务动作重复。**签名验证 + eventId 幂等是底线**。

## 5.1 Agent-as-a-Service API：鉴权与租户隔离

```typescript
// apps/web/src/app/api/agent/route.ts —— 对外 Agent API
export async function POST(req: Request) {
  // 1. 验证 API Key（存哈希，不存明文）
  const apiKey = req.headers.get('x-api-key');
  const tenant = await authenticateApiKey(apiKey);
  if (!tenant) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  // 2. 配额检查（Upstash）
  const { success } = await tenantRatelimit.limit(tenant.id);
  if (!success) return NextResponse.json({ error: 'quota exceeded' }, { status: 429 });
  // 3. 交给后端 Agent 循环（streamText + LiteLLM 路由）
  return runAgentStream(tenant, await req.json());
}
```

- API Key 哈希后存储（argon2/bcrypt），泄露可吊销。
- 所有会话、消息、记忆表都带 `tenant_id` 并启用 RLS（见 19）。
- 对外暴露 `POST /api/agent`（非流式返回 JSON）与 `POST /api/agent/stream`（SSE）两种形态。

## 6. 本层验收清单

> 完成本层后，用以下步骤验证产品化能力（限流 / 成本 / Webhook / 路由）符合预期（可在本地或 CI 执行）：

- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，确认 `24-product-layer.md` 所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本节验收清单。
- [ ] **Playground**：`useChat` 发送消息后逐 token 渲染；Compare Mode 两个模型独立取消互不影响；浏览器 Network 面板只有 `/api/chat` 一个流式请求，无手写 SSE。
- [ ] **路由与 Fallback**：LiteLLM Proxy 的 `model_group_alias` 解析正确；把 `gpt-4o` 的上游凭证改为无效后，请求自动落到 `gpt-4o-mini`，响应头带降级标记。
- [ ] **限流**：同一用户 1 分钟内超过 `rpm` 后收到 `429` + `X-RateLimit-Remaining` 头；不同用户相互不影响。
- [ ] **配额预算**：LiteLLM 虚拟密钥 `max_budget` 生效后，超预算请求被拒绝；`BUDGET_ALERT_RATIO` 触达时管理员收到通知。
- [ ] **Webhook 幂等**：用 `stripe-fixtures` 重复投递同一 `invoice.paid` 事件，`processed_events` 只插入一次，`upgradeTenantToPro` 只执行一次。
- [ ] **类型检查**：`pnpm typecheck` 通过，`packages/core/product`、`packages/core/rate-limit`、`packages/core/webhook` 0 错误。

---

*演进路径：先接 Playground（`useChat`），再上 LiteLLM Proxy 管路由与成本，然后加 Upstash 限流，最后用 Stripe Webhook 打通计费。每一步都替换掉一块手写基础设施，让产品层只留下业务策略。*

---

**交叉引用**：
- `createModel` / `LanguageModel` 契约与 `useChat` 基础 → [01-foundation.md](01-foundation.md)
- CI/CD 与密钥管理 → [09-deploy.md](09-deploy.md)
- Function Calling 统一协议 → [11-function-calling.md](11-function-calling.md)
- SSE 调优与心跳 → [17-streaming-advanced.md](17-streaming-advanced.md)
- 多租户隔离与认证 → [19-multi-tenancy.md](19-multi-tenancy.md)
- 可观测性与成本追踪 → [08-eval-observability.md](08-eval-observability.md)
