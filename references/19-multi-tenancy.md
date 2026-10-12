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


### 1.1.1 完整 RLS 迁移（企业级）

只 `ENABLE ROW LEVEL SECURITY` 不写 `POLICY` 是常见翻车点。下面是一份**自洽完整**的迁移：建表、开 RLS、写读写策略、撤销默认权限、建索引，一次到位：

```sql
-- migrations/004_rls_policies_full.sql（配置：RLS 是数据库策略，不是应用代码）
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  title TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- 租户只能看到自己的租户行（tenants 表仅对当前租户可见）
CREATE POLICY tenants_select ON tenants
  FOR SELECT
  USING (id = current_setting('app.current_tenant_id', true)::UUID);

-- 读策略：SELECT 只能看到当前租户
CREATE POLICY conversations_select ON conversations
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- 写策略：INSERT 必须属于当前租户（WITH CHECK）
CREATE POLICY conversations_insert ON conversations
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- UPDATE：USING 限制“能改哪些行”，WITH CHECK 防止改完跨租户
CREATE POLICY conversations_update ON conversations
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- DELETE：只允许删除当前租户的行
CREATE POLICY conversations_delete ON conversations
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- 防止表 owner 绕过 RLS（超级用户仍然绕过，生产禁止用超级用户跑应用）
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;

-- 最小权限：应用角色只拥有业务操作权
REVOKE ALL ON conversations FROM PUBLIC;
REVOKE ALL ON messages FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON conversations TO agentcore_app;
GRANT SELECT, INSERT ON messages TO agentcore_app;

-- 索引：租户过滤与列表查询
CREATE INDEX idx_conversations_tenant_id ON conversations (tenant_id);
CREATE INDEX idx_messages_tenant_conversation ON messages (tenant_id, conversation_id, created_at DESC);
```

**关键点**：

- `current_setting('app.current_tenant_id', true)` 的第二参数 `missing_ok := true`：未设置 GUC 时返回 `NULL` 而不是抛错，`tenant_id = NULL` 恒为假 → 未登录请求天然读不到任何行。
- `FORCE ROW LEVEL SECURITY`：表 owner 也不能绕过 RLS（Postgres 15+ 对 `FORCE` 支持更完整）。应用连接**绝不使用 superuser**。
- `WITH CHECK`：防止 `UPDATE` 把行改成其他租户，也防止 `INSERT` 直接写入别人的 `tenant_id`。

#### RLS 策略矩阵

| 策略 | 操作 | USING（限制可见/可改的行） | WITH CHECK（限制写入的行） |
|------|------|---------------------------|---------------------------|
| `tenants_select` | SELECT | `id = 当前租户` | — |
| `conversations_select` | SELECT | `tenant_id = 当前租户` | — |
| `conversations_insert` | INSERT | — | `tenant_id = 当前租户` |
| `conversations_update` | UPDATE | `tenant_id = 当前租户` | `tenant_id = 当前租户` |
| `conversations_delete` | DELETE | `tenant_id = 当前租户` | — |

`messages`、`skills`、`audit_logs` 的 RLS 策略与 `conversations` 完全同构，只是表名不同。

#### RLS 自检 SQL（CI 可执行）

```sql
-- 自检 1：设置当前租户后，能读到自己的行
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO conversations (id, tenant_id, title)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', '自己的数据');
SELECT count(*) FROM conversations;  -- 期望：1
ROLLBACK;
```

```sql
-- 自检 2：跨租户读取返回 0 行
SET app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
SELECT count(*) FROM conversations
WHERE tenant_id = '22222222-2222-2222-2222-222222222222';  -- 期望：0
```

```sql
-- 自检 3：跨租户写入必须被 WITH CHECK 拒绝
BEGIN;
SET LOCAL app.current_tenant_id = '11111111-1111-1111-1111-111111111111';
INSERT INTO conversations (id, tenant_id, title)
VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', '越权写入');
-- 期望：ERROR: new row violates row-level security policy
ROLLBACK;
```

