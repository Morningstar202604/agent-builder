# 对标业界：成熟开源项目参考与二次开发清单 / Open-Source Benchmark & Fork Guide

> 用途：想做某个东西时，先看"业界成熟项目"——**哪些用来参考架构，哪些可以直接 fork 做二次开发**。
> 数据基于 2026-10 调研（详见 `docs/research/benchmark-*.md` 五份报告，含许可证原文核对）。**动手前必须读目标仓库 LICENSE**：许可证决定你能不能改品牌、能不能闭源商用。

## 0. 快速决策表（按你的需求）

| 你想做什么 | 直接 fork / 二次开发 | 参考架构 | 许可证风险 |
|---|---|---|---|
| 类 ChatGPT 多用户产品 | **LibreChat**（MIT） | LobeChat、Open WebUI | 无（MIT） |
| 轻量聊天套壳快速上线 | **NextChat**（MIT） | Vercel AI Chatbot | 无（MIT） |
| Next.js 自研聊天应用 | **Vercel AI Chatbot**（Apache-2.0） | LibreChat | 无 |
| 企业知识库问答（商用） | **RAGFlow**（Apache-2.0） | FastGPT、Dify | 无（Apache-2.0） |
| 中文知识库助手 | **FastGPT** | Dify | 保留 LOGO；SaaS 需商业许可 |
| 全套低代码 Agent 平台 | Dify（单租户自托管） | Dify、n8n | 去 LOGO/多租户 SaaS 需商业许可 |
| 内网自用 AI 前端 | **Open WebUI** | LobeChat | 不可去品牌对外分发 |
| 自研 Agent 后端（编排） | OpenAI Agents SDK / LangGraph（作依赖） | LangGraph、MAF、ADK | 无（MIT） |
| 模型网关（多模型路由/计费） | **LiteLLM**（MIT）或 **One-API**（MIT） | new-api | new-api 是 AGPL |
| 可观测性 + 评估 | **Langfuse**（MIT，docker 自托管）+ **promptfoo**（MIT） | LangSmith（闭源） | 无 |
| 运行时护栏 | **Guardrails AI**（Apache-2.0） | OWASP LLM Top 10 | 无 |
| 代码沙箱 | **E2B** / **Daytona**（Apache-2.0） | Firecracker、gVisor | 自托管偏重 |
| 桌面 Agent 客户端 | **Cherry Studio**（AGPL，改代码须开源）或 electron-vite 模板自研 | LobeChat、Claude Desktop | AGPL 传染 |
| 浏览器 Agent | **Browser Use**（MIT，作库嵌入） | Skyvern | 无（MIT） |
| MCP 工具互联 | **@modelcontextprotocol/typescript-sdk** + Playwright/GitHub MCP | awesome-mcp-servers | 无（MIT/Apache） |

## 1. 全栈产品 / 聊天前端

| 项目 | 定位 | 许可证 | 用途建议 |
|---|---|---|---|
| **LibreChat**（~46k★） | 多模型聊天平台（Agent/MCP/Artifacts） | MIT | **类 ChatGPT 产品首选 fork**：多用户、多模型、可闭源商用 |
| **NextChat**（~89k★） | 轻量全平台聊天前端 | MIT | 快速套壳、一键部署 Vercel |
| **Vercel AI Chatbot**（~21k★） | Next.js + AI SDK 官方模板 | Apache-2.0 | 自研产品代码起点（是模板不是成品） |
| **RAGFlow**（~92k★） | 深度文档理解 RAG 引擎 | Apache-2.0 | 企业知识库商用，可自由改品牌（UI 需自配） |
| **Open WebUI**（~154k★） | 自托管 AI 前端 | 自定义 BSD（**不可去品牌**） | 内网自用最佳；对外改品牌不行 |
| **LobeChat**（~83k★） | 现代 UI 聊天/Agent 前端 | 社区许可（分发衍生品需授权） | UI/插件生态参考；改品牌需谨慎 |
| **Dify**（~158k★） | 全栈 Agent 平台 | Dify 开源许可 | 自托管单租户参考；多租户 SaaS 需商业许可 |
| **FastGPT**（~30k★） | 中文知识库+工作流 | FastGPT 开源许可 | 中文场景、单租户交付 |
| **n8n**（~207k★） | 工作流自动化 | fair-code（禁止对外售卖） | 内部自动化参考 |
| **Cherry Studio**（~53k★） | 桌面多模型客户端 | AGPL-3.0 | 桌面二次开发（改代码须开源） |
| **Chatbox**（~42k★） | 桌面/移动客户端 | GPL-3.0 | 参考交互；闭源分发不行 |
| chatbot-ui（~33k★） | 聊天模板 | MIT | ⚠️ 已停更（2024-06），勿 fork |

## 2. Agent 后端 / 框架 / 模型网关

