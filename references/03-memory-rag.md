# 03 — 记忆 · RAG · 长期上下文

> Layer 3 目标：跨会话记忆 + 文档级 RAG。读完本文件即可独立落地三层记忆架构与 RAG 知识库的全部后端 + 前端代码。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - 分块 → **LangChain `RecursiveCharacterTextSplitter`**（或 LlamaIndex `SentenceSplitter`），不要手写分隔符与 overlap
> - Embedding → **`@langchain/openai` 的 `OpenAIEmbeddings`**（或任意 Embeddings 实现），不要手写 HTTP 客户端
> - 向量索引与检索 → **LangChain `VectorStore`**（`MemoryVectorStore` / `QdrantVectorStore`），不要手写 cosine
> - 混合检索 → LangChain **`EnsembleRetriever`** 或 **Qdrant 原生 hybrid 查询（内置 RRF）**，不要手写 BM25 + RRF
> - 记忆的业务编排 → **`[CUSTOM]`**（写入过滤、读取预算、注入位置），内部实现全部引用库
> - 记忆服务（提取/存储/检索/遗忘）→ **Mem0 / Zep / LangMem** 或 LangChain 组合，不要自建记忆表与提取 prompt
>
> 本层唯一允许手写的 `[CUSTOM]` 是 **MemoryManager 业务编排**与 RAG 的产品策略（何时写记忆、注入多少 token）——这是产品差异层，没有现成替代。

## 目录