这三条自检放进 CI（`pnpm vitest run tenant/isolation` 对应的 SQL 夹具），防止任何人在迁移中删掉策略。


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


### 3.1 多级限流：租户级 + 用户级同时生效

单一滑动窗口不够：企业平台需要“租户级总配额”和“用户级配额”同时生效。组合两个 `Ratelimit` 实例即可，**不写任何 Lua 脚本**：

```typescript
// packages/core/src/tenant/rate-limiter-multi.ts —— 多级限流
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export function createTenantLimiters(tenantId: string) {
  const perTenant = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(1000, '1 m'),
    prefix: `ratelimit:tenant:${tenantId}`,
  });

  const perUser = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, '1 m'),
    prefix: `ratelimit:user:${tenantId}`,
  });

  return { perTenant, perUser };
}
```

在 `guardLLMCall` 里同时检查两级：

```typescript
// packages/core/src/tenant/quota-guard-multi.ts —— 两级限流组合
import { getCurrentTenant } from './tenant-context';
import { createTenantLimiters } from './rate-limiter-multi';

export async function guardLLMCallMulti(userId: string): Promise<{ ok: boolean; reason?: string }> {
  const { tenantId } = getCurrentTenant();
  const { perTenant, perUser } = createTenantLimiters(tenantId);

  const tenantRes = await perTenant.limit('api_calls');
  if (!tenantRes.success) {
    return { ok: false, reason: '租户级配额已用完' };
  }

  const userRes = await perUser.limit(userId);
  if (!userRes.success) {
    return { ok: false, reason: '用户级配额已用完' };
  }

  return { ok: true };
}
```

**注意**：`createTenantLimiters` 每次调用都会 new 两个 Ratelimit 实例。与 3 节 `getRatelimiter` 一样，生产环境应把实例缓存在 `Map` 里复用，避免每个请求重复建连。

### 3.2 月度 token 配额：Redis 原子累加 + 月末过期

月度配额是“账单上限”不是“秒级限流”，用 Redis `INCRBY` 原子累加并设置月末过期，不手写计数器：

```typescript
// packages/core/src/tenant/monthly-quota.ts —— 月度用量累加器
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

export const MONTHLY_TOKEN_LIMITS = {
  free: 500_000,
  pro: 10_000_000,
  enterprise: 100_000_000,
} as const;

export async function consumeMonthlyTokens(
  tenantId: string,
  tier: keyof typeof MONTHLY_TOKEN_LIMITS,
  amount: number,
): Promise<{ ok: boolean; remaining: number }> {
  const now = new Date();
  const key = `usage:tokens:${tenantId}:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const used = await redis.incrby(key, amount);
  if (used === amount) {
    // 首次写入时设置 31 天过期，避免 key 永久残留
    await redis.expire(key, 31 * 24 * 60 * 60);
  }

  const limit = MONTHLY_TOKEN_LIMITS[tier];
  return { ok: used <= limit, remaining: Math.max(0, limit - used) };
}
```

与 3 节 `recordTokenUsage` 的差异：`recordTokenUsage` 只记账，`consumeMonthlyTokens` 在记账前先检查配额。调用链建议为：

1. `guardLLMCall`（秒级限流 + 单次 token 上限）
2. `consumeMonthlyTokens`（月度配额检查并累加）
3. 通过后才调用模型 API
4. 模型返回后 `recordTokenUsage` 精确补账（用实际用量覆盖预估值）

### 3.3 配额不足时的降级

配额用尽不应该是 500 错误。成熟的降级策略（按顺序尝试）：

1. **缓存答案**：相同请求（`prompt hash` 一致）直接返回缓存，不消耗配额。
2. **降级模型**：pro 租户月配额用尽后，提示“已切换基础模型”并走便宜模型，配额按折扣计。
3. **排队**：企业租户可以进入队列，`BullMQ` 延迟执行（见 [21-fault-recovery](./21-fault-recovery.md)）。
4. **硬拒绝**：免费租户直接返回 429 + `Retry-After`。

降级策略是**产品决策**，不属于基础设施，保留 `[CUSTOM]`——但执行降级用的缓存、队列、限流全部是成熟组件。


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


### 4.1 权限矩阵（业务配置）

CASL 的 `can`/`cannot` 只负责“判断与执行”，**矩阵本身是业务配置**。把角色权限收敛成一张表，代码与文档共用同一份事实：

| 能力 | owner | admin | editor | viewer |
|------|:---:|:---:|:---:|:---:|
| manage Tenant | ✅ | ❌ | ❌ | ❌ |
| manage Member | ✅ | ✅ | ❌ | ❌ |
| create / edit / delete Agent | ✅ | ✅ | ❌ | ❌ |
| invoke Agent | ✅ | ✅ | ✅ | ✅ |
| manage Skill | ✅ | ✅ | ✅ | ❌ |
| view AuditLog | ✅ | ✅ | ❌ | ❌ |
| view Usage | ✅ | ✅ | ✅ | ❌ |
| manage MCP | ✅ | ✅ | ✅ | ❌ |
| manage Billing | ✅ | ✅ | ❌ | ❌ |

这张表对应 `rbac.ts` 中的 `ROLE_PERMISSIONS`。**新增角色或能力时，先改表再改代码**，避免“文档说能看审计日志、代码实际拒绝”的漂移。

### 4.2 带条件的 ability：数据属于谁

纯角色表不够表达“行级归属”。例如：`editor` 只能编辑**自己创建**的 Agent，`admin` 可以编辑所有 Agent。CASL 用条件对象表达这种规则，与 RLS 的 `tenant_id` 过滤互补——**RLS 管租户边界，CASL 管租户内部的行归属**：

```typescript
// packages/core/src/tenant/rbac-conditions.ts —— 条件化 ability
import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';

