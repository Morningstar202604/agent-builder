# 19 — 多租户架构 · 企业级 Agent 产品

> 目标：Agent 产品从"个人工具"升级到"企业平台"必须跨过的门槛——多组织隔离、资源配额、RBAC、审计、计费。每一条都是企业采购时的必查项。

---

## 目录

- [1. 多租户架构模式对比](#1-多租户架构模式对比)
- [2. Tenant Context 注入](#2-tenant-context-注入)
- [3. 资源配额系统](#3-资源配额系统)
- [4. RBAC 矩阵设计](#4-rbac-矩阵设计)
- [5. 隔离策略](#5-隔离策略)
- [6. 跨租户审计日志](#6-跨租户审计日志)
- [7. 计费 & 计量](#7-计费--计量)
- [8. 前端：Admin Dashboard](#8-前端admin-dashboard)
- [9. 避坑汇总](#9-避坑汇总)

---

## 1. 多租户架构模式对比

### 1.1 三种模式详解

| 模式 | 隔离级别 | 运维成本 | 数据隔离强度 | 适用阶段 |
|------|---------|---------|-------------|---------|
| **Database-per-tenant** | 完全物理隔离 | 极高（每个租户独立迁移/备份） | 最强 | 大租户（银行/政府/医疗） |
| **Shared-database-with-RLS** | 行级逻辑隔离 | 中等（单一 schema + RLS policies） | 强 | 成长阶段（10-1000 租户） |
| **Shared-schema** | 共用表 + tenant_id 列 | 最低（一个 schema，应用层过滤） | 依赖代码正确性 | 早期阶段（< 10 租户） |

### 1.2 推荐策略：渐进路径

```
启动阶段（< 10 租户）
│ 使用 Shared-schema + 应用层过滤
│ 最便宜的部署，代码集中
│
├── 租户增长到 10+
│   切换到 RLS 模式（在 Postgres 层加行级安全策略）
│   零代码迁移，只改 schema + policies
│
└── 大客户要求完全物理隔离
     给这些大客户单独部署 Database-per-tenant
     其他租户留在 RLS 模式
```

🔗 **工程逻辑**：不要直接从 Shared-schema 跳到 Database-per-tenant——你的运维能力要匹配租户规模。Database-per-tenant 意味着每个租户独立备份、独立迁移、独立伸缩，运维工作量随租户数线性增长。RLS 模式在 Postgres 层做隔离，运维成本和 Shared-schema 几乎一样，但数据泄漏风险接近 Database-per-tenant。

### 1.3 模式切换的无缝迁移路径

```typescript
// packages/core/src/tenant/tenant-strategy.ts

/**
 * 租户存储策略抽象。
 * 允许混合模式：大部分租户走 RLS，大客户走 Database-per-tenant。
 */
export interface TenantStoreStrategy {
  /** 获取数据库连接——Database-per-tenant 返回独立连接，RLS 返回共享连接 */
  getConnection(tenantId: string): Promise<{ query: (sql: string, params?: any[]) => Promise<unknown> }>;

  /** 确认 RLS 上下文已设置 */
  setRLSContext(conn: unknown, tenantId: string): Promise<void>;
}

/**
 * 混合策略：根据租户配置选择 RLS 或 Database-per-tenant。
 */
export class HybridTenantStrategy implements TenantStoreStrategy {
  constructor(
    private sharedPool: any,
    private isolatedConnections: Map<string, any>,
  ) {}

  async getConnection(tenantId: string) {
    // 完全隔离的租户——独立连接
    if (this.isolatedConnections.has(tenantId)) {
      return this.isolatedConnections.get(tenantId);
    }

    // 普通租户——共享连接 + RLS 策略
    const conn = await this.sharedPool.connect();
    await this.setRLSContext(conn, tenantId);
    return conn;
  }

  async setRLSContext(conn: any, tenantId: string) {
    // Postgres RLS：设置当前会话的 tenant_id 上下文
    // 0=SQL注入：tenantId 必须用参数化查询，禁止字符串拼接
    await conn.query('SET app.current_tenant_id = $1', [tenantId]);
  }
}
```

### 1.4 RLS 策略实现

```sql
-- migrations/004_rls_policies.sql

-- 启用 Row Level Security
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- 创建 RLS Policy：租户只能看到自己的数据
CREATE POLICY tenant_isolation_conversations ON conversations
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation_messages ON messages
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- 重要：RLS 不自动保护——如果你忘了 SET app.current_tenant_id，
-- 查询会返回空集（因为有 USING 过滤），而不是全部数据。
-- 这比返回全部数据安全，但会导致难以调试的空响应问题。

-- 为 bypass RLS 的 superuser 创建专门的角色（用于运维/备份）
CREATE ROLE agentcore_admin BYPASSRLS;

-- 确保应用连接不能用 admin 角色
-- 检查：SELECT rolname, rolbypassrls FROM pg_roles;
```

---

## 2. Tenant Context 注入

### 2.1 请求链路

```
HTTP Request → JWT Token → 解析 tenant_id → AsyncLocalStorage → Postgres RLS → 数据隔离
                                                         ↓
                                                    MemoryManager 隔离
                                                         ↓
                                                    ToolRegistry 隔离
                                                         ↓
                                                    MCP Server 隔离
```

### 2.2 AsyncLocalStorage 上下文

```typescript
// packages/core/src/tenant/tenant-context.ts

import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  tenantId: string;
  tenantTier: 'free' | 'pro' | 'enterprise';
  userId: string;
  userRole: 'owner' | 'admin' | 'editor' | 'viewer';
  /** 用于 tracing：整个请求链路传播 */
  traceId?: string;
}

const tenantStorage = new AsyncLocalStorage<TenantContext>();

/**
 * 在请求开始时调用，设置租户上下文。
 * 从此之后，同一个 async 链路里的所有代码都能通过 getCurrentTenant() 获取。
 */
export function runWithTenantContext<T>(
  context: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return tenantStorage.run(context, fn);
}

export function getCurrentTenant(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) {
    throw new Error('No tenant context - request did not pass through tenant middleware');
  }
  return ctx;
}

export function getCurrentTenantId(): string {
  return getCurrentTenant().tenantId;
}
```

### 2.3 Next.js Middleware 入口

```typescript
// apps/web/src/middleware.ts

import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

/**
 * 全局 tenant 注入中间件。
 *
 * 所有请求都要经过这里。流程：
 * 1. 解析 JWT，提取 tenant_id 和 user_role
 * 2. 验证租户状态（是否已过期/暂停）
 * 3. 注入到请求头（向下传播到 route handler）
 */
export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // 解析 Auth Token
  const token = req.cookies.get('auth_token')?.value;
  if (!token) {
    res.headers.set('x-tenant-id', 'anonymous');
    return res;
  }

  try {
    const secret = new TextEncoder().encode(process.env.NEXTAUTH_SECRET);
    const { payload } = await jwtVerify(token, secret);

    const tenantId = payload.tenant_id as string;
    const tenantTier = payload.tier as string;

    // 检查租户状态
    if (tenantTier === 'suspended') {
      return NextResponse.json(
        { error: 'Tenant account suspended' },
        { status: 403 },
      );
    }

    // 注入到请求头
    res.headers.set('x-tenant-id', tenantId);
    res.headers.set('x-tenant-tier', tenantTier);
    res.headers.set('x-user-id', payload.sub as string);
    res.headers.set('x-user-role', payload.role as string);
  } catch {
    res.headers.set('x-tenant-id', 'anonymous');
  }

  return res;
}

export const config = {
  matcher: ['/api/:path*', '/admin/:path*'],
};
```

### 2.4 Route Handler 消费

```typescript
// apps/web/src/app/api/chat/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { runWithTenantContext, TenantContext } from '@agentcore/core/tenant/tenant-context';
import { redis } from '@/lib/redis';

/**
 * Chat API 的 tenant 注入。
 *
 * 从 middleware 拿到 tenant_id 后，用 AsyncLocalStorage 传播到整个请求链路。
 * 这样 AbstractAgent.run() 内部无需显式传 tenant_id，tools 调用也能拿到。
 */
export async function POST(req: NextRequest) {
  const tenantId = req.headers.get('x-tenant-id') ?? 'anonymous';
  const tenantTier = req.headers.get('x-tenant-tier') ?? 'free';
  const userId = req.headers.get('x-user-id') ?? 'anonymous';
  const userRole = req.headers.get('x-user-role') ?? 'viewer';

  const tenantContext: TenantContext = {
    tenantId,
    tenantTier: tenantTier as TenantContext['tenantTier'],
    userId,
    userRole: userRole as TenantContext['userRole'],
    traceId: crypto.randomUUID(),
  };

  // 用 tenant context 包裹整个请求处理
  return runWithTenantContext(tenantContext, async () => {
    const body = await req.json();

    // 这里开始，所有代码都自动知道当前 tenant
    // AbstractAgent 内部调用 tool 时，tool 能从 getCurrentTenant() 获取 tenant
    const response = new StreamingResponse(/* ... */);
    return response;
  });
}
```

---

## 3. 资源配额系统

### 3.1 配额定义

```typescript
// packages/core/src/tenant/quota.ts

export interface TenantQuota {
  /** 每月 token 配额 */
  monthlyTokenLimit: number;
  /** 每分钟请求数上限 */
  requestsPerMinute: number;
  /** 并发执行的 Agent 数 */
  concurrentAgents: number;
  /** 单次请求最大 token 数 */
  maxTokensPerRequest: number;
  /** 存储配额（MB） */
  storageMb: number;
}

export const TIER_QUOTAS: Record<string, TenantQuota> = {
  free: {
    monthlyTokenLimit: 500_000,        // 50 万 token
    requestsPerMinute: 5,
    concurrentAgents: 1,
    maxTokensPerRequest: 4096,
    storageMb: 100,
  },
  pro: {
    monthlyTokenLimit: 10_000_000,      // 1000 万 token
    requestsPerMinute: 30,
    concurrentAgents: 5,
    maxTokensPerRequest: 16384,
    storageMb: 1024,
  },
  enterprise: {
    monthlyTokenLimit: 100_000_000,     // 1 亿 token
    requestsPerMinute: 100,
    concurrentAgents: 20,
    maxTokensPerRequest: 32768,
    storageMb: 10240,
  },
};
```

### 3.2 Redis 限流实现

```typescript
// packages/core/src/tenant/rate-limiter.ts

import { redis } from '@/lib/redis';
import { getCurrentTenant } from './tenant-context';
import { TIER_QUOTAS, TenantQuota } from './quota';

/**
 * 基于滑动窗口的限流。
 *
 * 使用 Redis Sorted Set：member 是时间戳，score 也是时间戳。
 * 窗口内的 member 数量 = 窗口内请求数。
 * 原子操作：ZADD + ZCOUNT + ZREMRANGEBYSCORE 在一个 Lua 脚本里完成。
 */
const RATE_LIMIT_SCRIPT = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  
  -- 清理窗口外的 old entries
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  
  -- 计算窗口内请求数
  local count = redis.call('ZCOUNT', key, now - window, '+inf')
  
  if count >= limit then
    return {0, count}
  end
  
  -- 允许通过，加入当前请求
  redis.call('ZADD', key, now, now .. ':' .. ARGV[4])
  redis.call('EXPIRE', key, window)
  return {1, count + 1}
`;

export async function checkRateLimit(
  resource: 'api_calls' | 'tokens' | 'storage',
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const tenant = getCurrentTenant();
  const quota = TIER_QUOTAS[tenant.tenantTier];

  const key = `rate:${tenant.tenantId}:${resource}`;
  const now = Date.now();
  const windowMs = 60_000; // 1 分钟窗口

  const limits: Record<string, number> = {
    api_calls: quota.requestsPerMinute,
    tokens: quota.maxTokensPerRequest,
    storage: quota.concurrentAgents,
  };

  const result = await redis.eval(
    RATE_LIMIT_SCRIPT,
    1,  // key 数量
    key,
    now,
    windowMs,
    limits[resource],
    crypto.randomUUID(),
  ) as [number, number];

  const [allowed, count] = result;

  return {
    allowed: allowed === 1,
    remaining: limits[resource] - count,
    resetAt: now + windowMs,
  };
}

/**
 * Token 用量累计。
 *
 * 在每次 LLM 调用后，把消耗的 token 加到当月计数器。
 */
export async function recordTokenUsage(
  inputTokens: number,
  outputTokens: number,
): Promise<{ total: number; exceeded: boolean }> {
  const tenant = getCurrentTenant();
  const quota = TIER_QUOTAS[tenant.tenantTier];

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const key = `usage:tokens:${tenant.tenantId}:${monthKey}`;

  const total = await redis.incrbyby(key, inputTokens + outputTokens);

  // 设置月底过期（第一次写入时设 TTL）
  if (total <= inputTokens + outputTokens) {
    await redis.expire(key, 60 * 60 * 24 * 32); // 最长 32 天
  }

  return { total, exceeded: total > quota.monthlyTokenLimit };
}
```

### 3.3 配额超限处理

```typescript
// packages/core/src/tenant/quota-guard.ts

import { recordTokenUsage, checkRateLimit } from './rate-limiter';
import { TIER_QUOTAS } from './quota';

/**
 * 在 AbstractAgent.run() 内部使用——每次 LLM 调用前后检查配额。
 *
 * 超限策略：
 * - token 超限 → 终止当前 Agent 执行，返回友好提示
 * - 限流触发 → 等待后重试，超过最大等待时间则报错
 * - 并发超限 → 等待其他 Agent 完成
 */
export async function guardLLMCall(
  promptTokenCount: number,
): Promise<{ ok: boolean; reason?: string }> {
  const tenant = getCurrentTenant();
  const quota = TIER_QUOTAS[tenant.tenantTier];

  // 1. 检查本次请求是否超出单次上限
  if (promptTokenCount > quota.maxTokensPerRequest) {
    return {
      ok: false,
      reason: `单次请求 token 数(${promptTokenCount})超出配额限制(${quota.maxTokensPerRequest})`,
    };
  }

  // 2. 检查月度 token 用量
  const { total: tokenTotal } = await recordTokenUsage(0, 0); // 只读不增
  if (tokenTotal >= quota.monthlyTokenLimit * 0.95) {
    return {
      ok: false,
      reason: `本月 token 用量已达配额 ${(tokenTotal / quota.monthlyTokenLimit * 100).toFixed(0)}%，请升级套餐或联系管理员`,
    };
  }

  // 3. 检查请求频率限流
  const rateCheck = await checkRateLimit('api_calls');
  if (!rateCheck.allowed) {
    return {
      ok: false,
      reason: `请求过于频繁，每分钟最多 ${quota.requestsPerMinute} 次，请在 ${Math.ceil((rateCheck.resetAt - Date.now()) / 1000)} 秒后重试`,
    };
  }

  return { ok: true };
}
```

---

## 4. RBAC 矩阵设计

### 4.1 权限矩阵

| 操作 | owner | admin | editor | viewer |
|------|-------|-------|--------|--------|
| 创建/删除 Agent | ✅ | ✅ | ❌ | ❌ |
| 编辑 Agent 配置 | ✅ | ✅ | ✅ | ❌ |
| 调用 Agent（对话） | ✅ | ✅ | ✅ | ✅ |
| 管理 Skills/Tools | ✅ | ✅ | ✅ | ❌ |
| 查看审计日志 | ✅ | ✅ | ❌ | ❌ |
| 管理成员 | ✅ | ✅ | ❌ | ❌ |
| 修改配额/套餐 | ✅ | ❌ | ❌ | ❌ |
| 查看用量统计 | ✅ | ✅ | ✅ | ❌ |
| 配置 MCP Servers | ✅ | ✅ | ✅ | ❌ |
| 删除租户 | ✅ | ❌ | ❌ | ❌ |
| 导出数据 | ✅ | ✅ | ❌ | ❌ |

### 4.2 实现

```typescript
// packages/core/src/tenant/rbac.ts

import { getCurrentTenant } from './tenant-context';

type Permission =
  | 'agent:create' | 'agent:delete' | 'agent:edit' | 'agent:invoke'
  | 'skills:manage' | 'skills:install'
  | 'audit:view'
  | 'members:manage'
  | 'billing:manage'
  | 'usage:view'
  | 'mcp:configure'
  | 'tenant:delete'
  | 'data:export';

type Role = 'owner' | 'admin' | 'editor' | 'viewer';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: [
    'agent:create', 'agent:delete', 'agent:edit', 'agent:invoke',
    'skills:manage', 'skills:install',
    'audit:view',
    'members:manage',
    'billing:manage',
    'usage:view',
    'mcp:configure',
    'tenant:delete',
    'data:export',
  ],
  admin: [
    'agent:create', 'agent:edit', 'agent:invoke',
    'skills:manage', 'skills:install',
    'audit:view',
    'members:manage',
    'usage:view',
    'mcp:configure',
    'data:export',
  ],
  editor: [
    'agent:invoke',
    'skills:manage', 'skills:install',
    'usage:view',
    'mcp:configure',
  ],
  viewer: [
    'agent:invoke',
  ],
};

export function hasPermission(permission: Permission): boolean {
  const { userRole } = getCurrentTenant();
  return ROLE_PERMISSIONS[userRole].includes(permission);
}

/**
 * 在 API 路由开头调用。无权限直接抛错，由全局异常处理返回 403。
 */
export function requirePermission(permission: Permission): void {
  if (!hasPermission(permission)) {
    const { userRole, tenantId } = getCurrentTenant();
    throw new ForbiddenError(
      `Role '${userRole}' in tenant '${tenantId}' does not have permission '${permission}'`,
    );
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}
```

### 4.3 与 ToolRegistry 集成

```typescript
// packages/core/src/tools/tool-registry.ts（追加方法）

class ToolRegistry {
  // ... 已有方法

  /**
   * 根据当前用户角色过滤可访问的工具。
   *
   * 关键：viewer 角色只能调用"安全"工具（无文件写入、无 API 写操作），
   * editor 可调用读写工具，admin/owner 可调用所有工具（包括管理类）。
   */
  getAccessibleTools(): AgentTool[] {
    const { userRole } = getCurrentTenant();
    const allTools = this.getAll();

    if (userRole === 'owner' || userRole === 'admin') {
      return allTools;
    }

    if (userRole === 'editor') {
      return allTools.filter((t) => !t.tags?.includes('admin'));
    }

    // viewer：只允许 read-only 工具
    return allTools.filter((t) => t.tags?.includes('read-only'));
  }
}
```

---

## 5. 隔离策略

### 5.1 文件系统隔离

```typescript
// packages/core/src/tenant/storage-isolation.ts

import { getCurrentTenantId } from './tenant-context';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';

const STORAGE_ROOT = process.env.TENANT_STORAGE_ROOT ?? '/data/tenants';

/**
 * 租户存储隔离。
 *
 * 每个租户有自己的目录：/data/tenants/{tenant_id}/
 * 工具调用里的文件路径必须通过这个封装——不能直接用用户提供的路径，
 * 防止 "../../etc/passwd" 路径穿越攻击。
 */
export class TenantFileStorage {
  private basePath: string;

  constructor(tenantId?: string) {
    const tid = tenantId ?? getCurrentTenantId();
    this.basePath = resolve(join(STORAGE_ROOT, tid));
  }

  /** 解析用户提供的相对路径为绝对路径（安全：不超出 basePath） */
  resolvePath(userPath: string): string {
    const absolute = resolve(this.basePath, userPath);

    // 安全检查：如果路径不以 basePath 开头，说明穿越了
    if (!absolute.startsWith(this.basePath)) {
      throw new Error(`Path traversal detected: ${userPath}`);
    }

    return absolute;
  }

  async readFile(userPath: string): Promise<string> {
    const fullPath = this.resolvePath(userPath);
    return fs.readFile(fullPath, 'utf-8');
  }

  async writeFile(userPath: string, content: string): Promise<void> {
    const fullPath = this.resolvePath(userPath);
    await fs.mkdir(resolve(fullPath, '..'), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  async ensureExists(): Promise<void> {
    await fs.mkdir(this.basePath, { recursive: true });
  }
}
```

### 5.2 记忆隔离

```typescript
// packages/core/src/memory/memory-manager.ts（追加 tenant 隔离）

class MemoryManager {
  // ... 已有方法

  /**
   * 记忆按 tenant_id 存储在独立 namespace。
   *
   * Qdrant 的 collection 层面做了物理隔离：
   * - 免费版：共用 collection，用 tenant_id 过滤
   * - 企业版：每个租户独立的 collection
   */
  private getCollectionName(): string {
    const { tenantId, tenantTier } = getCurrentTenant();

    if (tenantTier === 'enterprise') {
      return `memories_${tenantId.replace(/-/g, '_')}`;
    }

    // free/pro 共用 collection，通过 payload filter 隔离
    return 'memories_shared';
  }

  private getFilter(): Record<string, unknown> {
    const { tenantTier } = getCurrentTenant();
    if (tenantTier === 'enterprise') return {}; // 物理隔离不需要 filter
    return { tenant_id: getCurrentTenantId() };
  }
}
```

### 5.3 MCP Server 隔离

```typescript
// packages/core/src/tenant/mcp-isolation.ts

/**
 * MCP Server 按租户配置隔离。
 *
 * 不同租户可以连接到不同的 MCP server（甚至不同的同一个工具的不同实例）。
 * 隔离级别由租户套餐决定：
 * - free / pro：共用 MCP server 实例
 * - enterprise：专用 MCP server 实例（保证资源独占 + 数据不串）
 */

interface MCPConfig {
  serverUrl: string;
  allowedTools: string[];
  /** enterprise 租户的专用 token */
  authToken?: string;
}

export function getMCPConfig(mcpServerName: string): MCPConfig {
  const { tenantId, tenantTier } = getCurrentTenant();

  // 企业租户：可能有专用配置
  if (tenantTier === 'enterprise') {
    const enterpriseConfig = getEnterpriseMCPConfig(tenantId, mcpServerName);
    if (enterpriseConfig) return enterpriseConfig;
  }

  // 标准租户：共用配置
  const standardConfig = getStandardMCPConfig(mcpServerName);
  if (!standardConfig) {
    throw new Error(`MCP server '${mcpServerName}' not configured for this tenant`);
  }
  return standardConfig;
}
```

---

## 6. 跨租户审计日志

### 6.1 审计事件定义

```typescript
// packages/core/src/tenant/audit.ts

import { getCurrentTenant } from './tenant-context';

export type AuditAction =
  | 'agent.create' | 'agent.delete' | 'agent.invoke'
  | 'tool.call' | 'tool.denied'
  | 'member.add' | 'member.remove' | 'member.role_change'
  | 'quota.change' | 'tenant.create' | 'tenant.delete'
  | 'data.export' | 'skill.install' | 'skill.uninstall'
  | 'login' | 'login_failed' | 'permission_denied';

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  tenantId: string;
  userId: string;
  action: AuditAction;
  resource: string;
  detail?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  /** 关联的请求 trace_id，用于链路追踪 */
  traceId?: string;
  /** risk_score: 0-100, > 70 触发告警 */
  riskScore?: number;
}

/**
 * 审计日志写入。关键：必须同步写入（不能用 fire-and-forget），
 * 否则日志丢了你都不知道是否发生过安全事件。
 */
export async function logAudit(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void> {
  const fullEntry: AuditLogEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
  };

  // 同步写入 Postgres（在 audit_logs 表，有 RLS policy 保护）
  await writeAuditToDB(fullEntry);

  // 高风险事件实时告警
  if ((entry.riskScore ?? 0) > 70) {
    await sendSecurityAlert(fullEntry);
  }
}

async function sendSecurityAlert(entry: AuditLogEntry): Promise<void> {
  // 发送到安全 webhook / Slack / 邮件
  const { hasPermission } = await import('./rbac');
  // 仅 owner 和 admin 收到告警
  console.warn(`[SECURITY ALERT] Tenant ${entry.tenantId}: ${entry.action} by ${entry.userId}`);
}

// --- 辅助工具函数 ---

/** 记录工具调用审计 */
export async function auditToolCall(toolName: string, params: unknown, result: 'success' | 'denied' | 'error'): Promise<void> {
  const tenant = getCurrentTenant();
  await logAudit({
    tenantId: tenant.tenantId,
    userId: tenant.userId,
    action: result === 'denied' ? 'tool.denied' : 'tool.call',
    resource: `tool:${toolName}`,
    detail: {
      params: sanitizeForAudit(params),
      result,
    },
    traceId: tenant.traceId,
    riskScore: result === 'denied' ? 50 : 0,
  });
}

function sanitizeForAudit(params: unknown): unknown {
  // 移除敏感字段（API keys, passwords）
  if (typeof params === 'object' && params !== null) {
    const sanitized = { ...params };
    for (const key of Object.keys(sanitized)) {
      if (key.toLowerCase().includes('key') || key.toLowerCase().includes('password') || key.toLowerCase().includes('token')) {
        (sanitized as Record<string, unknown>)[key] = '[REDACTED]';
      }
    }
    return sanitized;
  }
  return params;
}
```

### 6.2 审计查询 API

```typescript
// apps/web/src/app/api/admin/audit/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { requirePermission } from '@agentcore/core/tenant/rbac';

export async function GET(req: NextRequest) {
  // RBAC：只有 owner 和 admin 可查看审计日志
  requirePermission('audit:view');

  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  // 查询当前租户的审计日志（RLS 自动过滤）
  const logs = await queryAuditLogs({
    action: action ?? undefined,
    startDate: startDate ? new Date(startDate) : undefined,
    endDate: endDate ? new Date(endDate) : undefined,
  });

  return NextResponse.json({ logs });
}
```

---

## 7. 计费 & 计量

### 7.1 计量模型

```typescript
// packages/core/src/tenant/billing.ts

/**
 * 基于 token 用量的计费模型。
 *
 * 计费粒度：
 * - 输入 token：按每百万计费（比输出 token 便宜）
 * - 输出 token：按每百万计费（比输入 token 贵 3-5 倍）
 * - 工具调用：固定费用（每次工具调用计费一次 LLM API 调用）
 * - 存储：按 GB/月计费
 */
export interface BillingRates {
  inputTokenPricePerM: number;   // 输入 token 每百万价格（分）
  outputTokenPricePerM: number;  // 输出 token 每百万价格（分）
  toolCallPrice: number;         // 每次工具调用价格（分）
  storagePricePerGbMonth: number; // 存储每 GB/月价格（分）
}

export const TIER_RATES: Record<string, BillingRates> = {
  free: {
    inputTokenPricePerM: 0,       // 免费
    outputTokenPricePerM: 0,
    toolCallPrice: 0,
    storagePricePerGbMonth: 0,
  },
  pro: {
    inputTokenPricePerM: 30,      // $0.30/M tokens
    outputTokenPricePerM: 150,    // $1.50/M tokens
    toolCallPrice: 1,             // $0.01/call
    storagePricePerGbMonth: 200,  // $2/GB/month
  },
  enterprise: {
    inputTokenPricePerM: 25,      // 量大优惠
    outputTokenPricePerM: 120,
    toolCallPrice: 0,
    storagePricePerGbMonth: 100,
  },
};

/**
 * 计算单次对话的费用。
 */
export function calculateConversationCost(
  inputTokens: number,
  outputTokens: number,
  toolCalls: number,
  tier: string,
): { totalCents: number; breakdown: Record<string, number> } {
  const rates = TIER_RATES[tier] ?? TIER_RATES.pro;

  const inputCost = Math.ceil((inputTokens / 1_000_000) * rates.inputTokenPricePerM);
  const outputCost = Math.ceil((outputTokens / 1_000_000) * rates.outputTokenPricePerM);
  const toolCost = toolCalls * rates.toolCallPrice;

  return {
    totalCents: inputCost + outputCost + toolCost,
    breakdown: { inputCost, outputCost, toolCost },
  };
}
```

### 7.2 用量报告生成

```typescript
// apps/web/src/app/api/admin/billing/report/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { getCurrentTenantId } from '@agentcore/core/tenant/tenant-context';
import { requirePermission } from '@agentcore/core/tenant/rbac';

export async function GET(req: NextRequest) {
  requirePermission('usage:view');

  const tenantId = getCurrentTenantId();
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // 从 Redis 拉取本月用量
  const [tokens, apiCalls, toolCalls] = await Promise.all([
    redis.get(`usage:tokens:${tenantId}:${monthKey}`),
    redis.get(`usage:api_calls:${tenantId}:${monthKey}`),
    redis.get(`usage:tool_calls:${tenantId}:${monthKey}`),
  ]);

  return NextResponse.json({
    period: monthKey,
    usage: {
      inputTokens: Math.floor(Number(tokens) * 0.6), // 实际应分别存储
      outputTokens: Math.floor(Number(tokens) * 0.4),
      apiCalls: Number(apiCalls ?? 0),
      toolCalls: Number(toolCalls ?? 0),
    },
  });
}
```

---

## 8. 前端：Admin Dashboard

🔗 **工程逻辑**：Admin Dashboard 不是给普通用户看的，是给以下角色准备的：
- 企业 IT 管理员：看用量、控制成本
- Agent 开发者：管理 Skills/Tools
- 安全专员：查看审计日志

所以它和普通聊天 UI 是分开的，独立路由 `/admin`，独立 layout（无聊天栏，侧边导航管理）。

### 8.1 布局结构

```tsx
// apps/web/src/app/admin/layout.tsx

import { AdminSidebar } from './_components/admin-sidebar';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-bg">
      <AdminSidebar />
      <main className="flex-1 overflow-auto p-6">
        {children}
      </main>
    </div>
  );
}
```

### 8.2 租户概览面板

```tsx
// apps/web/src/app/admin/_components/tenant-overview.tsx

'use client';

import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface UsageData {
  date: string;
  tokens: number;
  apiCalls: number;
}

export function TenantOverview() {
  const [usage, setUsage] = useState<UsageData[]>([]);
  const [tenantInfo, setTenantInfo] = useState<{ name: string; tier: string; memberCount: number } | null>(null);

  useEffect(() => {
    fetch('/api/admin/tenant-info').then(r => r.json()).then(setTenantInfo);
    fetch('/api/admin/usage?days=30').then(r => r.json()).then((d) => setUsage(d.daily));
  }, []);

  const tierColors = {
    free: 'bg-gray-500/20 text-gray-400',
    pro: 'bg-blue-500/20 text-blue-400',
    enterprise: 'bg-purple-500/20 text-purple-400',
  };

  return (
    <div className="space-y-6">
      {/* 租户基本信息 */}
      <div className="bg-surface rounded-lg border border-border p-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl text-text font-medium">{tenantInfo?.name ?? 'Loading...'}</h1>
            <div className="flex gap-2 mt-2">
              <span className={`text-xs px-2 py-0.5 rounded ${tierColors[tenantInfo?.tier ?? 'free']}`}>
                {(tenantInfo?.tier ?? 'free').toUpperCase()}
              </span>
              <span className="text-xs text-muted">{tenantInfo?.memberCount} members</span>
            </div>
          </div>
          <button className="text-sm bg-primary/20 text-primary px-3 py-1 rounded-md hover:bg-primary/30">
            升级套餐
          </button>
        </div>
      </div>

      {/* 用量图表 */}
      <div className="bg-surface rounded-lg border border-border p-5">
        <h2 className="text-text font-medium text-sm mb-4">近 30 天用量</h2>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={usage}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#888' }} />
            <YAxis tick={{ fontSize: 10, fill: '#888' }} />
            <Tooltip contentStyle={{ background: '#1e1e2e', border: '1px solid #333' }} />
            <Bar dataKey="tokens" fill="#6366f1" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* 配额使用率 */}
      <div className="grid grid-cols-3 gap-4">
        <QuotaCard title="Token 用量" used={1_500_000} limit={10_000_000} />
        <QuotaCard title="API 调用" used={12_400} limit={50_000} />
        <QuotaCard title="存储使用" used={234} limit={1024} unit="MB" />
      </div>
    </div>
  );
}

function QuotaCard({ title, used, limit, unit = '' }: { title: string; used: number; limit: number; unit?: string }) {
  const percent = Math.min((used / limit) * 100, 100);
  const color = percent > 90 ? 'bg-red-500' : percent > 70 ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className="text-xs text-muted">{title}</div>
      <div className="text-text font-medium mt-1">
        {used.toLocaleString()} / {limit.toLocaleString()} {unit}
      </div>
      <div className="mt-2 h-1.5 bg-surface/60 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
```

### 8.3 审计日志面板

```tsx
// apps/web/src/app/admin/_components/audit-log.tsx

'use client';

import { useState, useEffect } from 'react';

interface AuditLogEntry {
  id: string;
  timestamp: number;
  userId: string;
  action: string;
  resource: string;
  detail?: Record<string, unknown>;
  riskScore?: number;
}

export function AuditLogPanel() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [filterAction, setFilterAction] = useState('all');

  useEffect(() => {
    fetch('/api/admin/audit').then((r) => r.json()).then((d) => setLogs(d.logs));
  }, []);

  const filteredLogs = filterAction === 'all'
    ? logs
    : logs.filter((l) => l.action.startsWith(filterAction));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg text-text font-medium">审计日志</h2>
        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          className="bg-surface border border-border text-text text-sm rounded-md px-2 py-1"
        >
          <option value="all">全部事件</option>
          <option value="agent">Agent 操作</option>
          <option value="member">成员操作</option>
          <option value="tool">工具调用</option>
          <option value="permission_denied">权限拒绝</option>
        </select>
      </div>

      <div className="bg-surface rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="text-left px-4 py-3">时间</th>
              <th className="text-left px-4 py-3">用户</th>
              <th className="text-left px-4 py-3">事件</th>
              <th className="text-left px-4 py-3">资源</th>
              <th className="text-center px-4 py-3">风险</th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.slice(0, 50).map((log) => (
              <tr key={log.id} className="border-b border-border/50 hover:bg-surface/40">
                <td className="px-4 py-2 text-xs text-muted">
                  {new Date(log.timestamp).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-xs font-mono">{log.userId.slice(0, 8)}</td>
                <td className="px-4 py-2">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    log.action.includes('denied') ? 'bg-red-500/20 text-red-400' :
                    log.action.includes('delete') ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-surface/60 text-text'
                  }`}>
                    {log.action}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs font-mono text-muted">{log.resource}</td>
                <td className="px-4 py-2 text-center">
                  {(log.riskScore ?? 0) > 30 && (
                    <span className="text-red-400 text-xs">{'⚠️'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

## 9. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| tenant_id 在 embedding 调用链上遗漏导致跨租户记忆泄漏 | MemoryManager 在 embedding search 时忘记设 RLS context / filter | 每次 search 前强制从 `getCurrentTenant()` 获取并注入 filter；集成测试中加"写入后切换租户再搜索"的用例 |
| RBAC 只在前端校验，直接调 API 就能绕过 | 前端隐藏了按钮但 API 端没有做同样的权限检查 | 每次 API route handler 开头都调 `requirePermission()`；前端隐藏只是 UX 优化，不是安全控制 |
| 审计日志写入异步导致 Agent 进程崩溃时日志丢了 | 用 setTimeout/writeFile 异步写日志 | 审计日志必须同步写入（`await writeAuditToDB()`）；可接受 5-10ms 的写入延迟 |
| 限流 Lua 脚本在高并发下 Redis 连接争用 | 每个请求都建立新 Redis 连接 | 使用 Redis Pool 复用连接；或者把 tenant 限流放在 Nginx 层（`limit_req_zone`） |
| 路径穿越攻击：用户工具调用里写 "../../etc/passwd" | 直接用用户输入拼接文件路径 | 全部文件操作走 `TenantFileStorage.resolvePath()` 做 basePath 约束 |
| 跨租户计费统计不对 | token 用量计数器没有区分 tenant | Redis key 格式是 `usage:tokens:{tenant_id}:{month}`，RLS 额外保护 Postgres 记录 |
| 企业版大客户的 RLS 和 Database-per-tenant 同时开启导致困惑 | 代码没有明确区分两种模式 | `HybridTenantStrategy` 优先检查 isolatedConnections Map——如果在就走 Database-per-tenant，否则走 RLS |
| JWT 过期时间太长（30 天）导致已离职员工仍能用旧 Token | Token TTL 设太长且没有 token 黑名单 | Access Token 设为 15 分钟，Refresh Token 设为 7 天 + Redis 黑名单；员工离职时清除黑名单 |
| 多人同时编辑 Agent 配置，最后写入覆盖前者 | 没有乐观锁 | Agent 配置表加 version 字段，UPDATE 时带 WHERE version = ?，受影响行数为 0 说明有并发修改 |
| 计费精度问题——浮点数（cents 计算出来有小数） | 没有用整数运算 | 所有货币 value 以 cents 为单位用整数存储；`Math.ceil()` 取整后再写入 |

---

## 10. AI 避坑追加（AST 可检）

> 🤖 **AI 常见错误**：
>
> 1. **租户 ID 注入遗漏** — 写 database query 时忘记在 WHERE 子句中加 `tenant_id = $1`，导致 A 租户能读到 B 租户的数据。**ESLint 规则**：所有 SQL 字符串模板必须通过 `requireTenantFilter()` 校验函数；所有 ORM 查询必须显式传 `{ tenantId }` 参数。
>
> 2. **共享内存数据结构泄露租户上下文** — 用 `new Map()` 做内存缓存时 key 不含 tenantId，不同租户的请求命中同一缓存条目。**检查方式**：所有 in-memory cache 的 key 必须包含 `tenantId` 前缀（如 `${tenantId}:${queryHash}`），用 ESLint plugin 检测 `Map.set(` 调用是否包含 tenant 标识。
>
> 3. **JWT 解码后跳过角色校验** — 从 JWT 解析出 `role: 'admin'` 后直接信任，但 JWT 过期或被吊销后仍可通过复用旧 token 绕过。**检查方式**：所有 `requireRole('xxx')` 中间件必须在验证 JWT signature 之后额外检查 Redis 黑名单；`jwt.verify()` 必须配置 `maxAge` 和 `clockTolerance`。

*本节点属于 Layer 4 企业能力层。多租户不是"加个 tenant_id 列"就完了——它触及请求链路（middleware）、存储层（RLM/postgres RLS）、缓存层（key 命名）、工具层（文件隔离）、计费层（用量统计）、安全层（审计日志）的每一个环节。做错了任何一个点，后果都是跨租户数据泄漏——在这个量级的安全事件面前，"我加了 tenant_id"不是辩护理由。演进路径：先在应用层做 tenant_id 过滤（最快上线），然后加 RLS 策略（零代码迁移，纯 SQL migration），最后给大客户做独立数据库（运维最高）。*
