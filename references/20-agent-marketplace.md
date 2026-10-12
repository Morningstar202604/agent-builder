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


### 2.1 发布来源：四个渠道

Marketplace 不是只能“直传压缩包”。2026 年 Agent 生态的成熟分发渠道有四种，`Listing` 需要记录来源以走不同的审核与扫描流程：

| source | 含义 | 文件托管 | 安全扫描 |
|--------|------|---------|---------|
| `direct-upload` | 直传 tar.gz | GitHub Release Asset | npm/pnpm audit + TruffleHog |
| `npm` | npm 包 | npm Registry + CDN | npm audit + Sigstore provenance |
| `mcp-registry` | MCP 官方 Registry | registry.modelcontextprotocol.io | MCP Inspector + audit |
| `github-marketplace` | GitHub 应用市场 | GitHub Marketplace | 平台审核 + TruffleHog |

```typescript
// packages/core/src/marketplace/types.ts
// [CUSTOM] 扩展实体：来源与校验信息随发布渠道增加

export type ListingSource = 'direct-upload' | 'npm' | 'mcp-registry' | 'github-marketplace';

export interface McpServerListing {
  id: string;
  listingId: string;               // 关联主 Listing
  mcpServerUrl?: string;            // 远程 Streamable HTTP 地址（生产）
  command?: string;                 // stdio 启动命令（本机调试场景）
  tools: Array<{ name: string; description: string }>;
  verified: boolean;                // 是否通过官方 Inspector 验证
}

export interface PackageArtifact {
  url: string;
  sha256: string;
  sizeBytes: number;
  license: string;
  signature?: string;                // Sigstore 签名（npm provenance）
}
```

### 2.2 版本与许可