type Action = 'create' | 'delete' | 'edit' | 'invoke' | 'manage' | 'view';
type Subject = 'Agent' | 'Skill' | 'AuditLog' | 'Member' | 'Billing' | 'Usage' | 'MCP' | 'Tenant' | 'all';

export type AppAbility = MongoAbility<[Action, Subject]>;

export function defineAbilityFor(role: string, ownUserId: string): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  if (role === 'owner') {
    can('manage', 'all');
  }

  if (role === 'admin') {
    can('manage', 'Agent');
    can('manage', 'Skill');
    can('manage', 'Member');
    can('manage', 'MCP');
    can('view', 'AuditLog');
    can('view', 'Usage');
    cannot('delete', 'Tenant');
  }

  if (role === 'editor') {
    can('create', 'Agent');
    can('edit', 'Agent', { ownerId: ownUserId });
    can('delete', 'Agent', { ownerId: ownUserId });
    can('invoke', 'Agent');
    can('manage', 'Skill');
    can('view', 'Usage');
  }

  if (role === 'viewer') {
    can('invoke', 'Agent');
  }

  return build();
}
```

`can('edit', 'Agent', { ownerId: ownUserId })` 的含义：只有当 `Agent` 对象的 `ownerId` 等于当前用户时，`edit` 才被允许。校验时传入要操作的资源字段：

```typescript
// apps/web/src/app/api/agents/[id]/route.ts —— 条件校验示例
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentTenant } from '@agentcore/core/tenant/tenant-context';
import { defineAbilityFor } from '@agentcore/core/tenant/rbac-conditions';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { userRole, userId } = getCurrentTenant();
  const ability = defineAbilityFor(userRole, userId);
  const agent = await db.query('SELECT owner_id FROM agents WHERE id = $1', [params.id]);

  if (!agent || ability.cannot('delete', 'Agent', { ownerId: String(agent.owner_id) })) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db.query('DELETE FROM agents WHERE id = $1', [params.id]);
  return NextResponse.json({ ok: true });
}
```

### 4.3 CASL 与 RLS 的分工

| 层 | 回答的问题 | 工具 | 粒度 |
|----|-----------|------|------|
| 数据库层 | “这个查询属于哪个租户？” | Postgres RLS | 行级（`tenant_id`） |
| 应用层 | “这个用户能否对这个资源做这个动作？” | CASL | 资源级（`ownerId`、`role`） |
| 前端层 | “要不要渲染这个按钮/入口？” | CASL `ability` 序列化 | UX 显示 |

前端隐藏按钮只是 UX——API 层的 CASL 校验与数据库层的 RLS 才是安全控制。**任何 API 都不要只依赖前端**。

🤖 **AI 常见错误**：把条件写进 `ROLE_PERMISSIONS` 数组（如 `['edit', 'Agent', 'ownerId=me']`）然后用 `if (permission.condition === 'owner')` 手写判断——CASL 的条件对象本身就是为这个设计的，直接交给 `can('edit', 'Agent', { ownerId })`，不要另造条件语法。


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


## 12. 审计日志表设计进阶：分区、不可变、保留

### 12.1 按月分区 + 不可变策略

审计日志只增不改，天然适合按时间分区。分区让“删除三个月前的日志”变成 `DROP PARTITION`，而不是海量 `DELETE`：

```sql
-- migrations/007_audit_logs_partitioned.sql（配置）
CREATE TABLE audit_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip INET,
  user_agent TEXT,
  trace_id TEXT,
  risk_score INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_logs_2026_10 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit_logs_2026_11 PARTITION OF audit_logs
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- 审计日志只允许 SELECT 当前租户，不允许 UPDATE/DELETE
CREATE POLICY audit_logs_select ON audit_logs
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant_id', true)::UUID);

