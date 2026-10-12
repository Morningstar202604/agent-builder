# 12 — 向量数据库实战：直接用官方 SDK，不封装

> 本 reference 覆盖向量数据库的生产级实战：选型决策树、Qdrant / Milvus / Chroma 官方 SDK 直连、Embedding 多 Provider 薄抽象 `[CUSTOM]`、缓存策略、Rerank 重排序与索引策略。读完本文件即可独立落地高性能向量检索。

> **⚠️ 本层铁律：不自研连接池，不手写查询封装。**
> - 向量库客户端 → **Qdrant / Milvus / Chroma 官方 SDK**（`@qdrant/js-client-rest` / `@zilliz/milvus2-sdk-node` / `chromadb`），不要写 `VectorStore` 接口 + 各库适配器
> - 分块 / 索引 / 检索管线 → **LlamaIndex / Haystack / LangChain**（见 03、15），不要手写 SmartChunker
> - Embedding 调用 → **AI SDK `embed` / `embedMany`**（`ai` + provider SDK），不要手写 HTTP `/embeddings`
>
> - 混合检索 → **Qdrant / Weaviate / Elasticsearch / Pinecone 原生 hybrid**（dense + sparse + RRF），不要手写 BM25 + RRF
> - 重排 → **Cohere Rerank / bge-reranker**（cross-encoder）；纯向量无重排是淘汰做法
> 本层唯一允许手写的 `[CUSTOM]` 是 **Embedding 多 Provider 薄抽象**与**缓存装饰器**——它们是业务胶水，没有现成替代。

---

## 目录

