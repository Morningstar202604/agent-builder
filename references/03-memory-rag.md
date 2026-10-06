# 03 — 记忆 · RAG · 长期上下文

> 本 reference 覆盖 Agent 记忆系统（三层记忆架构、混合检索引擎、MemoryManager 编排）和 RAG 知识库（文档装载、chunk 召回、rerank）。读完本文件即可独立落地跨会话记忆与文档级知识检索的全部后端+前端代码。

---

## 目录

- [记忆系统](#记忆系统)
  - [工程逻辑：三层记忆架构](#工程逻辑三层记忆架构)
  - [记忆类型与存储接口](#1-记忆类型与存储接口)
  - [混合检索引擎：向量 + BM25](#2-混合检索引擎向量--bm25)
  - [BM25 轻量索引实现](#3-bm25-轻量索引实现)
  - [RRF 融合排序](#4-rrf-融合排序)
  - [记忆写入策略](#5-记忆写入策略)
  - [MemoryManager 编排器](#6-memorymanager-三层编排)
  - [记忆与 Agent 循环集成](#7-记忆与-agent-循环集成)
- [RAG 知识库](#rag-知识库)
  - [RAG 管线概述](#rag-管线概述)
  - [文档装载器](#1-文档装载器)
  - [Chunk 切分与嵌入](#2-chunk-切分与嵌入)
  - [召回与 Rerank](#3-召回与-rerank)
- [Skill 系统的进阶（Node 08 后半）](#skill-系统的进阶)
  - [Skill 安装来源扩展](#skill-安装来源扩展)
  - [Skill Eval 与版本管理](#skill-eval-与版本管理)
- [前端集成](#前端集成)
  - [Memory 搜索面板](#memory-搜索面板)
  - [RAG 上传与管理面板](#rag-上传与管理面板)

---

## 记忆系统

### 工程逻辑：三层记忆架构

Agent 单轮对话的上下文窗口可以通过 Token Budget 管理，但用户一周前的对话、三个月前的偏好需要跨记忆层设计。

记忆不是"把历史消息全存起来"（太浪费）。正确做法是**三层分级**，每层有不同的存储介质、检索方式和淘汰策略。这就像计算机存储体系：缓存 → 内存 → 硬盘。

```
┌────────────────────────────────────────────────────────────┐
│                   三层记忆架构                                │
│                                                              │
│  Layer 1: 会话记忆 (Session Memory)                          │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Redis / Memory                               TTL 24h   │   │
│  │ 当前对话的消息历史（与 Token Budget 系统共享）            │   │
│  │ 检索：session_id 直接读取                              │   │
│  │ 大小：~50K token / session                             │   │
│  └──────────────────────────────────────────────────────┘   │
│                          ↓ 会话结束后触发提取                  │
│  Layer 2: 情景记忆 (Episodic Memory)                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Qdrant / Milvus vector DB                   持久存储   │   │
│  │ 会话纪要、用户决策、重要事件                              │   │
│  │ 检索：向量相似度 + BM25 关键词混合                       │   │
│  │ 大小：数百条摘要 / 用户                                  │   │
│  └──────────────────────────────────────────────────────┘   │
│                          ↓ 需要文档级知识时                    │
│  Layer 3: 语义记忆 (Semantic Memory)                         │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Qdrant collection + 文档解析                  持久存储   │   │
│  │ 用户上传的文档、FAQ、知识库、代码仓库                     │   │
│  │ 检索：RAG chunk 召回 + rerank                           │   │
│  │ 大小：数万 chunk / 用户                                  │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

**关键设计原则**：
1. **写入端过滤**：不是所有对话内容都值得记住。"你好"、"谢谢"等口水话不进记忆。
2. **读取端预算**：记忆注入有 token 上限（~1500 token），超出时按分数截断。
3. **存储层分离**：Session Memory 用 Redis 做缓存（TTL 24h），Episodic/Semantic 用向量库持久化。

### 1. 记忆类型与存储接口

工程上先定义统一的记忆数据模型，后续所有检索/读写操作都基于这些抽象：

```typescript
// packages/core/src/memory/types.ts

/** 记忆层级 */
export type MemoryTier = 'session' | 'episodic' | 'semantic';

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  tier: MemoryTier;
  content: string;               // 原始文本
  summary?: string;              // 摘要（用于检索展示）
  embedding?: number[];          // 向量表示
  metadata: MemoryMetadata;
  createdAt: number;
  updatedAt: number;
  /** 过期时间（0 表示永不过期） */
  expiresAt?: number;
  /** 重要程度 0-1，影响检索排序和淘汰 */
  importance: number;
  /** 访问计数（用于 LRU 淘汰） */
  accessCount: number;
  /** 关联的 session_id */
  sessionId?: string;
  /** 关联的用户标签 */
  tags?: string[];
}

export interface MemoryMetadata {
  source: 'conversation' | 'document' | 'manual' | 'extraction';
  userId?: string;
  sessionId?: string;
  toolName?: string;              // 如果是工具产生的
  [key: string]: unknown;
}

/** 检索结果 */
export interface MemoryRetrievalResult {
  entry: MemoryEntry;
  similarity: number;             // 向量相似度
  keywordScore?: number;          // BM25 分数
  combinedScore: number;          // 融合分数
  /** 为什么被召回（用于 debug） */
  retrievalReason: 'vector' | 'keyword' | 'hybrid' | 'manual';
}

/** 写入策略 */
export interface WriteStrategy {
  /** 触发写入的条件 */
  shouldWrite: (message: any, context: any) => boolean;
  /** 提取要记忆的内容 */
  extract: (messages: any[]) => Array<{ content: string; metadata: any }>;
  tier: MemoryTier;
}
```

### 2. 混合检索引擎：向量 + BM25

**工程逻辑**：为什么用混合检索（向量 + BM25）而不是纯向量？因为纯向量检索有个常见问题——**精确匹配反而差**。用户问"PostgreSQL 怎么安装"，可能匹配不到包含 "PostgreSQL installation" 的记忆，因为 embedding 对同义词敏感但不保证精确匹配。BM25 关键词检索在精确匹配上很好，但在语义理解上很弱（"数据库安装" 完全匹配不到 "DB setup"）。两者互补，混合评分是学术和工业界都验证过的最优策略。

```typescript
// packages/core/src/memory/episodic.ts

import { v4 as uuid } from 'uuid';
import type {
  MemoryEntry, MemoryMetadata, MemoryRetrievalResult, WriteStrategy
} from './types';

/** Embedding 服务接口 */
export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
}

/** 向量数据库接口 */
export interface VectorStore {
  upsert(collection: string, entries: Array<{
    id: string; vector: number[]; payload: Record<string, unknown>;
  }>): Promise<void>;
  search(collection: string, vector: number[], limit: number): Promise<Array<{
    id: string; score: number; payload: Record<string, unknown>;
  }>>;
  delete(collection: string, ids: string[]): Promise<void>;
  list(collection: string, filter?: Record<string, unknown>): Promise<MemoryEntry[]>;
}
```

### 3. BM25 轻量索引实现

BM25 是一种经典的关键词检索算法，比向量检索更擅长精确匹配。这里提供一个零外部依赖的内存实现，适合中小规模记忆（<10 万条）。当规模更大时可切换到 Elasticsearch 或 Qdrant 的内置 BM25：

```typescript
// packages/core/src/memory/bm25.ts

/**
 * BM25 轻量索引 —— 零依赖、纯内存
 *
 * 工程选择：
 * - 中文按字切分（bigram），英文按空格切词
 * - 标准 BM25 公式：IDF * (tf * (k1+1)) / (tf + k1*(1-b+b*dl/avgdl))
 * - k1=1.5, b=0.75 是经广泛验证的默认值
 * - 适合<10万条记忆条目，超过该规模请换 Elasticsearch 或 Qdrant BM25
 */
interface BM25Index {
  add(docId: string, text: string): void;
  remove(docId: string): void;
  search(query: string, topK: number): Array<{ docId: string; score: number }>;
}

export class BM25SimpleIndex implements BM25Index {
  private documents = new Map<string, string>();
  private invertedIndex = new Map<string, Set<string>>();
  private docLengths = new Map<string, number>();
  private avgLength = 0;

  add(docId: string, text: string): void {
    this.remove(docId);  // 去重
    this.documents.set(docId, text);

    const tokens = this.tokenize(text);
    this.docLengths.set(docId, tokens.length);

    for (const token of tokens) {
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set());
      }
      this.invertedIndex.get(token)!.add(docId);
    }

    this.updateAvgLength();
  }

  remove(docId: string): void {
    const existing = this.documents.get(docId);
    if (!existing) return;

    const tokens = this.tokenize(existing);
    for (const token of tokens) {
      this.invertedIndex.get(token)?.delete(docId);
    }
    this.documents.delete(docId);
    this.docLengths.delete(docId);
    this.updateAvgLength();
  }

  search(query: string, topK: number): Array<{ docId: string; score: number }> {
    const tokens = this.tokenize(query);
    const scores = new Map<string, number>();
    const k1 = 1.5;
    const b = 0.75;
    const N = this.documents.size;

    for (const token of tokens) {
      const docIds = this.invertedIndex.get(token);
      if (!docIds) continue;

      const df = docIds.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

      for (const docId of docIds) {
        const text = this.documents.get(docId)!;
        const tokensInDoc = this.tokenize(text);
        const tf = tokensInDoc.filter(t => t === token).length;
        const docLen = this.docLengths.get(docId)!;

        const score = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / this.avgLength));
        scores.set(docId, (scores.get(docId) ?? 0) + score);
      }
    }

    return Array.from(scores.entries())
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * 中英文混合分词：中文按单字切，英文按空格按词切
   * 在 stage 2 可以升级为更智能的 jieba/sentencepiece 分词
   */
  private tokenize(text: string): string[] {
    return text.toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  private updateAvgLength(): void {
    if (this.docLengths.size === 0) { this.avgLength = 0; return; }
    const total = Array.from(this.docLengths.values()).reduce((a, b) => a + b, 0);
    this.avgLength = total / this.docLengths.size;
  }
}
```

### 4. RRF 融合排序

```typescript
// packages/core/src/memory/hybridRetriever.ts

/**
 * 混合检索 —— 向量 + BM25 + RRF 融合排序
 *
 * RRF (Reciprocal Rank Fusion) 融合策略：
 * - 向量检索和 BM25 各自返回一个有序列表
 * - 对每条记忆的排名计算 1/(k + rank)，其中 k=60 是平滑因子
 * - 两个来源的分数相加得到最终排名
 * - RRF 的优势：不需要归一化分数，天然兼容不同量纲的检索结果
 *
 * 工程选择：为什么用 RRF 而不是加权平均？
 * - 加权平均需要调权重（vectorWeight=0.7, keywordWeight=0.3），权重需要领域调优
 * - RRF 无参数，学术界（LangChain、LlamaIndex 等）广泛验证过
 * - 如果未来加第三种检索来源（如 Graph RRF），扩展只需多加一个来源的分数
 */
export class HybridRetriever {
  private collection: string;
  private vectorStore: VectorStore;
  private embedding: EmbeddingService;
  private bm25: BM25SimpleIndex;
  private rrfK: number;  // RRF 平滑因子

  constructor(
    collection: string,
    vectorStore: VectorStore,
    embedding: EmbeddingService,
    options?: { rrfK?: number }
  ) {
    this.collection = collection;
    this.vectorStore = vectorStore;
    this.embedding = embedding;
    this.bm25 = new BM25SimpleIndex();
    this.rrfK = options?.rrfK ?? 60;
  }

  /** 把新记忆加入检索索引 */
  async index(entry: MemoryEntry): Promise<void> {
    if (!entry.embedding) {
      entry.embedding = await this.embedding.embed(entry.content);
    }

    await this.vectorStore.upsert(this.collection, [{
      id: entry.id,
      vector: entry.embedding,
      payload: {
        content: entry.content,
        summary: entry.summary,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
        importance: entry.importance,
        tags: entry.tags || [],
      },
    }]);

    this.bm25.add(entry.id, entry.content + ' ' + (entry.summary ?? ''));
  }

  /**
   * 混合检索主入口
   * 并行执行向量检索 + BM25，然后用 RRF 融合
   */
  async search(
    query: string,
    limit: number = 5,
    options?: {
      vectorWeight?: number;     // 兼容旧版加权模式
      keywordWeight?: number;
      minScore?: number;
      useRRF?: boolean;          // 默认 true
    }
  ): Promise<MemoryRetrievalResult[]> {
    const minScore = options?.minScore ?? 0;
    const useRRF = options?.useRRF ?? true;

    // 并行执行两种检索
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch(query, limit * 3),
      Promise.resolve(this.keywordSearch(query, limit * 3)),
    ]);

    if (useRRF) {
      return this.fuseWithRRF(vectorResults, keywordResults, limit, minScore);
    } else {
      return this.fuseWithWeighted(vectorResults, keywordResults, limit, options);
    }
  }

  /**
   * RRF 融合：对两个来源分别排名，取倒数求和
   * score(doc) = Σ 1/(k + rank_i) for each retriever i
   */
  private fuseWithRRF(
    vectorResults: Array<{ id: string; score: number; payload: Record<string, unknown> }>,
    keywordResults: Array<{ docId: string; score: number }>,
    limit: number,
    minScore: number
  ): MemoryRetrievalResult[] {
    const rrfScores = new Map<string, number>();
    const entryMap = new Map<string, any>();

    // 向量结果排名
    vectorResults.forEach((r, idx) => {
      const rr = 1 / (this.rrfK + idx + 1);
      rrfScores.set(r.id, (rrfScores.get(r.id) ?? 0) + rr);
      entryMap.set(r.id, { ...r, rank: idx + 1, retrievalSource: 'vector' });
    });

    // BM25 结果排名
    keywordResults.forEach((r, idx) => {
      const rr = 1 / (this.rrfK + idx + 1);
      rrfScores.set(r.docId, (rrfScores.get(r.docId) ?? 0) + rr);
      if (!entryMap.has(r.docId)) {
        entryMap.set(r.docId, { id: r.docId, score: r.score, rank: idx + 1, retrievalSource: 'keyword' });
      } else {
        const existing = entryMap.get(r.docId);
        existing.bm25Rank = idx + 1;
        existing.retrievalSource = 'hybrid';
      }
    });

    const results: MemoryRetrievalResult[] = [];

    for (const [id, rrfScore] of rrfScores) {
      if (rrfScore < minScore) continue;
      const info = entryMap.get(id);

      const entry: MemoryEntry = {
        id,
        tier: 'episodic',
        content: info.payload?.content ?? '',
        summary: info.payload?.summary,
        embedding: info.vector,
        metadata: info.payload?.metadata ?? {},
        createdAt: info.payload?.createdAt ?? 0,
        updatedAt: info.payload?.createdAt ?? 0,
        importance: info.payload?.importance ?? 0.5,
        accessCount: 0,
        tags: info.payload?.tags ?? [],
      };

      results.push({
        entry,
        similarity: info.score ?? 0,
        keywordScore: info.retrievalSource === 'keyword' || info.retrievalSource === 'hybrid' ? 1 / (this.rrfK + (info.bm25Rank ?? 999)) : 0,
        combinedScore: rrfScore,
        retrievalReason: (info.retrievalSource === 'vector' ? 'vector' :
          info.retrievalSource === 'keyword' ? 'keyword' : 'hybrid') as any,
      });
    }

    return results.sort((a, b) => b.combinedScore - a.combinedScore).slice(0, limit);
  }

  /**
   * 加权平均融合（旧版兼容）
   * 需要归一化两种分数到同一量纲
   */
  private fuseWithWeighted(
    vectorResults: Array<{ id: string; score: number; payload: Record<string, unknown> }>,
    keywordResults: Array<{ docId: string; score: number }>,
    limit: number,
    options?: { vectorWeight?: number; keywordWeight?: number; minScore?: number }
  ): MemoryRetrievalResult[] {
    const vectorWeight = options?.vectorWeight ?? 0.7;
    const keywordWeight = options?.keywordWeight ?? 0.3;
    const minScore = options?.minScore ?? 0;

    const scores = new Map<string, MemoryRetrievalResult>();

    for (const r of vectorResults) {
      scores.set(r.id, {
        ...this.payloadToEntry(r.payload, r.id),
        similarity: r.score,
        combinedScore: r.score * vectorWeight,
        retrievalReason: 'vector' as const,
      });
    }

    const maxBm25Score = Math.max(...keywordResults.map(r => r.score), 1);
    for (const r of keywordResults) {
      const normalized = r.score / maxBm25Score;
      const existing = scores.get(r.id);
      if (existing) {
        existing.combinedScore += normalized * keywordWeight;
        existing.keywordScore = normalized;
        existing.retrievalReason = 'hybrid';
      } else {
        scores.set(r.id, {
          ...this.payloadToEntry({}, r.docId),
          similarity: 0,
          keywordScore: normalized,
          combinedScore: normalized * keywordWeight,
          retrievalReason: 'keyword' as const,
        });
      }
    }

    return Array.from(scores.values())
      .filter(r => r.combinedScore >= minScore)
      .sort((a, b) => b.combinedScore - a.combinedScore)
      .slice(0, limit);
  }

  private async vectorSearch(query: string, limit: number) {
    const queryVector = await this.embedding.embed(query);
    return this.vectorStore.search(this.collection, queryVector, limit);
  }

  private keywordSearch(query: string, limit: number) {
    return this.bm25.search(query, limit);
  }

  private payloadToEntry(payload: Record<string, unknown>, id: string): MemoryEntry {
    return {
      id,
      tier: 'episodic',
      content: (payload.content as string) ?? '',
      summary: payload.summary as string | undefined,
      metadata: (payload.metadata as MemoryMetadata) ?? {},
      createdAt: (payload.createdAt as number) ?? 0,
      updatedAt: (payload.createdAt as number) ?? 0,
      importance: (payload.importance as number) ?? 0.5,
      accessCount: 0,
      tags: (payload.tags as string[]) ?? [],
    };
  }

  /** 删除记忆索引 */
  async remove(id: string): Promise<void> {
    await this.vectorStore.delete(this.collection, [id]);
    this.bm25.remove(id);
  }
}
```

> 🤖 **AI 常见错误**：
> 1. **embedding 模型不匹配** —— 用 OpenAI 的 text-embedding-3-small 生成的向量，存到 Qdrant 里，但查询时用本地模型生成 embedding。向量空间完全不同，召回率接近 0。**必须确保写入和查询用同一个 embedding 模型**。
> 2. **存储过量噪音** —— 每次对话结束都把"你好"、"谢谢"存到长期记忆里。结果记忆数据库膨胀 + 召回时被噪音稀释。`WriteStrategy.shouldWrite` 必须有严格过滤。

### 5. 记忆写入策略

两种互补的写入策略——LLM 提取（高精度高延迟）和 规则匹配（低精度零延迟）：

```typescript
// packages/core/src/memory/strategies.ts

import type { WriteStrategy } from './types';
import type { LLMMessage } from '../llm/types';
import type { LLMClient } from '../llm/types';
import { v4 as uuid } from 'uuid';
import type { MemoryEntry } from './types';

/**
 * LLM 提取策略
 *
 * 会话结束后，用 LLM 扫描该轮对话，判断是否有值得记忆的信息。
 * 优点：能识别隐含偏好和复杂语义
 * 缺点：有延迟（1-2s 额外 LLM 调用），有 token 成本（应在阶段 3 实现具体 LLM 调用）
 */
export class LLMBasedExtractionStrategy implements WriteStrategy {
  private llm: LLMClient;
  tier: 'episodic' = 'episodic';

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  shouldWrite(message: any, context: any): boolean {
    return message.type === 'done';
  }

  async extract(messages: LLMMessage[]): Promise<Array<{ content: string; metadata: any; importance: number }>> {
    const conversationBlock = messages.slice(-12).map(m =>
      `[${m.role.toUpperCase()}]: ${m.content ?? ''}${m.tool_calls?.map(tc =>
        `\n  └─ ${tc.function.name}(${tc.function.arguments.slice(0, 80)})`
      ).join('') ?? ''}`
    ).join('\n---\n');

    const extractionPrompt = `Analyze the following conversation and extract MEMORY-WORTHY information.

What is memory-worthy:
- User preferences (languages, frameworks, tools, styles)
- Decisions made (chosen approach, rejected alternatives)
- Key entities (project names, product names, company names)
- Action items or TODOs mentioned
- Numerical data (dates, versions, IDs, counts)
- User feedback or corrections to the assistant

What is NOT memory-worthy:
- Small talk ("hello", "thanks", "ok")
- Successful routine operations (standard file read/write)
- Information already widely known

Output a JSON array. Each item: {"fact": "concise statement", "importance": 0-1, "tags": ["tag1", "tag2"]}
If nothing is memory-worthy, return [].

Conversation:
${conversationBlock}

JSON output:`;

    // [阶段 3 实现] 调用 LLM 实际提取
    // const response = await this.callLLM(extractionPrompt);
    // const extracted = JSON.parse(response);
    // return Array.isArray(extracted) ? extracted : [];

    // 当前占位：返回空数组，待集成具体 LLM 客户端后可用
    return [];
  }
}

/**
 * 规则匹配策略（零延迟，实时写入）
 *
 * 在对话进行中检查用户消息，发现偏好表达/实体声明时立即写入。
 * 不依赖 LLM，用正则匹配。代价是召回率较低。
 */
export class RuleBasedExtractionStrategy implements WriteStrategy {
  tier: 'episodic' = 'episodic';

  private preferencePatterns = [
    /我喜欢(.{2,30})/,
    /我(?:比较|更)偏好(.{2,30})/,
    /请(?:一直|始终|默认)(.{2,20})/,
    /记住[，:](.{2,40})/,
    /my preference is (.{2,40})/,
    /i prefer (.{2,40})/,
    /always use (.{2,40})/,
    /default to (.{2,40})/,
  ];

  shouldWrite(message: any, _context: any): boolean {
    return message.role === 'user' && !!message.content;
  }

  async extract(messages: LLMMessage[]): Promise<Array<{ content: string; metadata: any; importance: number }>> {
    const lastUserMsg = messages.filter(m => m.role === 'user').at(-1);
    if (!lastUserMsg?.content) return [];

    const content = lastUserMsg.content;
    const extracted: Array<{ content: string; metadata: any; importance: number }> = [];

    for (const pattern of this.preferencePatterns) {
      const match = content.match(pattern);
      if (match) {
        extracted.push({
          content: `User preference: ${match[0]}`,
          importance: 0.8,
          metadata: { source: 'rule', matchedPattern: pattern.source },
        });
      }
    }

    const entityMatch = content.match(/(?:我们?的?|我)[产品项目叫]*[：:](.{2,30})/);
    if (entityMatch) {
      extracted.push({
        content: `Entity: ${entityMatch[0]}`,
        importance: 0.9,
        metadata: { source: 'rule', entity: true },
      });
    }

    return extracted;
  }
}
```

### 6. MemoryManager —— 三层编排

MemoryManager 是记忆系统对外的统一入口，编排 HybridRetriever + 写入策略 + 会话记忆：

```typescript
// packages/core/src/memory/manager.ts

import { v4 as uuid } from 'uuid';
import type {
  MemoryEntry, MemoryTier, MemoryRetrievalResult, WriteStrategy, MemoryMetadata
} from './types';
import type { HybridRetriever } from './hybridRetriever';
import type { EmbeddingService } from './episodic';

export class MemoryManager {
  private retriever: HybridRetriever;
  private embedding: EmbeddingService;
  private strategies: WriteStrategy[] = [];
  /** 会话级记忆 —— 与 02 的 SessionStore 共享（MVP 用内存，后续换 Redis） */
  private sessionMemory = new Map<string, any[]>();
  private maxSessionMemory = 1000;

  constructor(retriever: HybridRetriever, embedding: EmbeddingService) {
    this.retriever = retriever;
    this.embedding = embedding;
  }

  /** 注册写入策略（多策略组合：RuleBased + LLMBased 可以并存） */
  addStrategy(strategy: WriteStrategy): void {
    this.strategies.push(strategy);
  }

  /**
   * 会话结束时调用 —— 提取 & 存储有价值的记忆
   * 遍历所有注册的写入策略，对每条策略的提取结果做索引写入
   */
  async processSessionEnd(sessionId: string, messages: any[]): Promise<MemoryEntry[]> {
    const extractedEntries: MemoryEntry[] = [];

    for (const strategy of this.strategies) {
      try {
        const items = await strategy.extract(messages);
        for (const item of items) {
          const entry: MemoryEntry = {
            id: uuid(),
            tier: strategy.tier,
            content: item.content,
            metadata: {
              source: 'extraction',
              sessionId,
              ...item.metadata,
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            importance: item.importance ?? 0.5,
            accessCount: 0,
            sessionId,
          };

          await this.retriever.index(entry);
          extractedEntries.push(entry);
        }
      } catch (error) {
        console.error(`Memory extraction failed for strategy ${strategy.constructor.name}:`, error);
      }
    }

    return extractedEntries;
  }

  /**
   * 检索记忆 —— Agent 开始新一轮对话前调用
   * 默认使用 RRF 融合，向量权重 0.7 关键词权重 0.3（兼容加权模式）
   */
  async recall(query: string, limit: number = 5): Promise<MemoryRetrievalResult[]> {
    return this.retriever.search(query, limit, {
      useRRF: true,
      minScore: 0.3,
    });
  }

  /**
   * 构建 memory context —— 注入到 system prompt
   * 按 token 预算截断，不超 maxTokens
   */
  async buildContext(
    query: string,
    options?: { maxTokens?: number; limit?: number }
  ): Promise<string> {
    const results = await this.recall(query, options?.limit ?? 5);
    const maxTokens = options?.maxTokens ?? 2000;

    let context = '';
    let currentTokens = 0;

    for (const result of results.slice(0, options?.limit ?? 5)) {
      const text = `[Memory] ${result.entry.content}`;
      const estimatedTokens = Math.ceil(text.length / 3);

      if (currentTokens + estimatedTokens > maxTokens) break;
      currentTokens += estimatedTokens;
      context += text + '\n';

      result.entry.accessCount++;
    }

    return context.trim();
  }

  /**
   * 手动写入记忆（用户点击"记住这个"按钮）
   */
  async remember(
    content: string,
    options?: { tags?: string[]; importance?: number; sessionId?: string }
  ): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: uuid(),
      tier: 'episodic',
      content,
      metadata: { source: 'manual' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      importance: options?.importance ?? 0.7,
      accessCount: 0,
      tags: options?.tags,
      sessionId: options?.sessionId,
    };

    await this.retriever.index(entry);
    return entry;
  }

  /** 忘记（删除）一条记忆 */
  async forget(entryId: string): Promise<void> {
    await this.retriever.remove(entryId);
  }

  /** 列出用户的记忆（前端展示用） */
  async listMemories(options?: {
    tier?: MemoryTier;
    limit?: number;
    offset?: number;
  }): Promise<{ entries: MemoryEntry[]; total: number }> {
    // 实际实现应调用 vectorStore 的 list 方法
    // 此处为接口定义
    return { entries: [], total: 0 };
  }
}
```

### 7. 记忆与 Agent 循环集成

```typescript
// packages/core/src/agent/base.ts —— 记忆集成部分

async *run(userMessage: string, context: AgentContext): AsyncGenerator<AgentEvent> {
  // 1. 检索相关记忆并注入 system prompt
  if (this.config.memoryManager) {
    const memoryContext = await this.config.memoryManager.buildContext(userMessage, {
      maxTokens: 1500,          // 记忆上下文不超过 1500 token
      limit: 5,
    });

    if (memoryContext) {
      // 作为 system 消息注入（在 systemPrompt 之后，对话历史之前）
      context.messages.unshift({
        role: 'system',
        content: `[User Memory Context]\n${memoryContext}`,
      } as LLMMessage);
    }
  }

  // ... 正常 ReAct 循环 ...

  // 2. 循环结束后，提取记忆
  if (this.config.memoryManager) {
    const extracted = await this.config.memoryManager.processSessionEnd(
      context.sessionId,
      context.messages
    );
    if (extracted.length > 0) {
      yield { type: 'memory_extracted', count: extracted.length } as any;
    }
  }
}
```

> 🤖 **工程逻辑**：记忆注入应放在 system prompt **之后**、对话历史**之前**。如放在 system prompt 之前，可能被 system prompt 的指令覆盖（LLM 更看重第一条消息）。如放在对话历史之后，LLM 可能已经"下决心"回答问题了，记忆成了事后补充不起作用。

---

## RAG 知识库

### RAG 管线概述

语义记忆层（Semantic Memory）由 RAG 管线提供，处理用户上传的文档、FAQ、知识库。管线包含：文档加载 → 分块 → 嵌入 → 存储 → 检索召回 → Rerank。

```
┌────────────────────────────────────────────────────────────┐
│                    RAG 管线                                  │
│                                                              │
│  Document → Loader → Splitter → Embedder → VectorStore       │
│  (PDF/MD/   (按格式   (chunk +   (text-     (Qdrant/        │
│   HTML)      读取)     overlap)    embed)     Milvus)        │
│                                                              │
│  Query → Embed → Retrieve(top-K) → Rerank → Inject to LLM   │
└────────────────────────────────────────────────────────────┘
```

### 1. 文档装载器

```typescript
// packages/core/src/rag/loader.ts

import { promises as fs } from 'fs';

export interface Document {
  id: string;
  content: string;
  metadata: {
    source: string;             // 文件路径或 URL
    mimeType: string;
    title?: string;
    createdAt: number;
    chunkCount?: number;
  };
}

export interface DocumentLoader {
  load(filePath: string): Promise<Document>;
  supports(mimeType: string): boolean;
}

/** 通用文本装载器 —— 支持 MD/TXT/JSON/代码文件 */
export class TextFileLoader implements DocumentLoader {
  private supportedTypes = ['text/plain', 'text/markdown', 'application/json', 'text/typescript', 'text/javascript', 'text/x-python'];

  async load(filePath: string): Promise<Document> {
    const content = await fs.readFile(filePath, 'utf-8');
    const path = await import('path');
    const fileName = path.basename(filePath);

    return {
      id: `doc-${fileName}-${Date.now()}`,
      content,
      metadata: {
        source: filePath,
        mimeType: 'text/plain',
        title: fileName,
        createdAt: Date.now(),
      },
    };
  }

  supports(mimeType: string): boolean {
    return this.supportedTypes.some(t => mimeType.includes(t));
  }
}
```

### 2. Chunk 切分与嵌入

```typescript
// packages/core/src/rag/splitter.ts

export interface Chunk {
  id: string;
  content: string;
  metadata: {
    docId: string;
    chunkIndex: number;
    startOffset: number;
    endOffset: number;
  };
}

/**
 * 递归字符切分器
 *
 * 工程选择：
 * - chunkSize=512：大多数 embedding 模型的最佳输入长度
 * - overlap=50：保持跨 chunk 的上下文连贯
 * - 分割符优先级：段落 > 句子 > 换行 > 空格
 *
 * 实际部署时建议使用 LangChain 的 RecursiveCharacterTextSplitter 或
 * LlamaIndex 的 SentenceSplitter，功能更完善
 */
export class RecursiveCharacterSplitter {
  private chunkSize: number;
  private overlap: number;
  private separators: string[];

  constructor(options?: { chunkSize?: number; overlap?: number }) {
    this.chunkSize = options?.chunkSize ?? 512;
    this.overlap = options?.overlap ?? 50;
    this.separators = ['\n\n', '\n', '. ', ' ', ''];
  }

  split(text: string, docId: string): Chunk[] {
    return this.recursiveSplit(text, docId, 0);
  }

  private recursiveSplit(text: string, docId: string, startIndex: number): Chunk[] {
    if (text.length <= this.chunkSize) {
      return [{
        id: `${docId}-${startIndex}`,
        content: text,
        metadata: { docId, chunkIndex: startIndex, startOffset: 0, endOffset: text.length },
      }];
    }

    const sep = this.separators.find(s => text.includes(s)) || '';
    const parts = text.split(sep);
    const chunks: Chunk[] = [];
    let currentChunk = '';
    let currentIndex = 0;

    for (const part of parts) {
      const candidate = currentChunk ? currentChunk + sep + part : part;

      if (candidate.length > this.chunkSize && currentChunk) {
        chunks.push({
          id: `${docId}-${currentIndex}`,
          content: currentChunk,
          metadata: {
            docId,
            chunkIndex: chunks.length,
            startOffset: currentIndex,
            endOffset: currentIndex + currentChunk.length,
          },
        });
        // 保留 overlap
        const overlapText = currentChunk.slice(-this.overlap);
        currentChunk = overlapText + sep + part;
        currentIndex += currentChunk.length - overlapText.length - part.length - sep.length;
      } else {
        currentChunk = candidate;
      }
    }

    if (currentChunk.length > 0) {
      chunks.push({
        id: `${docId}-${currentIndex}`,
        content: currentChunk,
        metadata: {
          docId,
          chunkIndex: chunks.length,
          startOffset: currentIndex,
          endOffset: currentIndex + currentChunk.length,
        },
      });
    }

    return chunks;
  }
}
```

### 3. 召回与 Rerank

```typescript
// packages/core/src/rag/retriever.ts

import type { EmbeddingService } from '../memory/episodic';
import type { VectorStore } from '../memory/episodic';
import type { Chunk } from './splitter';

export interface RAGResult {
  chunk: Chunk;
  similarity: number;
  rerankScore?: number;
}

/**
 * RAG 检索器
 *
 * 工程选择：
 * - 先用向量检索召回 top-K*3 候选
 * - 再用 Rerank 模型做精排，取 top-K 最终结果
 * - Rerank 在阶段 2 时可用 cross-encoder（如 bge-reranker）实现
 * - MVP 阶段可跳过 rerank 步骤，直接取向量检索 top-K
 */
export class RAGRetriever {
  private collection: string;
  private vectorStore: VectorStore;
  private embedding: EmbeddingService;

  constructor(collection: string, vectorStore: VectorStore, embedding: EmbeddingService) {
    this.collection = collection;
    this.vectorStore = vectorStore;
    this.embedding = embedding;
  }

  /** 存储文档 chunks 到向量库 */
  async indexChunks(chunks: Chunk[]): Promise<void> {
    const embeddings = await this.embedding.embedBatch(chunks.map(c => c.content));

    await this.vectorStore.upsert(this.collection, chunks.map((chunk, i) => ({
      id: chunk.id,
      vector: embeddings[i],
      payload: {
        content: chunk.content,
        docId: chunk.metadata.docId,
        chunkIndex: chunk.metadata.chunkIndex,
        startOffset: chunk.metadata.startOffset,
        endOffset: chunk.metadata.endOffset,
      },
    })));
  }

  /** 检索并可选 rerank */
  async search(
    query: string,
    limit: number = 5,
    options?: { rerank?: boolean }
  ): Promise<RAGResult[]> {
    const queryVector = await this.embedding.embed(query);
    const rawResults = await this.vectorStore.search(this.collection, queryVector, limit * 3);

    let results: RAGResult[] = rawResults.map(r => ({
      chunk: {
        id: r.id,
        content: r.payload.content as string,
        metadata: {
          docId: r.payload.docId as string,
          chunkIndex: r.payload.chunkIndex as number,
          startOffset: r.payload.startOffset as number,
          endOffset: r.payload.endOffset as number,
        },
      },
      similarity: r.score,
    }));

    // Rerank（可选，阶段 2 实现具体 rerank 模型调用）
    if (options?.rerank && results.length > 1) {
      results = await this.rerank(query, results, limit);
    } else {
      results = results.slice(0, limit);
    }

    return results;
  }

  /**
   * [阶段 2 实现] Rerank 精排
   * 接入 bge-reranker 或 Cohere Rerank API
   */
  private async rerank(query: string, candidates: RAGResult[], topK: number): Promise<RAGResult[]> {
    // 占位：在阶段 2 接入具体 Rerank 模型
    // 当前直接按相似度排序返回
    return candidates.sort((a, b) => b.similarity - a.similarity).slice(0, topK);
  }

  /** 删除文档对应的所有 chunks */
  async removeDocument(docId: string): Promise<void> {
    // 需要 vectorStore 支持按 filter 删除
    // 此处为接口定义
  }
}
```

---

## Skill 系统的进阶（Node 08 后半）

### 工程逻辑

系统内置 Skill 随产品打包发布，通常覆盖高频通用场景（PDF 分析、数据可视化、报告生成）。但业务场景千变万化——用户需要能安装第三方 Skill 或自己编写 Skill 扩展 Agent 能力。因此 Skill 来源需要扩展为内置、市场、自定义三种，并增加版本管理与质量评估能力。

### Skill 安装来源扩展

```typescript
// packages/core/src/skill/sources.ts

/**
 * Skill 的三种来源
 *
 * 1. 内置（bundled）：随 core 包打包，默认启用
 *    - 存储位置：packages/core/skills/
 * 2. 市场（marketplace）：从远程 Skill 注册表下载安装
 *    - 来源：Git 仓库 / npm 包 / 注册表 API
 * 3. 自定义（user）：用户手动编写
 *    - 存储位置：~/.agent-core/skills/
 */
export type SkillSource = 'bundled' | 'marketplace' | 'user';

export interface SkillVersion {
  version: string;
  changelog?: string;
  downloadUrl: string;
  checksum: string;              // SHA-256 校验，防篡改
  createdAt: number;
}

export interface SkillMarketEntry {
  name: string;
  description: string;
  author: string;
  latestVersion: string;
  versions: SkillVersion[];
  downloads: number;
  rating?: number;
  tags: string[];
}

// 内置 Skill 清单（随产品打包）
export const BUNDLED_SKILLS = [
  'pdf-analysis',
  'data-viz',
  'report-gen',
  'web-search',
  'code-review',
] as const;
```

### Skill Eval 与版本管理

```typescript
// packages/core/src/skill/eval.ts

export interface SkillEvalCase {
  input: string;
  expectedTools: string[];       // 预期应激活的工具
  expectedBehavior: string;      // 预期行为的自然语言描述
}

export interface SkillEvalResult {
  skillName: string;
  passed: number;
  failed: number;
  total: number;
  passRate: number;
  failures: Array<{
    input: string;
    expected: string;
    actual: string;
    severity: 'low' | 'medium' | 'high';
  }>;
}

/**
 * Skill 内置测试套件
 *
 * 每个 Skill 目录下的 tests/ 可以包含 eval 用例。
 * SkillManager.install() 完成后自动运行 eval，评估新 Skill 的质量。
 * 这在阶段 3 实现完整 LLM 自动评估时需要。
 */
export class SkillEvaluator {
  /** 对指定的 Skill 运行 eval */
  async evaluate(skillName: string): Promise<SkillEvalResult> {
    // [阶段 3 实现] 读取 Skill tests/ 目录下的 eval 用例，逐步执行评估
    return {
      skillName,
      passed: 0,
      failed: 0,
      total: 0,
      passRate: 0,
      failures: [],
    };
  }
}
```

> 🤖 **工程逻辑**：Skill 安装做静态冲突检测（`detectConflicts`）只解决了"安装时"的问题。运行时的 Skill 冲突（多个 Skill 的 instructions 对同一类用户请求产生不同行为指导）需要在 eval 阶段通过测试用例发现。SkillEvaluator 提供了这个"运行时质量门控"的框架。

---

## 前端集成

### Memory 搜索面板

```typescript
// apps/web/src/components/settings/MemoryPanel.tsx

import { useState, useCallback } from 'react';

interface MemoryItem {
  id: string;
  content: string;
  tags: string[];
  importance: number;
  createdAt: number;
  accessCount: number;
  sessionId?: string;
}

export function MemoryPanel() {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);

  const handleSearch = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setIsSearching(true);

    try {
      const res = await fetch(`/api/memories/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setMemories(data.results);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setIsSearching(false);
    }
  }, []);

  const handleDelete = async (id: string) => {
    await fetch(`/api/memories/${id}`, { method: 'DELETE' });
    setMemories(prev => prev.filter(m => m.id !== id));
  };

  const handleImportanceToggle = async (id: string, currentImportance: number) => {
    const newImportance = currentImportance > 0.5 ? 0.3 : 0.9;
    await fetch(`/api/memories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ importance: newImportance }),
    });
    setMemories(prev => prev.map(m => m.id === id ? { ...m, importance: newImportance } : m));
  };

  return (
    <div className="space-y-4">
      {/* 搜索栏 */}
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="搜索长期记忆..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch(searchQuery)}
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-surface border border-border focus:border-accent outline-none"
        />
        <button
          onClick={() => handleSearch(searchQuery)}
          disabled={isSearching}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-accent-foreground"
        >
          {isSearching ? '...' : '搜索'}
        </button>
      </div>

      {/* 记忆列表 */}
      <div className="space-y-2">
        {memories.map(memory => (
          <div key={memory.id} className="p-3 rounded-lg bg-surface border border-border group">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm flex-1">{memory.content}</p>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => handleDelete(memory.id)}
                  className="p-1 text-xs text-red-400 hover:bg-red-500/10 rounded"
                  title="删除"
                >
                  ✗
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 mt-2">
              {/* 重要性标记 */}
              <button
                onClick={() => handleImportanceToggle(memory.id, memory.importance)}
                className={`px-1.5 py-0.5 text-[10px] rounded ${
                  memory.importance > 0.7
                    ? 'bg-amber-500/20 text-amber-300'
                    : 'bg-border/50 opacity-40'
                }`}
                title={memory.importance > 0.7 ? '重要记忆' : '普通记忆'}
              >
                {memory.importance > 0.7 ? '★ 重要' : '☆ 普通'}
              </button>

              {/* 标签 */}
              {memory.tags?.map(tag => (
                <span key={tag} className="px-1.5 py-0.5 text-[10px] rounded bg-border/50 opacity-40">
                  {tag}
                </span>
              ))}

              {/* 时间 */}
              <span className="text-[10px] opacity-30 ml-auto">
                {new Date(memory.createdAt).toLocaleDateString()}
              </span>
            </div>
          </div>
        ))}
      </div>

      {memories.length === 0 && (
        <div className="text-center py-8 text-sm opacity-30">
          没有记忆。对话中说"记住xxx"来手动写入记忆。
        </div>
      )}
    </div>
  );
}
```

### RAG 上传与管理面板

```typescript
// apps/web/src/components/settings/RAGPanel.tsx

import { useState, useCallback } from 'react';

interface RAGDocument {
  id: string;
  title: string;
  mimeType: string;
  chunkCount: number;
  createdAt: number;
}

export function RAGPanel() {
  const [documents, setDocuments] = useState<RAGDocument[]>([]);
  const [uploading, setUploading] = useState(false);

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);

    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);

        await fetch('/api/rag/documents', {
          method: 'POST',
          body: formData,
        });
      }
      // 刷新列表
    } catch (error) {
      console.error('Upload failed:', error);
    } finally {
      setUploading(false);
    }
  }, []);

  const handleDelete = async (docId: string) => {
    await fetch(`/api/rag/documents/${docId}`, { method: 'DELETE' });
    setDocuments(prev => prev.filter(d => d.id !== docId));
  };

  return (
    <div className="space-y-4">
      {/* 上传区 */}
      <div className="p-6 rounded-lg border border-border border-dashed text-center">
        <p className="text-sm opacity-60 mb-3">拖拽文件到此处或点击上传</p>
        <p className="text-xs opacity-40 mb-3">
          支持 PDF / Markdown / HTML / 代码文件 / TXT
        </p>
        <input
          type="file"
          multiple
          accept=".pdf,.md,.html,.txt,.py,.ts,.js,.json"
          onChange={e => handleUpload(e.target.files)}
          disabled={uploading}
          className="block mx-auto text-sm"
        />
        {uploading && <p className="text-xs mt-2 text-blue-400">上传中...</p>}
      </div>

      {/* 文档列表 */}
      <div className="space-y-2">
        {documents.map(doc => (
          <div key={doc.id} className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-border">
            <div className="flex-1">
              <div className="text-sm font-medium">{doc.title}</div>
              <div className="text-xs opacity-50">
                {doc.chunkCount} chunks · {doc.mimeType}
              </div>
            </div>
            <span className="text-[10px] opacity-30">
              {new Date(doc.createdAt).toLocaleDateString()}
            </span>
            <button
              onClick={() => handleDelete(doc.id)}
              className="text-xs text-red-400 hover:text-red-300"
            >
              删除
            </button>
          </div>
        ))}
      </div>

      {documents.length === 0 && (
        <div className="text-center py-8 text-sm opacity-30">
          还没有上传文档。上传的文档会被切块并被 Agent 在相关查询时检索到。
        </div>
      )}
    </div>
  );
}
```

### Settings 页面建议布局

```
Settings Page
├── MemoryPanel         → 搜索/查看/删除/标记记忆
├── RAGPanel            → 上传/管理文档
├── SkillsPanel         → 管理 Skill (见 02-tools-skills.md)
└── MCPConfigPanel      → 管理 MCP 连接 (见 02-tools-skills.md)

Chat Area
├── MessageList
│   ├── Memory injection indicator  → "本次对话使用了 N 条记忆"
│   └── ...
└── ChatInput
```

---

## 深入话题：Embedding 服务实现

HybridRetriever 和 RAGRetriever 都依赖 `EmbeddingService` 接口。以下是 OpenAI embedding 的实现参考：

```typescript
// packages/core/src/memory/embeddings.ts

import type { EmbeddingService } from './episodic';

/**
 * OpenAI Embedding 服务
 *
 * 工程选择：
 * - text-embedding-3-small：性价比高（$0.02/1M tokens），维度 1536
 * - text-embedding-3-large：精度更高（$0.13/1M tokens），维度 3072
 * - 对于记忆系统，small 维度足够了（记忆条目都很短）
 */
export class OpenAIEmbeddingService implements EmbeddingService {
  readonly dimension = 1536;
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'text-embedding-3-small';
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!res.ok) throw new Error(`Embedding API error: ${res.status}`);
    const data = await res.json();
    return data.data[0].embedding;
  }

  /**
   * 批量嵌入 —— 一次请求处理多条文本
   *
   * OpenAI 的 embedding API 支持一次传多条文本：
   * input: ["text1", "text2", ...] → data: [{embedding: ...}, ...]
   * 比逐条调用快 10x+
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) throw new Error(`Embedding API error: ${res.status}`);
    const data = await res.json();
    return data.data.map((d: any) => d.embedding);
  }
}
```

> 🤖 **AI 常见错误**：
> 1. **embedding 维度配置错误** —— text-embedding-3-small 是 1536 维，但有人错配成 3072（large 的维度），导致向量存储完全不工作。
> 2. **逐条调用 embed** —— 每次会话结束可能要 embed 10-20 条记忆，逐条调用浪费大量延迟和 API 费。必须用 embedBatch。

---

## 深入话题：向量数据库适配

以下是为 Qdrant 和内存实现的 VectorStore 适配器：

```typescript
// packages/core/src/memory/vectorstore.ts

import type { VectorStore } from './episodic';
import type { MemoryEntry } from './types';

/**
 * 内存 VectorStore —— 用于测试/开发
 *
 * 生产环境必须替换为 Qdrant/Milvus/Pinecone 等真正向量数据库。
 * 内存版的 search 用的是暴力余弦相似度，时间复杂度 O(N)。
 */
export class InMemoryVectorStore implements VectorStore {
  private collectionData = new Map<string, Map<string, { vector: number[]; payload: Record<string, unknown> }>>();

  async upsert(collection: string, entries: Array<{
    id: string; vector: number[]; payload: Record<string, unknown>;
  }>): Promise<void> {
    if (!this.collectionData.has(collection)) {
      this.collectionData.set(collection, new Map());
    }
    const col = this.collectionData.get(collection)!;
    for (const entry of entries) {
      col.set(entry.id, { vector: entry.vector, payload: entry.payload });
    }
  }

  async search(collection: string, vector: number[], limit: number): Promise<Array<{
    id: string; score: number; payload: Record<string, unknown>;
  }>> {
    const col = this.collectionData.get(collection);
    if (!col) return [];

    const results = Array.from(col.entries()).map(([id, data]) => ({
      id,
      score: this.cosineSimilarity(vector, data.vector),
      payload: data.payload,
    }));

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    const col = this.collectionData.get(collection);
    if (!col) return;
    for (const id of ids) {
      col.delete(id);
    }
  }

  async list(collection: string, filter?: Record<string, unknown>): Promise<MemoryEntry[]> {
    const col = this.collectionData.get(collection);
    if (!col) return [];
    return Array.from(col.entries()).map(([id, data]) => ({
      id,
      tier: 'episodic',
      content: (data.payload.content as string) ?? '',
      metadata: (data.payload.metadata as any) ?? {},
      createdAt: (data.payload.createdAt as number) ?? 0,
      updatedAt: (data.payload.createdAt as number) ?? 0,
      importance: (data.payload.importance as number) ?? 0.5,
      accessCount: 0,
      tags: (data.payload.tags as string[]) ?? [],
    }));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
  }
}

/**
 * Qdrant VectorStore —— 生产环境适配器
 *
 * Qdrant 是开源向量数据库，支持：
 * - 高效的 ANN 搜索（HNSW 索引）
 * - payload 过滤（按 userId、tag 等元数据筛选）
 * - BM25 混合检索（2024 年新增）
 *
 * 部署时需要用 @qdrant/js-client-rest 包
 */
export class QdrantVectorStore implements VectorStore {
  private client: any;
  private url: string;

  constructor(url: string, apiKey?: string) {
    this.url = url;
    // 实际实现需要 import { QdrantClient } from '@qdrant/js-client-rest'
    // this.client = new QdrantClient({ url, apiKey });
  }

  async upsert(collection: string, entries: Array<{
    id: string; vector: number[]; payload: Record<string, unknown>;
  }>): Promise<void> {
    // await this.client.upsert(collection, {
    //   wait: true,
    //   points: entries.map(e => ({
    //     id: e.id,
    //     vector: e.vector,
    //     payload: e.payload,
    //   })),
    // });
    // [阶段 3 实现] 接入 Qdrant SDK
  }

  async search(collection: string, vector: number[], limit: number): Promise<Array<{
    id: string; score: number; payload: Record<string, unknown>;
  }>> {
    // const result = await this.client.search(collection, {
    //   vector,
    //   limit,
    //   with_payload: true,
    // });
    // return result.map((r: any) => ({ id: r.id, score: r.score, payload: r.payload }));
    return [];
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    // await this.client.delete(collection, { points: ids });
  }

  async list(collection: string, filter?: Record<string, unknown>): Promise<MemoryEntry[]> {
    // const result = await this.client.scroll(collection, { filter, with_payload: true });
    // return result.points.map(...);
    return [];
  }
}
```

---

## 记忆系统配置示例

```typescript
// 完整初始化一个三层记忆系统的示例

import { HybridRetriever } from './memory/hybridRetriever';
import { OpenAIEmbeddingService } from './memory/embeddings';
import { QdrantVectorStore } from './memory/vectorstore';
import { MemoryManager } from './memory/manager';
import { RuleBasedExtractionStrategy, LLMBasedExtractionStrategy } from './memory/strategies';
import type { LLMClient } from './llm/types';

export function createMemoryManager(llm: LLMClient, config: {
  qdrantUrl: string;
  openaiApiKey: string;
}) {
  // 1. Embedding 服务
  const embedding = new OpenAIEmbeddingService({ apiKey: config.openaiApiKey });

  // 2. 向量数据库
  const vectorStore = new QdrantVectorStore(config.qdrantUrl);
  // 测试环境用内存版：const vectorStore = new InMemoryVectorStore();

  // 3. 混合检索器
  const retriever = new HybridRetriever('episodic_memory', vectorStore, embedding);

  // 4. MemoryManager
  const manager = new MemoryManager(retriever, embedding);

  // 5. 写入策略
  manager.addStrategy(new RuleBasedExtractionStrategy());
  manager.addStrategy(new LLMBasedExtractionStrategy(llm));

  return manager;
}
```

> 🤖 **工程逻辑**：RuleBasedExtractionStrategy 和 LLMBasedExtractionStrategy 互补。RuleBased 实时写入（看到"我喜欢 TS"马上存），但只能识别模式化的表达。LLM 提取更灵活（"用户有点偏好静态类型"），但有延迟。两者并存可以兼顾实时性和语义理解。

---

## RAG 知识库完整接入示例

```typescript
// 完整的 RAG 管线初始化 + 文档入库 + 检索示例

import { RAGRetriever } from './rag/retriever';
import { RecursiveCharacterSplitter } from './rag/splitter';
import { TextFileLoader, Document } from './rag/loader';
import { QdrantVectorStore } from './memory/vectorstore';
import { OpenAIEmbeddingService } from './memory/embeddings';

export class RAGPipeline {
  private retriever: RAGRetriever;
  private splitter: RecursiveCharacterSplitter;
  private loader: TextFileLoader;

  constructor(embedding: OpenAIEmbeddingService, vectorStore: QdrantVectorStore) {
    this.retriever = new RAGRetriever('semantic_memory', vectorStore, embedding);
    this.splitter = new RecursiveCharacterSplitter({ chunkSize: 512, overlap: 50 });
    this.loader = new TextFileLoader();
  }

  /** 导入文档到 RAG 知识库 */
  async ingest(filePath: string): Promise<{ docId: string; chunkCount: number }> {
    // 1. 加载文档
    const doc = await this.loader.load(filePath);

    // 2. 分块
    const chunks = this.splitter.split(doc.content, doc.id);
    doc.metadata.chunkCount = chunks.length;

    // 3. 嵌入 + 入库
    await this.retriever.indexChunks(chunks);

    return { docId: doc.id, chunkCount: chunks.length };
  }

  /** 检索相关文档片段 */
  async search(query: string, limit: number = 5) {
    return this.retriever.search(query, limit);
  }
}
```
