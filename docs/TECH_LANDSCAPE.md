# 2026 AI Agent 成熟技术清单 · Tech Landscape

> 本文件是"不要重造轮子"的**活地图**：梳理 2022 年大模型爆发以来，**业界真正成熟且被大厂/社区广泛采用**的技术与方案。所有 reference 扩写时以此为准；过时的做法不要写。
> 调研日期：2026-10。证据来自官方文档、GitHub、大厂博客与公开报道（详见 `_research/` 下五份调研报告）。

## 1. 演进主线（2022 → 2026）

| 阶段 | 特征 | 代表 |
|---|---|---|
| 2022-2023 | 自主循环热、单 agent 为主 | LangChain 0.x AgentExecutor、AutoGPT、BabyAGI |
| 2024 | 编排分化、多 agent 定型 | LangGraph（图状态）、AutoGen 0.4（分布式）、CrewAI（角色协作）、MCP 发布 |
| 2025 | 收敛期：实验品被官方替代 | Swarm→Agents SDK；AutoGen→Microsoft Agent Framework；LangGraph Platform→LangSmith Deployment；Assistants API 停用 |
| 2026 | 平台化 + 协议化 | MAF 1.0、ADK 2.0、A2A 1.0（Linux Foundation）、MCP 无状态化、AgentCore GA |

## 2. Agent 编排与多智能体（含"Agent 集群"）

### 生产级选型（按场景）
| 框架 | 定位 | 采用证据 | 适用 |
|---|---|---|---|
| **LangGraph + LangSmith Deployment** | 最成熟的通用编排层 | Klarna、LinkedIn、Uber、Replit、Elastic 公开案例 | 复杂业务流、长时任务、人机协同 |
| **OpenAI Agents SDK** | 最轻的官方生产 SDK（Swarm 继任） | 企业级更新、Temporal GA 集成 | OpenAI 模型为主、handoff 式多 agent |
| **Claude Agent SDK** | Claude 生态官方 SDK | Uber 工程师采用率 84%、Anthropic 自用 | 深度绑定 Claude |
| **Google ADK** | 多语言、A2A 原生 | 支撑 Google Agentspace/Gemini Enterprise | Google Cloud 栈、跨厂商互操作 |
| **Microsoft Agent Framework** | AutoGen+Semantic Kernel 统一继任 | MAF 1.0 GA，.NET/Python/Go | 微软栈/.NET 团队 |
| **CrewAI Flows** | 业务侧快速编排 | 累计 20 亿次执行、DocuSign 客户 | 非资深 AI 团队、快速上线 |
| **AWS Bedrock AgentCore** | 托管 agent 运行时 | 2025-10 GA、9 区域 | AWS 栈、托管会话/记忆 |

### "Agent 集群"的真实形态
- **orchestrator-worker 是绝对主流**：Anthropic 研究系统（主 agent 规划 + 并行子 agent + evaluator pass）、微软 Magentic-One（Orchestrator + 专家 agent）、AWS Bedrock 多 agent（supervisor 模式）、Claude Agent SDK subagents。
- **hierarchical（分层）**：Salesforce Agentforce Multi-Agent Orchestration、Copilot Studio 生成式编排（顶层路由 → 下层业务 agent）。
- **swarm（并行交接）**：OpenAI Swarm 已弃用；真正的并行来自 orchestrator 动态创建的 worker，**不是无组织的自由 swarm**。
- **协议层互操作**：**A2A**（Agent↔Agent，Linux Foundation，150+ 组织，1.0 于 2026-03）用于跨团队/跨厂商 agent 发现与协作；**MCP**（Agent↔工具）是工具连接事实标准。

