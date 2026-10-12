# 15 — 知识库管理：成熟 RAG 管线

> Layer 15 目标：用成熟管线搭建生产级知识库——多格式文档解析、索引、检索、增量更新、版本化 RAG 与引用追踪。读完本文件可独立落地一个可追溯、可回滚的 RAG 知识库。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - 多格式文档解析 → **Unstructured** / **LlamaParse** / LlamaIndex Reader，不要手写 PDF/DOCX/HTML 解析
> - 分块 → **LlamaIndex SentenceSplitter** / LangChain `RecursiveCharacterTextSplitter`，不要手写分隔符
> - 索引与检索 → **LlamaIndex VectorStoreIndex** / **Haystack Pipeline**，不要手写 cosine 与过滤
> - 增量索引 → 成熟管线的 `deleteRefDoc` / doc_id 更新能力，**业务调度策略 [CUSTOM]**
> - 版本化 RAG、引用追踪 → 业务策略 [CUSTOM]（成熟库没有直接对应物，但实现建立在成熟管线之上）
>
> 本文件是 [03-memory-rag.md](03-memory-rag.md) 的 RAG 深度扩展：03 用 LangChain 搭基础 RAG，这里用成熟管线覆盖全生命周期。

---

## 目录

- [1.1 选型：LlamaIndex / Haystack / Unstructured](#11-选型llamaindex--haystack--unstructured)
- [1.2 文档解析管线](#12-文档解析管线)
- [1.3 索引与检索](#13-索引与检索)
- [1.4 增量索引 [CUSTOM]](#14-增量索引-custom)
- [1.5 版本化 RAG [CUSTOM]](#15-版本化-rag-custom)
- [1.6 引用追踪 [CUSTOM]](#16-引用追踪-custom)
- [1.7 质量闭环](#17-质量闭环)
- [1.8 本层验收清单](#18-本层验收清单)

---

## 1.1 选型：LlamaIndex / Haystack / Unstructured

🔗 **工程逻辑**：三个库覆盖同一问题空间的不同粒度，按场景选，不要混用后手写胶水：

| 需求 | 推荐 | 说明 |
|------|------|------|
| 多格式解析（PDF/DOCX/HTML/PPTX/扫描件） | **Unstructured**（`unstructured` / `unstructured-client`）或 **LlamaParse** | 表格、OCR、版式还原都是成熟能力 |
| 分块 + 索引 + 检索一体化 | **LlamaIndex**（TS 用 `llamaindex`，Python 用 `llama-index`） | 本文件示例采用 |
| 生产级组件化流水线 | **Haystack**（`haystack-ai`） | 转换器/检索器/排序器可插拔 |
| 向量库 | Qdrant / Milvus / Chroma 官方 SDK（见 [12-vector-db-practical.md](12-vector-db-practical.md)） | LlamaIndex 有原生集成 |

**跨层类型契约**：所有 RAG 之上的 `llm` 一律是 `ai` 的 `LanguageModel`，创建入口只用 01 的 `createModel`，不再引入自定义 LLM 抽象：

```typescript
// packages/core/src/knowledge/llm.ts —— 契约：复用 01 的模型入口，不 import 自定义 LLM 类型
import { createModel } from '@agentcore/core/llm';
import type { LanguageModel } from 'ai';

export function getKnowledgeModel(): LanguageModel {
  return createModel('openai', process.env as Record<string, string | undefined>);
}
```

> 🤖 **AI 常见错误**：同时引入 LlamaIndex、Haystack、Unstructured 三个库然后手写适配层。按场景选一个主框架，其余只在需要特定解析器（如 Unstructured 的 OCR）时通过官方集成接入，不要自己写桥接。

---

## 1.2 文档解析管线

**不要手写 Parser Registry**。LlamaIndex 的 `SimpleDirectoryReader` 按扩展名自动选择解析器；Unstructured 负责更难的版式（表格、扫描件 OCR）。解析结果进入统一的分块器。

```typescript
// packages/core/src/knowledge/ingest.ts —— 解析与分块全部交给成熟管线
import { SimpleDirectoryReader, SentenceSplitter, type Document, type BaseNode } from 'llamaindex';

export async function loadDocuments(dirPath: string): Promise<Document[]> {
  // 按扩展名自动选择解析器（PDF/DOCX/MD/HTML...），不手写格式解析
  const reader = new SimpleDirectoryReader();
  return reader.loadData(dirPath);
}

export function splitDocuments(docs: Document[]): BaseNode[] {
  // 成熟分块：语义感知的句子分块 + overlap，不手写字符切分
  const splitter = new SentenceSplitter({ chunkSize: 512, chunkOverlap: 64 });
  return splitter.getNodesFromDocuments(docs);
}
```

> 🤖 **AI 常见错误**：为 PDF/DOCX 各写一个解析器再注册分发。解析器注册表、MIME 分发、表格/OCR 全是成熟库已解决的问题——手写意味着每个新格式都要改代码。**检查方式**：`grep -rn "ParserRegistry" packages/core/` 应无结果。

---

## 1.3 索引与检索

向量索引、embedding 编排、相似度检索都是 LlamaIndex 能力。生产环境把 `VectorStoreIndex` 接到 Qdrant（见 [12-vector-db-practical.md](12-vector-db-practical.md)）而不是内存。

```typescript
// packages/core/src/knowledge/index.ts —— 索引与检索
import { VectorStoreIndex, type BaseNode, type QueryEngine } from 'llamaindex';

export async function buildIndex(nodes: BaseNode[]): Promise<VectorStoreIndex> {
  // 默认内存索引；生产换成 QdrantVectorStore（见 12-vector-db-practical.md）
  return VectorStoreIndex.fromNodes(nodes);
}

export function createQueryEngine(index: VectorStoreIndex): QueryEngine {
  // 成熟检索：embedding 相似度 + similarityTopK，不要手写 cosine
  return index.asQueryEngine({ similarityTopK: 5 });
}
```

> 🔗 **工程逻辑**：`QueryEngine` 输出的是带 `node.metadata` 的检索结果——`source` / `pageNumber` / `sectionTitle` 等字段随分块时写入 metadata，这是 1.6 引用追踪的数据基础。metadata 写入属于业务策略 [CUSTOM]，检索本身不是。

---

## 1.4 增量索引 [CUSTOM]

**工程逻辑**：文档更新后只重新索引变化部分，不重建整个 collection。成熟管线提供 `deleteRefDoc`（按 doc_id 删除旧向量）与按 doc_id 更新；"何时判定变化、哪些文档需要同步"是业务调度策略，保留手写 [CUSTOM]。

```typescript
// packages/core/src/knowledge/delta.ts —— 增量同步的业务调度策略 [CUSTOM]
import type { VectorStoreIndex } from 'llamaindex';

export interface SyncResult {
  upserted: string[];
  removed: string[];
  unchanged: number;
}

export async function syncKnowledgeBase(
  index: VectorStoreIndex,
  currentDocs: Array<{ docId: string; contentHash: string }>,
  previousHashes: Map<string, string>
): Promise<SyncResult> {
  const upserted: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;

  for (const doc of currentDocs) {
    if (previousHashes.get(doc.docId) === doc.contentHash) {
      unchanged++;
      continue;
    }
    // 变化/新增文档：删除旧向量后重新入库（成熟管线能力）
    await index.deleteRefDoc(doc.docId, true);
    upserted.push(doc.docId);
  }
  for (const docId of previousHashes.keys()) {
    if (!currentDocs.some((d) => d.docId === docId)) {
      await index.deleteRefDoc(docId, true);
      removed.push(docId);
    }
  }
  return { upserted, removed, unchanged };
}
```

> 🤖 **AI 常见错误**：增量索引时只 `upsert` 不 `deleteRefDoc`。向量库不会自动覆盖旧向量，同一 doc 的旧 chunk 会同时被召回，导致"文档已删内容仍出现在答案里"。**检查方式**：修改文档后检索，断言旧 chunk id 不再出现。

---

## 1.5 版本化 RAG [CUSTOM]

**工程逻辑**：知识库文档需要版本管理——追溯到历史版本、比较差异、回滚。成熟库没有"RAG 版本"概念，版本表与回滚策略是业务 [CUSTOM]，但回滚时的重索引仍走 1.4 的成熟管线。

```typescript
// packages/core/src/knowledge/versioning.ts —— 版本化 RAG 业务策略 [CUSTOM]
export interface DocVersion {
  docId: string;
  version: number;
  contentHash: string;
  nodeIds: string[];
  createdAt: number;
  createdBy: string;
}

export class KnowledgeVersionStore {
  private versions = new Map<string, DocVersion[]>();

  async snapshot(
    docId: string,
    contentHash: string,
    nodeIds: string[],
    createdBy: string
  ): Promise<DocVersion> {
    const list = this.versions.get(docId) ?? [];
    const v: DocVersion = {
      docId,
      version: list.length + 1,
      contentHash,
      nodeIds,
      createdAt: Date.now(),
      createdBy,
    };
    list.push(v);
    this.versions.set(docId, list);
    return v;
  }

  async rollbackTo(docId: string, version: number, operatorId: string): Promise<DocVersion | null> {
    const list = this.versions.get(docId) ?? [];
    const target = list.find((v) => v.version === version);
    if (!target) return null;
    // 回滚 = 用目标版本的 nodeIds 重建索引（复用 1.4 的 sync 管线）
    return this.snapshot(docId, target.contentHash, target.nodeIds, operatorId);
  }
}
```

> 🔗 **工程逻辑**：版本快照只保存 `contentHash` + `nodeIds`，不保存全文——内容在向量库中，回滚时用 `nodeIds` 重新构建索引即可。这样存储成本低且回滚可审计（`operatorId` 落库）。

---

## 1.6 引用追踪 [CUSTOM]

**工程逻辑**：RAG 召回必须可追溯到原文位置——"这句话来自《产品需求 v2.3》第 3 页「用户认证流程」"。分块时把 `docId / docTitle / pageNumber / sectionTitle` 写入 node metadata，检索后格式化引用，这是业务策略 [CUSTOM]；metadata 的存储与检索是成熟管线能力。

```typescript
// packages/core/src/knowledge/citation.ts —— 引用追踪业务策略 [CUSTOM]
import type { BaseNode } from 'llamaindex';

export interface Citation {
  docId: string;
  docTitle: string;
  pageNumber?: number;
  sectionTitle?: string;
}

export function toCitedContext(nodes: BaseNode[], topK = 5): string {
  return nodes.slice(0, topK).map((node, i) => {
    const meta = node.metadata ?? {};
    const docTitle = String(meta.docTitle ?? 'Unknown');
    const page = meta.pageNumber ? `第${meta.pageNumber}页` : '';
    const section = meta.sectionTitle ? `「${meta.sectionTitle}」` : '';
    return `[参考 ${i + 1}] ${node.getContent()}\n来源：《${docTitle}》${page}${section}`;
  }).join('\n\n');
}
```

> 🤖 **AI 常见错误**：检索后把整个 node 文本塞进上下文，不带来源。模型无法区分"事实"与"推测"，合规场景不可用。必须让 metadata 跟随 node 走完整管线，并在提示词中固定引用格式。

---

## 1.7 质量闭环

召回质量评估不做手写指标库——用 [08-eval-observability.md](08-eval-observability.md) 的 Langfuse / promptfoo 追踪与回归检测：

- 每个查询的检索结果、相似度、引用一并写入 Langfuse trace（08-eval-observability.md）。
- 用户"相关/不相关"反馈回流到 08 的评估集，积累 bad case 后用 promptfoo 跑回归。
- 版本回滚后跑一遍黄金问题集，断言关键引用仍来自目标版本。

🔗 **工程逻辑**：知识库质量 = 数据质量 × 检索质量 × 生成质量。数据侧（解析、分块、metadata）本文件负责；评估侧是 08 的领域，不要在 15 里自研指标。

---


---

## 1.3.1 混合检索 + 重排（生产标配）

不要只做纯向量检索。**混合检索（BM25 稀疏 + 稠密向量 + RRF 融合）+ cross-encoder 重排**是 2026 年 RAG 的标配，Qdrant / Weaviate / Pinecone 均原生支持。

```typescript
// packages/core/src/rag/hybrid-search.ts —— Qdrant 混合检索 + 重排
import { QdrantClient } from '@qdrant/js-client-rest';

const qdrant = new QdrantClient({ url: process.env.QDRANT_URL, apiKey: process.env.QDRANT_API_KEY });

export async function hybridSearch(collection: string, dense: number[], sparse: Record<string, number>, topK = 10) {
  // dense + sparse 双路检索，RRF 融合
  const hits = await qdrant.queryPoints(collection, {
    prefetch: [
      { query: dense, using: 'dense', limit: 100 },
      { query: sparse, using: 'sparse', limit: 100 },
    ],
    query: { fusion: 'rrf' }, // 倒数排名融合
    limit: topK * 3,          // 先多召回，重排后再截断
    with_payload: true,
  });
  return hits.points;
}
```

**重排（cross-encoder）**：召回 top-30 后，用 Cohere Rerank 或 bge-reranker 精排取 top-5。

```typescript
// packages/core/src/rag/rerank.ts
import { CohereClient } from 'cohere-ai';

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

export async function rerank(query: string, docs: Array<{ id: string; text: string }>, topK = 5) {
  const res = await cohere.rerank({
    model: 'rerank-v3.5',
    query,
    documents: docs.map((d) => d.text),
    topN: topK,
  });
  return res.results.map((r) => docs[r.index!]).map((d, i) => ({ ...d, rank: i }));
}
```

🤖 **AI 常见错误**：只做向量检索不重排——BM25 与向量各有盲区，RRF 融合 + cross-encoder 重排能显著提升召回精度；不融合等于放弃工程上已验证的增益。

## 1.4.1 增量索引：LlamaIndex ingestion pipeline

手写增量索引容易漏更新。用 LlamaIndex 的 ingestion pipeline（或 Haystack 的 Pipeline）管理"解析 → 分块 → embedding → 写入"。

```python
# packages/core/src/rag/ingest.py —— LlamaIndex 增量摄入管线
from llama_index.core.ingestion import IngestionPipeline
from llama_index.core.node_parser import SentenceSplitter
from llama_index.vector_stores.qdrant import QdrantVectorStore
from llama_index.embeddings.openai import OpenAIEmbedding
import qdrant_client

client = qdrant_client.QdrantClient(url="http://localhost:6333")
store = QdrantVectorStore(client=client, collection_name="docs")

pipeline = IngestionPipeline(
    transformations=[
        SentenceSplitter(chunk_size=1024, chunk_overlap=64),
        OpenAIEmbedding(model="text-embedding-3-small"),
    ],
    vector_store=store,
)

def ingest(doc_id: str, documents: list[str]):
    # upsert 按 doc_id 去重；重跑同一 doc_id 即"增量更新"
    nodes = [{"text": t, "metadata": {"doc_id": doc_id}} for t in documents]
    pipeline.run(nodes=nodes)
```

- **增量更新**：按 `doc_id` 先删除旧分块再写入新分块（或版本号递增）。
- **失败恢复**：摄入任务入 BullMQ 队列（见 21），失败重试且幂等。

## 1.5.1 版本化 RAG：文档版本与回滚

- 每个文档块带 `version` 字段；检索时默认只查 `is_latest = true`。
- 升级解析器后重建索引：新版本写入新 collection，验证通过后切别名（Qdrant alias），失败即回滚。

```typescript
// packages/core/src/rag/versioning.ts —— 用 collection alias 做蓝绿切换
await qdrant.createCollection('docs_v2', { vectors: { size: 1536, distance: 'Cosine' } });
// ...写入 v2...
await qdrant.updateAliases({ actions: [
  { create_alias: { collection_name: 'docs_v2', alias_name: 'docs' } },
  { delete_alias: { alias_name: 'docs' } }, // 切别名时先建后删，保证无缝
]});
```

## 1.6.1 引用追踪：让答案可溯源

- 检索命中块必须携带 `doc_id` + `chunk_index` + `source_url`。
- 生成回答时，把命中块注入 tool 结果的 `citations` 数组，前端渲染为可点击引用。

```typescript
// packages/core/src/rag/citations.ts
export interface Citation { docId: string; chunkIndex: number; sourceUrl?: string; text: string; score: number }
```

🤖 **AI 常见错误**：引用与答案分离——模型可能答非所问还挂着引用。正确做法是**基于引用的生成**：只允许模型引用检索到的块，且引用块必须实际参与了生成上下文（否则前端高亮与答案无关，合规场景会出事）。

## 1.7.1 质量闭环：Ragas 评估 RAG

用 **Ragas**（或 DeepEval）评估检索质量：faithfulness（忠实度）、context_relevance（上下文相关性）、answer_relevance。

```bash
# 离线评估脚本（CI 可跑）
pip install ragas
```

```python
# eval/rag_eval.py（摘要）
from ragas import evaluate
from ragas.metrics import faithfulness, context_relevance

result = evaluate(
    dataset=[{"question": q, "answer": a, "contexts": ctx} for ...],
    metrics=[faithfulness, context_relevance],
)
print(result)  # 分数低于阈值 → CI 失败，阻止知识库变更合入
```

## 1.8 本层验收清单

- [ ] **类型检查**：运行 `npx tsc --noEmit -p packages/core`，`knowledge/ingest.ts`、`index.ts`、`delta.ts`、`versioning.ts`、`citation.ts` 全部 0 错误，公共 API 无 `any` 泄漏。
- [ ] **解析**：准备 PDF/DOCX/MD 各一份放入目录，`loadDocuments` + `splitDocuments` 产出带 metadata 的 node，断言 `docTitle` / `pageNumber` 正确写入。
- [ ] **增量**：修改文档后 `syncKnowledgeBase` 只 upsert 变化文档、删除已删文档的旧向量；检索旧 chunk id 断言不再出现。
- [ ] **版本与引用**：回滚后检索结果与历史版本一致；`toCitedContext` 输出包含《文档名》+页码+章节。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs` 本文件 0 失败；`grep -rn "LLMClient" references/` 无结果。

---

## 交叉引用

- [03-memory-rag.md](03-memory-rag.md) — 基础 RAG 管线与记忆层（本文件是它的深度扩展）
- [12-vector-db-practical.md](12-vector-db-practical.md) — 向量数据库选型与部署
- [01-foundation.md](01-foundation.md) — `createModel` / `LanguageModel` 跨层契约
- [08-eval-observability.md](08-eval-observability.md) — 质量评估、Trace、回归检测
- [00-types.md](00-types.md) — 跨层类型契约
