# 12 — 向量数据库实战：从"能用"到"好用十倍"

> 本 reference 覆盖向量数据库的生产级实战：选型决策树、Qdrant/Milvus 完整 SDK 代码、Embedding 抽象层与缓存、Rerank 重排序、索引策略进阶。读完本文件即可独立落地高性能向量检索，不再停留于"demo 能跑"阶段。

---

## 目录

- [向量数据库选型决策树](#1-向量数据库选型决策树)
- [Qdrant 完整 SDK 实战](#2-qdrant-完整-sdk-实战)
- [Milvus 实战](#3-milvus-实战)
- [Embedding 服务抽象层](#4-embedding-服务抽象层)
- [Embedding 缓存](#5-embedding-缓存)
- [索引策略：文档级 vs Chunk 级 vs Token 级](#6-索引策略文档级-vs-chunk-级-vs-token-级)
- [重排序：Cross-Encoder Reranker](#7-重排序cross-encoder-reranker)
- [前端：向量配置面板](#8-前端向量配置面板)
- [AI 避坑汇总](#9-ai-避坑汇总)

---

## 1. 向量数据库选型决策树

**工程逻辑**：向量数据库不是"选一个最好的"，而是"选一个最合适的"。选型取决于你的数据规模、运维能力、延迟要求和预算。错误选型会导致后期迁移成本极高（embedding 数据需要重新生成）。

```
┌────────────────────────────────────────────────────────────────┐
│                    向量数据库选型决策树                            │
│                                                                  │
│  Q: 数据规模多大？                                                │
│  ├── < 100 万向量 → Chroma (嵌入式) / Qdrant (单机)              │
│  ├── 100 万 - 1 亿 → Qdrant (集群) / Milvus (集群)               │
│  └── > 1 亿 → Milvus / Weaviate / Pinecone (托管)               │
│                                                                  │
│  Q: 运维能力如何？                                                │
│  ├── 无运维/小团队 → Qdrant (Docker 一行命令) / Pinecone (全托管) │
│  ├── 有 K8s 团队 → Milvus (K8s 原生) / Weaviate                  │
│  └── 预算充足不需要运维 → Pinecone (按量付费，省心)                │
│                                                                  │
│  Q: 延迟要求？                                                   │
│  ├── < 10ms P99 → Qdrant (Rust，极致性能) / Milvus + HNSW       │
│  ├── 10-50ms → 以上任意一个                                       │
│  └── > 50ms 也可 → Weaviate / Chroma                             │
│                                                                  │
│  Q: 需要混合检索？                                               │
│  ├── 向量 + BM25 → Qdrant (2024 内置) / Weaviate (hybrid 搜索)  │
│  └── 仅需向量 → 全部支持                                         │
└────────────────────────────────────────────────────────────────┘
```

**详细对比表**：

| 维度 | Qdrant | Milvus | Chroma | Pinecone | Weaviate |
|------|--------|--------|--------|----------|----------|
| 语言 | Rust | Go + C++ | Python | 托管 | Go |
| 部署复杂度 | 低 (Docker) | 高 (需 etcd/MinIO/消息队列) | 极低 (嵌入式) | 零 (全托管) | 中 (Docker) |
| 单机吞吐 | 极高 | 高 | 低 | N/A | 中 |
| 集群能力 | 支持 (分片+副本) | 原生分布式 | 不支持 | 自动 | 支持 |
| 索引类型 | HNSW, Sparse | IVF_FLAT, HNSW, DiskANN, IVF_PQ | HNSW | 专有 | HNSW, Flat |
| Payload 过滤 | 丰富 (AND/OR/嵌套) | 中 (表达式) | 基础 | 中 | 丰富 |
| 内置 BM25 | 支持 (2024) | 不支持 | 不支持 | 不支持 | 支持 |
| 稀疏向量 | 支持 | 支持 | 不支持 | 不支持 | 支持 |
| 成本 (自托管) | 低 (单容器 < 1GB 内存) | 高 (集群需多台中配机器) | 极低 | N/A (按量付费，贵) | 中 |
| 推荐场景 | 中小规模需要极致性能 | 超大规模生产环境 | 原型/测试 | 无运维团队 | GraphQL 生态 |
| 不适用场景 | > 100 亿向量 (无原生分布式) | 小团队/小规模 | 生产环境 | 预算紧张 | 需要极致 QPS |

> 🤖 **AI 常见错误**：选型时只看 benchmark 数字。Benchmark 用的是标准数据集 + 理想环境，真实业务的数据分布、查询模式完全不同。对于 Agent 的记忆系统（通常 < 100 万向量），Qdrant 是最均衡的选择——部署简单、性能足够、payload 过滤灵活、社区活跃。

---

## 2. Qdrant 完整 SDK 实战

### 2.1 客户端初始化与 Collection 配置

```typescript
// packages/core/src/memory/vectorstore-qdrant.ts

import { QdrantClient } from '@qdrant/js-client-rest';
import type { VectorStore } from './episodic';
import type { MemoryEntry } from './types';

/**
 * Qdrant 生产级适配器
 *
 * 工程选择：
 * - 用 UUID 而非自增 ID（分布式写入无冲突）
 * - HNSW 索引：m=16, ef_construct=200 是性能和召回率的最佳平衡点
 * - Cosine 距离：适用于 embedding 向量（大多数模型输出已归一化）
 */
export class QdrantVectorStore implements VectorStore {
  private client: QdrantClient;
  private defaultCollection: string;

  constructor(options: {
    url?: string;
    apiKey?: string;
    defaultCollection?: string;
  }) {
    this.client = new QdrantClient({
      url: options.url ?? process.env.QDRANT_URL ?? 'http://localhost:6333',
      apiKey: options.apiKey ?? process.env.QDRANT_API_KEY,
    });
    this.defaultCollection = options.defaultCollection ?? 'agent_memory';
  }

  /**
   * 创建 Collection —— 只需在首次部署时调用一次
   *
   * HNSW 参数详解：
   * - m: 每个节点的最大连接数。越大召回率越高但内存越大。16 是默认值，通常够用
   * - ef_construct: 构建索引时的搜索宽度。越大索引质量越高但构建越慢。200 是推荐的平衡点
   * - on_disk: true 时将 HNSW 索引放磁盘而非内存，内存占用降 10x，但查询延迟增加约 3-5ms
   *
   * 对于记忆系统（QPS < 100），on_disk=false 优先（内存够用）
   */
  async createCollection(
    collection: string,
    dimension: number,
    options?: {
      onDisk?: boolean;
      hnswM?: number;
      hnswEfConstruct?: number;
      distance?: 'Cosine' | 'Euclid' | 'Dot';
    }
  ): Promise<void> {
    await this.client.createCollection(collection, {
      vectors: {
        size: dimension,
        distance: options?.distance ?? 'Cosine',
        hnsw_config: options?.onDisk !== undefined ? {
          on_disk: options.onDisk,
          m: options.hnswM ?? 16,
          ef_construct: options.hnswEfConstruct ?? 200,
        } : undefined,
      },
      // Payload 索引：对常用过滤字段建索引，否则全表扫描
      payload_indexing: true,
    });

    // 为常用 payload 字段创建显式索引（加速过滤）
    await this.client.createPayloadIndex(collection, {
      field_name: 'userId',
      field_schema: 'keyword',
    });
    await this.client.createPayloadIndex(collection, {
      field_name: 'tier',
      field_schema: 'keyword',
    });
    await this.client.createPayloadIndex(collection, {
      field_name: 'createdAt',
      field_schema: 'integer',
    });
    await this.client.createPayloadIndex(collection, {
      field_name: 'tags',
      field_schema: 'keyword',
    });
    await this.client.createPayloadIndex(collection, {
      field_name: 'importance',
      field_schema: 'float',
    });
  }

  /**
   * 检查 Collection 是否存在，不存在则创建
   * 建议在应用启动时调用
   */
  async ensureCollection(collection: string, dimension: number): Promise<void> {
    try {
      await this.client.getCollection(collection);
    } catch (e: any) {
      if (e?.status === 404 || e?.message?.includes('Not Found')) {
        await this.createCollection(collection, dimension);
      } else {
        throw e;
      }
    }
  }

  // ... (其余方法在下面)
}
```

### 2.2 批量 Upsert 与错误重试

```typescript
// packages/core/src/memory/vectorstore-qdrant.ts (续)

/**
 * 批量写入向量 —— 自动分块 + 错误重试
 *
 * 工程选择：
 * - Qdrant 单次 upsert 不宜超过 100-200 条（payload 太大会超时）
 * - 写入失败时指数退避重试（可能因并发冲突或网络抖动）
 * - wait=false 让写入异步进行，不阻塞 Agent 对话流程
 */
async upsert(
  collection: string,
  entries: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>
): Promise<void> {
  const BATCH_SIZE = 100;
  const MAX_RETRIES = 3;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    let lastError: Error | null = null;

    for (let retry = 0; retry < MAX_RETRIES; retry++) {
      try {
        await this.client.upsert(collection, {
          wait: false,  // 异步写入，不阻塞
          points: batch.map(e => ({
            id: e.id,
            vector: e.vector,
            payload: e.payload,
          })),
        });
        lastError = null;
        break;  // 成功，跳出重试循环
      } catch (e: any) {
        lastError = e;
        const delay = Math.pow(2, retry) * 100;
        console.warn(`Qdrant upsert batch ${i / BATCH_SIZE} retry ${retry + 1}/${MAX_RETRIES}: ${e.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (lastError) {
      // 最终失败了，记录但不让 Agent 对话中断
      console.error(`Qdrant upsert failed after ${MAX_RETRIES} retries for batch starting at ${i}:`, lastError);
    }
  }
}

/** 同步等待版本（用于关键写入场景，确保数据持久化） */
async upsertAndWait(
  collection: string,
  entries: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>
): Promise<void> {
  const BATCH_SIZE = 100;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await this.client.upsert(collection, {
      wait: true,  // 同步等待，确保写入完成
      points: batch.map(e => ({
        id: e.id,
        vector: e.vector,
        payload: e.payload,
      })),
    });
  }
}
```

### 2.3 搜索与 Payload 过滤

```typescript
// packages/core/src/memory/vectorstore-qdrant.ts (续)

/**
 * 基础向量搜索
 *
 * 参数说明：
 * - limit: 返回 top-K
 * - score_threshold: 最低相似度阈值（Cosine 距离下 0.7-0.8 是常见阈值）
 * - with_payload: 是否返回 payload 数据（前端展示需要）
 * - with_vector: 是否返回向量（通常不需要，节省带宽）
 */
async search(
  collection: string,
  vector: number[],
  limit: number,
  options?: {
    scoreThreshold?: number;
    filter?: QdrantFilter;
    withPayload?: boolean;
  }
): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
  const result = await this.client.search(collection, {
    vector,
    limit,
    score_threshold: options?.scoreThreshold,
    filter: options?.filter,
    with_payload: options?.withPayload ?? true,
    with_vector: false,
    // ef 参数：搜索时考察的候选数。越大召回率越高但越慢。默认 128，生产可设为 256
    params: { ef: 256 },
  });

  return result.map(r => ({
    id: String(r.id),
    score: r.score,
    payload: r.payload as Record<string, unknown>,
  }));
}

/**
 * Payload 过滤的复杂写法
 *
 * Qdrant 过滤语法：
 * - must: AND 条件（全部满足）
 * - should: OR 条件（满足任一）
 * - must_not: NOT 条件（全不满足）
 * - 可以嵌套：must 里放 should，实现 (A AND (B OR C))
 *
 * 预过滤 vs 后过滤：
 * - 预过滤 (filter 参数)：在 ANN 搜索前先过滤，结果少但可能漏掉边界结果
 * - 后过滤：先搜索再过滤，精确但需要搜索更多候选
 * - 推荐：对重要过滤条件（如 userId）用预过滤，次要条件用后过滤
 */
async searchWithFilter(
  collection: string,
  vector: number[],
  limit: number,
  filterOptions: {
    userId: string;
    tier?: string;
    tags?: string[];
    minImportance?: number;
    createdAfter?: number;
    createdBefore?: number;
  }
): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
  const must: any[] = [
    { key: 'userId', match: { value: filterOptions.userId } },
  ];

  if (filterOptions.tier) {
    must.push({ key: 'tier', match: { value: filterOptions.tier } });
  }

  // Tags: 任意一个 tag 匹配即可（OR）
  if (filterOptions.tags && filterOptions.tags.length > 0) {
    must.push({
      key: 'tags',
      match: { any: filterOptions.tags },
    });
  }

  // Importance: 范围过滤（>= minImportance）
  if (filterOptions.minImportance !== undefined) {
    must.push({
      key: 'importance',
      range: { gte: filterOptions.minImportance },
    });
  }

  // 时间范围：AND 两个 range 条件
  if (filterOptions.createdAfter !== undefined) {
    must.push({
      key: 'createdAt',
      range: { gte: filterOptions.createdAfter },
    });
  }
  if (filterOptions.createdBefore !== undefined) {
    must.push({
      key: 'createdAt',
      range: { lte: filterOptions.createdBefore },
    });
  }

  return this.search(collection, vector, limit, {
    filter: { must },
  });
}

/** Qdrant 过滤器的类型定义 */
interface QdrantFilter {
  must?: QdrantCondition[];
  should?: QdrantCondition[];
  must_not?: QdrantCondition[];
}

type QdrantCondition =
  | { key: string; match: { value: any } | { any: any[] } | { text: string } }
  | { key: string; range: { gte?: number; lte?: number; gt?: number; lt?: number } }
  | { key: string; isEmpty: { is_empty: { key: string } } }
  | { key: string; hasId: (string | number)[] }
  | QdrantFilter;  // 嵌套
```

### 2.4 分页与删除

```typescript
// packages/core/src/memory/vectorstore-qdrant.ts (续)

/**
 * 分页滚动查询 —— 返回某用户的所有记忆
 *
 * Qdrant 的 scroll 接口不按排名分页（不返回 score），
 * 而是按 ID 顺序遍历。适合管理页面展示全部数据的场景。
 */
async list(
  collection: string,
  filter?: Record<string, unknown>,
  options?: { limit?: number; offset?: number }
): Promise<MemoryEntry[]> {
  const scrollFilter = filter ? this.buildScrollFilter(filter) : undefined;

  const result = await this.client.scroll(collection, {
    filter: scrollFilter,
    limit: options?.limit ?? 50,
    offset: options?.offset,
    with_payload: true,
    with_vector: false,
  });

  // result.points 是 MemoryEntry[] 格式的数组
  return result.points.map((point: any) => ({
    id: String(point.id),
    tier: (point.payload?.tier as MemoryEntry['tier']) ?? 'episodic',
    content: (point.payload?.content as string) ?? '',
    summary: point.payload?.summary as string | undefined,
    metadata: (point.payload?.metadata as any) ?? {},
    createdAt: (point.payload?.createdAt as number) ?? 0,
    updatedAt: (point.payload?.updatedAt as number) ?? 0,
    importance: (point.payload?.importance as number) ?? 0.5,
    accessCount: (point.payload?.accessCount as number) ?? 0,
    tags: (point.payload?.tags as string[]) ?? [],
  }));
}

/** 将简单 filter 转换为 Qdrant 过滤格式 */
private buildScrollFilter(filter: Record<string, unknown>): any {
  const must: any[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        must.push({ key, match: { any: value } });
      } else {
        must.push({ key, match: { value } });
      }
    }
  }
  return must.length > 0 ? { must } : undefined;
}

/**
 * 按 ID 删除向量
 */
async delete(collection: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await this.client.delete(collection, { points: ids });
}

/**
 * 按条件删除（删除某用户的所有记忆）
 */
async deleteByFilter(collection: string, filter: Record<string, unknown>): Promise<void> {
  const scrollFilter = this.buildScrollFilter(filter);
  if (!scrollFilter) return;
  await this.client.delete(collection, { filter: scrollFilter });
}

/** 获取 Collection 信息 */
async getCollectionInfo(collection: string): Promise<{
  pointsCount: number;
  vectorsCount: number;
  indexedVectorsCount: number;
  status: string;
  optimizerStatus: string;
}> {
  const info = await this.client.getCollection(collection);
  return {
    pointsCount: info.points_count ?? 0,
    vectorsCount: info.vectors_count ?? 0,
    indexedVectorsCount: info.indexed_vectors_count ?? 0,
    status: info.status,
    optimizerStatus: info.optimizer_status,
  };
}
```

---

## 3. Milvus 实战

### 3.1 客户端初始化

```typescript
// packages/core/src/memory/vectorstore-milvus.ts

import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { VectorStore } from './episodic';
import type { MemoryEntry } from './types';

/**
 * Milvus 适配器 —— 适用于超大规模向量场景
 *
 * 工程选择：
 * - Milvus 是分布式架构，生产部署需要 etcd + MinIO + 消息队列
 * - 单机开发版可用 Attu (Milvus 的 GUI 管理工具)
 * - 相比 Qdrant，Milvus 的索引更丰富（DiskANN 适合冷数据）
 */
export class MilvusVectorStore implements VectorStore {
  private client: MilvusClient;
  private database: string;

  constructor(options: {
    address: string;              // "localhost:19530"
    username?: string;
    password?: string;
    database?: string;
  }) {
    this.client = new MilvusClient({
      address: options.address,
      username: options.username ?? 'root',
      password: options.password ?? 'Milvus',
      database: options.database ?? 'default',
    });
    this.database = options.database ?? 'default';
  }

  /**
   * 创建 Collection —— 包含 schema 定义
   *
   * 注意：Milvus 的 schema 比 Qdrant 复杂得多（需要显式定义字段类型），
   * 但这也意味着更强的类型安全和更灵活的查询能力
   */
  async createCollection(
    collection: string,
    dimension: number,
    options?: {
      indexType?: 'IVF_FLAT' | 'HNSW' | 'DiskANN' | 'IVF_PQ';
      metricType?: 'IP' | 'L2' | 'COSINE';
    }
  ): Promise<void> {
    const indexType = options?.indexType ?? 'HNSW';
    const metricType = options?.metricType ?? 'COSINE';

    // 1. 创建 Collection (定义 schema)
    await this.client.createCollection({
      collection_name: collection,
      fields: [
        { name: 'id', description: 'Primary key', data_type: 'VarChar', max_length: 64, is_primary_key: true, auto_id: false },
        { name: 'content', description: 'Content text', data_type: 'VarChar', max_length: 65535 },
        { name: 'tier', description: 'Memory tier', data_type: 'VarChar', max_length: 32 },
        { name: 'userId', description: 'User ID', data_type: 'VarChar', max_length: 64 },
        { name: 'importance', description: 'Importance score', data_type: 'Float' },
        { name: 'createdAt', description: 'Creation timestamp', data_type: 'Int64' },
        { name: 'tags', description: 'Tags', data_type: 'JSON' },
        { name: 'vector', description: 'Embedding vector', data_type: 'FloatVector', dim: dimension },
      ],
    });

    // 2. 创建索引 —— 索引类型决定搜索性能
    // HNSW: 内存索引，最快但占用内存最大
    // IVF_FLAT: 内存索引，召回率较低但构建快
    // DiskANN: 磁盘索引，适合超大规模（>1亿），速度略慢但内存占用极小
    // IVF_PQ: 量化索引，精度损失大但速度最快
    await this.client.createIndex({
      collection_name: collection,
      field_name: 'vector',
      index_name: 'vector_index',
      index_type: indexType,
      metric_type: metricType,
      params: indexType === 'HNSW'
        ? { M: 16, efConstruction: 200 }
        : indexType === 'IVF_FLAT'
          ? { nlist: 1024 }
          : indexType === 'DiskANN'
            ? {}  // DiskANN 自动调参
            : { nlist: 1024, m: 8, nbits: 8 },  // IVF_PQ
    });

    // 3. 加载 Collection 到内存（Milvus 需要手动加载）
    await this.client.loadCollectionSync({ collection_name: collection });
  }

  /**
   * 分区（Partition）策略
   *
   * Milvus 支持分区——将 Collection 按某个字段拆分为多个物理子集。
   * 对于多用户 Agent，按 userId 分区是最自然的选择：
   * - 查询时指定分区名，数据隔离，性能更好
   * - 删除时直接 drop 整个分区，比逐条删除快得多
   *
   * 注意：Qdrant 没有原生分区概念，用 payload 过滤实现类似效果
   */
  async createPartition(collection: string, partitionName: string): Promise<void> {
    await this.client.createPartition({
      collection_name: collection,
      partition_name: partitionName,
    });
  }

  async upsert(
    collection: string,
    entries: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>
  ): Promise<void> {
    if (entries.length === 0) return;

    // Milvus 的 upsert 需要按字段分行列格式传递
    await this.client.upsert({
      collection_name: collection,
      fields_data: entries.map(e => ({
        id: e.id,
        content: (e.payload.content as string) ?? '',
        tier: (e.payload.tier as string) ?? 'episodic',
        userId: (e.payload.userId as string) ?? '',
        importance: (e.payload.importance as number) ?? 0.5,
        createdAt: (e.payload.createdAt as number) ?? Date.now(),
        tags: JSON.stringify((e.payload.tags as string[]) ?? []),
        vector: e.vector,
      })),
      // upsert 会在 id 冲突时更新而非插入
      // merge_data: true 是 insert 而非 upsert
    });

    // 刷新到磁盘（Milvus 的写入是异步的，flush 确保持久化）
    await this.client.flushSync({ collection_names: [collection] });
  }

  /**
   * 向量搜索
   *
   * 关键参数：
   * - nprobe (IVF 索引): 搜索时的聚类数。越大越慢但召回率越高。默认 10，可调到 32-64
   * - ef (HNSW 索引): 搜索宽度。和 Qdrant 的 ef 含义一致
   * - search_params 因索引类型而异
   */
  async search(
    collection: string,
    vector: number[],
    limit: number,
    options?: {
      scoreThreshold?: number;
      filter?: string;  // Milvus 用表达式语法，如 'userId == "user123"'
    }
  ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> {
    const result = await this.client.search({
      collection_name: collection,
      vector: vector,
      limit,
      filter: options?.filter,
      params: { nprobe: 32, ef: 256 },  // 根据索引类型调参
      output_fields: ['id', 'content', 'tier', 'userId', 'importance', 'createdAt', 'tags'],
    });

    return result.results.map((r: any) => ({
      id: r.id,
      score: r.score,
      payload: {
        content: r.content,
        tier: r.tier,
        userId: r.userId,
        importance: r.importance,
        createdAt: r.createdAt,
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags,
      },
    }));
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.delete({
      collection_name: collection,
      filter: `id in [${ids.map(id => `"${id}"`).join(',')}]`,
    });
  }

  async list(collection: string, filter?: Record<string, unknown>): Promise<MemoryEntry[]> {
    // Milvus 通过 query 接口查询
    // filter 简单处理，实际生产中需要构建 expression
    const queryFilter = filter
      ? Object.entries(filter)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k} == "${v}"`)
          .join(' and ')
      : undefined;

    const result = await this.client.query({
      collection_name: collection,
      filter: queryFilter,
      output_fields: ['id', 'content', 'tier', 'userId', 'importance', 'createdAt', 'tags'],
      limit: 1000,
    });

    return result.data.map((row: any) => ({
      id: row.id,
      tier: row.tier ?? 'episodic',
      content: row.content ?? '',
      metadata: { userId: row.userId },
      createdAt: row.createdAt ?? 0,
      updatedAt: row.createdAt ?? 0,
      importance: row.importance ?? 0.5,
      accessCount: 0,
      tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags ?? [],
    }));
  }
}
```

### 3.2 索引选型决策

```
索引类型选型决策：

┌──────────────────────────────────────────────────────────────┐
│  HNSW (Hierarchical Navigable Small World)                    │
│  - 适用：< 5000 万向量，追求极致查询速度                         │
│  - 延迟：< 5ms                                                │
│  - 内存：向量总数 × 维度 × 4 bytes + 图结构开销                    │
│  - 召回率：> 95%                                               │
│  - 构建时间：中等                                               │
│  - 推荐：Agent 记忆系统首选索引                                  │
│                                                                │
│  IVF_FLAT (Inverted File)                                      │
│  - 适用：内存充足但需要快速构建                                  │
│  - 延迟：5-20ms (取决于 nprobe)                                │
│  - 内存：与 HNSW 相似                                           │
│  - 召回率：80-95% (取决于 nprobe)                               │
│  - 构建时间：很快                                               │
│  - 推荐：对召回率要求不高时的备选                                │
│                                                                │
│  DiskANN                                                       │
│  - 适用：> 1 亿向量，内存有限                                   │
│  - 延迟：5-15ms                                                │
│  - 内存：极小（磁盘存储图结构）                                  │
│  - 召回率：90-98%                                              │
│  - 构建时间：慢                                                │
│  - 推荐：超大规模冷数据                                         │
│                                                                │
│  IVF_PQ (Product Quantization)                                 │
│  - 适用：内存极端有限，能接受精度损失                             │
│  - 延迟：< 5ms                                                │
│  - 内存：极小（量化压缩向量）                                    │
│  - 召回率：75-90%                                              │
│  - 构建时间：中等                                               │
│  - 推荐：不推荐用于 Agent 记忆（精度损失影响语义理解）              │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Embedding 服务抽象层

**工程逻辑**：Agent 系统需要在不同 Provider 之间无缝切换 Embedding 服务。设计一个统一接口后，切换 OpenAI → BGE → 本地模型只需改一行配置，业务代码完全不受影响。

```typescript
// packages/core/src/llm/embedding-service.ts

/**
 * Embedding 服务统一接口
 *
 * 所有 Embedding 实现必须满足：
 * 1. dimension 属性在创建后不可变（影响向量库配置）
 * 2. embed 和 embedBatch 使用同一个模型（防止意外混用）
 * 3. 不对输入做任何假设（调用方负责截断/分段）
 */
export interface EmbeddingService {
  readonly provider: string;          // 'openai' | 'bge' | 'jina' | 'local'
  readonly model: string;
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /** 可选：限流配置 */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

/**
 * 服务注册表 —— 支持运行时切换 Embedding Provider
 */
export class EmbeddingRegistry {
  private services = new Map<string, EmbeddingService>();
  private defaultService: string = '';

  register(name: string, service: EmbeddingService, isDefault = false): void {
    if (this.services.has(service.provider + ':' + service.model)) {
      throw new Error(`Embedding service ${service.provider}:${service.model} already registered`);
    }
    this.services.set(name, service);
    if (isDefault || !this.defaultService) {
      this.defaultService = name;
    }
  }

  get(name?: string): EmbeddingService {
    const service = this.services.get(name ?? this.defaultService);
    if (!service) throw new Error(`Embedding service "${name ?? this.defaultService}" not found`);
    return service;
  }

  /** 列出所有可用的服务 */
  list(): Array<{ name: string; provider: string; model: string; dimension: number }> {
    return Array.from(this.services.entries()).map(([name, s]) => ({
      name,
      provider: s.provider,
      model: s.model,
      dimension: s.dimension,
    }));
  }
}

/**
 * OpenAI Embedding 实现
 *
 * 模型选择：
 * - text-embedding-3-small: 1536 维, $0.02/1M tokens, 性价比最高
 * - text-embedding-3-large: 3072 维, $0.13/1M tokens, 精度更高
 * - text-embedding-ada-002: 1536 维, $0.10/1M tokens, 已不推荐
 *
 * 注意：-3 系列支持维度缩减（dimensions 参数），可将 1532 降到 256-1532 之间
 */
export class OpenAIEmbedding implements EmbeddingService {
  readonly provider = 'openai';
  readonly model: string;
  readonly dimension: number;
  private apiKey: string;
  private baseUrl: string;

  constructor(config: {
    apiKey: string;
    model?: string;
    dimension?: number;     // 缩减维度（仅 -3 系列支持）
    baseUrl?: string;
    timeoutMs?: number;
  }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.dimension = config.dimension ?? 1536;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
    };
    // 如果指定了维度缩减，添加 dimensions 参数
    if (this.dimension < 1536 && this.model.includes('text-embedding-3')) {
      body.dimensions = this.dimension;
    }

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`OpenAI embedding API error: ${res.status} - ${errBody}`);
    }

    const data = await res.json();
    // 按 input 顺序返回
    return data.data.map((d: any) => d.embedding);
  }
}

/**
 * BGE (BAAI General Embedding) 实现
 *
 * 工程选择：
 * - BGE-M3: 多语言、多功能（密集/稀疏/ColBERT），1024 维
 * - BGE-large-zh-v1.5: 中文专用，1024 维，效果优于 OpenAI 中文场景
 * - 本地部署用 sentence-transformers 或 FastAPI 包装
 *
 * 本地部署推荐：用 Xinference 或 text-embeddings-inference (HuggingFace)
 */
export class BgeEmbedding implements EmbeddingService {
  readonly provider = 'bge';
  readonly model: string;
  readonly dimension: number;
  private endpoint: string;

  constructor(config: {
    endpoint: string;       // "http://localhost:8000/v1/embeddings"
    model?: string;
    dimension?: number;
  }) {
    this.endpoint = config.endpoint;
    this.model = config.model ?? 'bge-m3';
    this.dimension = config.dimension ?? 1024;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) throw new Error(`BGE API error: ${res.status}`);
    const data = await res.json();
    return data.data.map((d: any) => d.embedding);
  }
}

/**
 * Jina Embedding 实现
 *
 * Jina 的特点：支持 8K 长文本 embedding（大多数模型只支持 512 tokens）
 * 适合需要直接 embed 整段文档的场景
 *
 * 模型：jina-embeddings-v3, 1024 维
 */
export class JinaEmbedding implements EmbeddingService {
  readonly provider = 'jina';
  readonly model = 'jina-embeddings-v3';
  readonly dimension = 1024;
  private apiKey: string;

  constructor(config: { apiKey: string }) {
    this.apiKey = config.apiKey;
  }

  async embed(text: string): Promise<number[]> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch('https://api.jina.ai/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) throw new Error(`Jina API error: ${res.status}`);
    const data = await res.json();
    return data.data.map((d: any) => d.embedding);
  }
}
```

---

## 5. Embedding 缓存

**工程逻辑**：对话中重复 embed 同一文本是巨大浪费。比如 "Hello, how are you?" 在会话中被问了三次，不应该调用三次 API。缓存可以减少 70%+ 的 embedding API 调用。

```typescript
// packages/core/src/llm/embedding-cache.ts

/**
 * Embedding 缓存层 —— 基于 LRU 的文本去重
 *
 * 工程选择：
 * - 基于文本内容的 SHA-256 hash 做缓存 key（而非文本本身，节省内存）
 * - LRU 淘汰策略：保留最近常用的 10,000 条 embedding
 * - TTL：1 小时后过期（因为 embedding 模型更新时缓存应该失效）
 *
 * 效果：在典型 Agent 对话中，30-50% 的 embedding 请求是重复的
 *      缓存命中后延迟从 50-200ms 降到 < 0.1ms
 */
export class CachedEmbeddingService implements EmbeddingService {
  constructor(
    private inner: EmbeddingService,
    private options?: {
      maxSize?: number;      // LRU 缓存最大条目数
      ttlMs?: number;        // 缓存过期时间
    }
  ) {}

  get provider() { return this.inner.provider; }
  get model() { return this.inner.model; }
  get dimension() { return this.inner.dimension; }

  private cache = new Map<string, { vector: number[]; expiry: number }>();
  private readonly maxSize = this.options?.maxSize ?? 10000;
  private readonly ttlMs = this.options?.ttlMs ?? 3600_000;

  async embed(text: string): Promise<number[]> {
    const cached = this.getFromCache(text);
    if (cached) return cached;

    const vector = await this.inner.embed(text);
    this.saveToCache(text, vector);
    return vector;
  }

  /**
   * 批量 embed —— 智能分片：只发送缓存 miss 的文本
   *
   * 这是缓存的最大价值所在：批量请求中可以只发未缓存的文本
   * 减少 API 传输量，同时不破坏顺序
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // 第一步：检查缓存命中
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const missedIndices: number[] = [];
    const missedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const cached = this.getFromCache(texts[i]);
      if (cached) {
        results[i] = cached;
      } else {
        missedIndices.push(i);
        missedTexts.push(texts[i]);
      }
    }

    // 第二步：批量 embed 缓存 miss 的文本
    if (missedTexts.length > 0) {
      const missedVectors = await this.inner.embedBatch(missedTexts);

      for (let i = 0; i < missedIndices.length; i++) {
        const originalIndex = missedIndices[i];
        results[originalIndex] = missedVectors[i];
        this.saveToCache(missedTexts[i], missedVectors[i]);
      }
    }

    return results as number[][];
  }

  /** 清除缓存（适用于模型切换后） */
  clearCache(): void {
    this.cache.clear();
  }

  /** 获取缓存统计 */
  getStats(): { size: number; maxSize: number; hitRate: number } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.cacheHits / Math.max(this.totalLookups, 1),
    };
  }

  private cacheHits = 0;
  private totalLookups = 0;

  private getFromCache(text: string): number[] | null {
    this.totalLookups++;
    const key = this.hashText(text);
    const entry = this.cache.get(key);

    if (!entry) return null;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }

    this.cacheHits++;
    // LRU: 重新 set 以更新访问顺序
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.vector;
  }

  private saveToCache(text: string, vector: number[]): void {
    const key = this.hashText(text);

    // LRU 淘汰
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      // Map 的 keys() 按插入顺序迭代
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      vector,
      expiry: Date.now() + this.ttlMs,
    });
  }

  /** 使用简单的字符串 hash（生产环境可用 crypto.createHash） */
  private hashText(text: string): string {
    // 简化的 hash 实现（生产环境用 Node.js crypto）
    // const { createHash } = await import('crypto');
    // return createHash('sha256').update(text).digest('hex');

    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;  // Convert to 32-bit integer
    }
    return `${this.provider}:${this.model}:${hash.toString(16)}`;
  }
}
```

---

## 6. 索引策略：文档级 vs Chunk 级 vs Token 级

**工程逻辑**：向量数据库的"一个向量代表什么"是一个容易被忽视的设计决策。粒度太粗（文档级）导致召回噪声大；粒度太细（token级）导致上下文碎片化。

```
索引策略决策树：

