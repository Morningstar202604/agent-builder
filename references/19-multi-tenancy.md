# 19 — 多租户架构 · 企业级 Agent 产品

> 目标：Agent 产品从"个人工具"升级到"企业平台"必须跨过的门槛——多组织隔离、资源配额、RBAC、审计、计费。每一条都是企业采购时的必查项。

> **⚠️ 本层铁律：不自研基础设施，只接成熟方案。**
> - 权限模型 → **CASL**（`@casl/ability`），不要手写 `ROLE_PERMISSIONS + hasPermission`
> - 租户数据隔离 → **Postgres RLS**（纯 SQL 配置），不要手写行级过滤
> - 配额/限流 → **Upstash Ratelimit / Redis 官方客户端**，不要手写 Lua 脚本
> - 审计日志 → **数据库表 + 一条 INSERT**（配置），不要手写审计引擎
> - 计费 → **Stripe API**（用量计费），不要手写资金账本
>
> 本层唯一允许手写的 `[CUSTOM]` 是**租户上下文注入**（AsyncLocalStorage 薄层）与**业务配额表**——这些是产品语义，没有现成替代。

---

## 目录

- [1. 多租户架构模式对比](#1-多租户架构模式对比)
- [2. Tenant Context 注入 [CUSTOM]](#2-tenant-context-注入-custom)
- [3. 配额与限流：Upstash Ratelimit](#3-配额与限流upstash-ratelimit)
- [4. RBAC：CASL](#4-rbaccasl)
- [5. 隔离策略](#5-隔离策略)
- [6. 审计日志：数据库表配置](#6-审计日志数据库表配置)
- [7. 计费 & 计量：Stripe](#7-计费--计量stripe)
- [8. 前端：Admin Dashboard](#8-前端admin-dashboard)
- [9. 避坑汇总](#9-避坑汇总)
- [10. AI 避坑追加](#10-ai-避坑追加)
- [11. 本层验收清单](#11-本层验收清单)

---

## 1. 多租户架构模式对比

| 模式 | 隔离级别 | 运维成本 | 数据隔离强度 | 适用阶段 |
|------|---------|---------|-------------|---------|
| **Database-per-tenant** | 完全物理隔离 | 极高（每个租户独立迁移/备份） | 最强 | 大租户（银行/政府/医疗） |
| **Shared-database-with-RLS** | 行级逻辑隔离 | 中等（单一 schema + RLS policies） | 强 | 成长阶段（10-1000 租户） |
| **Shared-schema** | 共用表 + tenant_id 列 | 最低（一个 schema，应用层过滤） | 依赖代码正确性 | 早期阶段（< 10 租户） |

🔗 **工程逻辑**：不要直接跳到 Database-per-tenant。每个租户独立备份/迁移，运维成本随租户数线性增长。**RLS 是配置不是代码**——同一套 SQL 迁移文件切换模式，应用层代码不变。

### 1.1 租户隔离：Postgres RLS（配置）

```sql
-- migrations/004_rls_policies.sql（配置，不是手写实现）
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_conversations ON conversations
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation_messages ON messages
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- 应用连接使用非 superuser 角色；RLS 由数据库强制执行
CREATE ROLE agentcore_app NOLOGIN;
GRANT CONNECT ON DATABASE agentcore TO agentcore_app;
```

> 🤖 **AI 常见错误**：开启 RLS 后只 `ENABLE ROW LEVEL SECURITY` 却不创建 `POLICY`，默认拒绝策略会让所有查询返回 0 行，表现为"登录正常但所有查询报错"。正确做法：迁移脚本必须为每张业务表创建 `USING (tenant_id = current_setting(...))` 的 POLICY，并在 CI 中断言跨租户查询返回 0 行。

### 1.2 连接层：薄胶水 [CUSTOM]

应用层唯一要做的，是请求进来时把 `tenant_id` 写进会话 GUC。这个"设置上下文"的动作是胶水层，保留 `[CUSTOM]`——但它只做一件事，不做隔离本身。

```typescript
// packages/core/src/tenant/tenant-strategy.ts
// [CUSTOM] 胶水层：把租户上下文写进 Postgres 会话；隔离策略本身在 SQL 里
import { getCurrentTenant } from './tenant-context';

export async function setTenantContext(conn: { query: (sql: string, params?: unknown[]) => Promise<unknown> }): Promise<void> {
  const { tenantId } = getCurrentTenant();
  await conn.query('SET app.current_tenant_id = $1', [tenantId]);
}
```

## 2. Tenant Context 注入 [CUSTOM]

**为什么保留 [CUSTOM]**：AsyncLocalStorage 承载「当前请求属于哪个租户」——这是产品运行时上下文，任何库都不替你定义。但注意：它只是"把租户 ID 传下去"，权限、配额、隔离全部交给成熟方案。

```typescript
// packages/core/src/tenant/tenant-context.ts
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  tenantId: string;
  tenantTier: 'free' | 'pro' | 'enterprise';
  userId: string;
  userRole: 'owner' | 'admin' | 'editor' | 'viewer';
  traceId?: string;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function runWithTenantContext<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run(context, fn);
}

export function getCurrentTenant(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) throw new Error('No tenant context - request did not pass through tenant middleware');
  return ctx;
}
```

```typescript
// apps/web/src/middleware.ts（胶水层：解析 JWT 并注入请求头）
import { NextRequest, NextResponse } from 'next/server';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const token = req.cookies.get('auth_token')?.value;
  if (!token) {
    res.headers.set('x-tenant-id', 'anonymous');
    return res;
  }
  const payload = await verifyJwt(token); // jose，见 07 安全层
  res.headers.set('x-tenant-id', String(payload.tenant_id));
  res.headers.set('x-user-id', String(payload.sub));
  res.headers.set('x-user-role', String(payload.role));
  return res;
}
```

## 3. 配额与限流：Upstash Ratelimit

**配额表是业务配置 `[CUSTOM]`**——随套餐定价调整。**限流机制用 Upstash Ratelimit**——滑动窗口、固定窗口、令牌桶都是现成算法，不手写 Lua 脚本。

```typescript
// packages/core/src/tenant/quota.ts
// [CUSTOM] 业务配额表：产品配置，随套餐调整；限流算法由成熟库提供
export const TIER_QUOTAS = {
  free: { requestsPerMinute: 5, monthlyTokenLimit: 500_000, maxTokensPerRequest: 4096 },
  pro: { requestsPerMinute: 30, monthlyTokenLimit: 10_000_000, maxTokensPerRequest: 16384 },
  enterprise: { requestsPerMinute: 100, monthlyTokenLimit: 100_000_000, maxTokensPerRequest: 32768 },
} as const;
```

```typescript
// packages/core/src/tenant/rate-limiter.ts
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const limiters = new Map<string, Ratelimit>();

export function getRatelimiter(tenantId: string, tier: keyof typeof TIER_QUOTAS): Ratelimit {
  const existing = limiters.get(tenantId);
  if (existing) return existing;
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(TIER_QUOTAS[tier].requestsPerMinute, '1 m'),
    prefix: `ratelimit:${tenantId}`,
  });
  limiters.set(tenantId, limiter);
  return limiter;
}
```

```typescript
// packages/core/src/tenant/usage.ts
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// 用量计数：Redis 官方客户端累加器（月末过期），不手写计数器
export async function recordTokenUsage(tenantId: string, inputTokens: number, outputTokens: number): Promise<number> {
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const key = `usage:tokens:${tenantId}:${monthKey}`;
  const total = await redis.incrby(key, inputTokens + outputTokens);
  if (total === inputTokens + outputTokens) {
    await redis.expire(key, 31 * 24 * 60 * 60);
  }
  return total;
}
```

```typescript
// packages/core/src/tenant/quota-guard.ts
import { getCurrentTenant } from './tenant-context';
import { TIER_QUOTAS } from './quota';
import { getRatelimiter } from './rate-limiter';

export async function guardLLMCall(promptTokenCount: number): Promise<{ ok: boolean; reason?: string }> {
  const { tenantId, tenantTier } = getCurrentTenant();
  const quota = TIER_QUOTAS[tenantTier];
  if (promptTokenCount > quota.maxTokensPerRequest) {
    return { ok: false, reason: `单次请求 token 数(${promptTokenCount})超出配额限制(${quota.maxTokensPerRequest})` };
  }
  const res = await getRatelimiter(tenantId, tenantTier).limit('api_calls');
  if (!res.success) {
    return { ok: false, reason: `请求过于频繁，每分钟最多 ${quota.requestsPerMinute} 次` };
  }
  return { ok: true };
}
```

> 🤖 **AI 常见错误**：自己实现"滑动窗口"限流（Redis ZSET + Lua）。Upstash Ratelimit 已经处理了原子性、时钟漂移与分布式场景；手写版本在高并发下会出现窗口错位或连接争用。

## 4. RBAC：CASL

**权限矩阵是业务定义，校验机制是 CASL**。用 `@casl/ability` 声明能力，不要手写 `ROLE_PERMISSIONS[role].includes(permission)`。

```typescript
// packages/core/src/tenant/rbac.ts
import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';

type Action = 'create' | 'delete' | 'edit' | 'invoke' | 'manage' | 'view';
type Subject = 'Agent' | 'Skill' | 'AuditLog' | 'Member' | 'Billing' | 'Usage' | 'MCP' | 'Tenant' | 'all';

export type AppAbility = MongoAbility<[Action, Subject]>;

const ROLE_PERMISSIONS: Record<string, Array<[Action, Subject]>> = {
  owner: [['manage', 'all']],
  admin: [
    ['create', 'Agent'], ['delete', 'Agent'], ['edit', 'Agent'], ['invoke', 'Agent'],
    ['manage', 'Skill'], ['view', 'AuditLog'], ['manage', 'Member'], ['view', 'Usage'], ['manage', 'MCP'],
  ],
  editor: [['invoke', 'Agent'], ['manage', 'Skill'], ['view', 'Usage'], ['manage', 'MCP']],
  viewer: [['invoke', 'Agent']],
};

export function defineAbilityFor(role: string): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const [action, subject] of ROLE_PERMISSIONS[role] ?? []) {
    can(action, subject);
  }
  return build();
}
```

```typescript
// apps/web/src/app/api/admin/audit/route.ts（薄胶水：CASL 校验 + RLS 查询）
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentTenant } from '@agentcore/core/tenant/tenant-context';
import { defineAbilityFor } from '@agentcore/core/tenant/rbac';

export async function GET(req: NextRequest) {
  const { userRole, tenantId } = getCurrentTenant();
  if (defineAbilityFor(userRole).cannot('view', 'AuditLog')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const logs = await queryAuditLogs(tenantId, req.nextUrl.searchParams);
  return NextResponse.json({ logs });
}
```

> 🤖 **AI 常见错误**：只在前端隐藏按钮、API 不做能力校验。CASL 的 `can`/`cannot` 必须在每个 route handler 开头执行一次；前端隐藏只是 UX，不是安全控制。

## 5. 隔离策略

### 5.1 文件系统隔离 [CUSTOM]

租户文件目录约束属于安全胶水层（成熟库不覆盖"产品数据目录"语义），保留 `[CUSTOM]`。

```typescript
// packages/core/src/tenant/storage-isolation.ts
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { getCurrentTenantId } from './tenant-context';

const STORAGE_ROOT = process.env.TENANT_STORAGE_ROOT ?? '/data/tenants';

export class TenantFileStorage {
  private basePath: string;

  constructor(tenantId?: string) {
    this.basePath = resolve(join(STORAGE_ROOT, tenantId ?? getCurrentTenantId()));
  }

  resolvePath(userPath: string): string {
    const absolute = resolve(this.basePath, userPath);
    if (!absolute.startsWith(this.basePath)) {
      throw new Error(`Path traversal detected: ${userPath}`);
    }
    return absolute;
  }

  async readFile(userPath: string): Promise<string> {
    return fs.readFile(this.resolvePath(userPath), 'utf-8');
  }

  async writeFile(userPath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(userPath);
    await fs.mkdir(resolve(fullPath, '..'), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }
}
```

### 5.2 记忆与 MCP 隔离（配置）

向量库（12 层 Qdrant）与 MCP（14 层）的租户隔离都是**过滤器/命名空间配置**，不是手写实现：

- Qdrant：shared collection 用 `tenant_id` payload filter；企业租户独立 collection。
- MCP Server：租户级配置表存储 serverUrl + allowedTools，代码只读配置。

## 6. 审计日志：数据库表配置

审计日志 = **一张表 + 一条 INSERT**。表结构是配置（migration SQL），写入是胶水代码。RLS 保证租户只能看到自己的日志。

```sql
-- migrations/006_audit_logs.sql（配置）
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  detail JSONB,
  ip INET,
  user_agent TEXT,
  trace_id TEXT,
  risk_score INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

```typescript
// packages/core/src/tenant/audit.ts
import { getCurrentTenant } from './tenant-context';

export async function logAudit(entry: {
  action: string;
  resource: string;
  detail?: Record<string, unknown>;
  riskScore?: number;
}): Promise<void> {
  const { tenantId, userId, traceId } = getCurrentTenant();
  await db.query(
    `INSERT INTO audit_logs (tenant_id, user_id, action, resource, detail, trace_id, risk_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, userId, entry.action, entry.resource, JSON.stringify(entry.detail ?? {}), traceId, entry.riskScore ?? 0],
  );
}
```

> 🤖 **AI 常见错误**：用 fire-and-forget 异步写审计日志，进程崩溃时安全事件丢失。审计写入必须 `await` 完成，可接受 5-10ms 延迟。

## 7. 计费 & 计量：Stripe

**计费账本交给 Stripe**。业务侧只做一件事：把内部用量事件翻译成 Stripe 计量记录（`[CUSTOM]` 胶水层）。

```typescript
// packages/core/src/tenant/billing.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// [CUSTOM] 业务映射：内部 token 用量 -> Stripe 计量记录（账本由 Stripe 管理）
export async function reportUsageToStripe(tenant: {
  stripeSubscriptionItemId: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  await stripe.subscriptionItems.createUsageRecord(tenant.stripeSubscriptionItemId, {
    quantity: tenant.inputTokens + tenant.outputTokens,
    timestamp: 'now',
    action: 'increment',
  });
}
```

🔗 **工程逻辑**：Stripe 负责计量、出账、发票与支付；你的代码只需在 LLM 调用链路上埋点调用 `reportUsageToStripe`。订阅管理、Webhook 幂等见 [24-product-layer](./24-product-layer.md)。身份与上下文相关约定参见 [01-foundation](./01-foundation.md)。

## 8. 前端：Admin Dashboard

Admin Dashboard（用量图表、配额卡片、审计表格）是产品 UI，用成熟组件（`recharts`、`@tanstack/react-table`）组装，不包含任何隔离逻辑——所有数据都来自已过 RLS/CASL 的 API。具体页面属于产品设计，不在本 reference 展开。

## 9. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| tenant_id 在 embedding 链路遗漏导致跨租户记忆泄漏 | 检索时忘记注入租户 filter | 每次 search 前强制从 `getCurrentTenant()` 获取并注入 filter；测试加"写入后切换租户再搜索" |
| RBAC 只在前端校验，直接调 API 绕过 | 前端隐藏按钮但 API 没校验 | 每个 route handler 开头执行 CASL `cannot()` 检查 |
| 审计日志异步写入丢失 | fire-and-forget | `await` INSERT 完成 |
| 路径穿越攻击 `../../etc/passwd` | 直接用用户输入拼接路径 | 全部文件操作走 `TenantFileStorage.resolvePath()` |
| 计费数据不透明 | 手工统计不精确 | 用 Stripe 计量 API，数据由 Stripe 出账 |

## 10. AI 避坑追加

> 🤖 **AI 常见错误**：
>
> 1. **租户 ID 注入遗漏** — 写 SQL 时忘记 `tenant_id = $1`，A 租户能读到 B 租户数据。**ESLint 规则**：所有 SQL 模板必须通过 `requireTenantFilter()` 校验；ORM 查询必须显式传 `{ tenantId }`。
>
> 2. **内存缓存 key 不含 tenantId** — `new Map()` 缓存命中跨租户条目。**检查方式**：所有 in-memory cache 的 key 必须包含 `tenantId` 前缀（如 `${tenantId}:${queryHash}`）。
>
> 3. **JWT 解码后跳过角色校验** — 直接信任 JWT 里的 `role`，吊销/离职后旧 token 仍可用。**检查方式**：`requireRole` 中间件必须在验证签名后检查 Redis 黑名单（见 [07-security](./07-security.md)）。

## 11. 本层验收清单

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/tenant/*.ts` 全部通过。
- [ ] **租户隔离**：运行 `pnpm vitest run tenant/isolation`，断言「租户 A 写入 → 切换租户 B 搜索」返回 0 条；未设置 `app.current_tenant_id` 的会话查询返回 0 行。
- [ ] **RBAC**：运行 `pnpm vitest run tenant/rbac`，断言 `viewer` 调用 `audit:view` 返回 403，`owner` 返回 200。
- [ ] **限流**：运行 `pnpm vitest run tenant/ratelimit`，断言超过 `TIER_QUOTAS[].requestsPerMinute` 后第 N+1 个请求被拒绝，`remaining` 正确递减。
- [ ] **审计**：运行 `pnpm vitest run tenant/audit`，断言 `logAudit()` 完成后同租户能查到、跨租户查不到。
- [ ] **门禁回归**：`node tools/check-skill.mjs` 本文件 0 失败。

---

*本节点属于 Layer 4 企业能力层。多租户不是"加个 tenant_id 列"就完了——它触及请求链路（middleware）、存储层（Postgres RLS）、缓存层（key 命名）、工具层（文件隔离）、计费层（Stripe）、安全层（审计日志）。演进路径：先应用层过滤（最快上线），再加 RLS 策略（纯 SQL 迁移），最后给大客户独立数据库。权限模型用 CASL，配额限流用 Upstash，计费用 Stripe——每一层都接成熟方案，企业采购问起来答得上。*
