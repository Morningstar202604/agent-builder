# RAG 与 Agent 记忆成熟技术现状（2024–2026）

> 用途：AI Agent 全栈构建参考文档 · 调研更新于 2026-10 · 只收录成熟且有生产采用的技术

## 一、RAG 演进与框架

- 演进路径：Naïve RAG → Advanced/Modular RAG（混合检索、查询改写、重排）→ GraphRAG → Agentic RAG（agent 自主规划"何时查、查什么、查几次"）。来源：arXiv 2501.09136《Agentic Retrieval-Augmented Generation: A Survey》。
- 成熟框架：LlamaIndex（检索/索引管线最全）、Haystack（生产级 pipeline）、LangChain/LangGraph（agent 编排）、DSPy（检索流程优化）。2025-11 第三方盘点 Top 5：LangGraph、Haystack、LangChain、LlamaIndex、Pathway（alphacorp.ai）。

## 二、检索技术成熟度

- 混合检索（BM25 稀疏 + 稠密向量 + RRF 融合）已是标配，Qdrant、Weaviate、Pinecone 均原生支持（官方文档/博客）。
- 重排（cross-encoder rerank）是精度关键环节，成熟方案：Cohere Rerank、bge-reranker 等。
- ColBERT 后期交互已工程化：Qdrant 官方教程支持 dense+sparse+ColBERT late-interaction 重排；适合中大规模，超大规模需评估成本。
- 向量库现状：Qdrant、Milvus、Weaviate、Pinecone 均为生产级；pgvector 适合已有 Postgres 的团队；Elasticsearch 适合已用 ES 的团队（自带 BM25+向量）。

## 三、Agent 记忆成熟方案

- Mem0：开源+托管记忆层，arXiv 2504.19413（2025-04）论文；生产采用广泛。
- Zep：图结构+时间关系记忆，面向长期/会话式记忆。
- LangMem：LangChain 官方记忆 SDK，适合 LangGraph 栈。
- LlamaIndex Memory：索引/记忆组件，配合 LlamaCloud。
- Anthropic memory tool 思路：LLM 自主管理记忆（memory tool + context editing），官方 cookbook 与《Effective context engineering》博文。
- OpenAI memory：ChatGPT 产品级记忆；API 侧仍以 prompt 缓存/工具为主。
- 趋势：向量记忆 + 图谱记忆融合（Mem0 graph variant、Zep graph）。

## 四、文档解析

- Unstructured：开源、社区大、可自托管。
- LlamaParse：托管解析，复杂版面/表格强，与 LlamaIndex 生态集成。
- Azure Document Intelligence：企业级 SLA/合规强，适合 Azure 栈。

## 五、2026 推荐组合

1. 解析：LlamaParse；企业合规场景用 Azure Document Intelligence。
2. 检索：混合检索 + cross-encoder 重排；大规模加 ColBERT。
3. 编排：LlamaIndex（RAG 管线）或 LangGraph（Agentic RAG）。
4. 向量库：Qdrant/Weaviate（混合检索优先）；Postgres 存量用 pgvector。
5. 记忆：Mem0 或 Zep；LangGraph 栈用 LangMem；复杂关系场景加微软 GraphRAG（LazyGraphRAG 版本成本仅为全局检索的 ~4%）。

## 六、淘汰清单

- 纯向量检索、无重排。
- 手写固定分块器（改用解析工具+语义分块）。
- 忽略图结构/实体关系（多跳问题失效）。
- 把全部历史塞进 prompt 的"伪记忆"（上下文爆炸，用记忆层）。
- 自建/自管向量基础设施（除非合规必需）。

## 来源

- arXiv 2501.09136（Agentic RAG survey）
- arXiv 2504.19413（Mem0 论文）
- microsoft.com/research GraphRAG 项目页与 LazyGraphRAG 博客（2025-06）
- qdrant.tech 官方 Hybrid Search with Reranking 教程
- weaviate.io/blog/hybrid-search-explained
- anthropic.com/engineering/effective-context-engineering-for-ai-agents；platform.claude.com cookbook
- llamaindex.ai（LlamaParse）；azure.microsoft.com Document Intelligence
- mem0.ai/blog/state-of-ai-agent-memory-2026（引用 McKinsey 2025 调查：23% 组织在规模化 agentic AI）