| 项目 | 定位 | 许可证 | 用途建议 |
|---|---|---|---|
| **OpenAI Agents SDK**（~30k★） | 官方轻量 Agent 循环（handoff/guardrail） | MIT | 作依赖集成，不自研 loop |
| **LangGraph**（~43k★） | 图状态机编排 | MIT | 复杂工作流作依赖；参考其状态图/持久化设计 |
| **Microsoft Agent Framework**（~14k★） | AutoGen+Semantic Kernel 后继 | MIT | .NET/TS 栈、MCP/A2A 一等公民 |
| **Google ADK**（~22k★） | 多智能体开发套件 | Apache-2.0 | Google 栈、A2A 原生 |
| **CrewAI**（~60k★） | 角色协作多智能体 | MIT | 业务侧快速编排 |
| AutoGen（~61k★） | 多智能体对话 | MIT | ⚠️ 维护模式，新项目用 MAF |
| AgentScope（~33k★） | 阿里多智能体框架 | Apache-2.0 | 国产模型适配参考 |
| **LiteLLM**（~61k★） | 100+ 模型统一网关 | MIT | **可直接 fork 做公司内部网关**（路由/重试/预算/计费） |
| **One-API**（~37k★） | 国内模型统一接入 | MIT | 可 fork；渠道管理参考 |
| new-api（~50k★） | One-API 增强分支 | **AGPL-3.0** | 自用可 fork；对外 SaaS 需开源改动 |
| **LibreChat 后端** | 多模型对话后端 | MIT | 对话产品后端底座 |

## 3. RAG / 记忆 / 向量库 / 知识库

| 项目 | 定位 | 许可证 | 用途建议 |
|---|---|---|---|
| **RAGFlow**（~92k★） | 深度文档理解 RAG 全流程 | Apache-2.0 | **企业知识库直接二次开发首选** |
| **FastGPT**（~30k★） | 知识库问答平台 | 开源许可+附加条件 | 自托管/交付可用，SaaS 需授权 |
| **LlamaIndex**（~40k★） | 检索/RAG 编排框架 | MIT | 作检索管线底层库 |
| **Haystack**（~20k★） | 生产级检索问答 pipeline | MIT | 自托管检索/问答服务 |
| **Qdrant**（~20k★） | Rust 向量库 | Apache-2.0 | 直接部署；混合检索+重排原生 |
| **Milvus**（~30k★） | 分布式向量库 | Apache-2.0 | 大数据量 |
| **pgvector**（~10k★） | PG 扩展 | PostgreSQL License | 已有 Postgres 团队最省事 |
| **Chroma**（~20k★） | 嵌入式向量库 | Apache-2.0 | 原型快 |
| **Mem0**（~40k★） | 通用记忆层 | Apache-2.0 | 直接集成做 Agent 记忆 |
| **Graphiti**（getzep，~10k★） | 时序知识图谱记忆 | Apache-2.0 | Zep CE 已停，官方迁移方向 |
| **LangMem** | LangChain 记忆 SDK | MIT | LangGraph 栈用 |
| **docling**（IBM，~30k★） | PDF/Word/PPT→Markdown | MIT | 直接嵌入文档解析 |
| **Unstructured**（~10k★） | 多格式文档解析 | Apache-2.0 | 直接嵌入 |
| marker（~20k★） | PDF→Markdown 高质量 | GPL-3.0 | 商用注意 GPL |
| MaxKB（飞致云，~10k★） | 中文知识库问答 | GPL-3.0 | 中文部署简单，注意 GPL |
| ⚠️ Zep CE | 记忆层 | 已停止维护 | 用 Graphiti 替代 |

## 4. 可观测性 / 评估 / 安全 / 沙箱

| 项目 | 定位 | 许可证 | 用途建议 |
|---|---|---|---|
| **Langfuse**（~32k★） | LLM 可观测+评估+Prompt 管理 | MIT（被 ClickHouse 收购，保持开源） | **docker compose 自托管主选** |
| **promptfoo**（~17k★） | CLI-first 评测/红队 | MIT（被 OpenAI 收购，保持开源） | CI 评测事实标准，可自托管 |
| **Arize Phoenix**（~12k★） | 开源 AI 可观测+评估 | ELv2 | 可自托管（注意 ELv2 再分发限制） |
| **DeepEval**（~17k★） | Python 评测框架 | Apache-2.0 | 离线/回归评测库 |
| **Ragas**（~15k★） | RAG 评估指标库 | Apache-2.0 | RAG 专项评测 |
| **Guardrails AI**（~6.6k★） | 输入输出护栏框架 | Apache-2.0（被 Harvey 收购） | 库形式嵌入应用 |
| **garak**（NVIDIA，~8k★） | 自动化红队扫描 | Apache-2.0 | 上线前红队 |
| **PyRIT**（Microsoft，~4k★） | 红队工具 | MIT | 上线前红队 |
| **E2B**（~13k★） | AI 代码沙箱 | Apache-2.0 | 直接接入代码解释器 |
| **Daytona**（~72k★） | API-first 沙箱 | Apache-2.0 | 直接部署/二次开发 |
| **Firecracker**（~37k★） | microVM 运行时 | Apache-2.0 | 沙箱底层参考 |
| **gVisor**（~20k★） | 容器安全沙箱 | Apache-2.0 | 已捐 CNCF，容器沙箱运行时 |
| Helicone（~6k★） | LLM 观测代理 | Apache-2.0 | ⚠️ 被收购后维护模式，短期可用 |
| ⚠️ LLM Guard / rebuff / NeMo Guardrails | 护栏 | — | **已归档/EOL，只可参考** |