### 淘汰清单（编排）
- ❌ OpenAI Swarm（官方弃用，仅教学）
- ❌ AutoGen 旧 `autogen` 包（maintenance mode → 迁移 MAF）
- ❌ LangChain 0.x AgentExecutor / 传统 Chain / LCEL 教程
- ❌ AutoGPT Classic（unsupported、有安全问题）
- ❌ MetaGPT / ChatDev / CAMEL / AgentVerse（学术项目，非生产）
- ❌ Magentic-One 作为独立产品（研究原型；生产走 MAF + Foundry Agent Service）

## 3. 工具互联：MCP（事实标准）与 A2A

### MCP 现状（2026-07-28 规范）
- **无状态核心**：移除 initialize/initialized 握手与 Mcp-Session-Id；Streamable HTTP 为主，新增 `Mcp-Method` / `Mcp-Name` 请求头。
- **传输选型**：本机/调试用 **stdio**；跨网络/生产用 **Streamable HTTP**（配 OAuth 2.1 + PKCE）。旧的 HTTP+SSE 双端点已废弃。
- **官方配套**：TypeScript/Python/Go/C# 四个官方 SDK；官方注册表 registry.modelcontextprotocol.io（preview，近万个列表）；调试器 `@modelcontextprotocol/inspector`。
- **治理**：Anthropic 2025-12 将 MCP 捐赠给 Linux Foundation 的 Agentic AI Foundation（与 OpenAI、Block 共立）。
- **大厂支持**：OpenAI Agents SDK、Google Gemini SDK/Vertex、Microsoft Agent Framework/Copilot Studio、AWS Bedrock、阿里百炼、字节扣子全部原生支持。

### A2A
- Google 发起、Linux Foundation 治理，1.0 于 2026-03-12 发布；150+ 组织支持，落地 Azure AI Foundry / Amazon Bedrock / Salesforce Agentforce。
- **与 MCP 分工**：MCP=Agent↔工具，A2A=Agent↔Agent。只有跨 Agent 协作场景才引入 A2A，单 Agent+工具不要上 A2A。

## 4. 记忆与 RAG

- 演进主线：Naïve RAG → Advanced/Modular RAG（混合检索+查询改写+重排）→ GraphRAG → **Agentic RAG**（agent 自主规划何时查、查什么）。参考：arXiv 2501.09136。
- **混合检索 + RRF 融合已是标配**：Qdrant / Weaviate / Pinecone 原生支持 dense+sparse；**cross-encoder 重排**是精度关键（Cohere Rerank、bge-reranker）；大规模可加 ColBERT（Qdrant 已支持 late-interaction）。
- 框架：LlamaIndex（索引/检索管线最全）、Haystack（生产级 pipeline）、LangGraph（Agentic RAG 编排）、DSPy（流程优化）。
- 向量库：Qdrant / Milvus / Weaviate / Pinecone 生产级；pgvector（Postgres 存量）；Elasticsearch（自带 BM25+向量）。
- **Agent 记忆成熟方案**：Mem0（开源+托管，arXiv 2504.19413）、Zep（图结构+时间关系记忆）、LangMem（LangGraph 栈）、LlamaIndex Memory、Anthropic memory tool 思路（LLM 自主管理记忆）、OpenAI memory（产品级）。
- 趋势：**向量记忆 + 图谱记忆融合**；微软 GraphRAG（LazyGraphRAG 成本约为全局检索的 4%）。
- 文档解析：Unstructured（开源自托管）、LlamaParse（托管、复杂版面强）、Azure Document Intelligence（企业合规）。
- 淘汰：纯向量无重排；手写固定分块器；忽略图结构/实体关系；把全部历史塞进 prompt 的"伪记忆"；自建向量基础设施（除非合规必需）。

## 5. 可观测性 / 评估 / 安全 / 沙箱 / 网关

### 可观测性
- **Langfuse**：开源+自托管+云，2026-01 被 ClickHouse 收购（承诺保持开源）；2025 起全面转向 OpenTelemetry → "OTel + Langfuse"是生产标配路径。
- **LangSmith**：LangChain 生态官方平台（trace/evals/deployment）。
- **Braintrust**：企业 SaaS（eval+observability 一体化）。
- **OpenTelemetry GenAI semconv**：chat/embeddings 属性趋于稳定，agent 属性仍在演进 → 生产可落地但需跟踪版本。