-- 撤销更新/删除权限，应用角色无法篡改审计
REVOKE UPDATE, DELETE ON audit_logs FROM agentcore_app;
GRANT SELECT, INSERT ON audit_logs TO agentcore_app;

CREATE INDEX idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at DESC);
```

**设计要点**：

- `PRIMARY KEY (id, created_at)`：分区键必须包含在主键/唯一约束中。
- 不创建 `UPDATE`/`DELETE` 策略：RLS 默认拒绝没有策略的操作，再配合 `REVOKE UPDATE, DELETE` 双保险。
- `resource_id` 单独成列：审计查询经常按“某个 Agent 的所有变更”过滤，避免每次都解 `detail` JSON。
- 保留策略：用 `pg_partman` 自动建分区，或定时任务 `DROP TABLE audit_logs_2026_03`，把“删除旧日志”变成“删分区”。

### 12.2 审计事件类型

`action` 字段建议用统一枚举，避免同义不同词（`update` vs `modified`）：

| action | 触发场景 | 风险分 |
|--------|---------|-------|
| `tenant.member.invited` | 邀请成员 | 20 |
| `tenant.member.role_changed` | 角色变更 | 40 |
| `agent.created` / `agent.deleted` | Agent 生命周期 | 10 |
| `agent.invoked` | 调用 Agent | 0 |
| `mcp.server_url_changed` | MCP 配置变更 | 30 |
| `billing.plan_changed` | 套餐变更 | 50 |
| `auth.login_failed` | 登录失败（多次触发告警） | 60 |

`risk_score` 用于安全仪表盘排序：累计高风险事件触发 [22-guardrails-tracing](./22-guardrails-tracing.md) 的告警。

## 13. Stripe 计量计费进阶：Billing Meters

### 13.1 `billing.meterEvents` 与 `createUsageRecord` 对比

| 维度 | `subscriptionItems.createUsageRecord`（传统） | `billing.meterEvents.create`（Billing Meters） |
|------|---------------------------------------------|-----------------------------------------------|
| 聚合粒度 | 每个订阅条目逐笔上报 | 事件流聚合到 Meter |
| 出账方式 | 立即写入订阅用量 | 定时聚合后按订阅计费 |
| 适用场景 | 简单按量（调用次数） | 高吞吐 token 计量、多维度过滤 |
| 容错 | 需要幂等键 | 事件 ID 天然幂等 |

2026 年的 token 计量推荐 **Billing Meters**：高频、异步、可聚合。

```typescript
// packages/core/src/tenant/billing-meter.ts —— Billing Meters 上报
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function reportMeteredUsage(params: {
  stripeCustomerId: string;
  tokenCount: number;
}): Promise<void> {
  await stripe.billing.meterEvents.create({
    event_name: 'agent_tokens',
    payload: {
      value: String(params.tokenCount), // Meter 事件 value 必须是字符串，且不支持小数
      stripe_customer_id: params.stripeCustomerId,
    },
  });
}
```

### 13.2 埋点链路

1. 路由层 `streamText` 结束后读取 `result.usage`（输入 + 输出 token）。
2. 调用 `reportMeteredUsage({ stripeCustomerId, tokenCount })`。
3. Stripe 定时把 Meter 聚合到订阅项，生成发票。
4. 订阅扣费与发票推送走 Webhook，幂等处理见 [24-product-layer](./24-product-layer.md)。

**注意**：Meter 事件是异步聚合，仪表盘上的用量有几分钟延迟——这是 Stripe 的设计，不要为了“实时”改成同步 `createUsageRecord` 双写，否则账单会出现重复计量。

## 14. 多租户测试矩阵

多租户的回归测试必须覆盖“读写两侧”与“绕过路径”。以下测试文件直接可跑：

```typescript
// packages/core/src/tenant/__tests__/isolation.test.ts
import { describe, expect, it } from 'vitest';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// db 来自测试夹具（pg 连接池），set_config 支持参数绑定
async function queryAsTenant(tenantId: string, sql: string) {
  await db.query('SELECT set_config(\'app.current_tenant_id\', $1, false)', [tenantId]);
  return db.query(sql);
}