Q: 你要索引什么类型的数据？
├── 对话记忆 (短文本，20-200 字)
│   └── 推荐：每条记忆 = 一个向量 (MemoryEntry-Level)
│
├── 用户文档 (长文本，1000-50000 字)
│   ├── 需要精确定位 → Chunk 级 (512 token/chunk, 50 token overlap)
│   ├── 需要段落级理解 → Paragraph 级 (按自然段落切分)
│   └── 需要全文档语义 → 文档级 (整段 embed，或分段后取平均)
│
├── 代码库
│   └── 推荐：Function/Class 级 (按代码结构切分)
│
└── FAQ / 知识条目 (每条独立)
    └── 推荐：FAQ 条目级 (每条一问一答 = 一个向量)

关键原则：
1. 召回粒度 = 你的回答需要的最小区块
   - 回答"用户上次说了什么" → MemoryEntry 级
   - 回答"文档第三章怎么说的" → Chunk 级
   - 回答"这个文档在讲什么" → 文档级

2. Embedding 粒度 = 检索粒度 ≠ 回答粒度
   - 你可以按 chunk 做向量检索，但回答时把整个段落或文档的所有 chunks 取出喂给 LLM
   - 这叫"expand-on-retrieve"：检索用细粒度，回答用粗粒度

3. 元数据比内容更重要
   - 每个向量永远附带 sourceId、chunkIndex、title、timestamp
   - 否则召回后你不知道这段内容属于哪个文档
