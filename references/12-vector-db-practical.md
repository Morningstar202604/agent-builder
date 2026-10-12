# 12 — 向量数据库实战：直接用官方 SDK，不封装

> 本 reference 覆盖向量数据库的生产级实战：选型决策树、Qdrant / Milvus / Chroma 官方 SDK 直连、Embedding 多 Provider 薄抽象 `[CUSTOM]`、缓存策略、Rerank 重排序与索引策略。读完本文件即可独立落地高性能向量检索。

> **⚠️ 本层铁律：不自研连接池，不手写查询封装。**
> - 向量库客户端 → **Qdrant / Milvus / Chroma 官方 SDK**（`@qdrant/js-client-rest` / `@zilliz/milvus2-sdk-node` / `chromadb`），不要写 `VectorStore` 接口 + 各库适配器
> - 分块 / 索引 / 检索管线 → **LlamaIndex / Haystack / LangChain**（见 03、15），不要手写 SmartChunker
> - Embedding 调用 → **AI SDK `embed` / `embedMany`**（`ai` + provider SDK），不要手写 HTTP `/embeddings`
>
> 本层唯一允许手写的 `[CUSTOM]` 是 **Embedding 多 Provider 薄抽象**与**缓存装饰器**——它们是业务胶水，没有现成替代。

---

## 目录

- [1 选型决策树](#1-选型决策树)
- [2 Qdrant 官方 SDK 直连](#2-qdrant-官方-sdk-直连)
- [3 Milvus / Chroma 直连要点](#3-milvus--chroma-直连要点)
- [4 Embedding 多 Provider 薄抽象 [CUSTOM]](#4-embedding-多-provider-薄抽象-custom)
- [5 Embedding 缓存策略](#5-embedding-缓存策略)
- [6 Rerank 重排序](#6-rerank-重排序)
- [7 索引策略](#7-索引策略)
- [8 AI 避坑汇总](#8-ai-避坑汇总)
- [9 本层验收清单](#9-本层验收清单)

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

## 2. Qdrant 官方 SDK 直连

🔗 **工程逻辑**：Qdrant 官方 `@qdrant/js-client-rest` 已提供 create / upsert / search / scroll / delete 与 Payload 过滤的全部能力。业务代码直接调用 SDK，**不写 `VectorStore` 接口 + 适配器类**——那只是把官方 API 换皮，API 一升级就要改三层。

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

---

## 3. Milvus / Chroma 直连要点

🔗 **工程逻辑**：切换向量库 = 换一个官方 SDK 调用，而不是换一个自研适配器。以下只给出与 Qdrant 的差异点，完整 API 以官方文档为准。

### 3.1 Milvus

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

### 3.2 Chroma

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

---

## 4. Embedding 多 Provider 薄抽象 [CUSTOM]

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

## 5. Embedding 缓存策略

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

---

## 6. Rerank 重排序

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

---

## 7. 索引策略

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

## 8. AI 避坑汇总

> 🤖 **AI 常见错误**：
>
> 1. **手写 `VectorStore` 接口 + 适配器**：把 Qdrant/Milvus/Chroma 封装成统一接口，等于同时维护三个 SDK 的换皮，API 一升级就要改三层。直接在各业务函数里调用官方 SDK，切换成本反而更低。
> 2. **搜索不设相似度阈值**：省略 `score_threshold`，任意查询都返回 K 条结果，相似度 0.1 也当命中。必须设阈值（0.7-0.8）或在应用层过滤。
> 3. **维度不匹配静默失败**：换 embedding 模型后维度变了，Collection 没重建。Qdrant 只比较前 N 维，完全不报错，召回率接近 0。换模型 = 重建 Collection。
> 4. **忽略 Payload 索引**：高频过滤字段（userId）不建索引，百万条后每次查询全表扫描，延迟从 5ms 飙到 500ms。
> 5. **Milvus 忘记加载 Collection**：`createIndex` 后不 `loadCollectionSync`，搜索静默返回空结果。
> 6. **Rerank 候选数过少**：召回 5 条再 Rerank 没有意义，必须召回 K×3 再精排。

---

## 9. 本层验收清单

- [ ] **SDK 直连**：运行 `node tools/check-skill.mjs`，本文件 0 失败；`grep -rn \"class QdrantVectorStore\\|interface VectorStore\" references/12-vector-db-practical.md` 应无结果。
- [ ] **写入召回**：用 `@qdrant/js-client-rest` 写入 3 条记忆，相同 embedding 查询能召回，无关查询在 `score_threshold: 0.7` 下返回空数组。
- [ ] **维度防护**：把 1024 维向量写入 1536 维 Collection 时显式报错或拦截，而不是静默返回空结果。
- [ ] **缓存命中**：连续两次 `embedBatch` 同一批文本，第二次不触发 provider 调用（mock provider 计数为 0）。
- [ ] **Rerank 管线**：mock Reranker 断言\"召回 top-K×3 → 精排取 top-K\"的调用顺序。
- [ ] **契约回归**：本文件未出现旧自定义 LLM 客户端类型，也未实例化裸 Provider 客户端；`llm` 相关引用均为 `LanguageModel` / `createModel`（见 00-types.md）。