`Listing.version` 必须严格遵循 semver，兼容性判断复用 [20 层自身的 `checkCompatibility`](#7-兼容性与安装) 与 `semver` 库。付费 Skill 的许可绑定策略见 7 节与 [19-multi-tenancy](./19-multi-tenancy.md) 的 License 校验。


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


#### 3.2.1 依赖审计：npm audit 与 pnpm audit

仓库是 pnpm workspace 时用 `pnpm audit`（同样基于 npm 漏洞库，但覆盖全部 workspace 包）；纯 npm 项目继续用 `npm audit`。两者都支持 `--json`，且发现高危漏洞时**以非零码退出但 stdout 仍输出 JSON**——所以要在 catch 里解析 stdout，而不是把非零退出码直接当失败：

```typescript
// packages/core/src/marketplace/security-scan-v2.ts —— pnpm audit（workspace 全覆盖）
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ScanReport {
  dependencyRisk: 'pass' | 'fail';
  secretRisk: 'pass' | 'fail';
  findings: string[];
}

export async function scanPackage(packageDir: string): Promise<ScanReport> {
  const [dependency, secrets] = await Promise.all([
    auditWithPnpm(packageDir),
    scanSecrets(packageDir),
  ]);

  return {
    dependencyRisk: dependency.ok ? 'pass' : 'fail',
    secretRisk: secrets.ok ? 'pass' : 'fail',
    findings: [...dependency.findings, ...secrets.findings],
  };
}

async function auditWithPnpm(packageDir: string): Promise<{ ok: boolean; findings: string[] }> {
  try {
    const { stdout } = await execFileAsync('pnpm', ['audit', '--json', '--audit-level', 'high'], {
      cwd: packageDir,
    });
    return parseAuditJson(stdout);
  } catch (err) {
    // pnpm audit 在发现漏洞时非零退出，但 stdout 仍包含 JSON
    const stdout = (err as { stdout?: string }).stdout;
    if (stdout) return parseAuditJson(stdout);
    return { ok: false, findings: [err instanceof Error ? err.message : String(err)] };
  }
}

function parseAuditJson(stdout: string): { ok: boolean; findings: string[] } {
  const report = JSON.parse(stdout) as {
    metadata: { vulnerabilities: Record<string, number> };
  };
  const critical = report.metadata.vulnerabilities.critical ?? 0;
  const high = report.metadata.vulnerabilities.high ?? 0;
  return { ok: critical === 0 && high === 0, findings: [`critical=${critical}`, `high=${high}`] };
}
```

> 说明：`scanPackage` 返回的 `findings` 是给审核人员看的摘要，完整 JSON 存审计日志（[19-multi-tenancy](./19-multi-tenancy.md) 的审计表）。

#### 3.2.2 密钥扫描：TruffleHog

依赖漏洞只覆盖依赖树，**源码里泄露的密钥要靠 TruffleHog 扫**。发布流水线对解压后的包目录执行 `trufflehog filesystem --json`，任何命中直接拒绝发布：

```typescript
async function scanSecrets(packageDir: string): Promise<{ ok: boolean; findings: string[] }> {
  try {
    const { stdout } = await execFileAsync(
      'trufflehog',
      ['filesystem', '--json', '--no-update', packageDir],
      { timeout: 60_000 },
    );
    const lines = stdout.trim().split('\n').filter((line) => line.length > 0);
    return { ok: lines.length === 0, findings: lines.slice(0, 10) };
  } catch (err) {
    return { ok: false, findings: [err instanceof Error ? err.message : String(err)] };
  }
}
```

**为什么 TruffleHog 而不是只靠 git ignore**：开发者可能把 `.env` 误提交、把测试密钥写进 fixture、或把云服务 AK 硬编码在源码里。TruffleHog 对常见密钥格式（AWS、GitHub、Stripe、OpenAI 等）做熵检测与正则匹配，比人工 review 可靠得多。

#### 3.2.3 AST 行为扫描（业务规则）[CUSTOM]

依赖与密钥之外，还需要拦截“Skill 包在安装后执行危险操作”。这是平台安全策略，无成熟开源替代，保留 `[CUSTOM]`——但扫描器本身只做正则/AST 匹配，不实现沙箱（沙箱见 [04-sandbox](./04-sandbox.md)）：

```typescript
// packages/core/src/marketplace/ast-scan.ts —— [CUSTOM] 业务规则：拒绝危险 API
import { readFile } from 'fs/promises';

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\beval\s*\(/, reason: 'eval is forbidden' },
  { pattern: /\bnew\s+Function\s*\(/, reason: 'Function constructor is forbidden' },
  { pattern: /child_process\s*\.\s*exec\s*\(/, reason: 'child_process.exec is forbidden' },
  { pattern: /process\s*\.\s*binding\s*\(/, reason: 'native binding is forbidden' },
];

export async function scanSourceFiles(files: string[]): Promise<string[]> {
  const findings: string[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    for (const item of DANGEROUS_PATTERNS) {
      if (item.pattern.test(content)) {
        findings.push(`${file}: ${item.reason}`);
      }
    }
  }
  return findings;
}
```

发布流水线的完整顺序：**解包 → `pnpm audit` → `trufflehog filesystem` → AST 扫描 → 全部通过才登记 Listing**。任一步 `fail` 直接置 `reviewStatus = 'rejected'` 并通知开发者。


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


### 8.1 开发者收入面板 API

开发者收入面板不能直接高频查 Stripe（Stripe API 有速率限制，且聚合查询不适合在线渲染）。正确做法：**每晚用定时任务把 Stripe 汇总同步到业务表 `developer_earnings`**，面板只读业务表：

```typescript
// packages/core/src/marketplace/earnings.ts —— 收入面板只读业务表
import { db } from '@/lib/db';

export interface EarningsSummary {
  listingId: string;
  grossCents: number;
  platformFeeCents: number;
  netCents: number;
  periodStart: string;
  periodEnd: string;
}

export async function listEarnings(developerId: string): Promise<EarningsSummary[]> {
  const rows = await db.query(
    `SELECT listing_id, gross_cents, platform_fee_cents, net_cents,
            period_start, period_end
     FROM developer_earnings
     WHERE developer_id = $1
     ORDER BY period_end DESC
     LIMIT 100`,
    [developerId],
  );
  return rows;
}
```

**同步任务设计**：

1. 每日 UTC 0 点跑一次（`BullMQ` 定时任务，见 [24-product-layer](./24-product-layer.md)）。
2. 对每个开发者的 Connect 账户调用 Stripe 的余额交易/发票接口，把净额写入 `developer_earnings`。
3. 同步任务只写业务表，**不做任何资金操作**——资金仍由 Stripe 记账。
4. 面板上的“提现”按钮直接跳转 Stripe 托管 onboarding/管理页，业务侧不实现转账 UI。

**为什么不能实时查 Stripe**：Stripe 的 `balance_transactions` 是账本视图，高频查询容易被限流；而且它返回的是“已发生交易”，不包含“已产生待入账的计量用量”，面板数字会跳动。业务表的快照口径与发票周期一致，更稳定。


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


## 12. MCP 工具发布到官方 Registry

MCP 是工具连接的事实标准（[14-mcp-server-dev](./14-mcp-server-dev.md)）。2026 年 MCP 官方 Registry（registry.modelcontextprotocol.io，preview）已收录近万个列表，是 Agent 工具被发现的主要入口。发布流程：

1. 用 `@modelcontextprotocol/sdk` 实现 MCP Server（stdio 或 Streamable HTTP，见 [14-mcp-server-dev](./14-mcp-server-dev.md)）。
2. 本地用 `@modelcontextprotocol/inspector` 逐工具验证：调用、参数、错误路径都要跑通。
3. 把 MCP Server 发布为 npm 包（`npm publish --provenance`，见 14 节供应链安全）。
4. 在 Registry 提交 listing：远程服务器填 `serverUrl`（Streamable HTTP + OAuth 2.1），本机工具填 `command`（stdio）。
5. 平台审核通过后，用户可在 Agent 配置里一键安装；`verified: true` 的列表获得更高权重。

```typescript
// packages/core/src/marketplace/mcp-registry.ts
// [CUSTOM] 组装提交到 MCP 官方 Registry 的清单数据（Registry 为 preview，字段以官方文档为准）
import type { McpServerListing } from './types';

export function buildMcpRegistryPayload(listing: McpServerListing): Record<string, unknown> {
  return {
    name: listing.listingId,
    description: listing.tools.map((t) => t.description).join(' ').slice(0, 500),
    tools: listing.tools.map((t) => t.name),
    serverUrl: listing.mcpServerUrl,
    command: listing.command,
    verified: listing.verified,
  };
}
```

**审核通过的关键**：Registry 只接受“验证过能跑”的服务器。提交前用官方 Inspector 走一遍工具调用，把输出结果附在审核备注里；同时在 `README` 写清 `serverUrl`/`command` 与环境变量（注意不要写真实密钥）。

## 13. GitHub 应用市场发布

如果产品形态是 GitHub App（如自动 PR 审查 Agent、代码扫描机器人），走 GitHub Marketplace 发布：

1. 用 **GitHub App Manifest** 一键创建应用（`POST /app-manifests/{code}/conversions`），免去手工填表单。
2. 配置权限（Contents: read、Pull requests: write 等）与 Webhook 事件。
3. 提交 Marketplace listing 审核（名称、图标、定价计划、隐私政策）。
4. 审核通过后，用户通过 `installation` 安装应用，你拿到 `installation_token` 调用 GitHub API。

```typescript
// server/src/marketplace/github-app-manifest.ts —— GitHub App 市场接入
import { Octokit } from '@octokit/rest';

export async function convertAppManifest(code: string): Promise<{ id: number; slug: string }> {
  const octokit = new Octokit();
  const { data } = await octokit.request('POST /app-manifests/{code}/conversions', { code });
  return { id: data.id, slug: data.slug };
}
```

**注意**：GitHub Marketplace 对 `installation` 权限有严格审核，需要说明每个权限的用途；应用市场与普通 OAuth App 不同，不能静默要求超出权限。Webhook 的幂等消费继续复用 [24-product-layer](./24-product-layer.md) 的模式。

## 14. 供应链安全：签名与校验

### 14.1 SHA-256 校验

所有下载包在安装前必须校验哈希。发布时计算并登记 `PackageArtifact.sha256`，安装器在解包前重新计算：

```typescript
// packages/core/src/marketplace/verify-artifact.ts
import { createHash } from 'crypto';
import { createReadStream } from 'fs';

export async function sha256OfFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function verifySha256(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}
```

### 14.2 npm provenance / Sigstore

npm 包的发布者身份用 Sigstore 签名验证。`npm publish --provenance` 在 GitHub Actions 中自动生成签名，消费者用 `npm audit signatures` 或 `sigstore verify` 验证。流水线里的发布命令（[09-deploy](./09-deploy.md) 的 CI 模板）：

```bash
# 在 GitHub Actions 中发布带 provenance 的包
npm publish --provenance --access public
```

### 14.3 安装器校验流程

```typescript
// packages/core/src/marketplace/installer.ts
import { checkCompatibility } from './install';
import { sha256OfFile, verifySha256 } from './verify-artifact';
import type { PackageArtifact } from './types';

export async function verifyBeforeInstall(params: {
  artifact: PackageArtifact;
  currentAgentCoreVersion: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const compat = checkCompatibility(
    params.currentAgentCoreVersion,
    '0.1.0', // minAgentCoreVersion 来自 Listing
  );
  if (!compat.ok) return { ok: false, reason: compat.reason };

  const actual = await sha256OfFile(params.artifact.url);
  if (!verifySha256(actual, params.artifact.sha256)) {
    return { ok: false, reason: 'sha256 mismatch' };
  }

  return { ok: true };
}
```

> 说明：真实实现中 `minAgentCoreVersion` 从 `Listing` 读取，上面的 `'0.1.0'` 只是示意占位。校验通过后的解压、沙箱执行见 [04-sandbox](./04-sandbox.md)。

## 15. 评分与分成进阶：Stripe Connect

### 15.1 付费安装：Checkout 实时分账

一次付费安装用 **Checkout + transfer_data** 实时分账：平台手续费 `application_fee_amount`，开发者分成在支付时自动转出，不需要事后定时打款：

```typescript
// packages/core/src/marketplace/connect-checkout.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function createPaidListingCheckout(params: {
  listingName: string;
  priceCents: number;
  platformFeeCents: number;
  developerConnectAccountId: string;
}): Promise<string> {
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: params.listingName },
          unit_amount: params.priceCents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: params.platformFeeCents,
      transfer_data: {
        destination: params.developerConnectAccountId,
      },
    },
    success_url: 'https://marketplace.example.com/install?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://marketplace.example.com/cancel',
  });

  return session.url ?? '';
}
```

**金额一律用整数分**，禁止浮点运算；`platformFeeCents` 由 6 节的分成比例计算得出，且必须满足 Stripe 的平台费上下限规则。

### 15.2 开发者 KYC：Connect Onboarding

开发者第一次注册时，引导到 Stripe 的托管 onboarding 完成 KYC：

```typescript
// packages/core/src/marketplace/connect-onboarding.ts
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function createOnboardingLink(accountId: string): Promise<string> {
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: 'https://marketplace.example.com/dev/settings/connect',
    return_url: 'https://marketplace.example.com/dev/earnings',
    type: 'account_onboarding',
  });
  return link.url;
}
```

KYC 完成前，开发者 Listing 只能免费发布；KYC 通过后解锁付费发布与提现。这是合规要求，不是产品功能。

### 15.3 订阅分成

订阅类 Skill 的每次续费都要分成。用 `subscriptions` 模式 + `invoice.created` Webhook 监听下一张发票，把 `application_fee_percent` 设成分成比例。Webhook 幂等键见 [24-product-layer](./24-product-layer.md)。

## 16. Trust & Safety：下架与申诉

### 16.1 审核状态机

审核状态机的合法迁移只有四条边，用函数约束而不是散落 if：

```typescript
// packages/core/src/marketplace/moderation.ts
// [CUSTOM] 审核状态机：pending → approved / rejected；approved ⇄ suspended
import type { Listing } from './types';

export type ModerationAction = 'approve' | 'reject' | 'suspend' | 'reinstate';

export function transition(listing: Listing, action: ModerationAction): Listing {
  const next = { ...listing };

  if (action === 'approve') {
    if (listing.reviewStatus !== 'pending') throw new Error('only pending can be approved');
    next.reviewStatus = 'approved';
  } else if (action === 'reject') {
    if (listing.reviewStatus !== 'pending') throw new Error('only pending can be rejected');
    next.reviewStatus = 'rejected';
  } else if (action === 'suspend') {
    if (listing.reviewStatus !== 'approved') throw new Error('only approved can be suspended');
    next.reviewStatus = 'suspended';
  } else if (action === 'reinstate') {
    if (listing.reviewStatus !== 'suspended') throw new Error('only suspended can be reinstated');
    next.reviewStatus = 'approved';
  }

  return next;
}
```

### 16.2 申诉流

- 被 `rejected` 的开发者可以在 7 天内提交申诉（补充扫描报告、说明误报）。
- 申诉单进入人工队列，管理员在后台复核；复核动作本身写入审计日志（[19-multi-tenancy](./19-multi-tenancy.md) 的 `audit_logs`）。
- `suspended` 的 Listing 立即从 Discovery API 消失，但已安装用户保留（许可校验在 [19-multi-tenancy](./19-multi-tenancy.md) 层执行）。

## 17. AI 避坑追加

> 🤖 **AI 常见错误**：

> 1. **只在根目录跑依赖审计** — 发布包是子目录，根目录 `npm audit` 扫不到。**检查方式**：`pnpm audit` 必须在 workspace 根执行（pnpm 自动覆盖全部包）；npm 项目进入 `packageDir` 再执行。

> 2. **只扫依赖不扫源码** — 依赖再干净，源码里硬编码的云密钥照样泄露。**检查方式**：发布流水线必须包含 `trufflehog filesystem --json`，命中即拒绝。

> 3. **Stripe 金额用浮点** — `0.7 * 19.99` 得到 13.993，转成分会丢精度。**检查方式**：所有金额 `Math.round` 成整数分后再传给 Stripe，测试断言 `amount % 1 === 0`。

> 4. **MCP Registry 提交前不验证** — 工具列表与描述是手工填的，审核被拒。**检查方式**：提交前用 `@modelcontextprotocol/inspector` 跑通每个工具，`verified: true` 由平台侧标记。

> 5. **审核状态机散落在各处** — 在 `approve` 和 `suspend` 逻辑里各写一份状态判断，状态可达性不可控。**检查方式**：所有状态变更走 `transition()` 单函数，非法迁移直接抛错。

## 18. 本层验收清单（追加）

- [ ] **安全扫描**：运行 `pnpm vitest run marketplace/security-scan-v2`，用含高危依赖、源码密钥、`eval(` 的恶意样例包，断言 `scanPackage` 返回 `dependencyRisk: fail` / `secretRisk: fail`，且安装被中止。
- [ ] **哈希校验**：运行 `pnpm vitest run marketplace/verify-artifact`，断言 `verifySha256` 对篡改包返回 `false`。
- [ ] **MCP Registry**：运行 `pnpm vitest run marketplace/mcp-registry`，断言 `buildMcpRegistryPayload` 输出含 `serverUrl`/`tools`/`verified` 字段，且 `description` 长度 ≤ 500。
- [ ] **GitHub 市场**：mock `octokit.request('POST /app-manifests/{code}/conversions')`，断言返回 `id` 与 `slug`。
- [ ] **实时分账**：mock `stripe.checkout.sessions.create`，断言 `payment_intent_data.application_fee_amount` 与 `transfer_data.destination` 正确传入。
- [ ] **审核状态机**：运行 `pnpm vitest run marketplace/moderation`，断言四条合法迁移成功、非法迁移（如 `pending → suspended`）抛错。
- [ ] **门禁回归**：`node tools/check-skill.mjs` 本文件 0 失败。


---

*本节点属于 Layer 4 生态层。Marketplace 的核心是"信任"：用户信任安装的 Skill 不盗数据，开发者信任平台不吞收入，平台信任审核不漏恶意代码。信任靠机制建立：npm audit 管依赖、GitHub Release 管分发、Stripe Connect 管资金、唯一约束 + 限流管评分。上线策略：先邀请制（只允许已验证开发者发布），再开放制。*