```

```typescript
// packages/core/src/memory/indexing-strategy.ts

/**
 * 索引策略配置
 */
export interface IndexingStrategy {
  /** 索引粒度 */
  granularity: 'entry' | 'chunk' | 'paragraph' | 'document' | 'function';
  /** Chunk 大小（仅 chunk 级有效） */
  chunkSize?: number;
  /** Chunk 重叠（仅 chunk 级有效） */
  chunkOverlap?: number;
  /** 是否存储父文档引用 */
  linkToSource: boolean;
}

/**
 * 分块元数据
 */
export interface ChunkMetadata {
  sourceId: string;             // 源文档/记忆的 ID
  sourceType: string;           // 'document' | 'memory' | 'code'
  sourceTitle?: string;
  chunkIndex: number;
  totalChunks: number;
  startOffset: number;
  endOffset: number;
  /** 父级引用（支持 expand-on-retrieve） */
  parentId?: string;
}

/**
 * 智能分块器 —— 根据策略选择不同切分方式
 */
export class SmartChunker {
  constructor(private strategy: IndexingStrategy) {}

  chunk(text: string, sourceId: string): Array<{ content: string; metadata: ChunkMetadata }> {
    switch (this.strategy.granularity) {
      case 'entry':
        return [{
          content: text,
          metadata: {
            sourceId,
            sourceType: 'memory',
            chunkIndex: 0,
            totalChunks: 1,
            startOffset: 0,
            endOffset: text.length,
          },
        }];

      case 'chunk':
        return this.chunkByToken(text, sourceId);

      case 'paragraph':
        return this.chunkByParagraph(text, sourceId);

      case 'document':
        return [{
          content: this.truncateDocument(text, 8000),
          metadata: {
            sourceId,
            sourceType: 'document',
            chunkIndex: 0,
            totalChunks: 1,
            startOffset: 0,
            endOffset: text.length,
          },
        }];

      case 'function':
        return this.chunkByFunctions(text, sourceId);

      default:
        return this.chunkByToken(text, sourceId);
    }
  }

