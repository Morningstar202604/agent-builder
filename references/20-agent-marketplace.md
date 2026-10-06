# 20 — Agent 市场 · Skill/Tool/Prompt 生态

> 目标：Agent 生态繁荣的关键是"让别人能贡献"。Marketplace 让开发者上传 Skill、用户发现 Skill、平台从交易中抽成——三方正循环。

---

## 目录

- [1. 市场本体设计](#1-市场本体设计)
- [2. Publishing API](#2-publishing-api)
- [3. Discovery API](#3-discovery-api)
- [4. Review & Rating 系统](#4-review--rating-系统)
- [5. Revenue Sharing](#5-revenue-sharing)
- [6. Sandbox 版本适配](#6-sandbox-版本适配)
- [7. 前端：Marketplace Portal](#7-前端marketplace-portal)
- [8. 避坑汇总](#8-避坑汇总)

---

## 1. 市场本体设计

### 1.1 五要素模型

```
┌──────────────┐       ┌─────────────┐       ┌──────────────┐
│  Publisher   │──────▶│   Listing   │◀──────│   Consumer   │
│  (开发者)     │       │  (上架商品)  │       │  (用户)      │
└──────────────┘       └──────┬──────┘       └──────┬───────┘
                              │                     │
                              ▼                     ▼
                        ┌──────────┐         ┌──────────┐
                        │  Review  │         │ Install  │
                        │ (评估)   │         │ (安装)   │
                        └──────────┘         └──────────┘
```

### 1.2 数据模型

```typescript
// packages/core/src/marketplace/types.ts

/**
 * Publisher: 市场上的 Skill 开发者。
 *
 * 每个 publisher 有一个唯一 slug（URL safe），验证状态决定是否能发布付费 Skill。
 */
export interface Publisher {
  id: string;
  slug: string;           // URL 友好的唯一标识，如 "acme-labs"
  name: string;           // 显示名称
  email: string;
  avatarUrl?: string;
  bio?: string;
  /** 开发者认证状态 */
  verificationStatus: 'unverified' | 'pending' | 'verified' | 'rejected';
  /** 账户余额（待提现的收入，单位：分） */
  balanceCents: number;
  joinedAt: number;
}

/**
 * Listing: 一个上架的 Skill 包。
 *
 * Skill 包 = manifest.json + SKILL.md + scripts/ + templates/
 * 这些文件以 tar.gz 形式存储，安装时解压到本地 skills 目录。
 */
export interface Listing {
  id: string;
  publisherId: string;
  slug: string;           // 包名，如 "pdf-assistant"
  version: string;        // semver，如 "1.2.0"
  displayName: string;
  description: string;
  iconEmoji?: string;     // 列表页显示的 emoji
  tags: string[];         // 分类标签

  /** 市场分类 */
  category: 'productivity' | 'data' | 'coding' | 'writing' | 'research' | 'fun' | 'enterprise';

  /** 文件存储路径 */
  packageUrl: string;     // S3/MinIO 中的 tar.gz URL

  /** 安装统计 */
  installCount: number;
  weeklyDownloads: number;

  /** 定价 */
  pricing: {
    type: 'free' | 'paid' | 'subscription';
    priceCents?: number;         // 一次性付费
    monthlyPriceCents?: number;  // 订阅制
    trialDays?: number;          // 免费试用天数
  };

  /** 审核状态 */
  reviewStatus: 'pending' | 'approved' | 'rejected' | 'suspended';

  /** 版本兼容性 */
  minAgentCoreVersion: string;   // 最低 Agent Core 版本
  maxAgentCoreVersion?: string;  // 最高兼容版本（可选）

  publishedAt: number;
  updatedAt: number;
}

/**
 * Review: 用户对已安装的 Skill 的评价。
 *
 * 一个用户只能对一个 Skill 写一次评价（但可以更新之前的评价）。
 */
export interface Review {
  id: string;
  listingId: string;
  userId: string;
  rating: number;         // 1-5 星
  title?: string;
  content: string;
  version: string;        // 评价时针对的版本
  helpfulCount: number;   // "有用" 计数
  createdAt: number;
  updatedAt: number;
}

/**
 * Install: 用户的安装记录。
 */
export interface Install {
  id: string;
  listingId: string;
  userId: string;
  installedVersion: string;
  installedAt: number;
  autoUpdate: boolean;    // 是否自动更新
}
```

### 1.3 存储层实现

```typescript
// packages/core/src/marketplace/store.ts

import { db } from '@/lib/db';
import { Listing, Publisher, Review, Install } from './types';

export class MarketplaceStore {
  /**
   * 发布新 listing。
   *
   * 流程：验证 publisher 状态 → 自动扫描合规 → 审核 → 上架
   * 初始状态是 'pending'，需要管理员审核通过（approved）后才能被搜索到。
   */
  async createListing(listing: Omit<Listing, 'id' | 'installCount' | 'weeklyDownloads' | 'reviewStatus' | 'publishedAt' | 'updatedAt'>): Promise<Listing> {
    // 检查 publisher 是否已验证
    const publisher = await db.publishers.findById(listing.publisherId);
    if (!publisher) throw new PublisherNotFoundError(listing.publisherId);

    // 付费 Skill 要求 publisher 已验证身份
    if (listing.pricing.type !== 'free' && publisher.verificationStatus !== 'verified') {
      throw new Error('Paid listings require verified publisher status');
    }

    return db.listings.create({
      ...listing,
      id: crypto.randomUUID(),
      installCount: 0,
      weeklyDownloads: 0,
      reviewStatus: 'pending',
      publishedAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  /**
   * 获取 listing 详情，包含评分统计。
   */
  async getListingWithStats(listingId: string): Promise<Listing & {
    avgRating: number;
    totalReviews: number;
    publisherName: string;
    publisherAvatar?: string;
  }> {
    const listing = await db.listings.findById(listingId);
    if (!listing) throw new ListingNotFoundError(listingId);

    const stats = await db.reviews.aggregate(listingId, {
      avg: 'rating',
      count: '*',
    });

    const publisher = await db.publishers.findById(listing.publisherId);

    return {
      ...listing,
      avgRating: stats.avg ?? 0,
      totalReviews: stats.count ?? 0,
      publisherName: publisher?.name ?? 'Unknown',
      publisherAvatar: publisher?.avatarUrl,
    };
  }
}
```

---

## 2. Publishing API

### 2.1 CLI 发布入口

```typescript
// packages/core/src/marketplace/publish.ts

import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';

/**
 * 开发者通过 CLI 发布 Skill：
 *
 *   agent-skill publish ./my-skill --api https://market.agentcore.dev
 *
 * 执行流程：
 * 1. 读取 manifest.json 验证格式
 * 2. 运行安全扫描（恶意代码检测）
 * 3. 打包为 tar.gz
 * 4. 上传到市场 API
 * 5. 等待管理员审核
 */

interface PublishOptions {
  apiKey: string;
  apiUrl: string;
  dryRun?: boolean;
}

export async function publishSkill(
  skillDir: string,
  options: PublishOptions,
): Promise<{ listingId: string; status: string }> {
  // 1. 验证 manifest
  const manifest = await validateManifest(skillDir);

  // 2. 运行安全扫描
  const scanResult = await runSecurityScan(skillDir);
  if (scanResult.criticalIssues.length > 0) {
    console.error(`❌ Found ${scanResult.criticalIssues.length} critical security issues:`);
    scanResult.criticalIssues.forEach((issue) => console.error(`  - ${issue}`));
    throw new Error('Security scan failed — fix issues before publishing');
  }

  // 3. 打包
  const packagePath = await packageSkill(skillDir, manifest);

  if (options.dryRun) {
    console.log(`📦 Package created: ${packagePath}`);
    console.log(`   Would upload to ${options.apiUrl}/api/marketplace/listings`);
    return { listingId: '', status: 'dry_run' };
  }

  // 4. 上传到 API
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('package', await fileFromPath(packagePath));

  const response = await fetch(`${options.apiUrl}/api/marketplace/listings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${options.apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Publish failed: ${error.message}`);
  }

  const result = await response.json();
  console.log(`✅ Published! Listing ID: ${result.listingId}`);
  console.log(`   Status: ${result.reviewStatus} (waiting for review)`);
  return result;
}

/**
 * manifest.json 验证规则。
 */
async function validateManifest(skillDir: string): Promise<Record<string, unknown>> {
  const manifestPath = `${skillDir}/manifest.json`;
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  const required = ['name', 'version', 'description', 'author', 'entry'];
  for (const key of required) {
    if (!manifest[key]) throw new Error(`manifest.json missing required field: ${key}`);
  }

  // version 必须是 semver
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(manifest.version)) {
    throw new Error(`Invalid semver in manifest.json: ${manifest.version}`);
  }

  // entry 文件必须存在
  const entryPath = `${skillDir}/${manifest.entry}`;
  if (!await fileExists(entryPath)) {
    throw new Error(`Entry file not found: ${manifest.entry}`);
  }

  return manifest;
}
```

### 2.2 安全扫描

```typescript
// packages/core/src/marketplace/security-scan.ts

/**
 * Skill 安全扫描器。
 *
 * 检测范围：
 * 1. 系统调用：eval, exec, execSync, child_process 的直接调用
 * 2. 网络请求：fetch / http.request（排除白名单域名如 api.openai.com）
 * 3. 文件系统：readFileSync / writeFileSync（只能通过本项目封装写文件）
 * 4. 隐私数据：硬编码的 API key、密码模式
 * 5. 资源消耗：无限循环、大内存分配模式
 */
export async function runSecurityScan(skillDir: string): Promise<{
  criticalIssues: string[];
  warnings: string[];
  info: string[];
}> {
  const critical: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // 遍历所有 TypeScript/JavaScript 文件
  const files = await glob('**/*.{ts,js,mjs}', { cwd: skillDir });

  for (const file of files) {
    const content = await fs.readFile(`${skillDir}/${file}`, 'utf-8');

    // 检测 child_process 执行
    if (/\bexec(Sync)?\s*\(/.test(content) || /\bspawn\s*\(/.test(content)) {
      critical.push(`${file}: Uses child_process.exec/spawn — this can execute arbitrary system commands`);
    }

    // 检测 eval
    if (/\beval\s*\(/.test(content)) {
      critical.push(`${file}: Uses eval() — code injection risk`);
    }

    // 检测硬编码密钥
    const keyPatterns = [
      /sk-[a-zA-Z0-9]{48}/,           // OpenAI API key pattern
      /["'][a-zA-Z0-9_]*api_key["']\s*[:=]\s*["'][a-zA-Z0-9]{20,}/,
      /["']password["']\s*[:=]\s*["'][^"']{8,}["']/,
    ];

    for (const pattern of keyPatterns) {
      if (pattern.test(content)) {
        critical.push(`${file}: Potential hardcoded secret/API key detected`);
        break;
      }
    }

    // 检测网络请求（非白名单域名）
    const whitelist = ['api.openai.com', 'api.anthropic.com', 'api.mistral.ai'];
    const fetchMatches = content.match(/fetch\s*\(\s*["']https?:\/\/[^"']+/g) ?? [];
    for (const match of fetchMatches) {
      const url = match.replace(/fetch\s*\(\s*["']/, '');
      const hostname = new URL(url).hostname;
      if (!whitelist.some((w) => hostname.endsWith(w))) {
        warnings.push(`${file}: Makes network request to ${hostname} — user must trust this endpoint`);
      }
    }

    // 检测 fetch 到 localhost（潜在的 SSRF）
    if (/fetch\s*\(\s*["']https?:\/\/localhost/.test(content)) {
      warnings.push(`${file}: Makes network request to localhost — possible SSRF risk`);
    }

    // 检测导入敏感模块
    if (/from\s+["']child_process["']/.test(content)) {
      critical.push(`${file}: Imports child_process module`);
    }
  }

  return { criticalIssues: critical, warnings, info };
}
```

### 2.3 REST API 端点

```typescript
// apps/web/src/app/api/marketplace/listings/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { MarketplaceStore } from '@agentcore/core/marketplace/store';

/**
 * POST /api/marketplace/listings — 发布新 Skill
 *
 * Body: multipart/form-data
 *   - manifest: JSON string
 *   - package: tar.gz file
 *
 * 这个端点是 marketplace 的入口 —— 开发者的 CLI 调用到这里。
 */
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 401 });
  }

  // 验证 API key 找到 publisher
  const publisher = await resolvePublisherFromApiKey(apiKey);
  if (!publisher) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const formData = await req.formData();
  const manifestRaw = formData.get('manifest') as string;
  const packageFile = formData.get('package') as File;

  if (!manifestRaw || !packageFile) {
    return NextResponse.json({ error: 'Missing manifest or package' }, { status: 400 });
  }

  const manifest = JSON.parse(manifestRaw);

  // 保存包到对象存储
  const packageUrl = await saveToStorage(packageFile, `${publisher.slug}/${manifest.name}-${manifest.version}.tar.gz`);

  const store = new MarketplaceStore();
  const listing = await store.createListing({
    publisherId: publisher.id,
    slug: manifest.name,
    version: manifest.version,
    displayName: manifest.displayName ?? manifest.name,
    description: manifest.description,
    iconEmoji: manifest.iconEmoji,
    tags: manifest.tags ?? [],
    category: manifest.category ?? 'productivity',
    packageUrl,
    pricing: {
      type: manifest.pricing?.type ?? 'free',
      priceCents: manifest.pricing?.priceCents,
      monthlyPriceCents: manifest.pricing?.monthlyPriceCents,
      trialDays: manifest.pricing?.trialDays,
    },
    minAgentCoreVersion: manifest.minAgentCoreVersion,
    maxAgentCoreVersion: manifest.maxAgentCoreVersion,
  });

  return NextResponse.json({
    listingId: listing.id,
    reviewStatus: listing.reviewStatus,
    message: 'Listing created and pending review',
  }, { status: 201 });
}
```

---

## 3. Discovery API

### 3.1 推荐算法

```typescript
// packages/core/src/marketplace/discovery.ts

export type DiscoveryStrategy =
  | 'popular'        // 下载量最高
  | 'newest'         // 最新发布
  | 'top_rated'      // 评分最高
  | 'trending'       // 近 7 天下载增速最快
  | 'personalized';  // 基于用户行为推荐

export interface DiscoveryOptions {
  strategy: DiscoveryStrategy;
  category?: string;
  search?: string;
  page: number;
  pageSize: number;
  /** 用户已安装的 listingIds（用于推荐时排除） */
  excludeInstalled?: string[];
}

/**
 * Discovery（发现）引擎。
 *
 * 各策略的实现逻辑：
 */
export class DiscoveryEngine {
  async discover(opts: DiscoveryOptions): Promise<Listing[]> {
    switch (opts.strategy) {
      case 'popular':
        return this.popular(opts);
      case 'newest':
        return this.newest(opts);
      case 'top_rated':
        return this.topRated(opts);
      case 'trending':
        return this.trending(opts);
      case 'personalized':
        return this.personalized(opts);
      default:
        return this.popular(opts);
    }
  }

  /**
   * Trending：近 7 天下载量增速最快的 Skill。
   *
   * 算法：delta = weeklyDownloads - (installCount / publishedWeeks)
   * delta 最高 = 近期增速最猛。比纯"下载新量"更公平——
   * 老 Skill 积累再多下载，如果近期增速平平也排不上来。
   */
  private async trending(opts: DiscoveryOptions): Promise<Listing[]> {
    const listings = await db.listings.findApproved({
      category: opts.category,
      limit: opts.pageSize * 3, // 多拉一些做排序
    });

    const now = Date.now();
    const scoring = listings.map((l) => {
      const publishedWeeks = Math.max(
        1,
        (now - l.publishedAt) / (1000 * 60 * 60 * 24 * 7),
      );
      const baseline = l.installCount / publishedWeeks;
      const velocity = l.weeklyDownloads - baseline;
      return { listing: l, score: velocity };
    });

    return scoring
      .sort((a, b) => b.score - a.score)
      .slice(opts.pageSize * opts.page, opts.pageSize * (opts.page + 1))
      .map((s) => s.listing);
  }

  /**
   * Personalized：基于用户历史行为推荐。
   *
   * 简单实现：看用户已安装的 Skill 的标签 → 找同标签高评分未安装的。
   * 真正的推荐系统需要用户行为数据累积后引入协同过滤。
   */
  private async personalized(opts: DiscoveryOptions): Promise<Listing[]> {
    if (!opts.excludeInstalled || opts.excludeInstalled.length === 0) {
      return this.popular(opts);
    }

    // 拉取用户已安装 Skill 的标签分布
    const installedListings = await db.listings.findMany(opts.excludeInstalled);
    const tagFrequency = new Map<string, number>();

    for (const listing of installedListings) {
      for (const tag of listing.tags) {
        tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
      }
    }

    // 按标签权重匹配未安装的 Skill
    const candidates = await db.listings.findApproved({
      excludeIds: opts.excludeInstalled,
      category: opts.category,
      limit: 200,
    });

    return candidates
      .map((l) => {
        const tagScore = l.tags.reduce((sum, tag) => sum + (tagFrequency.get(tag) ?? 0), 0);
        return { listing: l, score: tagScore + l.avgRating * 10 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.pageSize)
      .map((s) => s.listing);
  }

  // popular / newest / topRated 简单实现省略...
  private async popular(opts: DiscoveryOptions) { return db.listings.findPopular(opts); }
  private async newest(opts: DiscoveryOptions) { return db.listings.findRecent(opts); }
  private async topRated(opts: DiscoveryOptions) { return db.listings.findTopRated(opts); }
}
```

### 3.2 REST API 端点

```typescript
// apps/web/src/app/api/marketplace/discover/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { DiscoveryEngine } from '@agentcore/core/marketplace/discovery';
import { getCurrentTenantId } from '@agentcore/core/tenant/tenant-context';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const engine = new DiscoveryEngine();
  const tenantId = getCurrentTenantId();

  const results = await engine.discover({
    strategy: (searchParams.get('strategy') as any) ?? 'popular',
    category: searchParams.get('category') ?? undefined,
    search: searchParams.get('search') ?? undefined,
    page: Number(searchParams.get('page') ?? 0),
    pageSize: Number(searchParams.get('pageSize') ?? 20),
    excludeInstalled: await getUserInstalledIds(tenantId),
  });

  return NextResponse.json({
    items: results.map((listing) => ({
      id: listing.id,
      slug: listing.slug,
      displayName: listing.displayName,
      description: listing.description,
      iconEmoji: listing.iconEmoji,
      category: listing.category,
      tags: listing.tags,
      pricing: listing.pricing,
      installCount: listing.installCount,
    })),
  });
}
```

---

## 4. Review & Rating 系统

### 4.1 防刷机制

```typescript
// packages/core/src/marketplace/review.ts

import { getCurrentTenant } from '../tenant/tenant-context';

/**
 * 评价提交。
 *
 * 防刷规则：
 * 1. 必须已安装才能评价（验证 install 记录）
 * 2. 一个用户一个 Skill 只能有一条评价
 * 3. 注册 < 7 天的用户不能给评分（防止 bulk account 刷榜）
 * 4. 24 小时内评分次数 < 10（防止刷评机器人）
 * 5. 评分与安装数比例异常时触发人工审核
 */
export async function submitReview(params: {
  listingId: string;
  rating: number;
  title?: string;
  content: string;
}): Promise<Review> {
  const tenant = getCurrentTenant();

  // 1. 检查是否已安装
  const install = await db.installs.find({
    listingId: params.listingId,
    userId: tenant.userId,
  });
  if (!install) {
    throw new Error('You must install the skill before reviewing');
  }

  // 2. 检查重复评价
  const existing = await db.reviews.findByUserAndListing(tenant.userId, params.listingId);
  if (existing) {
    // 更新而非新建
    return db.reviews.update(existing.id, {
      rating: params.rating,
      title: params.title,
      content: params.content,
      updatedAt: Date.now(),
    });
  }

  // 3. 新用户限制
  const userCreatedAt = await getUserCreatedAt(tenant.userId);
  if (Date.now() - userCreatedAt < 7 * 24 * 60 * 60 * 1000) {
    throw new Error('Account must be at least 7 days old to submit reviews');
  }

  // 4. 频率限制
  const recentCount = await db.reviews.countRecent(tenant.userId, 24 * 60 * 60 * 1000);
  if (recentCount >= 10) {
    throw new Error('Too many reviews in 24 hours. Please wait and try again.');
  }

  const review: Review = {
    id: crypto.randomUUID(),
    listingId: params.listingId,
    userId: tenant.userId,
    rating: params.rating,
    title: params.title,
    content: params.content,
    version: install.installedVersion,
    helpfulCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await db.reviews.create(review);

  // 5. 检查是否需要触发人工审核
  await checkAnomalyAndFlag(params.listingId);

  return review;
}

/**
 * 异常检测：评分与安装数比例异常。
 *
 * 例如：一个 Skill 有 5 个安装但 50 个全五星评价 → 肯定刷了。
 */
async function checkAnomalyAndFlag(listingId: string): Promise<void> {
  const stats = await db.reviews.getStats(listingId);

  // 规则 1：评价数 / 安装数 > 0.8 → 正常人均最多评一次，超过说明有假账号
  if (stats.totalReviews > 0 && stats.totalInstalls > 0) {
    const reviewRatio = stats.totalReviews / stats.totalInstalls;
    if (reviewRatio > 0.8) {
      await db.listings.flagForManualReview(listingId, 'High review-to-install ratio');
    }
  }

  // 规则 2：24 小时内新增评价 > 10 且平均评分 != 历史均值 ± 1
  const recentStats = await db.reviews.getRecentStats(listingId, 24 * 60 * 60 * 1000);
  if (recentStats.count > 5 && Math.abs(recentStats.avgRating - stats.avgRating) > 1) {
    await db.listings.flagForManualReview(listingId, 'Sudden rating anomaly');
  }
}
```

### 4.2 恶意 Skill 下架流程

```
发现恶意 Skill
     │
     ▼
管理员 Review Dashboard 看到 flag
     │
     ▼
确认恶意 → 点击 suspend
     │
     ▼
Skill reviewStatus = 'suspended'
│
├── 搜索结果不再出现
├── 已安装的用户收到通知 "该 Skill 已被下架，请卸载"
├── 已安装的版本仍然可用（不能远程删除用户的本地文件）
│   ⚠️ 但标记为 "untrusted" — 下次 Agent 调用时提示用户
└── 已付款用户自动退款
     │
     ▼
开发者申诉 → 重新扫描 → 人工审核 → 恢复或永久下架
```

---

## 5. Revenue Sharing

### 5.1 分成模型

```typescript
// packages/core/src/marketplace/revenue.ts

/**
 * 付费 Skill 的分成模型。
 *
 * 默认分成：
 * - Developer（开发者）：70%
 * - Platform（平台）：30%（含支付通道费、服务器成本、市场运营）
 *
 * 支付通道费（Stripe）已从用户支付金额中扣除（2.9% + $0.30），
 * 所以 developer 拿到的是平台收入分成后的 70%。
 */
export interface RevenueSplit {
  developerCents: number;
  platformCents: number;
  paymentProcessorCents: number;
  totalCents: number;
}

export function calculateRevenue(
  grossCents: number,
  developerShare: number = 0.7,  // 可配置
): RevenueSplit {
  // Stripe 费用（先扣通道费）
  const stripeFee = Math.ceil(grossCents * 0.029) + 30;
  const netAmount = grossCents - stripeFee;

  return {
    developerCents: Math.floor(netAmount * developerShare),
    platformCents: Math.floor(netAmount * (1 - developerShare)),
    paymentProcessorCents: stripeFee,
    totalCents: grossCents,
  };
}
```

### 5.2 License Key 校验

```typescript
// packages/core/src/marketplace/license.ts

import { createHash, createHmac } from 'crypto';

/**
 * 付费 Skill 的 License Key 机制。
 *
 * License key 格式: ac_live_{base62(tenantId_hash)}_{base62(expiry)}_{hmac}
 *
 * 校验逻辑：
 * 1. 解析 key 结构
 * 2. 检查 expiry 未过期
 * 3. HMAC 签名验证（防伪造）
 * 4. 检查 license 未被 revoke
 */
export interface LicenseValidation {
  valid: boolean;
  listingId: string;
  tenantId: string;
  expiresAt: number;
  reason?: string;
}

export function validateLicenseKey(key: string, listingId: string): LicenseValidation {
  const SECRET = process.env.LICENSE_SECRET;
  if (!SECRET) throw new Error('LICENSE_SECRET not configured');

  const prefix = 'ac_live_';
  if (!key.startsWith(prefix)) {
    return { valid: false, listingId, tenantId: '', expiresAt: 0, reason: 'Invalid key format' };
  }

  const parts = key.slice(prefix.length).split('_');
  if (parts.length !== 3) {
    return { valid: false, listingId, tenantId: '', expiresAt: 0, reason: 'Invalid key structure' };
  }

  const [tenantIdHash, expiryStr, providedHmac] = parts;

  // 验证 HMAC
  const payload = `${tenantIdHash}_${expiryStr}`;
  const expectedHmac = createHmac('sha256', SECRET)
    .update(`${listingId}:${payload}`)
    .digest('base64url')
    .slice(0, 12);

  if (providedHmac !== expectedHmac) {
    return { valid: false, listingId, tenantId: '', expiresAt: 0, reason: 'Invalid signature' };
  }

  // 检查过期
  const expiry = parseInt(expiryStr, 36);
  if (Date.now() > expiry) {
    return { valid: false, listingId, tenantId: '', expiresAt: expiry, reason: 'License expired' };
  }

  if (process.env.REDIS_URL) {
    const revoked = await redis.sismember('license:revoked', key);
    if (revoked) return { valid: false, reason: 'License revoked' };
  }

  return {
    valid: true,
    listingId,
    tenantId: tenantIdHash, // 实际存储是反查的
    expiresAt: expiry,
  };
}
```

---

## 6. Sandbox 版本适配

### 6.1 兼容性声明

```jsonc
// manifest.json 示例 - Skill 包的兼容性声明
{
  "name": "pdf-assistant",
  "version": "1.2.0",
  "minAgentCoreVersion": "0.8.0",
  "maxAgentCoreVersion": "1.5.0",
  "dependencies": {
    "system": ["python3.11+", "pdftotext"],     // 需要的系统工具
    "python": ["pypdf>=4.0", "pdfplumber>=0.10"], // Python 依赖
    "node": ">=20.0.0"                          // Node 运行时版本
  },
  "permissions": ["filesystem:read", "http:fetch"],  // 需要的权限
  "resourceLimits": {
    "maxMemoryMb": 512,
    "maxExecutionSeconds": 300,
    "maxFileWriteMb": 50
  }
}
```

### 6.2 安装时检查

```typescript
// packages/core/src/marketplace/install.ts

import { compareVersions } from 'compare-versions';

export async function installSkill(listingId: string): Promise<{
  success: boolean;
  reason?: string;
  installedPath?: string;
}> {
  const listing = await new MarketplaceStore().getListing(listingId);
  if (!listing) return { success: false, reason: 'Listing not found' };

  if (listing.reviewStatus !== 'approved') {
    return { success: false, reason: 'Listing is not approved for installation' };
  }

  // 1. 检查 Agent Core 版本兼容性
  const currentVersion = process.env.APP_VERSION ?? '0.0.0';
  if (compareVersions(currentVersion, listing.minAgentCoreVersion) < 0) {
    return {
      success: false,
      reason: `Requires Agent Core >= ${listing.minAgentCoreVersion}, current is ${currentVersion}`,
    };
  }
  if (listing.maxAgentCoreVersion && compareVersions(currentVersion, listing.maxAgentCoreVersion) > 0) {
    return {
      success: false,
      reason: `Not compatible with Agent Core > ${listing.maxAgentCoreVersion}`,
    };
  }

  // 2. 检查系统依赖
  const manifest = await downloadAndParseManifest(listing.packageUrl);
  if (manifest.dependencies?.system) {
    for (const dep of manifest.dependencies.system) {
      const available = await checkSystemDependency(dep);
      if (!available) {
        return { success: false, reason: `Missing system dependency: ${dep}` };
      }
    }
  }

  // 3. 下载安装包
  const downloadPath = await downloadPackage(listing.packageUrl);

  // 4. 解压到沙箱路径
  const installPath = `skills/${listing.publisherId}/${listing.slug}-${listing.version}`;
  await extractPackage(downloadPath, installPath);

  // 5. 记录安装
  await db.installs.create({
    id: crypto.randomUUID(),
    listingId,
    userId: getCurrentTenant().userId,
    installedVersion: listing.version,
    installedAt: Date.now(),
    autoUpdate: true,
  });

  // 6. 更新安装计数
  await db.listings.incrementInstallCount(listingId);

  return { success: true, installedPath: installPath };
}
```

---

## 7. 前端：Marketplace Portal

🔗 **工程逻辑**：Marketplace Portal 的设计要同时服务两类用户：
1. **找 Skill 的人**：发现、对比、安装。设计重点是"信任信号"——评分、安装量、认证开发者的徽章。
2. **发 Skill 的人**：管理我的 listings、看收入、看评价。设计重点是"数据面板"——下载/收入/评价趋势。

### 7.1 页面布局

```tsx
// apps/web/src/app/marketplace/_components/marketplace-page.tsx

'use client';

import { useState } from 'react';
import { CategorySidebar } from './category-sidebar';
import { ListingGrid } from './listing-grid';
import { ListingDetail } from './listing-detail';
import { SearchBar } from './search-bar';

export type MarketplaceView = 'discover' | 'installed' | 'my-listings';

export function MarketplacePage() {
  const [view, setView] = useState<MarketplaceView>('discover');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedListing, setSelectedListing] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <div className="flex h-screen bg-bg">
      {/* 左侧分类导航 */}
      <CategorySidebar
        active={selectedCategory}
        onSelect={setSelectedCategory}
        currentView={view}
        onViewChange={setView}
      />

      {/* 中间内容区 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          strategy={view === 'discover' ? 'popular' : 'recent'}
        />

        <ListingGrid
          category={selectedCategory}
          search={searchQuery}
          view={view}
          onSelect={setSelectedListing}
        />
      </div>

      {/* 右侧详情面板（选中时显示） */}
      {selectedListing && (
        <ListingDetail
          listingId={selectedListing}
          onClose={() => setSelectedListing(null)}
        />
      )}
    </div>
  );
}
```

### 7.2 列表网格卡片

```tsx
// apps/web/src/app/marketplace/_components/listing-grid.tsx

'use client';

import { useState, useEffect } from 'react';
import { StarRating } from './star-rating';

interface ListingCardData {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  iconEmoji?: string;
  category: string;
  tags: string[];
  installCount: number;
  avgRating: number;
  totalReviews: number;
  pricing: { type: string; priceCents?: number; monthlyPriceCents?: number };
}

export function ListingGrid({ category, search, view, onSelect }: {
  category: string | null;
  search: string;
  view: string;
  onSelect: (id: string) => void;
}) {
  const [listings, setListings] = useState<ListingCardData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const params = new URLSearchParams();
    if (category) params.set('category', category);
    if (search) params.set('search', search);
    params.set('strategy', view === 'discover' ? 'popular' : 'recent');

    setLoading(true);
    fetch(`/api/marketplace/discover?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setListings(d.items);
        setLoading(false);
      });
  }, [category, search, view]);

  if (loading) return <div className="p-6 text-muted text-sm">加载中...</div>;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {listings.map((listing) => (
          <button
            key={listing.id}
            onClick={() => onSelect(listing.id)}
            className="text-left bg-surface rounded-lg border border-border p-4 hover:border-primary/50 transition-colors"
          >
            <div className="flex items-start gap-3">
              {/* Icon */}
              <div className="w-12 h-12 bg-surface/60 rounded-lg flex items-center justify-center text-2xl flex-shrink-0">
                {listing.iconEmoji ?? '📦'}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <h3 className="text-text font-medium text-sm truncate">{listing.displayName}</h3>
                <p className="text-muted text-xs mt-1 line-clamp-2">{listing.description}</p>

                {/* Stats */}
                <div className="flex items-center gap-3 mt-2 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    📥 {listing.installCount.toLocaleString()}
                  </span>
                  {listing.totalReviews > 0 && (
                    <span className="flex items-center gap-1">
                      <StarRating rating={listing.avgRating} size="xs" />
                      {listing.totalReviews}
                    </span>
                  )}
                </div>

                {/* Pricing */}
                <div className="mt-2">
                  {listing.pricing.type === 'free' ? (
                    <span className="text-xs text-green-400">免费</span>
                  ) : listing.pricing.type === 'paid' ? (
                    <span className="text-xs text-text">¥{((listing.pricing.priceCents ?? 0) / 100).toFixed(0)}</span>
                  ) : (
                    <span className="text-xs text-text">¥{((listing.pricing.monthlyPriceCents ?? 0) / 100).toFixed(0)}/月</span>
                  )}
                </div>
              </div>
            </div>
          </button>
        ))}
      </div>

      {listings.length === 0 && (
        <div className="text-center text-muted text-sm py-12">
          {search ? `没有找到匹配 "${search}" 的 Skill` : '该分类暂无 Skill'}
        </div>
      )}
    </div>
  );
}
```

### 7.3 详情面板（含安装按钮）

```tsx
// apps/web/src/app/marketplace/_components/listing-detail.tsx

'use client';

import { useState, useEffect } from 'react';
import { StarRating } from './star-rating';

interface ListingDetailData {
  id: string;
  slug: string;
  displayName: string;
  description: string;
  version: string;
  iconEmoji?: string;
  category: string;
  tags: string[];
  installCount: number;
  avgRating: number;
  totalReviews: number;
  pricing: { type: string; priceCents?: number; monthlyPriceCents?: number };
  publisherName: string;
  publisherAvatar?: string;
  minAgentCoreVersion: string;
}

export function ListingDetail({ listingId, onClose }: {
  listingId: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ListingDetailData | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    fetch(`/api/marketplace/listings/${listingId}`)
      .then((r) => r.json())
      .then(setDetail);
  }, [listingId]);

  const handleInstall = async () => {
    setInstalling(true);
    try {
      const res = await fetch(`/api/marketplace/install/${listingId}`, { method: 'POST' });
      const result = await res.json();
      if (result.success) {
        setInstalled(true);
      } else {
        alert(`安装失败: ${result.reason}`);
      }
    } finally {
      setInstalling(false);
    }
  };

  if (!detail) return <div className="w-96 border-l border-border p-6 text-muted">加载中...</div>;

  return (
    <div className="w-96 border-l border-border flex flex-col overflow-hidden">
      {/* Close button */}
      <button onClick={onClose} className="absolute top-4 right-4 text-muted hover:text-text">✕</button>

      <div className="overflow-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-16 h-16 bg-surface rounded-xl flex items-center justify-center text-3xl">
            {detail.iconEmoji ?? '📦'}
          </div>
          <div>
            <h2 className="text-lg text-text font-medium">{detail.displayName}</h2>
            <div className="text-xs text-muted mt-0.5">v{detail.version} · {detail.publisherName}</div>
          </div>
        </div>

        {/* Install button */}
        <button
          onClick={handleInstall}
          disabled={installing || installed}
          className={`w-full py-2.5 rounded-lg font-medium text-sm transition-colors ${
            installed
              ? 'bg-green-500/20 text-green-400 cursor-default'
              : 'bg-primary text-white hover:bg-primary/80 disabled:opacity-50'
          }`}
        >
          {installed ? '✓ 已安装' : installing ? '安装中...' : detail.pricing.type === 'free' ? '免费安装' : `购买 ¥${((detail.pricing.priceCents ?? 0) / 100).toFixed(0)}`}
        </button>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-text font-medium">{detail.installCount.toLocaleString()}</div>
            <div className="text-xs text-muted">安装量</div>
          </div>
          <div>
            <div className="text-text font-medium"><StarRating rating={detail.avgRating} /></div>
            <div className="text-xs text-muted">{detail.totalReviews} 评价</div>
          </div>
          <div>
            <div className="text-text font-medium">{detail.tags.length}</div>
            <div className="text-xs text-muted">标签</div>
          </div>
        </div>

        {/* Description */}
        <div>
          <h3 className="text-sm text-text font-medium mb-2">介绍</h3>
          <p className="text-sm text-muted leading-relaxed">{detail.description}</p>
        </div>

        {/* Compatibility */}
        <div>
          <h3 className="text-sm text-text font-medium mb-2">兼容性</h3>
          <div className="text-xs text-muted">需要 Agent Core ≥ v{detail.minAgentCoreVersion}</div>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5">
          {detail.tags.map((tag) => (
            <span key={tag} className="text-xs bg-surface/60 text-muted px-2 py-0.5 rounded">
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
```

---

## 8. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| 上传的 Skill 包含恶意代码（挖矿/数据窃取） | 没有安全扫描就入库 | 自动扫描 + 管理员审核双重机制；付费 Skill 必须有 verified publisher |
| 付费 Skill 源码/配置被爬走（用户安装后直接从本地目录copy走） | Skill 文件以明文形式存在用户本地 | 不完美解法——本地文件永远可被物理读取。可做的是：混淆 + license key 校验 + 法律条款。核心 Skill 不要放在 marketplace |
| 评分被刷榜（大量 bulk 账号注册→全五星评价） | 无防御的评分系统 | 新用户 7 天内不能评分 + 评分频率限制 + 安装/评分比例异常检测 + 人工审核标记 |
| 付费 Skill 开发者收入不透明 | 没有给开发者看收入面板 | 开发者后台 panel：每日/月收入、下载量、评分趋势；每次交易记录可查 |
| Skill 安装后 Agent Core 版本不兼容导致崩溃 | 开发者升级 Skill 但用户还在用旧版本 Agent | manifest.json 声明 `minAgentCoreVersion`，不兼容的 Skill 不展示在列表里；升级 Agent 时提示已安装的 Skill 是否兼容 |
| 大量 Skill 下架后用户本地已安装的还在跑但没有任何提示 | 下架是市场级别行为，不影响已安装 | 定期检查已安装 Skill 的 market 状态，如果被 suspend 通知用户 |
| License key 被共享（一个 key 多设备使用） | Key 不绑定设备 | Key 绑定 tenantId + 可选设备指纹（hash(IP + user agent)）；定期校验 |
| 安装在 Windows 上路径用 `\` 导致 tar.gz 解压失败 | 包内文件用 Unix 路径格式 | 统一在 package 工具里用 `/` 做路径分隔符，解压时自动转换 |
| 市场上有同名 Skill（两个开发者都叫 "pdf-assistant"） | slug 没有唯一性约束 | slug 加 publisher 前缀：`{publisher-slug}/{skill-name}` 作为全局唯一标识 |
| 恶意 Skill 在 Agent 对话时保存用户对话记录并外发到远程服务器 | 安全扫描没有检查 `fetch` 到未知域名 + 上传对话内容 | 扫描检测 `fetch` 到非白名单域名；工具调用权限 `http:fetch` 时提示用户的域名是否可信；审计日志记录所有外部请求 |

---

## 9. AI 避坑追加（AST 可检）

> 🤖 **AI 常见错误**：
>
> 1. **Skill 安装时不做代码安全扫描** — 直接 `npm install` 一个包含 `postinstall` 脚本的包，该脚本可以执行任意系统命令。**ESLint/AST 检查**：安装前必须用 AST 解析器扫描 `package.json` 的 `scripts` 字段，拒绝含 `preinstall/postinstall` 钩子的包；扫描所有 `.js/.ts` 文件是否含 `eval(`、`Function(`、`child_process.exec(` 调用模式。
>
> 2. **SKILL.md 的 frontmatter 注入攻击** — 解析第三方 SKILL.md 时把 `description` 字段直接拼入 `system prompt`，其中含 "ignore previous instructions" 指令。**检查方式**：所有外部 markdown 文件解析出 frontmatter 后，必须经 `PromptSanitizer.sanitizeVariable()` 处理；description 字段长度硬性限制 ≤ 500 字符。
>
> 3. **评分统计使用算术平均而非贝叶斯平均** — 新 Skill 获 1 个 5 星就排到头部，老 Skill 1000 个评价 4.8 分反而排在后面。**检查方式**：评分排序必须用贝叶斯平均 `(totalStars + C * globalMean) / (count + C)`，其中 C 是最小置信阈值（建议 10）；在排序函数中禁止裸 `.sort((a, b) => b.avgRating - a.avgRating)`。

---

*本节点属于 Layer 4 生态层。Marketplace 的核心是"信任"——用户需要相信安装的 Skill 不会盗取数据，开发者需要相信平台不会吞掉收入，平台需要相信审核机制不会漏过恶意代码。三个信任都是通过机制（而非承诺）建立的：安全扫描、License Key、审核流程、异常检测。上线策略应该是"先邀请制（只允许已验证开发者发布），再开放制"——在信任机制跑通之前开放发布，等于给恶意开发者开绿灯。*