### 评估
- **promptfoo**：CLI-first、可入 CI 的事实标准（YAML 用例 + 红队）。
- **LLM-as-judge**：主流团队生产默认评估方法，配合人工抽检；OpenAI/Anthropic/Google 均有官方实践指南。
- DeepEval / Ragas：离线指标与 RAG 质量评估。

### 安全护栏
- **OpenAI Agents SDK Guardrails**：输入/输出护栏 + tripwire，官方文档完善。
- **Guardrails AI / LLM Guard（Protect AI）**：开源护栏编排与扫描器，可自托管。
- **NeMo Guardrails 已 EOL（2025-10）**：新项目勿用。
- **OWASP LLM Top 10（2025）**：事实标准，LLM01 提示注入居首。
- 默认实践：不信任模型输出；系统提示与工具调用隔离；输入+输出双向往护栏；最小工具权限。

### 代码沙箱
- **E2B**：Firecracker microVM 之上的开源 AI 代码沙箱，大量 agent 项目集成。
- **Daytona**：API-first 安全沙箱（$24M A 轮），90ms 环境创建。
- **Firecracker**：AWS Lambda 底层 microVM，生产验证最充分。
- **Modal**：serverless + Sandboxes，适合重型 Python/GPU。

### 模型路由 / 网关
- **LiteLLM**：开源 AI Gateway（Rust 核心），统一 100+ 模型商，生产广泛部署。
- **Cloudflare AI Gateway**：托管网关+可观测性+缓存+统一计费（已与 Workers AI 合并）。
- **OpenRouter**：多模型路由 API，适合个人/原型。

## 6. 大厂生产共识（2025-2026）

1. **官方 Agent SDK + MCP 工具连接 + Responses 类有状态运行时 + 内置护栏/HITL + 可观测性与 evals** 是收敛路径。
2. **多 Agent 编排默认 orchestrator-worker**；先单 agent+工具，确认需要再升级多 agent。
3. **Assistants API 已停用（2026-08-26）** → 用 Responses API + Conversations API。
4. 工具连接一律 MCP；跨 Agent 通信才上 A2A。
5. **先接 tracing 再写功能**：上线前定义 evals（记录完整轨迹：步骤、工具调用）。
6. 低代码原型用扣子/百炼/Copilot Studio/Agentforce；生产托管用云厂商运行时（Bedrock AgentCore、百炼 Managed Agents），避免自建基础设施。

## 7. 淘汰清单（全站速查）

- ❌ 手写 LLM 客户端/工厂（用 Vercel AI SDK / LiteLLM）
- ❌ 手写 ReAct 循环（用 SDK `streamText`/Agent SDK/LangGraph）
- ❌ 手写 SSE/EventSource（用 AI SDK 的流式能力；远程 MCP 用 Streamable HTTP）
- ❌ 手写工具协议（用 MCP）；❌ 手写 JSON-RPC
- ❌ 手写 span 管理（用 OTel + Langfuse/LangSmith）
- ❌ 纯向量检索无重排；❌ 手写分块器；❌ 伪记忆
- ❌ 无护栏直连模型；❌ 无 eval 上线
- ❌ OpenAI Swarm / AutoGen 旧包 / Assistants API / NeMo Guardrails / AutoGPT Classic / MetaGPT/ChatDev/CAMEL
- ❌ MCP 的 HTTP+SSE 双端点、有状态会话假设（initialize 握手、Mcp-Session-Id）

---
*详细证据与来源见 [docs/research/](research/) 目录下的五份调研报告：agent-orchestration.md、mcp-ecosystem.md、bigtech-production.md、memory-rag.md、observability-eval-security.md。*