  private chunkByToken(text: string, sourceId: string) {
    const chunkSize = this.strategy.chunkSize ?? 512;
    const overlap = this.strategy.chunkOverlap ?? 50;
    const chunks: Array<{ content: string; metadata: ChunkMetadata }> = [];

    // 简化的按字符切分（生产用 tiktoken）
    let i = 0;
    let chunkIndex = 0;
    while (i < text.length) {
      const end = Math.min(i + chunkSize * 4, text.length); // 粗略估算 1 token ≈ 4 chars
      const chunk = text.slice(i, end);

      chunks.push({
        content: chunk,
        metadata: {
          sourceId,
          sourceType: 'document',
          chunkIndex,
          totalChunks: 0,  // 后面回填
          startOffset: i,
          endOffset: end,
        },
      });

      i += chunkSize * 4 - overlap * 4;
      chunkIndex++;
    }

    // 回填 totalChunks
    for (const c of chunks) {
      c.metadata.totalChunks = chunks.length;
    }

    return chunks;
  }

  private chunkByParagraph(text: string, sourceId: string) {
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    return paragraphs.map((p, idx) => ({
      content: p.trim(),
      metadata: {
        sourceId,
        sourceType: 'document',
        chunkIndex: idx,
        totalChunks: paragraphs.length,
        startOffset: text.indexOf(p),
        endOffset: text.indexOf(p) + p.length,
      },
    }));
  }