describe('tenant isolation', () => {
  it('tenant A cannot read tenant B rows', async () => {
    const rows = await queryAsTenant(TENANT_A, 'SELECT * FROM conversations');
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_A);
    }
  });

  it('cross-tenant insert is rejected by RLS', async () => {
    await expect(
      queryAsTenant(
        TENANT_A,
        `INSERT INTO conversations (tenant_id, title) VALUES ('${TENANT_B}', 'x')`,
      ),
    ).rejects.toThrow();
  });

  it('unauthenticated session reads zero rows', async () => {
    await db.query('SELECT set_config(\'app.current_tenant_id\', NULL, false)');
    const rows = await db.query('SELECT * FROM conversations');
    expect(rows).toHaveLength(0);
  });
});
```

| 测试场景 | 断言 | 防的漏洞 |
|---------|------|---------|
| 跨租户读 | 返回 0 行 | 漏写 `tenant_id` 过滤 |
| 跨租户写 | `rejects.toThrow()` | 漏写 `WITH CHECK` |
| 未登录会话 | 0 行 | `current_setting` 单参数抛错 |
| viewer 调用管理 API | 403 | 前端隐藏但 API 未校验 |
| 路径穿越 | `resolvePath` 抛错 | 文件系统隔离失效 |

## 15. 企业演进路径：RLS → schema-per-tenant → DB-per-tenant

| 阶段 | 模式 | 租户规模 | 迁移动作 |
|------|------|---------|---------|
| 1 | Shared DB + RLS | 10-1000 | 单一 schema，所有表带 `tenant_id` + RLS |
| 2 | Schema-per-tenant | 1000-10000 | 每个租户一个 schema，`SET search_path` 切换 |
| 3 | DB-per-tenant | 大客户 | 独立实例/集群，备份与合规独立 |

**何时从 1 升级到 2**：当 RLS 策略数量超过 50 张表、或出现“单租户写入风暴拖垮全局”时。Schema-per-tenant 的切换是配置：

```sql
-- 连接池为每个租户设置 search_path（胶水层调用）
ALTER ROLE agentcore_app SET search_path TO tenant_abc, public;
```

```typescript
// packages/core/src/tenant/schema-router.ts
// [CUSTOM] 胶水层：按租户设置 search_path；隔离本身由数据库 schema 保证
export async function setTenantSchema(conn: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, tenantId: string): Promise<void> {
  await conn.query('SELECT set_config(\'search_path\', $1, false)', [`tenant_${tenantId.replace(/-/g, '')}, public`]);
}
```

**何时升级到 3**：当客户明确要求“数据不与其他客户共享基础设施”（银行/医疗/政府），或合规要求数据驻留在特定区域。升级到 3 不是代码改动，而是部署拓扑变化——应用代码保持 `getCurrentTenant()` 不变。

## 16. AI 避坑追加

> 🤖 **AI 常见错误**：

> 1. **`current_setting` 用单参数** — 租户上下文没设置时直接抛 `ERROR: unrecognized configuration parameter`，表现为“所有查询 500”。**检查方式**：全仓搜索 `current_setting('`，必须是两参形式 `current_setting('...', true)`。

> 2. **忘记 `FORCE ROW LEVEL SECURITY`** — 表 owner（开发常用账号）可以绕过 RLS，导致本地正常、生产异常。**检查方式**：迁移里每张业务表都要有 `ALTER TABLE ... FORCE ROW LEVEL SECURITY`。

> 3. **应用层过滤与 RLS 双写不一致** — 代码里既写 `WHERE tenant_id = $1` 又依赖 RLS，两处逻辑总有一天不一致。**约定**：RLS 是唯一真相，应用层查询**不写** `tenant_id` 过滤（由 GUC 自动生效），只依赖 RLS；需要显式传租户的场景（如后台服务）走 `setTenantContext`。

> 4. **Stripe Meter 事件 value 传数字** — `payload.value` 必须是字符串且不能有小数，token 计量直接 `String(round)`。**检查方式**：`reportMeteredUsage` 前对 `tokenCount` 做 `Math.round` 再 `String`。

> 5. **审计日志没有保留策略** — 日志表无限增长拖垮查询。**检查方式**：审计表必须有分区（按月）与 `DROP PARTITION` 定时任务，且 `created_at` 进入主键。

## 17. 本层验收清单（追加）

- [ ] **RLS 自检**：在 CI 执行 1.1.1 节的三条自检 SQL，确认跨租户读为 0、跨租户写被拒、未登录会话返回 0 行。
- [ ] **CASL 条件**：运行 `pnpm vitest run tenant/rbac-conditions`，断言 `editor` 能删除自己创建的 Agent、不能删除他人 Agent，`admin` 可删除任何租户内 Agent。
- [ ] **多级限流**：运行 `pnpm vitest run tenant/ratelimit-multi`，断言租户级 1000 次/分钟与用户级 60 次/分钟分别生效。
- [ ] **月度配额**：运行 `pnpm vitest run tenant/monthly-quota`，断言超过 `MONTHLY_TOKEN_LIMITS[tier]` 后返回 `ok: false` 且 `remaining` 不为负。
- [ ] **审计分区**：执行 `migrations/007_audit_logs_partitioned.sql`，确认 `DROP TABLE audit_logs_2026_10` 可独立完成，应用角色无 `UPDATE/DELETE` 权限。
- [ ] **计费埋点**：mock `stripe.billing.meterEvents.create`，断言 `reportMeteredUsage` 传入的 `value` 是字符串且为四舍五入后的整数。
- [ ] **门禁回归**：`node tools/check-skill.mjs` 本文件 0 失败。


---

*本节点属于 Layer 4 企业能力层。多租户不是"加个 tenant_id 列"就完了——它触及请求链路（middleware）、存储层（Postgres RLS）、缓存层（key 命名）、工具层（文件隔离）、计费层（Stripe）、安全层（审计日志）。演进路径：先应用层过滤（最快上线），再加 RLS 策略（纯 SQL 迁移），最后给大客户独立数据库。权限模型用 CASL，配额限流用 Upstash，计费用 Stripe——每一层都接成熟方案，企业采购问起来答得上。*