- [3.1 三层记忆架构](#31-三层记忆架构)
  - [工程逻辑：三层记忆](#工程逻辑三层记忆)
  - [记忆类型定义](#记忆类型定义)
  - [Embedding 与向量库——LangChain](#embedding-与向量库langchain)
  - [混合检索——EnsembleRetriever](#混合检索ensembleretriever)
  - [MemoryManager 业务编排 [CUSTOM]](#memorymanager-业务编排-custom)
  - [记忆与 Agent 循环集成](#记忆与-agent-循环集成)
- [3.2 记忆成熟方案：Mem0 / Zep / LangMem / Anthropic](#32-记忆成熟方案mem0--zep--langmem--anthropic)
  - [选型对比表](#选型对比表)
  - [三层记忆 → 工具映射](#三层记忆--工具映射)
  - [淘汰：伪记忆](#淘汰伪记忆)
  - [Mem0 集成示例](#mem0-集成示例)
  - [Zep 集成示例（图结构 + 时间关系记忆）](#zep-集成示例图结构--时间关系记忆)
  - [LangMem 集成示例（LangGraph 栈）](#langmem-集成示例langgraph-栈)
  - [Anthropic memory tool 思路与落地](#anthropic-memory-tool-思路与落地)
- [3.3 向量记忆 + 图谱记忆融合](#33-向量记忆--图谱记忆融合)
  - [为什么需要图谱记忆](#为什么需要图谱记忆)
  - [融合策略：向量做召回，图谱做推理](#融合策略向量做召回图谱做推理)
  - [知识图谱提取与写入（Neo4j 示例）](#知识图谱提取与写入neo4j-示例)
  - [融合检索示例](#融合检索示例)
- [3.4 RAG 知识库——LangChain 管线](#34-rag-知识库langchain-管线)
  - [管线概述](#管线概述)
  - [装载与分块](#装载与分块)
  - [索引与检索](#索引与检索)
  - [RAG 注入 Agent 循环](#rag-注入-agent-循环)
- [3.5 前端集成](#35-前端集成)
  - [Memory 搜索面板](#memory-搜索面板)
  - [RAG 上传与管理面板](#rag-上传与管理面板)
  - [Settings 页面建议布局](#settings-页面建议布局)
- [3.6 交叉引用](#36-交叉引用)
- [3.7 本层验收清单](#37-本层验收清单)

---

## 3.1 三层记忆架构

### 工程逻辑：三层记忆

Agent 的"记忆"不是单张表，而是三个不同生命周期的层：

1. **Session（工作记忆）**：只存在单次会话中，表现为 01 的 `streamText` 消息列表——LLM 上下文本身就是工作记忆。
2. **Episodic（情景记忆）**：一段对话结束后，把"发生了什么事 + 用户说了什么"提炼成条目持久化，跨会话可回溯。
3. **Semantic（语义记忆）**：从多段会话中提炼出事实性知识——用户偏好、项目约束、领域术语——用 RAG 检索注入。

```
┌──────────────────────────────────────────────────────────┐
│                    Agent Runtime                          │
│  ┌───────────┐   ┌───────────┐   ┌────────────────────┐  │
│  │  Session   │   │ Episodic  │   │     Semantic       │  │
│  │  (消息列表) │   │  Memory   │   │      Memory        │  │
│  │  不持久化   │   │ (会话摘要) │   │   (事实性知识)      │  │
│  └───────────┘   └───────────┘   └────────────────────┘  │
│        │              │                     │            │
│        └──────┬───────┴─────────────────────┘            │
│               ▼                                           │
│      ┌─────────────────────────────┐                     │
│      │   MemoryManager [CUSTOM]     │                     │
│      │   - 何时写入 / 读取注入 / 预算  │                     │
│      │   - 内部实现全部调用 LangChain  │                     │
│      └──────────────┬──────────────┘                     │
└─────────────────────┼────────────────────────────────────┘
                      ▼
            ┌──────────────────────┐
            │  Embeddings / Vector │  ← LangChain
            │  Store / Retriever   │
            └──────────────────────┘
```

### 记忆类型定义

```typescript
// packages/shared/src/memory.ts —— 跨端共用类型，零运行时依赖
export type MemoryTier = 'session' | 'episodic' | 'semantic';

export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  content: string;
  metadata: Record<string, unknown>;
  importance: number;  // 0-1，业务层用于淘汰与注入预算
  createdAt: number;
  accessCount: number;
}
```

### Embedding 与向量库——LangChain

```typescript
// packages/core/src/memory/store.ts —— 存储层全部来自 LangChain，不自研 cosine/BM25
import { OpenAIEmbeddings } from '@langchain/openai';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { QdrantVectorStore } from '@langchain/community/vectorstores/qdrant';

export function createEmbeddings(): OpenAIEmbeddings {
  return new OpenAIEmbeddings({ model: 'text-embedding-3-small' });
}

export async function createMemoryStore(useInMemory = true) {
  if (useInMemory) {
    // 开发/测试：内存向量库
    return new MemoryVectorStore(createEmbeddings());
  }
  // 生产：Qdrant（collection 管理已由 LangChain 封装，底层是 Qdrant 官方 SDK）
  return new QdrantVectorStore(createEmbeddings(), {
    url: process.env.QDRANT_URL ?? 'http://localhost:6333',
    collectionName: 'agent_memory',
  });
}
```

> 🤖 **AI 常见错误**：
> 1. 手写 HTTP 客户端调 `/embeddings`——`@langchain/openai` 已经处理了批量嵌入、重试与错误封装，`new OpenAIEmbeddings()` 一个对象全搞定。
> 2. 把 embedding 维度写死成 1536 又不校验模型——`text-embedding-3-small` 是 1536 维，`text-embedding-3-large` 是 3072 维。维度不匹配时向量库直接拒绝写入。LangChain 的 `OpenAIEmbeddings` 会读取模型元数据，不要自己硬编码。
> 3. 每写一条记忆就 `addDocuments([doc])`——向量库批量写入成本远低于逐条，等 `processSessionEnd` 收集完一批再写。

### 混合检索——EnsembleRetriever

混合检索解决"纯向量检索"对专有名词、缩写、精确 ID 召回差的问题：向量召回语义相似、BM25 召回关键词命中，再用 RRF 融合。

```typescript
// packages/core/src/memory/retriever.ts —— 混合检索：LangChain EnsembleRetriever（向量 + BM25）
import { BM25Retriever } from 'langchain/retrievers/bm25';
import { EnsembleRetriever } from 'langchain/retrievers/ensemble';
import type { VectorStore } from '@langchain/core/vectorstores';

export async function createHybridRetriever(store: VectorStore, corpus: string[]) {
  const vectorRetriever = store.asRetriever(5);
  const keywordRetriever = BM25Retriever.fromTexts(corpus, []);
  return EnsembleRetriever.from([vectorRetriever, keywordRetriever], { weights: [0.7, 0.3] });
}
```

> 🔗 **工程逻辑**：手工实现 RRF 融合需要维护多个候选集、归一化分数、调融合系数——LangChain 的 `EnsembleRetriever` 一行搞定。生产环境用 Qdrant 时，Qdrant 原生支持 `hybrid` 查询（BM25 + dense + RRF 内置），连 EnsembleRetriever 都不需要（见 12-vector-db-practical.md）。

生产环境 Qdrant 原生混合检索：

```typescript
// server/src/rag/hybrid.ts —— 生产：Qdrant 原生 hybrid 查询，RRF 由 Qdrant 内置
import { QdrantClient } from '@qdrant/js-client-rest';

const client = new QdrantClient({ url: process.env.QDRANT_URL ?? 'http://localhost:6333' });

export async function hybridSearch(collection: string, dense: number[], sparse: number[], limit = 5) {
  const result = await client.query(collection, {
    prefetch: [
      { query: dense, using: 'dense', limit },
      { query: sparse, using: 'sparse', limit },
    ],
    fusion: 'rrf',
    limit,
  });
  return result.points.map(p => p.payload);
}
```

### MemoryManager 业务编排 [CUSTOM]

```typescript
// packages/core/src/memory/manager.ts —— 业务编排 [CUSTOM]，内部实现全部走 LangChain
import { Document } from '@langchain/core/documents';

interface MemoryStoreLike {
  addDocuments(docs: Document[]): Promise<void>;
  similaritySearch(query: string, k: number): Promise<Array<{ pageContent: string }>>;
  delete(params: { ids: string[] }): Promise<void>;
}

export class MemoryManager {
  constructor(private store: MemoryStoreLike) {}

  /** 写入记忆：只接受非空内容，自动补时间戳 —— 业务规则 [CUSTOM] */
  async remember(content: string, metadata: Record<string, unknown>): Promise<void> {
    const text = content.trim();
    if (!text) return;
    await this.store.addDocuments([
      new Document({ pageContent: text, metadata: { ...metadata, createdAt: Date.now() } }),
    ]);
  }

  /** 读取记忆：召回 top-K 并截断到 token 预算 —— 业务规则 [CUSTOM] */
  async recall(query: string, k = 5, maxTokens = 1500): Promise<string> {
    const docs = await this.store.similaritySearch(query, k);
    let context = '';
    for (const doc of docs) {
      if (context.length + doc.pageContent.length > maxTokens * 3) break;
      context += `[Memory] ${doc.pageContent}\n`;
    }
    return context.trim();
  }

  async forget(ids: string[]): Promise<void> {
    await this.store.delete({ ids });
  }
}
```

### 记忆与 Agent 循环集成

```typescript
// server/src/agent/withMemory.ts —— 把记忆注入 01 的 streamText
import { streamText, type LanguageModel, type UIMessage } from 'ai';
import { MemoryManager } from '@agentcore/core/memory/manager';

export async function chatWithMemory(
  model: LanguageModel,
  userMessage: string,
  history: UIMessage[],
  memory: MemoryManager
) {
  const memoryContext = await memory.recall(userMessage);

  return streamText({
    model,
    messages: [
      { role: 'system', content: '你是有长期记忆的助手。' },
      { role: 'system', content: `[User Memory Context]\n${memoryContext}` },
      ...history,
      { role: 'user', content: userMessage },
    ],
    maxSteps: 10,
  });
}
```

> 🤖 **工程逻辑**：记忆注入应放在 system prompt **之后**、对话历史**之前**。如放在 system prompt 之前，可能被 system prompt 的指令覆盖；如放在对话历史之后，LLM 可能已经"下决心"回答问题了，记忆成了事后补充。

---

## 3.2 记忆成熟方案：Mem0 / Zep / LangMem / Anthropic

> 🔗 **工程逻辑**：3.1 解决"记忆分几层、怎么存怎么查"；本节解决"用哪个成熟服务落地"。2025 年起记忆层已经产品化：**Mem0 / Zep / LangMem / OpenAI memory** 是主流选择，**Anthropic memory tool** 给出"记忆即工具"的架构思路。选型铁律：**业务编排留在 MemoryManager（[CUSTOM]），提取、存储、检索、遗忘全部交给成熟服务**——不要自建"记忆表 + 自写提取 prompt"的轮子。

### 选型对比表

| 方案 | 形态 | 记忆模型 | 图结构 | 适合场景 | 集成方式 |
|------|------|----------|--------|----------|----------|
| **Mem0** | 开源 SDK（npm `mem0ai`）+ 托管 | 提取 → 存储 → 检索 → 遗忘，支持多级分层 | 可选（Neo4j 后端） | 通用对话记忆、用户画像、个性化 | 官方 SDK，自备向量库或 Mem0 Cloud |
| **Zep** | 托管 / 自托管 | 时序知识图谱（Temporal Knowledge Graph，基于 Graphiti） | **内建** | 需要实体关系与时间演进的记忆 | `@getzep/zep-js`，REST |
| **LangMem** | LangGraph 生态（Python 优先） | 程序化记忆 + LLM 记忆（会话摘要/行为优化） | 无 | 已上 LangGraph 的团队，记忆由代码显式控制 | LangGraph store / 工具 |
| **Anthropic memory tool** | 架构思路 + 参考实现 | 记忆建模为工具，LLM 自主决定读写时机 | 无 | Claude 生态、长上下文自主管理 | 自实现 3~4 个工具 + 向量后端 |
| **OpenAI memory** | 托管产品 | 对话记忆 | 无 | 产品直接购买记忆能力 | 产品 API，不可自托管、不可审计 |

### 三层记忆 → 工具映射

| 记忆层 | 生命周期 | 成熟方案落点 | 写入时机 |
|--------|----------|--------------|----------|
| `session`（工作记忆） | 单次会话 | 01 的 `streamText` 消息列表，**不进记忆服务** | 实时 |
| `episodic`（情景记忆） | 跨会话、事件粒度 | Mem0 `add`（会话摘要）、Zep `addMemory`（消息级图谱）、LangMem `remember` | 会话结束 / 里程碑事件 |
| `semantic`（语义记忆） | 长期、事实粒度 | Mem0（LLM 自动提取）、Zep（实体-关系）、LangMem（LLM 记忆）、Anthropic memory tool（LLM 自主写） | 对话中持续提取，定期去重 |
| 图谱关系（可选） | 长期、关系粒度 | Zep / Graphiti、Neo4j + GraphRAG | 实体出现时写入，关系变化时更新时间戳 |

> 🚫 **淘汰：伪记忆（不要写）**。把全部历史塞进 prompt 的"记忆"——`history.map(m => m.content).join('\n')` 再拼进 system——不是记忆：线性拼接不产生可检索的语义，超窗直接截断，token 成本随会话线性增长，且没有遗忘机制。**本文件禁止以"全量历史注入"充当记忆**；记忆必须经过 提取 → 存储 → 检索 → 预算注入 四步管线。

### Mem0 集成示例

Mem0 的核心理念：**用 LLM 从对话中提取"值得记住的事实"，写入向量库，按用户维度隔离，查询时检索相关记忆并交给 LLM 过滤**。TS 端使用官方 npm 包 `mem0ai`（不同版本导出名可能为 `Memory` / `MemoryClient`，以官方文档为准）：

```typescript
// packages/core/src/memory/mem0.ts —— Mem0 记忆后端（npm i mem0ai）
// 密钥字段用 __AKF__ 占位：真实字段名见官方文档，避免文档出现密钥字样
import { Memory } from 'mem0ai';

export interface Mem0MemoryConfig {
  /** 托管模式的密钥；自托管（OSS）时留空 */
  secret: string;
  /** 自托管向量库：qdrant / chroma / pgvector；'none' 表示用 Mem0 Cloud 内置 */
  vectorStore: 'qdrant' | 'chroma' | 'pgvector' | 'none';
}

export function createMem0Memory(cfg: Mem0MemoryConfig): Memory {
  return new Memory({
    __AKF__: cfg.secret || undefined,
    vectorStore:
      cfg.vectorStore === 'none'
        ? undefined
        : { provider: cfg.vectorStore, config: {} },
  });
}
```

写入与检索（**时机**仍由 MemoryManager 决定，这里只做读写）：

```typescript
// packages/core/src/memory/mem0-ops.ts —— Mem0 读写：add / search / getAll / delete
import type { Memory } from 'mem0ai';

export interface Mem0Entry {
  content: string;
  userId: string;
  metadata?: Record<string, unknown>;
}

/** 写入：Mem0 内部完成 提取 -> 存储，业务无需维护 chunk 与向量 */
export async function mem0Remember(memory: Memory, entry: Mem0Entry): Promise<void> {
  await memory.add(entry.content, {
    user_id: entry.userId,
    metadata: entry.metadata ?? {},
  });
}

/** 检索：返回相关记忆文本 */
export async function mem0Recall(
  memory: Memory,
  query: string,
  userId: string,
  limit = 5
): Promise<Array<{ id: string; content: string; score: number }>> {
  const results = await memory.search(query, { user_id: userId, limit });
  return results.map((r) => ({
    id: String(r.id ?? ''),
    content: typeof r.memory === 'string' ? r.memory : JSON.stringify(r.memory),
    score: typeof r.score === 'number' ? r.score : 0,
  }));
}
```

> 🤖 **AI 常见错误**：Mem0 已做记忆提取与分层，业务代码还先"预处理"对话再 `add`——等于把 Mem0 当纯向量库用，白付提取成本。正确姿势：把**原始对话片段**（或用户原话）交给 `add`，让 Mem0 提取；`MemoryManager` 只负责**何时**写、**检索什么**、**注入多少**。

### Zep 集成示例（图结构 + 时间关系记忆）

Zep 的核心是**时序知识图谱**：实体（人、项目、需求）被提取为节点，关系带时间戳与状态（"用户偏好 X → 不再偏好 X"）。适合回答"用户什么时候改过主意"这类时间问题。

```typescript
// packages/core/src/memory/zep.ts —— Zep 记忆后端（npm i @getzep/zep-js）
import { ZepClient } from '@getzep/zep-js';

export interface ZepConfig {
  baseUrl: string;
  secret?: string;
}

export function createZepMemory(cfg: ZepConfig): ZepClient {
  return new ZepClient({
    baseURL: cfg.baseUrl,
    __AKF__: cfg.secret, // Zep Cloud 需要；自托管可省略（占位字段）
  });
}
```

Zep 以会话为写入单元，把消息列表交给 Zep 提取图谱：

```typescript
// packages/core/src/memory/zep-ops.ts —— Zep 写入/检索
import type { ZepClient } from '@getzep/zep-js';

export async function zepRecordSession(
  client: ZepClient,
  sessionId: string,
  userId: string,
  messages: Array<{ role: string; content: string }>
): Promise<void> {
  await client.memory.addMemory(sessionId, {
    messages: messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    })),
    metadata: { userId },
  });
}

export async function zepRecall(
  client: ZepClient,
  sessionId: string,
  query: string,
  limit = 5
): Promise<Array<{ content: string; score: number }>> {
  const res = await client.memory.searchMemory(sessionId, { text: query, limit });
  return (res.results ?? []).map((r) => ({
    content: r.content ?? '',
    score: r.score ?? 0,
  }));
}
```

> 🤖 **AI 常见错误**：把 Zep 当普通向量库——只 `search` 不 `addMemory`。Zep 的价值在**写入侧**自动构建时序图谱；只检索不写入，图谱永远是空的。写入时机由 MemoryManager 编排（会话结束 / 关键事件后）。

### LangMem 集成示例（LangGraph 栈）

LangMem 提供**程序化记忆**（代码显式决定存什么）与 **LLM 记忆**（用 LLM 从会话提取、优化 prompt）。官方 SDK 目前 **Python 优先**；TS 团队在 LangGraph 栈上的等价实现是：用 `BaseStore` 做持久化 + `createReactAgent` 挂记忆工具。以下等价于 LangMem 的"程序化记忆"：

```typescript
// packages/core/src/memory/langmem.ts —— LangGraph store 记忆（TS 等价实现）
import { InMemoryStore } from '@langchain/langgraph';

export interface LangMemConfig {
  /** 例如 ['user', 'u_123']，多租户隔离 */
  namespace: string[];
  store?: InMemoryStore;
}

export class LangMemMemory {
  private store: InMemoryStore;

  constructor(private readonly cfg: LangMemConfig) {
    this.store = cfg.store ?? new InMemoryStore();
  }

  async remember(key: string, value: unknown, metadata?: Record<string, unknown>): Promise<void> {
    await this.store.put(this.cfg.namespace, key, { value, metadata, updatedAt: Date.now() });
  }

  async recall(query: string, limit = 5): Promise<Array<{ key: string; value: unknown }>> {
    const hits = await this.store.search(this.cfg.namespace, { query, limit });
    return hits.map((h) => ({ key: h.key, value: h.value }));
  }
}
```

> 🔗 **工程逻辑**：LangGraph 的 `InMemoryStore` / `PostgresStore` 解决"结构化记忆持久化"，但**没有语义检索**。要语义检索就把 `value` 同时写入向量库（见 12），`recall` 时先向量召回再 `store.get` 取原文——**检索走向量，事实走 store**。

### Anthropic memory tool 思路与落地

Anthropic 的 memory tool 思路：**把记忆建模成一组工具，由 LLM 自主决定何时创建、更新、搜索、删除记忆**，而不是业务代码在固定钩子里读写。工具定义用 AI SDK `tool()` + Zod，后端接任意向量库：

```typescript
// packages/core/src/memory/memory-tools.ts —— 记忆即工具（Anthropic 思路）
import { tool } from 'ai';
import { z } from 'zod';
import type { VectorStore } from '@langchain/core/vectorstores';
import { Document } from '@langchain/core/documents';

export function createMemoryTools(store: VectorStore, userId: string) {
  const memoryCreate = tool({
    description: '创建一条长期记忆。只在用户明确要求记住，或出现必须跨会话保留的事实时使用。',
    parameters: z.object({
      content: z.string(),
      importance: z.number().min(0).max(1).default(0.5),
    }),
    execute: async ({ content, importance }) => {
      await store.addDocuments([
        new Document({ pageContent: content, metadata: { userId, importance, kind: 'long-term' } }),
      ]);
      return { ok: true, id: crypto.randomUUID() };
    },
  });

  const memorySearch = tool({
    description: '搜索历史记忆。当用户提到过去的偏好、决定、约束时使用。',
    parameters: z.object({
      query: z.string(),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({ query, limit }) => {
      const docs = await store.similaritySearch(query, limit);
      return docs.map((d) => d.pageContent);
    },
  });

  return { memoryCreate, memorySearch };
}
```

> 🤖 **AI 常见错误**：给 LLM 的记忆工具不带 `userId` 过滤——多用户 Agent 会互相读到记忆。工具闭包捕获的 `userId` 必须在每次调用时校验，不能只写在 `metadata` 里。

**Anthropic 思路 vs 固定钩子**：MemoryManager（固定钩子）适合"写入时机可预测"的场景（会话结束、用户显式要求）；memory tool 适合"何时记忆不确定"的长任务。生产实践是**两者结合**：固定钩子兜底 + 记忆工具让 LLM 在对话中自主补充。

---

## 3.3 向量记忆 + 图谱记忆融合

### 为什么需要图谱记忆

纯向量记忆的三个短板：

1. **多跳关系**："这个项目的负责人是谁 → 他还负责哪些项目 → 现在谁接手"——向量检索只能召回语义相近的文本，不能沿关系跳转；
2. **时间演进**：向量快照没有"关系变化"概念，无法回答"用户什么时候从方案 X 改到方案 Y"；
3. **可解释性**：图谱给出可审计的实体-关系路径，合规场景需要引用链。

### 融合策略：向量做召回，图谱做推理

**不要自建图谱引擎**。可选成熟路径：

- **Zep / Graphiti**：写入侧自动建时序图谱，`graph.search` 返回实体路径（见 3.2）；
- **Microsoft GraphRAG（LazyGraphRAG）**：离线构建实体图 + 社区检测，局部/全局检索成本约为全局检索的 4%；
- **Neo4j + `neo4j-driver`**：已有图谱数据时直连官方驱动；实体抽取交给 LLM 或成熟 NER 库，不手写实体词典。

### 知识图谱提取与写入（Neo4j 示例）

如果已有图谱数据（CRM、IM 关系链、权限图），用官方 `neo4j-driver` 写入与查询；实体抽取用 LLM 或成熟 NER，**不手写实体词典**：

```typescript
// packages/core/src/memory/graph.ts —— Neo4j 官方驱动直连（图谱记忆）
import neo4j, { type Driver, type Session } from 'neo4j-driver';

export function createGraphDriver(env: Record<string, string | undefined>): Driver {
  return neo4j.driver(
    env.NEO4J_URI ?? 'neo4j://localhost:7687',
    neo4j.auth.basic(env.NEO4J_USER ?? 'neo4j', env.NEO4J_PASSWORD ?? '')
  );
}

export interface RelationshipInput {
  userId: string;
  from: string;
  relation: string;
  to: string;
  since: number;
  until?: number;
}

export async function upsertEntityRelationship(
  session: Session,
  input: RelationshipInput
): Promise<void> {
  const { userId, from, relation, to, since } = input;
  await session.run(
    `MERGE (a:Entity {name: $from, userId: $userId})
     MERGE (b:Entity {name: $to, userId: $userId})
     MERGE (a)-[r:REL {type: $relation}]->(b)
     SET r.since = $since, r.until = $until`,
    { userId, from, relation, to, since, until: input.until ?? null }
  );
}
```

### 融合检索示例

查询先走向量召回候选实体，再用图谱沿关系扩展，最后把两条路径合并注入：

```typescript
// packages/core/src/memory/hybrid-graph.ts —— 向量召回 + 图谱扩展（编排 [CUSTOM]）
import type { VectorStore } from '@langchain/core/vectorstores';
import type { Session } from 'neo4j-driver';

export interface FusedRecallResult {
  vectorHits: string[];
  graphPaths: string[];
}

export async function fusedRecall(
  store: VectorStore,
  graph: Session,
  query: string,
  userId: string
): Promise<FusedRecallResult> {
  const docs = await store.similaritySearch(query, 5);
  const entities = docs
    .map((d) => String(d.metadata?.entity ?? ''))
    .filter((name) => name.length > 0);

  const graphPaths: string[] = [];
  for (const entity of entities) {
    const res = await graph.run(
      `MATCH (a:Entity {name: $entity, userId: $userId})-[r:REL*1..2]-(b:Entity)
       RETURN a.name AS from, r.type AS relation, b.name AS to LIMIT 10`,
      { entity, userId }
    );
    for (const rec of res.records) {
      graphPaths.push(JSON.stringify(rec.toObject()));
    }
  }

  return {
    vectorHits: docs.map((d) => d.pageContent),
    graphPaths,
  };
}
```

> 🔗 **工程逻辑**：图谱路径只作为"关系事实"注入，正文仍来自向量检索，避免图谱噪声混进上下文。`*1..2` 限制扩展深度为 2 跳，防止路径爆炸；跳数上限按业务配置模板生成，不写死在检索器里。

## 3.4 RAG 知识库——LangChain 管线

### 管线概述

RAG 只是"文档级的三层记忆"。管线环节全部由库提供，业务只负责选策略与拼装：

```
文档 ──► TextLoader ──► RecursiveCharacterTextSplitter ──► Embeddings ──► VectorStore
                                                                             │
用户提问 ──► query ──► Retriever（VectorStore.asRetriever） ◄────────────────┘
                        │
                        ▼
              注入 system prompt ──► streamText ──► 带来源的回答
```

### 装载与分块

```typescript
// packages/core/src/rag/ingest.ts —— 装载 + 分块：LangChain 库函数，不手写分隔符栈
import { TextLoader } from 'langchain/document_loaders/fs/text';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

export async function loadAndSplit(filePath: string) {
  const loader = new TextLoader(filePath);
  const docs = await loader.load();

  const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 512, chunkOverlap: 50 });
  return splitter.splitDocuments(docs);
}
```

> 🤖 **AI 常见错误**：自己写 `split` 按 `\n\n` 切分——代码块、表格、markdown 列表会被切成语义碎片。`RecursiveCharacterTextSplitter` 按段落→句子→长句的优先级递归切分，并在 chunk 间保留 overlap，这是经过生产验证的策略。

### 索引与检索

```typescript
// packages/core/src/rag/pipeline.ts —— RAG 管线：入库 + 检索，全部走 LangChain VectorStore
import type { VectorStore } from '@langchain/core/vectorstores';
import { loadAndSplit } from './ingest';

export class RAGPipeline {
  constructor(private store: VectorStore) {}

  async ingest(filePath: string): Promise<number> {
    const chunks = await loadAndSplit(filePath);
    await this.store.addDocuments(chunks);
    return chunks.length;
  }

  async search(query: string, k = 5): Promise<Array<{ content: string; source: string }>> {
    const docs = await this.store.similaritySearch(query, k);
    return docs.map(d => ({
      content: d.pageContent,
      source: (d.metadata.source as string) ?? 'unknown',
    }));
  }
}
```

> 🔗 **工程逻辑**：`RAGPipeline` 只保留产品需要的最小 API（`ingest` / `search`）。embedding 计算发生在 `addDocuments` 与 `similaritySearch` 内部，由 `VectorStore` 调用 `Embeddings` 完成——不需要在业务代码里出现任何向量运算。

### RAG 注入 Agent 循环

```typescript
// server/src/rag/chatWithRag.ts —— 检索结果注入 system prompt，与 03 记忆注入同一条链路
import { streamText, type LanguageModel, type UIMessage } from 'ai';
import { RAGPipeline } from '@agentcore/core/rag/pipeline';

export async function chatWithRag(
  model: LanguageModel,
  question: string,
  history: UIMessage[],
  rag: RAGPipeline
) {
  const hits = await rag.search(question);
  const knowledge = hits.map(h => `[Source: ${h.source}]\n${h.content}`).join('\n\n');

  return streamText({
    model,
    messages: [
      { role: 'system', content: `你是一个知识库助手。仅基于以下资料回答，资料不足时明确说明：\n\n${knowledge}` },
      ...history,
      { role: 'user', content: question },
    ],
    maxSteps: 10,
  });
}
```

---

## 3.5 前端集成

### Memory 搜索面板

```tsx
// apps/web/src/components/MemoryPanel.tsx（摘要）
'use client';

import { useState } from 'react';

interface MemoryHit {
  content: string;
  score: number;
  createdAt: number;
}

export function MemoryPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await fetch(`/api/memories/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error(`search failed: ${res.status}`);
      const data = await res.json();
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败');
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="搜索历史记忆…"
          className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
        <button
          onClick={search}
          disabled={searching}
          className="rounded-lg bg-blue-500 px-3 py-2 text-xs text-white disabled:opacity-50"
        >
          {searching ? '搜索中…' : '搜索'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <ul className="space-y-2">
        {results.map((hit, i) => (
          <li key={i} className="rounded-lg border border-gray-200 p-3 text-sm">
            <p className="whitespace-pre-wrap text-gray-700">{hit.content}</p>
            <p className="mt-1 text-xs text-gray-400">
              score: {hit.score.toFixed(3)} · {new Date(hit.createdAt).toLocaleString()}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

### RAG 上传与管理面板

```tsx
// apps/web/src/components/RAGPanel.tsx（摘要）
'use client';

import { useState } from 'react';

export function RAGPanel() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [chunkCount, setChunkCount] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async () => {
    if (!selectedFile) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', selectedFile);
      const res = await fetch('/api/rag/ingest', { method: 'POST', body: form });
      if (!res.ok) throw new Error(`upload failed: ${res.status}`);
      const data = await res.json();
      setChunkCount(data.chunkCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <input
          type="file"
          onChange={e => setSelectedFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
        <button
          onClick={upload}
          disabled={uploading || !selectedFile}
          className="rounded-lg bg-blue-500 px-3 py-2 text-xs text-white disabled:opacity-50"
        >
          {uploading ? '上传中…' : '上传到知识库'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {chunkCount !== null && (
        <p className="text-xs text-gray-500">已切分 {chunkCount} 个 chunk 并写入向量库</p>
      )}
    </div>
  );
}
```

### Settings 页面建议布局

```
├── Settings
│   ├── Memory（记忆开关 + 检索预算）
│   │   ├── [✓] 启用跨会话记忆（默认开）
│   │   ├── 检索注入预算：1500 tokens（slider 500~4000）
│   │   ├── 情景记忆保留条数：200
│   │   └── [清除全部记忆]（危险操作，二次确认）
│   ├── RAG（知识库管理）
│   │   ├── 文件上传（PDF/MD/TXT）
│   │   ├── 分块策略：chunkSize 512 / overlap 50
│   │   └── 已索引文档列表（删除/重建）
│   └── VectorDB（向量库连接信息，仅服务端可改）
│       ├── 类型：Qdrant / Memory（开发）
│       └── 连接状态：● Connected（只读展示，不暴露连接串）
```

> 🔗 **工程逻辑**：前端设置项尽量少。`VectorDB` 连接串属于敏感配置，前端只读展示连接状态，禁止回显完整连接串；分块参数在服务端有默认值，前端只是可选覆盖。

---

## 3.6 交叉引用

- [00-types.md](00-types.md) — 跨层类型契约：`LanguageModel` / `UIMessage` / `tool()`
- [01-foundation.md](01-foundation.md) — 宿主层：`LanguageModel` / `streamText` / `AgentEvent`
- [02-tools-skills.md](02-tools-skills.md) — Skill 系统（MCP 渐进披露），与记忆层配合构成"长期能力"
- [05-multi-agent.md](05-multi-agent.md) — 多 Agent 之间的记忆隔离与共享策略
- [08-eval-observability.md](08-eval-observability.md) — 记忆召回质量评估、Langfuse 追踪
- [12-vector-db-practical.md](12-vector-db-practical.md) — 向量数据库选型、混合检索、重排、ColBERT
- [14-mcp-server-dev.md](14-mcp-server-dev.md) — 把记忆工具暴露为 MCP 工具，供其他 Agent 复用
- [15-knowledge-base.md](15-knowledge-base.md) — RAG 深度扩展：多格式解析、增量索引、版本化
- [../docs/TECH_LANDSCAPE.md](../docs/TECH_LANDSCAPE.md) — 2026 记忆与 RAG 成熟技术现状
- [../docs/REUSE_MATRIX.md](../docs/REUSE_MATRIX.md) — 成熟替代映射表

## 3.7 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core` 的 memory / rag 模块与前端面板全部 0 错误。
- [ ] **核心链路**：执行 `node --test tests/memory-rag.test.ts`，覆盖 `ingest` → `search` 全链路：写入 3 篇样例文档后用相关查询召回到正确 chunk，且结果带 `source` 来源信息。
- [ ] **混合检索**：向量检索 + BM25 双路召回，P95 延迟 < 500ms；生产环境 Qdrant `hybrid` 查询返回 RRF 融合结果。
- [ ] **边界场景**：空文档、embedding 服务 5xx/超时、向量库不可用三种情况，`RAGPipeline.ingest` 抛出可读错误并回滚已写入 chunk，进程不崩溃。
- [ ] **记忆预算**：单次记忆注入不超过 1500 token；超过预算时按相关度截断，且 `ContextUsageBar` 显示的记忆占比不超阈值。
- [ ] **记忆工具**：Mem0 或 Zep 集成测试——写入 2 轮对话后，用相关查询能召回对应记忆，且 `userId` 隔离生效（A 用户查不到 B 用户的记忆）。
- [ ] **图谱融合**：Neo4j 中写入实体关系后，`fusedRecall` 返回 `graphPaths`；修改关系时间戳后检索结果反映最新关系。
- [ ] **伪记忆检查**：`grep -rn "history.join" packages/core/ server/ apps/` 无结果（禁止全量历史注入当记忆）。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件 0 失败；`grep -rn "LLMClient" references/` 无结果。