  private chunkByFunctions(text: string, sourceId: string) {
    // 简化的函数级切分：按 function/class/brace 切分
    const functionPattern = /^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?class\s+\w+/gm;
    const matches = [...text.matchAll(functionPattern)];

    if (matches.length < 2) {
      return this.chunkByToken(text, sourceId);
    }

    return matches.map((match, idx) => {
      const start = match.index!;
      const end = idx < matches.length - 1 ? matches[idx + 1].index! : text.length;
      return {
        content: text.slice(start, end),
        metadata: {
          sourceId,
          sourceType: 'code',
          chunkIndex: idx,
          totalChunks: matches.length,
          startOffset: start,
          endOffset: end,
        },
      };
    });
  }

  private truncateDocument(text: string, maxLength: number): string {
    return text.length > maxLength ? text.slice(0, maxLength) + '\n...[truncated]' : text;
  }
}
```

---

## 7. 重排序：Cross-Encoder Reranker

**工程逻辑**：向量检索是 Bi-Encoder（查询和文档分别编码），速度快但精度有上限。Cross-Encoder 将查询和文档一起输入模型打分，精度显著提高，但速度慢（无法预计算）。最佳实践是：**用向量检索召回 top-K×3，再用 Reranker 精排取 top-K**。

```typescript
// packages/core/src/memory/reranker.ts