## 5. MCP 生态 / 桌面客户端 / 浏览器 Agent

| 项目 | 定位 | 许可证 | 用途建议 |
|---|---|---|---|
| **@modelcontextprotocol/typescript-sdk**（~13.5k★） | MCP 客户端/服务器官方 SDK | Apache-2.0 | **自研 MCP 能力首选** |
| **Playwright MCP**（~36k★） | 浏览器自动化 MCP 服务器 | Apache-2.0 | 直接给 Agent 浏览器能力 |
| **GitHub MCP**（~33k★） | GitHub 官方 MCP 服务器 | MIT | 直接接代码/PR/Issue |
| **crystaldba/postgres-mcp**（~3.4k★） | Postgres MCP | 开源 | 数据库工具（官方 Postgres 已归档） |
| **awesome-mcp-servers**（~96k★） | MCP 服务器精选清单 | — | 选型目录 |
| **Browser Use**（~106k★） | 浏览器 Agent 框架 | MIT | 作为库直接嵌入 |
| **Skyvern**（~23k★） | 浏览器自动化平台 | AGPL-3.0 | 自托管或参考工作流 |
| **electron-vite-react**（~5k★） | Electron 桌面模板 | MIT | 自研桌面客户端外壳 |
| **Cherry Studio**（~53k★） | 桌面 AI 客户端 | AGPL-3.0 | 产品级原型；改代码须开源 |
| Claude Desktop | 官方桌面客户端 | 闭源 | 参照物（MCP 配置模板） |

## 6. 二次开发拼装示例（一周 MVP）

### 场景 A：企业知识库问答产品
`RAGFlow`（fork，改品牌）→ 前端接 RAGFlow API → 加 `Langfuse` 观测 → `promptfoo` 评测。
全 Apache-2.0/MIT，无许可证包袱。

### 场景 B：类 ChatGPT 多用户产品
`LibreChat`（fork，MIT）→ 接 `LiteLLM` 网关（多模型/计费）→ 加 MCP（Playwright/GitHub）→ 部署 `Langfuse`。

### 场景 C：自研桌面 Agent 客户端
`electron-vite-react`（外壳）→ `@modelcontextprotocol/typescript-sdk`（MCP 客户端）→ 接 Playwright MCP + GitHub MCP + Filesystem MCP → 自研 Agent 逻辑。全部 MIT/Apache-2.0。

### 场景 D：给现有产品加"可观测+评估+护栏"
`docker compose` 起 `Langfuse` + `promptfoo`，嵌入 `Guardrails AI`，红队用 `garak`；基线对照 `OWASP LLM Top 10`。

## 7. 许可证红绿灯速查

| 绿灯（可闭源商用、可改品牌） | 黄灯（可用但要读条款） | 红灯（传染/限制，慎重） |
|---|---|---|
| LibreChat、NextChat、Vercel AI Chatbot、RAGFlow、LangGraph、OpenAI Agents SDK、LiteLLM、One-API、Qdrant、Milvus、Mem0、Langfuse、promptfoo、Guardrails AI、E2B、Daytona、Browser Use、Playwright MCP、electron-vite、docling、Unstructured | Dify、FastGPT、Open WebUI、LobeChat、n8n、Arize Phoenix | Cherry Studio（AGPL）、Chatbox（GPL）、new-api（AGPL）、Skyvern（AGPL）、marker（GPL）、MaxKB（GPL） |

## 8. 避坑清单（已停更/已归档）

- ❌ chatbot-ui（2024 停更）
- ❌ Zep CE（已停，用 Graphiti）
- ❌ LLM Guard（2026-07 归档）、rebuff（2025-05 归档）、NeMo Guardrails（2025-10 EOL）
- ❌ Helicone 作为长期主平台（被收购后维护模式）
- ❌ AutoGen 旧包（维护模式，用 Microsoft Agent Framework）
- ❌ OpenAI Swarm / Assistants API（官方已弃用）
- ⚠️ modelcontextprotocol/servers 中的 PostgreSQL/Puppeteer/Slack 等已移到 servers-archived，不再维护

---
*详细来源：docs/research/benchmark-fullstack.md、benchmark-backend.md、benchmark-rag-memory.md、benchmark-obs-security.md、benchmark-mcp-desktop.md。*