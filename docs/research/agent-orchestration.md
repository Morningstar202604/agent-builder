# Agent 编排与多智能体规模化调研（2022–2026）

> 调研日期：2026-10-12。证据以官方文档/官方博客、GitHub 仓库与 star 数据（第三方追踪）、大厂公开案例为主；star 数为检索时第三方平台快照，略有出入。

## 1. 结论摘要

2026 年生产级多 Agent 系统的成熟选择集中在五个：**LangGraph（+LangSmith Deployment）、OpenAI Agents SDK、Google ADK、Microsoft Agent Framework、CrewAI Flows**；若深度绑定 Claude 生态则选 **Claude Agent SDK**。它们都有大厂自用或头部客户生产案例支撑。**OpenAI Swarm、AutoGen 旧包、LangChain 0.x 的 AgentExecutor/Chain 模式、AutoGPT Classic 已明确过时**；MetaGPT/ChatDev/CAMEL 等仍是学术/教学项目，不建议上生产。

## 2. Agent 框架演进时间线（2022–2026）

| 框架 | 状态 | 生产可用性 | 大厂采用证据 |
|---|---|---|---|
| LangChain → LangGraph | 活跃（LangChain 1.0 / LangGraph 1.0 于 2025-10 发布） | 高 | LangChain ~145k star（2026-08）；LangGraph ~40.7k star。生产用户：Klarna（8500 万用户客服）、LinkedIn、Uber、Replit、Elastic（langchain.com/built-with-langgraph） |
| OpenAI Swarm → Agents SDK | Swarm 已弃用（2025-03-11 起），Agents SDK 为官方继任 | 高 | Swarm README 自述"replaced by the OpenAI Agents SDK"；Agents SDK ~28–30k star；2026-04 TechCrunch 报道其企业级更新；与 Temporal 的集成 2026-03-23 GA |
| AutoGen → Microsoft Agent Framework | AutoGen 进入维护模式（2025-10 起）；MAF 为统一继任 | 中→高 | AutoGen ~50–59k star，官方 GitHub 标注 maintenance mode；官方提供 AutoGen→MAF 迁移指南；MAF 1.0 于 2026-04-03 GA，.NET/Python/Go，支持 MCP+A2A，~9.6k star |
| CrewAI | 活跃 | 高 | ~47.8k star（2026-04）；官方称累计 20 亿次 agentic workflow 执行；DocuSign 为 CrewAI Flows 早期客户 |
| Google ADK | 活跃（ADK 2.0，Python 2026-05-19 GA） | 高 | ~21.8k star；Google 自家 Agentspace（现 Gemini Enterprise）由 ADK 支撑；配合 A2A 协议（Linux Foundation 托管，150+ 组织支持） |
| Anthropic Claude Agent SDK / Claude Code | 活跃（Claude Code SDK 于 2025-09-29 更名） | 高 | Uber 工程师采用率从 32%→84%（2025-12 至 2026-03）；Anthropic 内部用于 GitHub issue 处理等 |
| AWS Bedrock AgentCore | 活跃（2025-10-23 GA，9 个区域） | 高（AWS 栈） | AWS 官方托管 agent runtime，含会话内/跨会话记忆 |
| Semantic Kernel | 维护中（1.x 继续支持，功能并入 MAF） | 中→高 | ~28k star（2026-05） |

**一处纠偏**：AgentScope 并非微软产品，而是**阿里通义实验室（Tongyi Lab）**的项目（agentscope-ai/agentscope，~33.1k star，AgentScope 2.0 主打生产可用）。微软的路线是 AutoGen/Semantic Kernel 并入 Agent Framework，不要混为一谈。

按年份看，演进分四个阶段：**2022–2023** 是 LangChain 与 AutoGPT/BabyAGI 带起的自主循环热，AgentExecutor 式单 agent 为主；**2024** 是编排分化期，LangGraph（图状态）、AutoGen 0.4（分布式 runtime）、CrewAI（角色协作）各自定型；**2025** 是收敛期，Swarm 被 Agents SDK 取代、AutoGen 并入 Agent Framework、LangGraph Platform 更名 LangSmith Deployment、AgentCore 与 ADK 1.0 相继 GA；**2026** 进入平台化与协议化，MAF 1.0 GA、ADK 2.0 多语言 GA、A2A 成为 Linux Foundation 下的跨厂商互操作标准。

判断框架是否真成熟，可查四个信号：**①官方文档是否含部署/可观测章节；②是否有公开企业客户案例页；③是否发布 1.0 GA 版本；④是否有托管平台承接运行**（LangSmith Deployment、Foundry Agent Service、Vertex AI、Bedrock）。只满足前两条的，多数仍处于社区阶段。

## 3. "Agent 集群 / 多智能体规模化编排"现状