- [1 选型决策树](#1-选型决策树)
- [2 向量库选型对比表（2026）](#2-向量库选型对比表2026)
- [3 Qdrant 官方 SDK 直连](#3-qdrant-官方-sdk-直连)
  - [3.1 基础写入与检索](#31-基础写入与检索)
  - [3.2 混合检索：dense + sparse + RRF（Qdrant 原生）](#32-混合检索dense--sparse--rrfqdrant-原生)
- [4 Weaviate 官方 SDK 直连](#4-weaviate-官方-sdk-直连)
- [5 Milvus / Chroma 直连要点](#5-milvus--chroma-直连要点)
- [6 Pinecone / pgvector / Elasticsearch 要点](#6-pinecone--pgvector--elasticsearch-要点)
- [7 Embedding 多 Provider 薄抽象 [CUSTOM]](#7-embedding-多-provider-薄抽象-custom)
- [8 Embedding 缓存策略](#8-embedding-缓存策略)
  - [8.1 内存缓存装饰器](#81-内存缓存装饰器)
  - [8.2 版本化与持久化缓存](#82-版本化与持久化缓存)
- [9 Rerank 重排序（标配）](#9-rerank-重排序标配)
  - [9.1 标准管线：召回 top-K×3 → 精排取 top-K](#91-标准管线召回-top-k3--精排取-top-k)
  - [9.2 重排服务对比](#92-重排服务对比)
  - [9.3 端到端：混合检索 + cross-encoder 重排](#93-端到端混合检索--cross-encoder-重排)
- [10 ColBERT late-interaction：何时用](#10-colbert-late-interaction何时用)
- [11 索引策略](#11-索引策略)
- [12 AI 避坑汇总](#12-ai-避坑汇总)
- [13 本层验收清单](#13-本层验收清单)

---

## 1. 选型决策树

🔗 **工程逻辑**：Agent 记忆的向量库选择 = 运维成本 × 数据规模 × 查询模式。先选型再写代码，避免\"写完再换库\"。

```
Q: 你的向量规模多大？
├── < 100 万，本机/原型 → Chroma（零运维，官方 chromadb）
├── < 5000 万，生产 → Qdrant（默认首选：API 简洁、Payload 过滤强、自托管/Docker 一键起）
├── > 5000 万，分布式/高可用 → Milvus（etcd + MinIO + 消息队列，运维成本高）
└── 已有 Postgres → 先评估 pgvector（与业务数据同库，减少组件）

关键决策依据：
1. 过滤能力：Qdrant Payload 过滤、Milvus 表达式、Chroma where —— 多用户 Agent 必须按 userId 过滤，这是刚需
2. 部署形态：Qdrant/Chroma 可单机 Docker；Milvus 需要完整分布式组件
3. 生态：三个都有官方 JS SDK，切换成本集中在\"集合\"与\"查询\"两处
```

> 🤖 **AI 常见错误**：数据量 10 万级直接上 Milvus——引入 etcd/MinIO/消息队列三套运维负担。Qdrant 单机 Docker 即可覆盖绝大多数 Agent 记忆场景。

---

## 2. 向量库选型对比表（2026）

🔗 **工程逻辑**：选型不是“哪个最好”，而是“哪个最匹配你的约束”。下表是 2026 年生产级向量库横向对比（结合 `docs/TECH_LANDSCAPE.md` 的向量库清单与 REUSE_MATRIX 的成熟度判断）：

| 维度 | Qdrant | Milvus | Weaviate | Pinecone | pgvector | Elasticsearch |
|------|--------|--------|----------|---------|----------|---------------|
| 部署形态 | 单机 Docker / 集群 | 分布式组件（etcd/MinIO/MQ） | 单机 Docker / 集群 | 全托管 SaaS | Postgres 扩展 | 自建 / Elastic Cloud |
| 官方 TS SDK | `@qdrant/js-client-rest` | `@zilliz/milvus2-sdk-node` | `weaviate-ts-client` | `@pinecone-database/pinecone` | `pg` + `pgvector` | `@elastic/elasticsearch` |
| 混合检索 | dense + sparse + RRF 原生 | dense + sparse（需自行融合） | BM25 + 向量 + RRF 原生 | dense + sparse（API 级） | 应用层融合（SQL + 向量） | BM25 + knn + RRF 原生（8.8+） |
| 过滤能力 | Payload 过滤（强） | 表达式过滤 | where 过滤（强） | metadata 过滤 | SQL where（最强） | query DSL（强） |
| 多租户 | userId 字段 + Payload 索引 | 表达式 + 分区 | tenant 概念内建 | namespace | 行级 RLS | 文档级权限 |
| 运维成本 | 低 | 高 | 中 | 零（托管） | 低（随 Postgres） | 中高 |
| 适合 | Agent 记忆、RAG 标配 | 亿级向量、分布式高可用 | 语义搜索 + 混合场景 | 不想运维、快速上线 | Postgres 存量业务 | 已有 ES 搜索栈 |

**决策速查**：
- 已有 Postgres → 先评估 pgvector，少一个组件；
- 已有 Elasticsearch 搜索栈 → 用 ES 的 `knn` + RRF，别再加一个向量库；
- 需要图近邻 / 混合场景 → Weaviate（hybrid 原生）；
- 亿级 + 高可用 → Milvus；
- 不想运维 → Pinecone；
- 默认推荐 → Qdrant（混合检索 + Payload 过滤 + 运维成本平衡最好）。

> 🤖 **AI 常见错误**：选型只看“支持向量检索”，忽略混合检索与过滤能力——Agent 记忆场景里 `userId` 过滤和多租户隔离比百万级召回更重要。

---

## 3. Qdrant 官方 SDK 直连

🔗 **工程逻辑**：Qdrant 官方 `@qdrant/js-client-rest` 已提供 create / upsert / search / scroll / delete 与 Payload 过滤的全部能力。业务代码直接调用 SDK，**不写 `VectorStore` 接口 + 适配器类**——那只是把官方 API 换皮，API 一升级就要改三层。

### 3.1 基础写入与检索

```typescript
// packages/core/src/memory/qdrant.ts —— Qdrant 直连（零封装）
import { QdrantClient } from '@qdrant/js-client-rest';

export const qdrant = new QdrantClient({
  url: process.env.QDRANT_URL ?? 'http://localhost:6333',
  apiKey: process.env.QDRANT_API_KEY, // 自托管可留空，Qdrant Cloud 必填
});
```

首次部署建 Collection 与 Payload 索引（幂等启动）：

```typescript
// packages/core/src/memory/qdrant-setup.ts
import { qdrant } from './qdrant';

export async function ensureAgentMemoryCollection(dimension: number): Promise<void> {
  const name = 'agent_memory';
  const existing = await qdrant.getCollections();
  if (existing.collections.some((c) => c.name === name)) return;

  await qdrant.createCollection(name, {
    vectors: {
      size: dimension,
      distance: 'Cosine', // embedding 向量默认余弦相似度
      hnsw_config: { m: 16, ef_construct: 200 },
    },
  });
  // 高频过滤字段必须建 Payload 索引，否则百万级数据全表扫描
  await qdrant.createPayloadIndex(name, { field_name: 'userId', field_schema: 'keyword' });
  await qdrant.createPayloadIndex(name, { field_name: 'createdAt', field_schema: 'integer' });
}
```

写入与检索：

```typescript
// packages/core/src/memory/qdrant-ops.ts
import { qdrant } from './qdrant';

export interface MemoryPoint {
  id: string;
  embedding: number[];
  content: string;
  userId: string;
  createdAt: number;
}

export async function upsertMemory(entries: MemoryPoint[]): Promise<void> {
  await qdrant.upsert('agent_memory', {
    wait: false, // 异步写入，不阻塞 Agent 对话
    points: entries.map((e) => ({
      id: e.id,
      vector: e.embedding,
      payload: { content: e.content, userId: e.userId, createdAt: e.createdAt },
    })),
  });
}

export async function searchMemory(
  vector: number[],
  userId: string,
  limit = 15
): Promise<Array<{ id: string; score: number; content: string }>> {
  const hits = await qdrant.search('agent_memory', {
    vector,
    limit,
    score_threshold: 0.7, // 不设阈值时任意查询都返回 K 条结果
    filter: { must: [{ key: 'userId', match: { value: userId } }] },
    with_payload: true,
    with_vector: false,
    params: { ef: 256 },
  });
  return hits.map((h) => ({
    id: String(h.id),
    score: h.score ?? 0,
    content: (h.payload?.content as string) ?? '',
  }));
}
```

> 🤖 **AI 常见错误**：搜索省略 `score_threshold`——任意向量都会返回 K 条\"命中\"，相似度 0.1 也当召回结果。必须设阈值（0.7 左右）或在应用层二次过滤。

### 3.2 混合检索：dense + sparse + RRF（Qdrant 原生）

**混合检索已是 2026 RAG 标配**：dense 召回语义、sparse（BM25/SPLADE）召回专名与精确词，RRF（Reciprocal Rank Fusion）融合两路排序。Qdrant 用命名向量（named vectors）在一个点里同时存 dense 与 sparse，`prefetch` 并行取两路候选，`fusion: 'rrf'` 融合。

创建带命名向量的 Collection：

```typescript
// packages/core/src/memory/qdrant-hybrid-setup.ts —— 命名向量：dense + sparse 共存
import { qdrant } from './qdrant';

export async function ensureHybridCollection(name: string, denseDim: number): Promise<void> {
  const existing = await qdrant.getCollections();
  if (existing.collections.some((c) => c.name === name)) return;

  await qdrant.createCollection(name, {
    vectors: {
      dense: { size: denseDim, distance: 'Cosine' },
    },
    sparse_vectors: {
      sparse: {},
    },
  });
  await qdrant.createPayloadIndex(name, { field_name: 'userId', field_schema: 'keyword' });
}
```

写入带 dense + sparse 的点（sparse 向量来自 fastembed 的 SPLADE / BM25 模块等稀疏编码模型）：

```typescript
// packages/core/src/memory/qdrant-hybrid-ops.ts —— Qdrant 原生 hybrid 写入与查询
import { qdrant } from './qdrant';

export interface HybridPoint {
  id: string;
  dense: number[];
  sparse: { indices: number[]; values: number[] };
  content: string;
  userId: string;
}

export async function upsertHybridPoints(collection: string, points: HybridPoint[]): Promise<void> {
  await qdrant.upsert(collection, {
    wait: false,
    points: points.map((p) => ({
      id: p.id,
      vector: {
        dense: p.dense,
        sparse: p.sparse,
      },
      payload: { content: p.content, userId: p.userId },
    })),
  });
}

export async function hybridSearch(
  collection: string,
  dense: number[],
  sparse: { indices: number[]; values: number[] },
  userId: string,
  limit = 5
): Promise<Array<{ id: string; content: string; score: number }>> {
  const res = await qdrant.query(collection, {
    prefetch: [
      { query: dense, using: 'dense', limit: limit * 3 },
      { query: sparse, using: 'sparse', limit: limit * 3 },
    ],
    fusion: 'rrf',
    limit,
    filter: { must: [{ key: 'userId', match: { value: userId } }] },
    with_payload: true,
  });
  return res.points.map((p) => ({
    id: String(p.id),
    content: String(p.payload?.content ?? ''),
    score: typeof p.score === 'number' ? p.score : 0,
  }));
}
```

> 🔗 **工程逻辑**：`limit: limit * 3` 是召回-精排的标准做法——每路先召回 3 倍候选交给 RRF 融合，再取最终 top-K。RRF 融合后的分数不可跨库比较，只能用于本查询内部排序。

---

## 4. Weaviate 官方 SDK 直连

🔗 **工程逻辑**：Weaviate 的差异化在**原生混合检索**——一个 `hybrid` 查询同时跑 BM25（sparse）与向量近邻（dense），`alpha` 控制两者权重，`fusionType: 'rrf'` 用 RRF 融合。官方 TS 客户端直连，不封装。

```typescript
// packages/core/src/memory/weaviate.ts —— Weaviate 官方 SDK 直连（零封装）
import weaviate from 'weaviate-ts-client';
import type { WeaviateClient } from 'weaviate-ts-client';

export function createWeaviateClient(env: Record<string, string | undefined>): WeaviateClient {
  return weaviate.client({
    scheme: env.WEAVIATE_SCHEME ?? 'http',
    host: env.WEAVIATE_HOST ?? 'localhost:8080',
    __AKF__: env.WEAVIATE_API_KEY, // 占位字段名：云实例需要，自托管可省略
  });
}

export async function upsertWeaviate(client: WeaviateClient, docs: Array<{ id: string; content: string; userId: string }>): Promise<void> {
  await client.data.batcher.objects()
    .withObjects(docs.map((d) => ({
      class: 'Memory',
      id: d.id,
      properties: { content: d.content, userId: d.userId },
    })))
    .do();
}

export async function weaviateHybrid(
  client: WeaviateClient,
  query: string,
  userId: string,
  limit = 5
): Promise<Array<{ id: string; content: string; score: number }>> {
  const res = await client.graphql
    .get()
    .withClassName('Memory')
    .withHybrid({ query, alpha: 0.5, fusionType: 'rrf' }) // alpha=0.5：dense 与 sparse 各半
    .withWhere({ path: ['userId'], operator: 'Equal', valueString: userId })
    .withFields('_additional { id score } content')
    .withLimit(limit)
    .do();

  const items = res.data.Get.Memory ?? [];
  return items.map((it: { _additional: { id: string; score: number }; content: string }) => ({
    id: it._additional.id,
    content: it.content,
    score: it._additional.score ?? 0,
  }));
}
```

> 🤖 **AI 常见错误**：`alpha: 1` 等于纯向量、`alpha: 0` 等于纯 BM25——写死 `alpha: 1` 就失去了混合检索的意义。从 `alpha: 0.5` 起步，用评估集调参。

---

## 5. Milvus / Chroma 直连要点

🔗 **工程逻辑**：切换向量库 = 换一个官方 SDK 调用，而不是换一个自研适配器。以下只给出与 Qdrant 的差异点，完整 API 以官方文档为准。

### 5.1 Milvus

```typescript
// packages/core/src/memory/milvus.ts —— Milvus 直连（零封装）
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

export const milvus = new MilvusClient({
  address: process.env.MILVUS_ADDRESS ?? 'localhost:19530',
  username: process.env.MILVUS_USER ?? 'root',
  password: process.env.MILVUS_PASSWORD ?? 'Milvus',
});
```

Milvus 与 Qdrant 的三个关键差异：
1. **Schema 先行**：建 Collection 必须显式声明字段类型，`vector` 字段用 `FloatVector` 并指定 `dim`；
2. **索引与加载分离**：`createIndex` 之后必须 `loadCollectionSync` 才能搜索，漏掉会静默返回空结果；
3. **过滤用表达式**：搜索时 `filter` 是字符串（如 `userId == \"u1\" and createdAt > 1700000000`），不是对象嵌套。

### 5.2 Chroma

```typescript
// packages/core/src/memory/chroma.ts —— Chroma 直连（零封装，原型/测试首选）
import { ChromaClient } from 'chromadb';

export const chroma = new ChromaClient({ path: process.env.CHROMA_URL ?? 'http://localhost:8000' });

export async function queryChroma(vector: number[], userId: string, limit = 15) {
  const collection = await chroma.getOrCreateCollection({ name: 'agent_memory' });
  const res = await collection.query({
    queryEmbeddings: [vector],
    nResults: limit,
    where: { userId },
  });
  return (res.documents?.[0] ?? []).map((content, i) => ({
    id: String(res.ids?.[0]?.[i] ?? i),
    content,
    distance: res.distances?.[0]?.[i] ?? 0,
  }));
}
```

Chroma 适合 < 100 万向量的原型与测试；上生产建议直接换 Qdrant，API 差异集中在\"集合\"与\"查询\"两处，切换成本低。
## 6. Pinecone / pgvector / Elasticsearch 要点

### 6.1 Pinecone（全托管 SaaS）

```typescript
// packages/core/src/memory/pinecone.ts —— Pinecone 官方 SDK（全托管）
import { Pinecone } from '@pinecone-database/pinecone';

export function createPineconeIndex(env: Record<string, string | undefined>) {
  const pc = new Pinecone({
    __AKF__: env.PINECONE_API_KEY, // 占位字段名，真实字段名见官方文档
    host: env.PINECONE_HOST,
  });
  return pc.index(env.PINECONE_INDEX ?? 'agent-memory');
}
```

Pinecone 的混合查询在 `query` 里同时给 dense 与 sparse 两个向量：

```typescript
// packages/core/src/memory/pinecone-ops.ts —— Pinecone hybrid query
import type { Index } from '@pinecone-database/pinecone';

export async function pineconeHybrid(
  index: Index,
  dense: number[],
  sparse: { indices: number[]; values: number[] },
  userId: string,
  topK = 5
): Promise<Array<{ id: string; content: string; score: number }>> {
  const res = await index.query({
    topK,
    vector: { dense, sparse },
    filter: { userId: { $eq: userId } },
    includeMetadata: true,
  });
  return (res.matches ?? []).map((m) => ({
    id: m.id,
    content: String(m.metadata?.content ?? ''),
    score: m.score ?? 0,
  }));
}
```

### 6.2 pgvector（Postgres 存量业务）

```typescript
// packages/core/src/memory/pgvector.ts —— pgvector 扩展 + 官方 pg 客户端
import pg from 'pg';
import { Vector } from 'pgvector';
import 'pgvector/pg';

export function createPgVectorPool(env: Record<string, string | undefined>): pg.Pool {
  return new Pool({
    connectionString: env.DATABASE_URL ?? 'postgres://localhost:5432/agent',
  });
}

export async function ensureVectorExtension(pool: pg.Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
}

export async function searchPgVector(
  pool: pg.Pool,
  embedding: number[],
  userId: string,
  limit = 5
): Promise<Array<{ id: string; content: string; score: number }>> {
  const res = await pool.query(
    `SELECT id, content, 1 - (embedding <=> $1) AS score
     FROM memory
     WHERE user_id = $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [new Vector(embedding), userId, limit]
  );
  return res.rows.map((r) => ({
    id: String(r.id),
    content: String(r.content),
    score: Number(r.score ?? 0),
  }));
}
```

### 6.3 Elasticsearch（已有搜索栈）

```typescript
// packages/core/src/memory/elastic.ts —— ES 官方客户端：knn + BM25 + RRF（8.8+）
import { Client } from '@elastic/elasticsearch';

export function createEsClient(env: Record<string, string | undefined>): Client {
  return new Client({ node: env.ES_URL ?? 'http://localhost:9200' });
}

export async function esHybrid(
  es: Client,
  indexName: string,
  query: string,
  dense: number[],
  userId: string,
  limit = 5
): Promise<Array<{ id: string; content: string; score: number }>> {
  const res = await es.search({
    index: indexName,
    size: limit,
    rank: {
      rrf: {
        retriever: [
          { knn: { field: 'embedding', query_vector: dense, k: limit * 10, filter: { term: { userId } } } },
          { bm25: { query, filter: { term: { userId } } } },
        ],
      },
    },
    _source: ['content'],
  });
  return (res.hits.hits ?? []).map((h) => ({
    id: String(h._id),
    content: String(h._source?.content ?? ''),
    score: typeof h._score === 'number' ? h._score : 0,
  }));
}
```

> 🔗 **工程逻辑**：ES 的 `rank.rrf` 检索器（8.8+）原生融合 `knn` 与 `bm25`，是已有 ES 栈最省事的混合检索入口；8.8 以下版本需应用层分别查询再手工 RRF。

---

## 7. Embedding 多 Provider 薄抽象 [CUSTOM]

> `[CUSTOM]` 理由：业务需要一个统一的 `embed / embedBatch` 入口和**维度注册表**（维度直接决定 Collection 配置），AI SDK 没有跨 provider 的维度注册能力；但内部**零手写 HTTP**——全部走 `ai` 的 `embed / embedMany` 与官方 provider SDK。这是胶水层，不是基础设施。

```typescript
// packages/core/src/llm/embedding.ts —— Embedding 多 Provider 薄抽象 [CUSTOM]
import { embed, embedMany } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface EmbeddingService {
  readonly provider: string;
  readonly model: string;
  readonly dimension: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export function createEmbeddingService(options: {
  provider: 'openai' | 'local';
  model: string;
  dimension: number;
  env: Record<string, string | undefined>;
}): EmbeddingService {
  const model =
    options.provider === 'openai'
      ? createOpenAI({ apiKey: options.env.OPENAI_API_KEY }).textEmbeddingModel(options.model)
      : createOpenAICompatible({
          name: 'local-embedding',
          baseURL: options.env.EMBEDDING_BASE_URL,
          apiKey: options.env.EMBEDDING_API_KEY,
        }).textEmbeddingModel(options.model);

  return {
    provider: options.provider,
    model: options.model,
    dimension: options.dimension,
    async embed(text: string) {
      const { embedding } = await embed({ model, value: text });
      return embedding;
    },
    async embedBatch(texts: string[]) {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({ model, values: texts });
      return embeddings;
    },
  };
}
```

🔗 **工程逻辑**：
- 切换 Provider 只改配置（`provider` / `model` / `dimension`），业务代码不动；
- **维度是硬约束**：换模型导致维度变化时，必须重建 Collection（Qdrant 不会自动检测维度不匹配，只会静默比较前 N 维）；
- 与 01 的 `createModel` 分工：`createModel` 返回对话用 `LanguageModel`，本文件返回 Embedding 模型，二者都是 AI SDK 官方抽象，不自研客户端。

---

## 8. Embedding 缓存策略

### 8.1 内存缓存装饰器

🔗 **工程逻辑**：Agent 对话中同一文本会反复出现（\"记住这个\"、重复查询），embedding 是付费 API 调用。缓存可减少 50%+ 调用。这是业务层优化，用装饰器模式包裹 `EmbeddingService`，仍在 `[CUSTOM]` 边界内。

```typescript
// packages/core/src/llm/embedding-cache.ts —— 缓存装饰器 [CUSTOM]
import { createHash } from 'node:crypto';
import type { EmbeddingService } from './embedding';

export class CachedEmbeddingService implements EmbeddingService {
  private cache = new Map<string, { vector: number[]; expiry: number }>();
  private hits = 0;
  private lookups = 0;

  constructor(
    private readonly inner: EmbeddingService,
    private readonly options: { maxSize?: number; ttlMs?: number } = {}
  ) {}

  get provider(): string { return this.inner.provider; }
  get model(): string { return this.inner.model; }
  get dimension(): number { return this.inner.dimension; }

  async embed(text: string): Promise<number[]> {
    const hit = this.read(text);
    if (hit) return hit;
    const vector = await this.inner.embed(text);
    this.write(text, vector);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const miss: number[] = [];
    texts.forEach((t, i) => {
      const hit = this.read(t);
      if (hit) results[i] = hit;
      else miss.push(i);
    });
    if (miss.length > 0) {
      const vectors = await this.inner.embedBatch(miss.map((i) => texts[i]));
      vectors.forEach((v, j) => {
        const idx = miss[j];
        results[idx] = v;
        this.write(texts[idx], v);
      });
    }
    return results as number[][];
  }

  private read(text: string): number[] | null {
    this.lookups++;
    const key = this.hash(text);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    this.hits++;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.vector;
  }

  private write(text: string, vector: number[]): void {
    const key = this.hash(text);
    if (this.cache.size >= (this.options.maxSize ?? 10000) && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, { vector, expiry: Date.now() + (this.options.ttlMs ?? 3600_000) });
  }

  private hash(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  getStats(): { size: number; hitRate: number } {
    return { size: this.cache.size, hitRate: this.lookups === 0 ? 0 : this.hits / this.lookups };
  }
}
```

策略要点：
- key 用 SHA-256 截断 16 hex，避免简单 hash 碰撞；
- LRU 淘汰 + TTL 1 小时（embedding 模型升级后缓存自然失效）；
- 批量请求只发送 miss 的文本，命中部分直接回填，不破坏顺序。

> 🤖 **AI 常见错误**：缓存 key 用 32-bit hash——大规模下生日悖论导致碰撞，不同文本返回同一 embedding。必须用加密级 hash（SHA-256）。

### 8.2 版本化与持久化缓存

🔗 **工程逻辑**：内存缓存只覆盖单进程。生产环境需要**跨实例共享缓存 + 模型版本失效**——否则每个 pod 都要重新调用 embedding API。成熟做法：Redis 缓存 + key 里带 embedding 模型版本。

```typescript
// packages/core/src/llm/embedding-redis-cache.ts —— Redis 持久化缓存 [CUSTOM]
import { createClient } from 'redis';
import type { EmbeddingService } from './embedding';

export interface RedisCacheConfig {
  model: string; // 模型名进入 key，换模型自动失效
  url: string;
  ttlSeconds: number;
}

export class RedisEmbeddingCache implements EmbeddingService {
  readonly provider: string;
  readonly model: string;
  readonly dimension: number;

  constructor(
    private readonly inner: EmbeddingService,
    private readonly cfg: RedisCacheConfig
  ) {
    this.provider = inner.provider;
    this.model = inner.model;
    this.dimension = inner.dimension;
    this.client = createClient({ url: cfg.url });
  }

  private client: ReturnType<typeof createClient>;

  async connect(): Promise<void> {
    await this.client.connect();
  }

  private key(text: string): string {
    return `emb:${this.cfg.model}:${text.length}:${text}`;
  }

  async embed(text: string): Promise<number[]> {
    const cached = await this.client.get(this.key(text));
    if (cached) return JSON.parse(cached) as number[];
    const vector = await this.inner.embed(text);
    await this.client.set(this.key(text), JSON.stringify(vector), { EX: this.cfg.ttlSeconds });
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}
```

> 🤖 **AI 常见错误**：缓存 key 不含模型名——切换 embedding 模型后，旧模型产出的向量被新模型查询命中，维度/分布不匹配导致召回异常。**key 必须带模型版本**，换模型 = 缓存自然失效。

策略要点：
- TTL 建议 24h~7d（embedding 相对稳定，但模型升级后要能尽快失效）；
- 文本长度进入 key，避免超长文本与短文本误命中；
- 含 PII 的敏感记忆不要进 Redis 缓存——用哈希混淆或直接禁用缓存。

---

## 9. Rerank 重排序（标配）

### 9.1 标准管线：召回 top-K×3 → 精排取 top-K

🔗 **工程逻辑**：向量检索是 Bi-Encoder，速度快但精度有上限；Cross-Encoder 把 query 与候选一起打分，精度高但慢。标准管线：**召回 top-K×3 → Rerank 精排 → 取 top-K**。Rerank 服务用成熟方案（Cohere 官方 SDK / 本地 BGE 推理服务），不手写打分模型。

```typescript
// packages/core/src/memory/reranker.ts —— Rerank 调用（官方 SDK / 本地推理服务）
import { CohereClient } from 'cohere-ai';

export const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

export async function rerankWithCohere(
  query: string,
  docs: Array<{ id: string; content: string }>,
  topK: number
): Promise<Array<{ id: string; content: string; score: number }>> {
  const res = await cohere.v2.rerank({
    model: 'rerank-v3.5',
    query,
    documents: docs.map((d) => d.content),
    topN: topK,
  });
  return (res.results ?? []).map((r) => {
    const doc = docs[r.index ?? 0];
    return { id: doc.id, content: doc.content, score: r.relevanceScore ?? 0 };
  });
}
```

本地 BGE Reranker 同理：把 `query` + `documents` POST 到你自己的推理服务 `/rerank`，返回排序后的 topK。**不要**自己训练 / 实现 rerank 模型。

### 9.2 重排服务对比

| 服务 | 形态 | 语言 | 说明 |
|------|------|------|------|
| Cohere Rerank | 托管 API | 多语言 | 生产最省心，官方 SDK |
| bge-reranker | 本地推理（自托管 TEI/Ollama） | 中英 | 数据不出域，GPU 成本自担 |
| Jina Reranker | 托管 API | 多语言 | 与 Cohere 同模式 |
| Voyage rerank | 托管 API | 英文为主 | 已在用 Voyage embedding 可同栈 |

### 9.3 端到端：混合检索 + cross-encoder 重排

```typescript
// packages/core/src/rag/hybrid-rerank.ts —— 标配：Qdrant hybrid 召回 → Cohere 重排
import { qdrant } from '../memory/qdrant';
import { cohere } from '../memory/reranker';

export async function hybridRerankSearch(
  collection: string,
  dense: number[],
  sparse: { indices: number[]; values: number[] },
  query: string,
  userId: string,
  finalK = 5
): Promise<Array<{ id: string; content: string; score: number }>> {
  const candidateK = finalK * 3;
  const res = await qdrant.query(collection, {
    prefetch: [
      { query: dense, using: 'dense', limit: candidateK },
      { query: sparse, using: 'sparse', limit: candidateK },
    ],
    fusion: 'rrf',
    limit: candidateK,
    filter: { must: [{ key: 'userId', match: { value: userId } }] },
    with_payload: true,
  });

  const docs = res.points.map((p) => ({
    id: String(p.id),
    content: String(p.payload?.content ?? ''),
  }));

  const reranked = await cohere.v2.rerank({
    model: 'rerank-v3.5',
    query,
    documents: docs.map((d) => d.content),
    topN: finalK,
  });

  return (reranked.results ?? []).map((r) => {
    const doc = docs[r.index ?? 0];
    return { id: doc.id, content: doc.content, score: r.relevanceScore ?? 0 };
  });
}
```

> 🤖 **AI 常见错误**：只召回 top-K 就 Rerank——如果候选里没有正确答案，重排再准也没用。必须 **召回 K×3~K×10 → 重排 → 取 K**。

---

## 10. ColBERT late-interaction：何时用

ColBERT 把 query 与 doc 各编码为**一组 token 向量**，相似度 = query 每个 token 与 doc 最相似 token 的最大值之和（MaxSim）。相比 Bi-Encoder 单向量（精度有损失）与 cross-encoder（逐对计算太慢），late-interaction 是精度/延迟之间的中间点。Qdrant 原生支持 multivector（`multivector_config` + `comparator: 'max_sim'`）。

| 场景 | 推荐 |
|------|------|
| 长文档、需要细粒度证据定位 | ColBERT（token 级匹配） |
| 查询含多个独立子意图 | ColBERT |
| 超大规模候选集 + 延迟敏感 | 先 Bi-Encoder 召回 K×10 → ColBERT 精排 |
| 常规 RAG（短文本、FAQ） | 不需要，混合检索 + cross-encoder 已够 |

```typescript
// packages/core/src/memory/qdrant-colbert.ts —— Qdrant multivector（late-interaction）
import { qdrant } from './qdrant';

export async function ensureColbertCollection(name: string, tokenDim: number): Promise<void> {
  const existing = await qdrant.getCollections();
  if (existing.collections.some((c) => c.name === name)) return;

  await qdrant.createCollection(name, {
    vectors: {
      colbert: {
        size: tokenDim,
        distance: 'Cosine',
        multivector_config: { comparator: 'max_sim' },
      },
    },
  });
}

export interface ColbertPoint {
  id: string;
  tokenVectors: number[][];
  content: string;
}

export async function upsertColbertPoints(collection: string, points: ColbertPoint[]): Promise<void> {
  await qdrant.upsert(collection, {
    wait: false,
    points: points.map((p) => ({
      id: p.id,
      vector: { colbert: p.tokenVectors },
      payload: { content: p.content },
    })),
  });
}
```

> 🤖 **AI 常见错误**：给短文本（< 20 token）也上 ColBERT——token 级匹配优势发挥不出来，存储成本却翻几倍。**先评估 bad case 是否来自“同义表述”或“长文档定位”**，再决定是否引入。

---

## 11. 索引策略

🔗 **工程逻辑**：\"一个向量代表什么\"决定召回质量。粒度太粗召回噪声大，太细上下文碎片化。**但分块器不需要手写**——LlamaIndex / LangChain / Unstructured 已有成熟实现（见 03、15），本层只给决策依据：

```
Q: 索引什么数据？
├── 对话记忆（短文本） → 每条记忆一个向量（entry 级）
├── 长文档
│   ├── 需要精确定位 → chunk 级（512 token + 50 overlap）
│   ├── 需要段落级理解 → paragraph 级（自然段切分）
│   └── 需要全文语义 → document 级
├── 代码库 → function/class 级（按语法结构切分，交给 tree-sitter 类工具）
└── FAQ → 条目级（一问一答 = 一个向量）

元数据铁律：每个向量必须附带 sourceId / chunkIndex / title / timestamp，
否则召回后无法回答\"这段内容来自哪个文档\"。
检索用细粒度，回答用粗粒度（expand-on-retrieve）。
```

---

## 12. AI 避坑汇总

> 🤖 **AI 常见错误**：
>
> 1. **手写 `VectorStore` 接口 + 适配器**：把 Qdrant/Milvus/Chroma 封装成统一接口，等于同时维护三个 SDK 的换皮，API 一升级就要改三层。直接在各业务函数里调用官方 SDK，切换成本反而更低。
> 2. **搜索不设相似度阈值**：省略 `score_threshold`，任意查询都返回 K 条结果，相似度 0.1 也当命中。必须设阈值（0.7-0.8）或在应用层过滤。
> 3. **维度不匹配静默失败**：换 embedding 模型后维度变了，Collection 没重建。Qdrant 只比较前 N 维，完全不报错，召回率接近 0。换模型 = 重建 Collection。
> 4. **忽略 Payload 索引**：高频过滤字段（userId）不建索引，百万条后每次查询全表扫描，延迟从 5ms 飙到 500ms。
> 5. **Milvus 忘记加载 Collection**：`createIndex` 后不 `loadCollectionSync`，搜索静默返回空结果。
> 6. **Rerank 候选数过少**：召回 5 条再 Rerank 没有意义，必须召回 K×3 再精排。
> 7. **纯向量无重排**：2026 年 RAG 标配是“混合检索 + cross-encoder 重排”，只做 dense 单路召回且不重排是淘汰做法，别写进新管线。
> 8. **手写混合检索融合**：dense 与 sparse 的分数归一化、权重调参、RRF 融合都是坑，直接用 Qdrant/Weaviate/ES 的原生 hybrid API。
> 9. **换 embedding 模型不重建 Collection 也不失效缓存**：维度变化静默失败，缓存 key 必须带模型版本，Collection 必须重建。

---

## 13. 本层验收清单

- [ ] **SDK 直连**：运行 `node tools/check-skill.mjs`，本文件 0 失败；`grep -rn \"class QdrantVectorStore\\|interface VectorStore\" references/12-vector-db-practical.md` 应无结果。
- [ ] **写入召回**：用 `@qdrant/js-client-rest` 写入 3 条记忆，相同 embedding 查询能召回，无关查询在 `score_threshold: 0.7` 下返回空数组。
- [ ] **维度防护**：把 1024 维向量写入 1536 维 Collection 时显式报错或拦截，而不是静默返回空结果。
- [ ] **缓存命中**：连续两次 `embedBatch` 同一批文本，第二次不触发 provider 调用（mock provider 计数为 0）。
- [ ] **Rerank 管线**：mock Reranker 断言\"召回 top-K×3 → 精排取 top-K\"的调用顺序。
- [ ] **契约回归**：本文件未出现旧自定义 LLM 客户端类型，也未实例化裸 Provider 客户端；`llm` 相关引用均为 `LanguageModel` / `createModel`（见 00-types.md）。
- [ ] **混合检索**：`ensureHybridCollection` 后写入 dense+sparse 点，`hybridSearch` 返回 RRF 融合结果；Weaviate `withHybrid` 同样验证。
- [ ] **重排端到端**：mock Cohere Reranker，断言“hybrid 召回 K×3 → rerank → 取 K”的调用顺序与 topN。
- [ ] **缓存版本化**：切换 `cfg.model` 后同一文本重新走 provider（Redis 旧 key 不命中）。
- [ ] **ColBERT 回归**：`ensureColbertCollection` 后写入多行向量点能被 `max_sim` 检索召回。

