# 对标清单：RAG / 记忆 / 向量检索 / 知识库开源项目（2026 年现状）

> 调研日期：2026-10-12。star 为 GitHub 量级估算（以仓库页为准）；许可证以各仓库 LICENSE 为准，下文重点项在回复中补充核对。

## 一、RAG 框架
- **LlamaIndex**（run-llama/llama_index）｜MIT｜star 约 4 万｜定位：数据索引 + 检索 + RAG 编排框架（Python/TS）。活跃度极高，周更。适合作为检索管线的底层库；参考：文档分块、索引结构、查询规划。https://github.com/run-llama/llama_index
- **Haystack**（deepset-ai/haystack）｜MIT｜约 2 万｜生产级 LLM 编排框架，组件化、管道清晰，适合自托管搭建检索/问答服务。https://github.com/deepset-ai/haystack
- **LangChain**（langchain-ai/langchain）｜MIT｜约 10 万｜生态最大的 LLM 应用框架。API 变动快，参考价值大于直接依赖。https://github.com/langchain-ai/langchain
- **Pathway**（pathwaycom/pathway）｜Apache-2.0｜约 1 万｜实时数据处理 + 增量 RAG 管道。https://github.com/pathwaycom/pathway
- **DSPy**（stanfordnlp/dspy）｜MIT｜约 2 万｜声明式优化 prompt/检索流程，适合参考检索优化策略，不宜直接做产品底座。https://github.com/stanfordnlp/dspy

## 二、向量库
- **Qdrant**（qdrant/qdrant）｜Apache-2.0｜约 2 万｜Rust 高性能向量库，自托管友好，推荐直接部署。https://github.com/qdrant/qdrant
- **Milvus**（milvus-io/milvus）｜Apache-2.0｜约 3 万｜分布式向量库，适合大数据量场景。https://github.com/milvus-io/milvus
- **Weaviate**（weaviate/weaviate）｜BSD-3｜约 1 万｜向量 + 混合检索，内置 AI 模块。https://github.com/weaviate/weaviate
- **Chroma**（chroma-core/chroma）｜Apache-2.0｜约 2 万｜嵌入式轻量向量库，原型快。https://github.com/chroma-core/chroma
- **pgvector**（pgvector/pgvector）｜PostgreSQL License｜约 1 万｜PG 扩展，中小团队运维成本最低。https://github.com/pgvector/pgvector
- **Elasticsearch**（elastic/elasticsearch）｜Elastic License 2.0 + AGPL 双许可｜约 7 万｜全文 + 向量一体，适合已有 ES 栈。https://github.com/elastic/elasticsearch
- **Vespa**（vespa-engine/vespa）｜Apache-2.0｜约 6 千｜大规模实时混合检索，参考价值高。https://github.com/vespa-engine/vespa

## 三、文档解析
- **Unstructured**（Unstructured-IO/unstructured）｜Apache-2.0｜约 1 万｜多格式文档解析 SDK，可直接嵌入。https://github.com/Unstructured-IO/unstructured
- **marker**（VikParuchuri/marker）｜GPL-3.0｜约 2 万｜PDF→Markdown 质量高；商用注意 GPL 传染性。https://github.com/VikParuchuri/marker
- **docling**（docling-project/docling，IBM）｜MIT｜约 3 万｜PDF/Word/PPT 转结构化 Markdown/JSON，推荐嵌入。https://github.com/docling-project/docling

## 四、记忆层
- **Mem0**（mem0ai/mem0）｜Apache-2.0｜约 4 万｜通用记忆层，可自托管，推荐直接使用。https://github.com/mem0ai/mem0
- **Graphiti**（getzep/graphiti）｜Apache-2.0｜约 1 万｜时序知识图谱记忆；Zep CE 已停止维护，官方迁移方向即 Graphiti。https://github.com/getzep/graphiti
- **LangMem**（langchain-ai/langmem）｜MIT｜LangChain 官方记忆 SDK，适合 LangChain 生态。https://github.com/langchain-ai/langmem
- **Letta**（letta-ai/letta，原 MemGPT）｜Apache-2.0｜约 2 万｜带记忆的 Agent 框架。https://github.com/letta-ai/letta

## 五、知识库产品
- **RAGFlow**（infiniflow/ragflow）｜Apache-2.0｜约 5 万｜深度文档理解 + RAG 全流程，API/前端齐全，最推荐直接二次开发/自托管。https://github.com/infiniflow/ragflow
- **FastGPT**（labring/FastGPT）｜Apache-2.0 + 附加条件（SaaS 商用需商业授权）｜约 2 万｜知识库问答平台，开箱即用；自托管/交付可用，对外提供 SaaS 需授权。https://github.com/labring/FastGPT
- **Dify**（langgenius/dify）｜Apache-2.0｜约 9 万｜LLM 应用平台，知识库 + 工作流，自托管友好。https://github.com/langgenius/dify
- **MaxKB**（1Panel-dev/MaxKB，飞致云）｜GPL-3.0｜约 1 万｜中文知识库问答，部署简单。https://github.com/1Panel-dev/MaxKB

## 结论
- **最值得直接二次开发**：RAGFlow。理由：Apache-2.0 无商用限制、文档理解（布局/表格/OCR）强、自带 API 与前端、社区活跃，适合中小团队私有化企业知识库问答。
- **可直接嵌入的组件**：docling / Unstructured（文档解析）、Qdrant 或 pgvector（向量存储）、Mem0 / Graphiti（记忆层）、LlamaIndex（检索编排底层）。