- **OpenAI Agents SDK 的 swarm 路由**：以 `handoffs`（agent 间交接）为核心实现 Swarm 式路由，配 guardrails、sessions、tracing；官方文档明确称其为 Swarm 的 production-ready 演进。这是真生产路径，Temporal 等已做 GA 级集成。
- **LangGraph Platform → LangSmith Deployment**：2025-10 更名后成为托管部署层，支持云端/自托管、长时状态、人机协同、可观测；配合 LangSmith 的 trace/评测。Klarna、LinkedIn、Uber 等是其生产背书。
- **AutoGen 分布式 agent**：AutoGen 0.4 引入基于 gRPC 的分布式 runtime，支持跨进程 agent 生命周期管理——能力真实存在，但 **AutoGen 已进入维护模式**，新项目应直接走 Microsoft Agent Framework + Foundry Agent Service（微软托管 multi-agent 平台）。
- **Anthropic orchestrator-worker**：官方博客《How we built our multi-agent research system》披露其 Research 系统采用 lead agent 编排 worker 的生产架构，已用于 Claude Research 产品——这是"orchestrator-worker 真生产"的最直接证据。
- **Google A2A 协议**：Linux Foundation 项目，150+ 支持组织（含 AWS、Microsoft、IBM、Salesforce、SAP、Cisco），官方称首年已出现企业生产用例；ADK 原生支持 A2A 暴露/调用远程 agent。协议层互操作，不与具体框架绑定。
- **CrewAI Flows**：事件驱动、支持状态与条件逻辑；以 20 亿次执行为规模化证据，DocuSign 为标杆客户。
- **Magentic-One / AutoGen 云服务**：Magentic-One 是微软研究原型（arXiv:2411.04468），以 AutoGen 团队示例形式存在，**属研究蓝图而非独立产品**；其生产化路径是 MAF + Azure AI Foundry（现 Microsoft Foundry）Agent Service。

**哪些真在生产用？** 证据最强的排序：LangGraph（多家大厂公开案例）≈ CrewAI（DocuSign + 20 亿次执行）≈ OpenAI Agents SDK（企业级迭代 + 生态 GA 集成）≈ Claude Agent SDK（Uber 84% 采用 + Anthropic 自用）> Google ADK（支撑自家 Agentspace，外部案例以 Google Cloud 生态为主）> A2A（协议层，150+ 组织）。**AutoGen 分布式与 Magentic-One 属于"能力存在但项目已冻结/研究性质"，不能算当前主流生产路径。**

需要区分的是：A2A 是**互操作协议**而非框架，它解决跨团队、跨厂商的 agent 通信问题，不替代框架内部的编排；生产系统通常是“一个编排框架 + A2A 出口”的组合，而不是二选一。

## 4. 关键判断：2026 年生产级选型

1. **LangGraph + LangSmith Deployment**：最成熟的通用编排层。状态机、长时任务、人机协同、可观测一应俱全，大厂公开案例最多，适合复杂业务流。代价是学习曲线高。
2. **OpenAI Agents SDK**：最轻的官方生产 SDK。若团队以 OpenAI 模型为主、需要快速上线 handoff 式多 agent，选它；但多 agent 语义较简单，复杂状态流仍需自己补。
3. **Google ADK**：多语言（Python/TS/Go/Java）、A2A 原生、Google 自家生产背书。适合 Google Cloud 栈或需要跨厂商 agent 互操作的场景。
4. **Microsoft Agent Framework**：微软栈/.NET 团队首选。统一 AutoGen + Semantic Kernel，MCP/A2A 一等公民，可平滑上 Foundry Agent Service 托管。
5. **CrewAI Flows**：业务侧快速编排、非资深 AI 团队也能上手，社区大、生产规模证据足；复杂底层控制力弱于 LangGraph。

选型不必绑定单一框架：跨厂商互操作走 A2A，复杂业务编排走 LangGraph 或 MAF，轻量内部 agent 用 OpenAI Agents SDK，已有 Google Cloud/AWS 基础设施则优先 ADK/AgentCore。多 Agent 系统 2026 年的关键是**可观测、状态持久化、权限隔离与人工介入点**，框架只提供基础，生产韧性要靠部署平台（LangSmith Deployment、Foundry Agent Service、Bedrock AgentCore）补齐。

**不建议作为生产底座**：OpenAI Swarm（教育实验）、AutoGen 旧包（维护模式）、Magentic-One（研究原型）、MetaGPT/ChatDev/CAMEL（学术项目）、AutoGPT Classic（官方不再支持）。

## 5. 淘汰清单（新手别学）

- **OpenAI Swarm**：官方已弃用，明确是"educational framework"，唯一价值是读源码理解 handoff。
- **AutoGen（`autogen` 包）**：maintenance mode，官方要求迁移到 Microsoft Agent Framework；旧教程大量过时。
- **LangChain 0.x 的 AgentExecutor / 传统 Chain**：官方已弃用并引导迁移 LangGraph/LangChain 1.0 的 `create_agent`；2023 年的"LCEL 链式"教程别学。
- **AutoGPT Classic**：unsupported，依赖不更新、有已知安全问题，仅作历史参考。
- **MetaGPT / ChatDev / CAMEL / AgentVerse**：论文式多智能体研究项目，非生产工程，别作为架构蓝本。
- **BabyAGI / 2023 年自主循环式 Agent 教程**：教学性质，已被结构化编排（图、状态、handoff）取代。

## 6. 主要来源

- OpenAI：github.com/openai/swarm（README）、openai.github.io/openai-agents-python（官方文档）
- 微软：learn.microsoft.com/agent-framework（Overview/迁移指南）、github.com/microsoft/autogen（maintenance mode）、microsoft.github.io/autogen（分布式 runtime 文档）
- LangChain：langchain.com/blog/langgraph-platform-ga、langchain.com/built-with-langgraph、docs.langchain.com（v1 迁移）
- CrewAI：crewai.com/blog/lessons-from-2-billion-agentic-workflows
- Google：adk.dev、linuxfoundation.org（A2A 150+ 组织新闻稿）
- Anthropic：anthropic.com/engineering/multi-agent-research-system、code.claude.com（Agent SDK 文档）
- AWS：awsinsider.net（AgentCore GA 报道）
- Star 数据：star-history.com、tech-insider.org、getpanto.ai、is4.ai、rywalker.com（第三方快照，时间见正文）