/**
 * Rerank 服务接口
 */
export interface Reranker {
  rerank(query: string, documents: Array<{ id: string; content: string }>, topK: number): Promise<Array<{ id: string; score: number; content: string }>>;
}

/**
 * 本地 BGE Reranker —— 基于 sentence-transformers
 *
 * 部署方式：用 FastAPI 或 gRPC 包装 cross-encoder/ms-marco-MiniLM-L-6-v2
 * 模型推荐：
 * - 中文: bge-reranker-v2-m3 (BAAI, 效果优秀)
 * - 英文: cross-encoder/ms-marco-MiniLM-L-12-v2 (轻量快速)
 * - 多语言: bge-reranker-v2-gemma (谷歌, 质量最高但较慢)
 *
 * 性能参考（bge-reranker-v2-m3 on V100）：
 * - 100 文档: ~150ms
 * - 300 文档: ~400ms
 * - 1000 文档: ~1500ms
 */
export class BgeReranker implements Reranker {
  private endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  async rerank(
    query: string,
    documents: Array<{ id: string; content: string }>,
    topK: number
  ): Promise<Array<{ id: string; score: number; content: string }>> {
    if (documents.length === 0) return [];

    const res = await fetch(`${this.endpoint}/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        documents: documents.map(d => d.content),
      }),
    });

    if (!res.ok) throw new Error(`Rerank API error: ${res.status}`);
    const data = await res.json();

    // 按重排分数排序，取 topK
    const scored = data.scores.map((score: number, idx: number) => ({
      id: documents[idx].id,
      score,
      content: documents[idx].content,
    }));

    return scored.sort((a: any, b: any) => b.score - a.score).slice(0, topK);
  }
}

/**
 * Cohere Rerank API (托管服务)
 *
 * 优点：零运维，全球部署，质量一流
 * 缺点：$2/1000 次调用（前 1000 次/月免费）
 */
export class CohereReranker implements Reranker {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async rerank(
    query: string,
    documents: Array<{ id: string; content: string }>,
    topK: number
  ): Promise<Array<{ id: string; score: number; content: string }>> {
    if (documents.length === 0) return [];

    const res = await fetch('https://api.cohere.com/v1/rerank', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'rerank-v3.5',
        query,
        documents: documents.map(d => d.content),
        top_n: topK,
      }),
    });

    if (!res.ok) throw new Error(`Cohere rerank error: ${res.status}`);
    const data = await res.json();

    return data.results.map((r: any) => ({
      id: documents[r.index].id,
      score: r.relevance_score,
      content: documents[r.index].content,
    }));
  }
}

/**
 * 带 Rerank 的混合检索 —— 生产级完整检索管线
 *
 * 管线：Query → Embed → VectorSearch(top-K*3) → Rerank(top-K) → Return
 */
export class ProductionRetriever {
  constructor(
    private vectorStore: VectorStore,
    private embedding: EmbeddingService,
    private reranker: Reranker,
    private options?: {
      collectionName?: string;
      initialTopK?: number;       // 向量检索返回数量（默认 15）
      finalTopK?: number;         // 最终返回数量（默认 5）
      minScore?: number;          // 最低分数阈值
      enableRerank?: boolean;     // 是否启用 rerank
    }
  ) {}

  /**
   * 完整检索管线
   */
  async retrieve(query: string): Promise<Array<{ id: string; content: string; score: number }>> {
    const initialTopK = this.options?.initialTopK ?? 15;
    const finalTopK = this.options?.finalTopK ?? 5;
    const minScore = this.options?.minScore ?? 0;
    const collection = this.options?.collectionName ?? 'agent_memory';

    // Stage 1: 向量检索获取候选
    const queryVector = await this.embedding.embed(query);
    const candidates = await this.vectorStore.search(collection, queryVector, initialTopK);
    const filtered = candidates.filter(c => c.score >= minScore);

    if (filtered.length === 0) return [];

    // Stage 2: Rerank 精排
    if (this.options?.enableRerank !== false) {
      const reranked = await this.reranker.rerank(
        query,
        filtered.map(c => ({ id: c.id, content: (c.payload.content as string) ?? '' })),
        finalTopK
      );

      return reranked.map(r => ({
        id: r.id,
        content: r.content,
        score: r.score,
      }));
    }

    // 不设 Rerank 时直接返回向量检索结果
    return filtered.slice(0, finalTopK).map(c => ({
      id: c.id,
      content: (c.payload.content as string) ?? '',
      score: c.score,
    }));
  }
}
```

---

## 8. 前端：向量配置面板

```typescript
// apps/web/src/components/settings/VectorDBPanel.tsx

import { useState, useCallback } from 'react';

interface VectorDBConfig {
  provider: 'qdrant' | 'milvus' | 'memory';
  url: string;
  apiKey?: string;
  embeddingModel: string;
  dimension: number;
  similarityThreshold: number;
  enableRerank: boolean;
  rerankProvider: 'bge' | 'cohere' | 'none';
  collectionName: string;
  chunkSize: number;
  chunkOverlap: number;
  indexingStrategy: 'entry' | 'chunk' | 'paragraph' | 'document';
}

interface RecallTestResult {
  latencyMs: number;
  results: Array<{ id: string; content: string; score: number }>;
  cacheHit: boolean;
}

export function VectorDBPanel() {
  const [config, setConfig] = useState<VectorDBConfig>({
    provider: 'qdrant',
    url: 'http://localhost:6333',
    embeddingModel: 'text-embedding-3-small',
    dimension: 1536,
    similarityThreshold: 0.7,
    enableRerank: false,
    rerankProvider: 'none',
    collectionName: 'agent_memory',
    chunkSize: 512,
    chunkOverlap: 50,
    indexingStrategy: 'chunk',
  });

  const [testQuery, setTestQuery] = useState('');
  const [testResult, setTestResult] = useState<RecallTestResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  const handleTestRecall = useCallback(async () => {
    if (!testQuery.trim()) return;
    setIsTesting(true);
    try {
      const startTime = performance.now();
      const res = await fetch('/api/vector/test-recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: testQuery, limit: 10 }),
      });
      const data = await res.json();
      setTestResult({
        latencyMs: performance.now() - startTime,
        results: data.results,
        cacheHit: data.cacheHit ?? false,
      });
    } catch (error) {
      console.error('Test recall failed:', error);
    } finally {
      setIsTesting(false);
    }
  }, [testQuery]);

  const handleSaveConfig = useCallback(async () => {
    await fetch('/api/vector/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
  }, [config]);

  return (
    <div className="space-y-6">
      {/* Provider 选择 */}
      <div>
        <h3 className="text-sm font-medium mb-3">向量数据库</h3>
        <div className="grid grid-cols-3 gap-2">
          {(['qdrant', 'milvus', 'memory'] as const).map(p => (
            <button
              key={p}
              onClick={() => setConfig(prev => ({ ...prev, provider: p }))}
              className={`p-2 text-sm rounded-lg border ${
                config.provider === p ? 'border-accent bg-accent/10' : 'border-border'
              }`}
            >
              {p === 'qdrant' ? 'Qdrant' : p === 'milvus' ? 'Milvus' : '内存 (测试)'}
            </button>
          ))}
        </div>
      </div>

      {/* 连接配置 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs opacity-60 mb-1">连接地址</label>
          <input
            type="text"
            value={config.url}
            onChange={e => setConfig(prev => ({ ...prev, url: e.target.value }))}
            className="w-full px-3 py-2 text-sm rounded-lg bg-surface border border-border"
          />
        </div>
        <div>
          <label className="block text-xs opacity-60 mb-1">API Key</label>
          <input
            type="password"
            value={config.apiKey ?? ''}
            onChange={e => setConfig(prev => ({ ...prev, apiKey: e.target.value }))}
            className="w-full px-3 py-2 text-sm rounded-lg bg-surface border border-border"
          />
        </div>
      </div>

      {/* Embedding 配置 */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs opacity-60 mb-1">Embedding 模型</label>
          <select
            value={config.embeddingModel}
            onChange={e => setConfig(prev => ({ ...prev, embeddingModel: e.target.value }))}
            className="w-full px-3 py-2 text-sm rounded-lg bg-surface border border-border"
          >
            <option value="text-embedding-3-small">OpenAI text-embedding-3-small (1536d)</option>
            <option value="text-embedding-3-large">OpenAI text-embedding-3-large (3072d)</option>
            <option value="bge-m3">BGE-M3 (1024d)</option>
            <option value="bge-large-zh-v1.5">BGE-large-zh-v1.5 (1024d)</option>
            <option value="jina-embeddings-v3">Jina v3 (1024d, 长文本)</option>
          </select>
        </div>
        <div>
          <label className="block text-xs opacity-60 mb-1">相似度阈值</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={config.similarityThreshold}
            onChange={e => setConfig(prev => ({ ...prev, similarityThreshold: parseFloat(e.target.value) }))}
            className="w-full"
          />
          <div className="text-xs opacity-40">{config.similarityThreshold}</div>
        </div>
      </div>

      {/* Rerank 配置 */}
      <div>
        <h3 className="text-sm font-medium mb-3">Rerank 重排序</h3>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input
            type="checkbox"
            checked={config.enableRerank}
            onChange={e => setConfig(prev => ({ ...prev, enableRerank: e.target.checked }))}
          />
          启用 Rerank（提升精度但增加 100-500ms 延迟）
        </label>
        {config.enableRerank && (
          <div className="flex gap-2">
            <select
              value={config.rerankProvider}
              onChange={e => setConfig(prev => ({ ...prev, rerankProvider: e.target.value as any }))}
              className="px-3 py-2 text-sm rounded-lg bg-surface border border-border"
            >
              <option value="bge">BGE Reranker (本地)</option>
              <option value="cohere">Cohere Rerank (托管)</option>
            </select>
          </div>
        )}
      </div>

      {/* 索引策略 */}
      <div>
        <h3 className="text-sm font-medium mb-3">索引粒度</h3>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: 'entry', label: '条目级', desc: '每条记忆一个向量' },
            { value: 'chunk', label: 'Chunk 级', desc: '512 token/块，最适合文档' },
            { value: 'paragraph', label: '段落级', desc: '按自然段落切分' },
            { value: 'document', label: '文档级', desc: '整段一个向量，快速但粗' },
          ] as const).map(s => (
            <button
              key={s.value}
              onClick={() => setConfig(prev => ({ ...prev, indexingStrategy: s.value }))}
              className={`p-2 text-left rounded-lg border ${
                config.indexingStrategy === s.value ? 'border-accent' : 'border-border'
              }`}
            >
              <div className="text-sm">{s.label}</div>
              <div className="text-xs opacity-40">{s.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 测试召回 */}
      <div>
        <h3 className="text-sm font-medium mb-3">测试召回</h3>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="输入查询测试向量检索效果..."
            value={testQuery}
            onChange={e => setTestQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleTestRecall()}
            className="flex-1 px-3 py-2 text-sm rounded-lg bg-surface border border-border"
          />
          <button
            onClick={handleTestRecall}
            disabled={isTesting}
            className="px-4 py-2 text-sm rounded-lg bg-accent text-accent-foreground"
          >
            {isTesting ? '搜索中...' : '测试'}
          </button>
        </div>

        {testResult && (
          <div className="mt-3 p-3 rounded-lg bg-surface/50 border border-border">
            <div className="text-xs opacity-50 mb-2">
              延迟: {Math.round(testResult.latencyMs)}ms
              {testResult.cacheHit && ' · 缓存命中'}
            </div>
            <div className="space-y-2">
              {testResult.results.map((r, idx) => (
                <div key={r.id} className="flex items-start gap-2 text-xs">
                  <span className="flex-shrink-0 w-5 h-5 rounded bg-border/50 flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <span className="flex-1 opacity-70 truncate">{r.content}</span>
                  <span className="text-accent">{r.score.toFixed(3)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 保存按钮 */}
      <div className="flex justify-end">
        <button
          onClick={handleSaveConfig}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-accent-foreground"
        >
          保存配置
        </button>
      </div>
    </div>
  );
}
```

---

## 9. AI 避坑汇总

> 🤖 **AI 常见错误**：
>
> 1. **Embedding 模型不一致**：存的时候用 BGE-large (1024 维)，建 Collection 时 dimension 设成 1536 (OpenAI 的小模型)，结果查询时向量维度不匹配，直接报错。更隐蔽的是存和查用不同模型但同是 1536 维——不会报错但召回率接近 0。
>
> 2. **Qdrant Payload 过滤的 AND/OR 嵌套写法错误**：AI 经常写成 `filter: { userId: "xx", tier: "episodic" }`（扁平 AND），但 Qdrant 的正确写法是 `filter: { must: [{...}, {...}] }`。复杂的 OR 条件嵌套更容易写错，建议在 IDE 中用类型提示。
>
> 3. **Batch upsert 不做错误重试**：Agent 对话中写入记忆是异步的，但 Qdrant upsert 可能因网络抖动失败。如果不重试，部分记忆就"丢了"——用户说"记住这个"但下次对话想不起来。必须实现指数退避重试。
>
> 4. **Collection 维度不匹配**：开发时用小 embedding 模型（384 维），部署切到大模型（1536 维），但 Collection 没重建。Qdrant 不会自动检测维度不匹配，它会静默地只比较前 384 维，召回率严重下降且完全无报错。
>
> 5. **忽略 Payload 索引**：频繁按 userId 过滤但没建索引，每次查询都是全表扫描。10 万条记忆时可能感觉不到，到 100 万条时延迟从 5ms 飙到 500ms。高频过滤字段必须建 Payload 索引。
>
> 6. **Embedding 缓存的 hash 碰撞**：用简单的 hash 函数（如 Java 的 hashCode）作为缓存 key 可能出现碰撞——不同文本映射到同一个 hash，导致返回错误的 embedding。必须用加密级 hash（SHA-256）。
>
> 7. **Reranker 候选数过少**：用向量检索召回 5 个文档然后 Rerank，Rerank 几乎没意义（候选太少）。标准做法是召回 K×3（如 15-30 个），让 Reranker 有足够空间区分优劣。
>
> 8. **Milvus 不加载 Collection**：Milvus 需要显式 `loadCollectionSync` 将数据加载到内存后才能搜索。忘记这一步会导致搜索返回空结果但不报错（静默失败）。
