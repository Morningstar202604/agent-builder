# 20 — Agent 市场 · Skill/Tool/Prompt 生态

> 目标：Agent 生态繁荣的关键是"让别人能贡献"。Marketplace 让开发者上传 Skill、用户发现 Skill、平台从交易中抽成——三方正循环。

> **⚠️ 本层定位：业务差异层（`[CUSTOM]`），但实现不重造轮子。**
> - **没有成熟开源"Agent 市场"** → 市场流程、实体模型、审核状态机是产品差异，保留 `[CUSTOM]`。
> - 但每个能力点的实现都接成熟服务：
>   - 发布与文件托管 → **GitHub API**（Release + Asset）
>   - 安全扫描 → **npm audit**（漏洞库由社区维护）
>   - 评分防刷 → **数据库唯一约束 + Upstash Ratelimit**
>   - 分成结算 → **Stripe Connect**
> - 结论：**业务编排可以自己写，但对象存储、漏洞库、资金流不要自己写。**

---

## 目录

- [1. 为什么这是业务差异层](#1-为什么这是业务差异层)
- [2. 数据模型 [CUSTOM]](#2-数据模型-custom)
- [3. Publishing API](#3-publishing-api)
- [4. Discovery API](#4-discovery-api)
- [5. Review & Rating](#5-review--rating)
- [6. Revenue Sharing：Stripe Connect](#6-revenue-sharingstripe-connect)
- [7. 兼容性与安装](#7-兼容性与安装)
- [8. 前端：Marketplace Portal](#8-前端marketplace-portal)
- [9. 避坑汇总](#9-避坑汇总)
- [10. AI 避坑追加](#10-ai-避坑追加)
- [11. 本层验收清单](#11-本层验收清单)

---

## 1. 为什么这是业务差异层

🔗 **工程逻辑**：市场本身（谁能发布、审核状态怎么流转、怎么抽成）是产品独特卖点，没有成熟开源替代——强行套"通用市场平台"会失去差异化。但**不要把业务差异当成不接成熟服务的借口**：发布上传、漏洞扫描、资金结算这些通用能力，社区和商业服务已经做得很成熟。本层的分工：

| 能力点 | 实现方式 | 说明 |
|--------|---------|------|
| 市场流程/实体/审核 | `[CUSTOM]` | 业务差异层 |
| 发布与文件托管 | GitHub API | Release + Asset 即对象存储 + CDN |
| 安全扫描 | npm audit | 漏洞库社区维护 |
| 评分防刷 | DB 唯一约束 + Upstash Ratelimit | 不手写风控 |
| 分成结算 | Stripe Connect | 资金流合规 |

多租户与许可校验复用 [19-multi-tenancy](./19-multi-tenancy.md) 的租户上下文与 RLS。

## 2. 数据模型 [CUSTOM]

```typescript
// packages/core/src/marketplace/types.ts
// [CUSTOM] 市场实体：Publisher/Listing/Review 是产品概念，无成熟替代
export interface Listing {
  id: string;
  publisherId: string;
  slug: string;
  version: string;
  displayName: string;
  description: string;
  tags: string[];
  packageUrl: string;
  installCount: number;
  pricing: { type: 'free' | 'paid' | 'subscription'; priceCents?: number; monthlyPriceCents?: number };
  reviewStatus: 'pending' | 'approved' | 'rejected' | 'suspended';
  minAgentCoreVersion: string;
  publishedAt: number;
}

export interface Review {
  id: string;
  listingId: string;
  userId: string;
  rating: number;
  content: string;
  createdAt: number;
}
```

## 3. Publishing API

### 3.1 发布流程编排 [CUSTOM]

发布流程（验证 → 扫描 → 上传 → 登记审核）是产品流程，保留 `[CUSTOM]`。**上传这一步调用 GitHub API**——Release 提供版本化对象存储，Asset URL 直接作为下载地址。

```typescript
// packages/core/src/marketplace/publish.ts
import { Octokit } from '@octokit/rest';
import { createReadStream } from 'fs';
import semver from 'semver';

// [CUSTOM] 业务校验：Skill 包的 manifest 字段是产品概念
export async function validateManifest(manifest: Record<string, unknown>): Promise<void> {
  const required = ['name', 'version', 'description', 'author', 'entry'];
  for (const key of required) {
    if (!manifest[key]) throw new Error(`manifest.json missing required field: ${key}`);
  }
  if (!semver.valid(String(manifest.version))) {
    throw new Error(`Invalid semver: ${manifest.version}`);
  }
}

// 文件托管与分发：GitHub Release Asset（成熟服务）
export async function uploadToGitHubRelease(options: {
  owner: string;
  repo: string;
  tag: string;
  packagePath: string;
  manifest: Record<string, unknown>;
}): Promise<string> {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const release = await octokit.rest.repos.createRelease({
    owner: options.owner,
    repo: options.repo,
    tag_name: options.tag,
    name: String(options.manifest.name),
  });
  await octokit.rest.repos.uploadReleaseAsset({
    owner: options.owner,
    repo: options.repo,
    release_id: release.data.id,
    name: `${String(options.manifest.name)}-${String(options.manifest.version)}.tar.gz`,
    data: createReadStream(options.packagePath) as unknown as Buffer,
  });
  return release.data.html_url;
}
```

### 3.2 安全扫描：npm audit

**不手写恶意代码规则库**。依赖漏洞交给 `npm audit`（成熟 CLI，漏洞库社区维护）；SKILL 文件级别的行为规则（`eval`、`child_process` 直调）作为 `[CUSTOM]` 业务规则留在发布流水线里。

```typescript
// packages/core/src/marketplace/security-scan.ts
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function auditDependencies(packageDir: string): Promise<{
  critical: number;
  high: number;
  vulnerablePackages: string[];
}> {
  const { stdout } = await execFileAsync('npm', ['audit', '--json'], { cwd: packageDir });
  const report = JSON.parse(stdout) as {
    metadata: { vulnerabilities: Record<string, number> };
    vulnerabilities: Record<string, { severity: string }>;
  };
  return {
    critical: report.metadata.vulnerabilities.critical ?? 0,
    high: report.metadata.vulnerabilities.high ?? 0,
    vulnerablePackages: Object.entries(report.vulnerabilities)
      .filter(([, v]) => v.severity === 'critical' || v.severity === 'high')
      .map(([name]) => name),
  };
}
```

> 🤖 **AI 常见错误**：把发布上传直接 POST 到自建存储服务器，既没有版本化也没有 CDN。正确做法：用 GitHub Release Asset，自动获得版本化下载 URL 与流量分发。

### 3.3 REST API 端点（薄胶水）

```typescript
// packages/core/src/marketplace/store.ts
import { db } from '@/lib/db';

export class MarketplaceStore {
  // [CUSTOM] 登记 listing 到业务表（审核状态机是产品差异）
  async createListing(
    manifest: Record<string, unknown>,
    packageFile: File,
  ): Promise<{ id: string; reviewStatus: string }> {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO listings (id, slug, version, display_name, description, review_status, published_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now())`,
      [id, String(manifest.name), String(manifest.version), String(manifest.displayName ?? manifest.name), String(manifest.description ?? '')],
    );
    return { id, reviewStatus: 'pending' };
  }
}
```

```typescript
// apps/web/src/app/api/marketplace/listings/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { MarketplaceStore } from '@agentcore/core/marketplace/store';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const manifestRaw = form.get('manifest') as string | null;
  const packageFile = form.get('package') as File | null;
  if (!manifestRaw || !packageFile) {
    return NextResponse.json({ error: 'Missing manifest or package' }, { status: 400 });
  }
  const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
  const store = new MarketplaceStore();
  const listing = await store.createListing(manifest, packageFile);
  return NextResponse.json({ listingId: listing.id, reviewStatus: listing.reviewStatus }, { status: 201 });
}
```

## 4. Discovery API

**搜索/过滤/排序在 SQL 里做**（数据库配置），不写内存推荐引擎。唯一业务算法是**贝叶斯平均**——防止新 Skill 1 个五星就霸榜，这是 marketplace 业务规则，`[CUSTOM]`。

```typescript
// packages/core/src/marketplace/discovery.ts
// [CUSTOM] 评分排序：贝叶斯平均是 marketplace 业务规则（无开源库直接覆盖）
export function bayesianScore(
  avgRating: number,
  reviewCount: number,
  globalMean: number,
  minReviews: number,
): number {
  return (avgRating * reviewCount + globalMean * minReviews) / (reviewCount + minReviews);
}
```

```typescript
// apps/web/src/app/api/marketplace/discover/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const category = searchParams.get('category');
  // 排序在 SQL 中完成；bayes_rating 是数据库函数（见 migrations/007_marketplace.sql）
  const rows = await db.query(
    `SELECT id, slug, display_name, description, install_count,
            bayes_rating(listing_id) AS rating
     FROM listings
     WHERE review_status = 'approved'
       AND ($1::text IS NULL OR category = $1)
     ORDER BY rating DESC, install_count DESC
     LIMIT 20`,
    [category],
  );
  return NextResponse.json({ items: rows });
}
```

## 5. Review & Rating

防刷 = **数据库唯一约束**（一个用户一个 Skill 一条评价）+ **Upstash Ratelimit**（24h 频率限制）。

```typescript
// packages/core/src/marketplace/review.ts
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const reviewLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '24 h'),
  prefix: 'marketplace:reviews',
});

export async function submitReview(params: {
  listingId: string;
  userId: string;
  rating: number;
  content: string;
}): Promise<void> {
  const res = await reviewLimit.limit(params.userId);
  if (!res.success) throw new Error('Too many reviews in 24 hours');
  // UNIQUE(listing_id, user_id) 由数据库保证，应用层只捕获冲突
  await db.query(
    `INSERT INTO reviews (listing_id, user_id, rating, content)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (listing_id, user_id)
     DO UPDATE SET rating = $3, content = $4, updated_at = now()`,
    [params.listingId, params.userId, params.rating, params.content],
  );
}
```

## 6. Revenue Sharing：Stripe Connect

**资金流交给 Stripe Connect**——支付在 Stripe 完成，开发者分成通过 `transfers.create` 结算到开发者 Connect 账户。分成比例是业务配置 `[CUSTOM]`。

```typescript
// packages/core/src/marketplace/revenue.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// [CUSTOM] 分成比例：产品决策（70/30），资金结算由 Stripe Connect 完成
export const DEVELOPER_SHARE = 0.7;

export async function payoutToDeveloper(params: {
  connectAccountId: string;
  grossCents: number;
  currency: string;
}): Promise<void> {
  await stripe.transfers.create({
    amount: Math.floor(params.grossCents * DEVELOPER_SHARE),
    currency: params.currency,
    destination: params.connectAccountId,
  });
}
```

> 🤖 **AI 常见错误**：自己维护"开发者余额"账本并用定时任务打款。余额、手续费、退款都应该由 Stripe 记账，业务表只存 `stripeAccountId` 关联，避免资金对不上。

## 7. 兼容性与安装

版本兼容判断用 `semver`（成熟库），安装后的沙箱执行在 [04-sandbox](./04-sandbox.md)，市场只负责校验与登记。

```typescript
// packages/core/src/marketplace/install.ts
import { compare } from 'semver';

export function checkCompatibility(
  currentVersion: string,
  minAgentCoreVersion: string,
  maxAgentCoreVersion?: string,
): { ok: boolean; reason?: string } {
  if (compare(currentVersion, minAgentCoreVersion) < 0) {
    return { ok: false, reason: `Requires Agent Core >= ${minAgentCoreVersion}` };
  }
  if (maxAgentCoreVersion && compare(currentVersion, maxAgentCoreVersion) > 0) {
    return { ok: false, reason: `Not compatible with Agent Core > ${maxAgentCoreVersion}` };
  }
  return { ok: true };
}
```

## 8. 前端：Marketplace Portal

Marketplace Portal（分类侧栏、列表网格、详情面板、开发者收入面板）是产品 UI，用现有组件库组装，数据全部来自上面的 API。评分展示、安装按钮、收入图表的具体设计属于产品设计，不在本 reference 展开。

## 9. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| 上传的 Skill 含恶意代码 | 没有扫描就入库 | `npm audit` + 发布流水线强制扫描，critical 直接拒绝 |
| 评分被刷榜 | 无防御评分系统 | 唯一约束 + Upstash Ratelimit + 贝叶斯平均 |
| 开发者收入不透明 | 手写账本 | Stripe Connect 转账记录即账本，开发者后台直接查 Stripe |
| 同名 Skill 冲突 | slug 无唯一约束 | slug 加 publisher 前缀 `{publisher-slug}/{skill-name}` |
| 付费 Skill 被共享 | License 不绑定设备 | License 绑定 `tenantId + deviceFingerprint`，校验见 19 层 |
| 安装后版本不兼容崩溃 | 未做版本检查 | `semver` 检查 `minAgentCoreVersion` |

## 10. AI 避坑追加

> 🤖 **AI 常见错误**：
>
> 1. **安装时不做代码扫描** — 直接 `npm install` 含 `postinstall` 钩子的包，可执行任意系统命令。**AST 检查**：安装前扫描 `package.json` 的 `scripts`，含 `preinstall/postinstall/prepare` 直接拒绝；所有 `.js/.ts` 文件检测 `eval(`、`Function(`、`child_process.exec(`。
>
> 2. **SKILL.md frontmatter 注入攻击** — 把第三方 `description` 直接拼入 system prompt，可被 "ignore previous instructions" 注入。**检查方式**：外部 markdown 的 frontmatter 必须经 `PromptSanitizer` 处理，description 长度 ≤ 500 字符。
>
> 3. **评分排序用算术平均** — 新 Skill 1 个 5 星就排头部，老 Skill 1000 个 4.8 分靠后。**检查方式**：排序必须用贝叶斯平均，禁止裸 `.sort((a, b) => b.avgRating - a.avgRating)`。

## 11. 本层验收清单

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/marketplace/*.ts` 与市场页面全部通过。
- [ ] **安全扫描**：运行 `pnpm vitest run marketplace/security-scan`，用含 `postinstall` 钩子与 `eval(` 的恶意样例包，断言扫描返回 critical 且安装被中止。
- [ ] **发布流程**：运行 `pnpm vitest run marketplace/publish`，mock GitHub API，断言 release 创建、asset 上传、listing 登记依次发生。
- [ ] **评分防刷**：运行 `pnpm vitest run marketplace/review`，断言同一用户 24h 内第 11 次评价被拒绝；同一 `(listing_id, user_id)` 只存在一行。
- [ ] **分成结算**：运行 `pnpm vitest run marketplace/revenue`，mock Stripe `transfers.create`，断言金额 = `grossCents * DEVELOPER_SHARE` 取整。
- [ ] **门禁回归**：`node tools/check-skill.mjs` 本文件 0 失败。

---

*本节点属于 Layer 4 生态层。Marketplace 的核心是"信任"：用户信任安装的 Skill 不盗数据，开发者信任平台不吞收入，平台信任审核不漏恶意代码。信任靠机制建立：npm audit 管依赖、GitHub Release 管分发、Stripe Connect 管资金、唯一约束 + 限流管评分。上线策略：先邀请制（只允许已验证开发者发布），再开放制。*
