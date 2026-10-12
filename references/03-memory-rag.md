# 03 — 记忆 · RAG · 长期上下文

> Layer 3 目标：跨会话记忆 + 文档级 RAG。读完本文件即可独立落地三层记忆架构与 RAG 知识库的全部后端 + 前端代码。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - 分块 → **LangChain `RecursiveCharacterTextSplitter`**（或 LlamaIndex `SentenceSplitter`），不要手写分隔符与 overlap
> - Embedding → **`@langchain/openai` 的 `OpenAIEmbeddings`**（或任意 Embeddings 实现），不要手写 HTTP 客户端
> - 向量索引与检索 → **LangChain `VectorStore`**（`MemoryVectorStore` / `QdrantVectorStore`），不要手写 cosine
> - 混合检索 → LangChain **`EnsembleRetriever`** 或 **Qdrant 原生 hybrid 查询（内置 RRF）**，不要手写 BM25 + RRF
> - 记忆的业务编排 → **`[CUSTOM]`**（写入过滤、读取预算、注入位置），内部实现全部引用库
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
- [3.2 RAG 知识库——LangChain 管线](#32-rag-知识库langchain-管线)
  - [管线概述](#管线概述)
  - [装载与分块](#装载与分块)
  - [索引与检索](#索引与检索)
  - [RAG 注入 Agent 循环](#rag-注入-agent-循环)
- [3.3 前端集成](#33-前端集成)
  - [Memory 搜索面板](#memory-搜索面板)
  - [RAG 上传与管理面板](#rag-上传与管理面板)
  - [Settings 页面建议布局](#settings-页面建议布局)
- [3.4 交叉引用](#34-交叉引用)
- [3.5 本层验收清单](#35-本层验收清单)

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

## 3.2 RAG 知识库——LangChain 管线

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

## 3.3 前端集成

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

## 3.4 交叉引用

- [01-foundation.md](01-foundation.md) — 宿主层：`LanguageModel` / `streamText` / `AgentEvent`
- [12-vector-db-practical.md](12-vector-db-practical.md) — 向量数据库选型与部署（Qdrant / Milvus / Chroma）
- [15-knowledge-base.md](15-knowledge-base.md) — RAG 深度扩展：多格式解析、增量索引、版本化
- [02-tools-skills.md](02-tools-skills.md) — Skill 系统（MCP 渐进披露），与记忆层配合构成"长期能力"

## 3.5 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core` 的 memory / rag 模块与前端面板全部 0 错误。
- [ ] **核心链路**：执行 `node --test tests/memory-rag.test.ts`，覆盖 `ingest` → `search` 全链路：写入 3 篇样例文档后用相关查询召回到正确 chunk，且结果带 `source` 来源信息。
- [ ] **混合检索**：向量检索 + BM25 双路召回，P95 延迟 < 500ms；生产环境 Qdrant `hybrid` 查询返回 RRF 融合结果。
- [ ] **边界场景**：空文档、embedding 服务 5xx/超时、向量库不可用三种情况，`RAGPipeline.ingest` 抛出可读错误并回滚已写入 chunk，进程不崩溃。
- [ ] **记忆预算**：单次记忆注入不超过 1500 token；超过预算时按相关度截断，且 `ContextUsageBar` 显示的记忆占比不超阈值。
