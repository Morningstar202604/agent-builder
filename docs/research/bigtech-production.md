# 大厂 Agent 产品与生产技术栈调研报告（2025–2026）

> 调研日期：2026-10-12。本报告所有结论均来自官方博客、官方文档、发布会/官方新闻稿及权威媒体，并在搜索结果层面做了多源交叉验证（本次调研期间页面全文抓取工具不可用，故引用以官方域名 URL + 标题/摘要为准，关键 URL 可直接复核）。整体置信度：**高**（核心事实均有官方来源，个别采用数据为分析师估计，已单独标注）。

## 一、大厂 Agent 产品与底层技术

### OpenAI
- **Agents SDK**（2025-03 发布）：开源（MIT），Python/TypeScript，默认基于 **Responses API**，内置 agent loop、工具、guardrails、handoffs、会话与 tracing；官方定位为实验项目 **Swarm 的生产级继承者**（Swarm 已在 GitHub 标注被 Agents SDK 取代）。来源：[openai.github.io/openai-agents-python](https://openai.github.io/openai-agents-python)、[github.com/openai/swarm](https://github.com/openai/swarm)。
- **Responses API**：面向 agent 的新一代 API（内置 web search、file search、computer use 等工具）；**Assistants API 已于 2026-08-26 停用**，官方指引迁移到 Responses API + Conversations API。来源：[kingy.ai 迁移追踪](https://kingy.ai/ai-launch-tracker/openai-assistants-api-reaches-its-migration-deadline-august-26)、[Zoho 社区引用的官方弃用通知](https://help.zoho.com/portal/en/community/topic/deprecation-notice-openai-assistants-api-will-be-shut-down-on-august-26-2026)。
- **AgentKit**（2025-10-06 DevDay 发布）：OpenAI 平台内的 no-code agent 构建器，与 Apps in ChatGPT 一同推出。来源：[ZDNet DevDay 2025 汇总](https://www.zdnet.com/article/everything-openai-announced-at-devday-2025-agent-kit-apps-sdk-chatgpt-and-more)、[The New Stack](https://thenewstack.io/openai-launches-a-no-code-agent-builder)。
- **Operator / ChatGPT Agent**：Operator 于 2025-01-23 以 research preview 发布，基于 **CUA（Computer-Using Agent）** 模型操控浏览器；2025-07-17 起统一并入 ChatGPT Agent。来源：[MIT Technology Review](https://www.technologyreview.com/2025/01/23/1110484/openai-launches-operator-an-agent-that-can-use-a-computer-for-you)、[Belitsoft 对 2025-07-17 公告的报道](https://belitsoft.com/news/chatgpt-agent-openai-20250717)。
- **MCP 支持**：2025-03 起在 Agents SDK（`MCPServerStdio`/`MCPServerHttp`）与 ChatGPT 桌面端支持 MCP。来源：[Agents SDK MCP 官方文档](https://openai.github.io/openai-agents-python/mcp)、[layered.dev 时间线](https://layered.dev/openai-embraces-mcp-the-protocol-era-of-ai-has-arrived)。

### Anthropic
- **MCP 发起者**：2024-11 开源 MCP；2025-12 将 MCP 捐给 Linux Foundation 旗下新成立的 **Agentic AI Foundation**（与 Block、OpenAI 共建）。来源：[Anthropic 官方新闻](https://www.anthropic.com/news/model-context-protocol)、[Anthropic 捐赠公告](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)。
- **Claude Agent SDK**（2025-09-29 发布，原名 Claude Code SDK）：将 Claude Code 的 agent loop、工具、权限、hooks、MCP 支持开放给 Python/TypeScript 开发者。来源：[Claude Code 官方文档 Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview)、[AI Agents Hub 发布记录](https://www.aiagentshub.net/blog/claude-agent-sdk-guide)。
- **Claude Code**：Anthropic 终端 agent 产品；据分析师报道，2026-02 年化收入运行率约 $25 亿、30 万+ 用户（**非官方数据，仅作参照**）。来源：[UncoverAlpha](https://www.uncoveralpha.com/p/anthropics-claude-code-is-having)、[GetPanto 统计](https://www.getpanto.ai/blog/claude-ai-statistics)。
- **多智能体研究系统**（官方工程博客，2025-06-13）：Claude 的 Research 功能采用 **orchestrator-worker 架构**——主 agent 规划，用工具并行创建子 agent 执行搜索/写作，再由独立 evaluator pass 校验质量；博客详述了上下文管理、token 成本、评估等生产级教训。来源：[Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)、[Anthropic Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)。

### Microsoft
- **Microsoft Agent Framework**（2025-10-01 发布，2026 年达 v1.0）：融合 **AutoGen** 的 agent 抽象与 **Semantic Kernel** 的企业级能力，多语言（.NET/Python/Go）。来源：[Azure 官方博客](https://azure.microsoft.com/en-us/blog/introducing-microsoft-agent-framework)、[MS Learn Overview](https://learn.microsoft.com/en-us/agent-framework/overview)、[Agent Framework v1.0 公告](https://devblogs.microsoft.com/agent-framework/microsoft-agent-framework-version-1-0)。
- **Magentic-One**：通用多 agent 系统，Orchestrator 协调 **WebSurfer / FileSurfer / Coder / ComputerTerminal** 四类专家 agent，是标准的 orchestrator-worker 生产形态。来源：[Microsoft Research](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks)、[arXiv 2411.04468](https://arxiv.org/html/2411.04468v1)。
- **Copilot Studio**：低代码 agent 平台，支持**自主 agent**（业务事件触发）与生成式编排（在 agent/主题/工具/知识间路由）。来源：[Microsoft Copilot 博客](https://www.microsoft.com/en-us/copilot/blog/copilot-studio/unlocking-autonomous-agent-capabilities-with-microsoft-copilot-studio)、[MS Learn 生成式编排](https://learn.microsoft.com/en-us/microsoft-copilot-studio/advanced-generative-actions)。

### Google
- **ADK（Agent Development Kit）**：开源 agent 开发框架（Python/Java），由 Agentspace/Gemini Enterprise 团队维护，支持 MCP 与 A2A。来源：[adk.dev](https://adk.dev/)。
- **A2A（Agent2Agent）**：agent 间通信开放协议，2025-04 发布，2025-06 捐给 Linux Foundation；官方称 150+ 组织采用并已有云平台生产使用。来源：[Linux Foundation 新闻稿](https://www.linuxfoundation.org/press/linux-foundation-launches-the-agent2agent-protocol-project-to-enable-secure-intelligent-communication-between-ai-agents)、[a2aproject/a2a](https://github.com/a2aproject/a2a)。
- **Agentspace → Gemini Enterprise**（2025-10-10 更名）：企业级 agent 平台，提供跨企业应用的单一通用 Gemini agent。来源：[Atlan 产品梳理](https://atlan.com/know/ai-agent/ai-agent-applications/google-agentspace)、[Constellation Research](https://www.constellationr.com/insights/news/google-cloud-launches-gemini-agent-work-across-enterprise-systems)。

### Salesforce / AWS / 国内
- **Salesforce Agentforce**：CRM 场景自治 agent 平台；**Atlas Reasoning Engine** 是其推理内核；提供 **Multi-Agent Orchestration**（agent 团队协作）与 Agentforce Grid（可视化编排）。来源：[Agentforce 官网](https://www.salesforce.com/agentforce)、[Atlas 介绍](https://www.salesforce.com/agentforce/what-is-a-reasoning-engine/atlas)、[Multi-Agent Orchestration](https://www.salesforce.com/agentforce/multi-agent-orchestration)。
- **AWS Bedrock**：2024-12 re:Invent 推出 Bedrock Agents **多 agent 协作**（路由 agent + 专业子 agent 的 supervisor 模式）；**AgentCore** 为托管 agent 运行时，AWS 提供官方多 agent 架构指南与示例。来源：[Amazon 官方新闻稿](https://press.aboutamazon.com/2024/12/aws-strengthens-amazon-bedrock-with-industry-first-ai-safeguard-new-agent-capability-and-model-customization)、[builder.aws AgentCore 多 agent 模式](https://builder.aws.com/content/3DCax04M9o7gBpAMttstsLjmPUD/multi-agent-architecture-patterns-with-amazon-bedrock-agentcore-runtime)、[AWS Solutions Library](https://github.com/aws-solutions-library-samples/guidance-for-multi-agent-orchestration-using-bedrock-agentcore-on-aws)。
- **阿里云百炼**：Agent 2.0 将知识库、MCP 等统一为工具；**Managed Agents** 提供托管会话/沙箱/工具执行的 agent 运行时；2025-06-25 百炼 3.0 升级，并有 MCP 广场生态。来源：[百炼 Agent 2.0 文档](https://help.aliyun.com/zh/model-studio/new-single-agent-application)、[Managed Agents 产品简介](https://help.aliyun.com/zh/model-studio/managed-agents-introduction)、[量子位对百炼 3.0 的报道](https://www.qbitai.com/2025/06/302521.html)。
- **字节扣子（Coze）/ 火山方舟**：扣子是低代码 agent 平台，内置 MCP 客户端，支持基于 MCP 创建插件、发布为 MCP 工具；火山方舟提供 **AgentKit** 开发工具平台（Agent 构建/部署/运行，含安全、记忆、知识、监控）。来源：[扣子 MCP 文档](https://docs.coze.cn/guides_create_a_plugin_based_on_mcp)、[扣子发布 MCP 工具](https://docs.coze.cn/guides_publish_to_space)、[火山引擎 AgentKit 文档中心](https://www.volcengine.com/docs/86681)、[火山方舟](https://www.volcengine.com/product/ark)。

## 二、"Agent 集群"在大厂的真实形态
- **orchestrator-worker 是绝对主流**：Anthropic 研究系统（主 agent 规划 + 并行子 agent + evaluator pass）、Magentic-One（Orchestrator + 四类专家）、AWS Bedrock 多 agent 协作（supervisor 模式）、Claude Agent SDK 的 subagents，全部是这一模式。
- **hierarchical（分层）**：Salesforce Agentforce 的多 agent 编排与 Copilot Studio 的 connected agents 均采用"顶层 agent 路由 → 下层业务 agent 执行"的分层结构。
- **swarm/并行**：OpenAI Swarm 已被官方弃用（实验性，不推荐生产）；真正的并行来自 **orchestrator 动态创建的 worker**（如 Anthropic 研究系统），而非无组织的自由 swarm。
- **结论**：大厂生产系统普遍是"一个 planner + 若干专业 worker + 质量校验 pass"的可控编排，**不是自由 swarm**。

## 三、共同趋势
1. **MCP 成为工具连接事实标准**：Anthropic 发起，OpenAI、Google ADK、Microsoft（Agent Framework/Copilot Studio）、AWS Bedrock、阿里百炼、字节扣子全部原生支持；A2A 负责 agent 间通信，与 MCP 分工。
2. **可观测性**：OpenTelemetry GenAI semantic conventions 正在标准化 LLM/agent 遥测；各 Agent SDK 内置 tracing，LangSmith/Langfuse 等生态工具成为标配。
3. **护栏**：OpenAI Agents SDK 内置输入/输出 guardrails；Claude Agent SDK 提供权限系统与 hooks；生产平台强调 prompt injection 防护。
4. **多 Agent 编排**：orchestrator-worker 是通用答案，低代码平台（Agentforce、Copilot Studio、扣子、百炼）把编排产品化。
5. **HITL**：审批、审计日志是标配；Anthropic 甚至发布《Measuring AI agent autonomy》研究报告衡量人类介入程度。
6. **评估体系**：agent evals 必须记录完整轨迹（步骤、工具调用）；Anthropic 研究系统用 evaluator agent 自动评分；LangSmith/Langfuse 均支持轨迹级评估。

## 四、2026 年中小团队 / 独立开发者推荐清单
1. **直接用官方 Agent SDK**（OpenAI Agents SDK 或 Claude Agent SDK），不要自研 agent loop。
2. **工具连接一律走 MCP**；需要 agent 间通信时再上 A2A。
3. **用 Structured Outputs / JSON Schema** 做结构化输出，不要解析自由文本。
4. **护栏内置**：输入/输出 guardrails + HITL 审批 + 审计日志，从第一天做起。
5. **先接 tracing 再写功能**：OpenTelemetry 或 Langfuse/LangSmith，上线前定义 evals。
6. **多 agent 采用 orchestrator-worker**；先单 agent + 工具，确认需要再升级多 agent。
7. **低代码原型**用扣子/百炼/Copilot Studio/Agentforce；生产托管用云厂商运行时（Bedrock AgentCore、百炼 Managed Agents），避免自建基础设施。
8. **选有长期官方支持的 API**：用 Responses API（Assistants API 已停用）。

## 五、淘汰清单
- ❌ **OpenAI Assistants API**（2026-08-26 已停用）→ Responses API + Conversations API。
- ❌ **OpenAI Swarm**（实验性）→ Agents SDK。
- ❌ **纯 prompt 工程调优代替结构化输出**：大厂全部提供 JSON Schema / Structured Outputs，脆弱文本解析已被放弃。
- ❌ **无护栏直连模型**：生产平台标配 guardrails / HITL。
- ❌ **自建工具协议**：MCP 已是事实标准，自建协议徒增集成与维护成本。
- ❌ **手写无状态 agent loop**：Responses API / 各 Agent SDK 已内置会话、工具调用与状态管理。
- ❌ **无评估、无可观测性就上线**：agent 生产化的前提是 evals + tracing。

---

*证据说明：本报告中的官方链接（anthropic.com、openai.com、learn.microsoft.com、help.aliyun.com、docs.coze.cn、volcengine.com、salesforce.com、aboutamazon.com、linuxfoundation.org、adk.dev、openai.github.io 等）均可直接打开复核；个别采用数据（如 Claude Code 收入）来自分析师估算，已在文中标注，不作事实断言。*