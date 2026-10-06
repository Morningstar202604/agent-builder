---
name: agent-builder
description: "Build a production-grade AI Agent product (web + Electron desktop). Full-stack: monorepo scaffolding, Agent ReAct loop, SSE streaming, Next.js frontend, Electron shell, context window, MCP tools, Skills system, memory with vector search, multi-agent orchestration, RAG, HITL, self-reflection, prompt protocol, function calling abstraction, prompt injection defense, OpenTelemetry, CI/CD, Docker Compose deploy. Trigger when: user wants to build/scaffold/architect an AI Agent; create a chat agent with tool calling; add MCP tools or Skills; add memory or RAG; design prompt template or system prompt versioning; unify function calling across providers; deploy to production; harden agent security; set up eval/observability; or wrap web agent in Electron. Even if user just says 'build me an agent' or 'Claude-like app' — use this skill."
---

# Agent Builder

A router for building a complete AI Agent product. **Do not implement directly from SKILL.md** — read the appropriate reference file for the layer the user needs.

## ⚠️ 最高优先级原则：不重复造轮子 / #1 Rule: Don't Reinvent the Wheel

> AI 最爱犯的错：看到一个需求就开始手搓。**请抑制这个冲动。** 本 Skill 覆盖的每一层，业界几乎都有成熟方案。Agent 的工作是**选方案、接方案**，不是重造方案。

**下面是各层"可以直接用"的清单，每层优先用这些，不要自己写：**

| 需求 | 直接用 | 不要再写 |
|------|--------|----------|
| MCP 工具互联 | `@modelcontextprotocol/sdk` | JSON-RPC 帧解析、连接管理 |
| Agent 编排/状态机 | LangGraph / LangChain Agents | 任务分发、状态快照、循环检测 |
| 流式调用+工具调用 | Vercel AI SDK (`ai` + `ai/react`) | SSE 拼接、工具调用帧解析 |
| Guardrails / 输入校验 | OpenAI Agents SDK Guardrails | 手写正则过滤、敏感词黑名单 |
| Function Calling 适配 | LiteLLM / OpenAI SDK | Provider 格式转换、参数映射 |
| RAG / 文档处理 | LlamaIndex / Haystack | 分块、Embedding 编排、索引更新 |
| 向量数据库客户端 | Qdrant/Milvus/Chroma 官方 SDK | 连接池、查询封装 |
| 可观测性 | Langfuse / OpenTelemetry SDK | Span 创建、Token 统计、Trace 导出 |
| 结构化输出验证 | Zod / TypeBox | 手写 JSON Schema 校验 |
| 多租户 RBAS | CASL / AccessControl | 权限模型手写 |
| 沙箱/代码执行 | E2B / Daytona / Modal | Docker 沙箱手写 |
| 多模型路由 | LiteLLM Proxy | Provider 切换、Fallback 逻辑 |
| CI/CD | GitHub Actions / GitLab CI 标准模板 | pipeline 手写 |

**仅在以下情况才自己写代码：**
- 本 Skill 的 references/ 明确给出的参考实现（包含完整工程考量）
- 业务特有的差异化逻辑（产品独特卖点相关）
- 各层之间的胶水层（用成熟库，只写集成代码）

首次加载任一 reference 前，**先检查上面的清单**：这一层是否已有成熟方案可以接入？如果有，直接接，不要重新发明。

## 🧭 你的路径选择：自建 vs 复用开源项目

> 你有两条路。不要一上来就默认"从头写"。

### 路径 A：直接使用开源项目（推荐先评估）

下面按"可以直接部署使用的完整产品"和"可以集成的框架库"分类。先看看有没有现成的能满足需求；如果满足，**直接用，不要重造**。

#### A1. 可以直接部署的完整产品 / Full-Stack Deployable Products

| 项目 | 定位 | 适合 | 不适合 | 许可证 |
|------|------|------|--------|--------|
| **[Dify](https://github.com/langgenius/dify)** | 低代码 AI Agent 工厂：可视化 Workflow + RAG + 多模型路由 + 插件生态 | 快速搭建企业 AI 应用、客服、数据分析 | 高度定制的前端交互、独特品牌体验 | Apache-2.0 |
| **[Open WebUI](https://github.com/open-webui/open-webui)** | 类 ChatGPT 自托管前端：多模型管理 + RAG + RBAC | 内部 AI 助手、私有化对话终端 | 复杂工作流编排、多 Agent 场景 | MIT |
| **[FastGPT](https://github.com/labring/FastGPT)** | 知识库问答专家：高精度文档检索 + 可视化流程 | 医疗/法律/军工等垂直领域知识库 | 通用多 Agent、前端深度定制 | Apache-2.0 |
| **[RAGFlow](https://github.com/infiniflow/ragflow)** | 复杂文档解析 + 多引擎 RAG（OCR+表格识别+语义重排） | 大量 PDF/PPT/表格的智能问答 | 实时多模态、流式交互 | Apache-2.0 |
| **[n8n](https://github.com/n8n-io/n8n)** | 工作流自动化引擎（含 AI Agent 节点） | 流程编排、系统集成（CRM/DB/API） | 做产品前端交互、C 端用户界面 | Fair-code |
| **[Coze/扣子](https://www.coze.cn)** | 字节跳动低代码 Agent 平台 | 快速搭建聊天机器人、C 端轻量应用 | 私有化部署（仅 SaaS）、开源定制 | 闭源 SaaS |
| **[DeerFlow](https://github.com/bytedance/deer-flow)** | 字节开源：深度研究 + 多 Agent 报告生成 | 自动研究报告、内容创作 | 通用对话、实时交互 | MIT |

**对比总结：**

| 需求场景 | 选哪个 |
|----------|--------|
| 5 分钟内上线一个能用的 Agent | Dify 或 Coze |
| 只换皮 ChatGPT（私有部署） | Open WebUI |
| 企业知识库（PDF 大文档） | RAGFlow + FastGPT |
| 自动化流程（非聊天） | n8n |
| 做深度研究报告 | DeerFlow |

#### A2. 可以集成到项目的框架与库 / Frameworks & Libraries

##### 多 Agent 编排 / Orchestration

| 框架 | 适合场景 | 学习成本 | 灵活性 |
|------|---------|----------|--------|
| **LangGraph** | 复杂状态机、任务循环、检查点恢复 | 中 | ⭐⭐⭐⭐⭐ |
| **CrewAI** | 多角色协作、科研/内容生产 | 低 | ⭐⭐⭐ |
| **AutoGen** (Microsoft) | 多 Agent 对话、编程协作 | 中 | ⭐⭐⭐⭐ |
| **MetaGPT** | 软件开发全流程（模拟团队） | 中 | ⭐⭐⭐ |
| **CAMEL** | 角色扮演 Agent 对话研究 | 低 | ⭐⭐ |
| **Google ADK** | Google 生态 Agent 开发 | 中 | ⭐⭐⭐⭐ |

##### 前端 / Frontend

| 项目 | 用途 |
|------|------|
| **[Vercel AI Chatbot](https://github.com/vercel/ai-chatbot)** | Next.js + Vercel AI SDK + 流式 UI（直接 fork 用） |
| **[LibreChat](https://github.com/danny-avocado/librechat)** | 多模型、多用户、合规的开源 ChatGPT 替代品 |
| **[chatbot-ui](https://github.com/mckaywrigley/chatbot-ui)** | Vercel AI 的前身，简洁轻量 |
| **Open WebUI 前端** | 自托管 ChatGPT 皮（React + Svelte） |

##### 后端 / Backend

| 项目 | 用途 |
|------|------|
| **[LiteLLM](https://github.com/BerriAI/litellm)** | 统一 100+ LLM Provider 接口 + 代理 + 限流 |
| **[Ollama](https://github.com/ollama/ollama)** | 本地模型一键运行（GPU/CPU） |
| **[vLLM](https://github.com/vllm-project/vllm)** | 高吞吐 LLM 推理引擎（生产级） |
| **[Open WebUI Backend](https://github.com/open-webui/open-webui)** | Python FastAPI + WebSocket 多用户后端 |

##### 向量检索 & RAG

| 项目 | 特点 |
|------|------|
| **[LlamaIndex](https://github.com/run-llama/llama_index)** | 最全面的 RAG 框架（数据摄入→索引→检索→Agent） |
| **[Haystack](https://github.com/deepset-ai/haystack)** | 模块化 NLP 管道（德国 deepset） |
| **[RAGFlow](https://github.com/infiniflow/ragflow)** | 复杂文档解析见长（OCR、表格结构识别） |
| **[Qdrant](https://github.com/qdrant/qdrant)** | Rust 向量数据库（高性能、支持过滤） |
| **[Milvus](https://github.com/milvus-io/milvus)** | 分布式向量数据库（Zilliz，十亿级） |
| **[Chroma](https://github.com/chroma-core/chroma)** | 嵌入式向量库（极简 API） |

##### MCP 生态 / MCP Ecosystem

| 项目 | 用途 |
|------|------|
| **`@modelcontextprotocol/sdk`** | MCP 官方 TypeScript SDK（必须用） |
| **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** | 浏览器自动化 MCP Server |
| **[Filesytem MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)** | 文件系统操作 |
| **[GitHub MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/github)** | GitHub 操作 |
| **[Slack MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/slack)** | Slack 集成 |
| **[Google Drive MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive)** | Google Drive |

##### 沙箱 & 安全

| 项目 | 特点 |
|------|------|
| **[E2B](https://github.com/e2b-dev/e2b)** | 云原生 Agent 沙箱（OpenAPI + SDK） |
| **[Daytona](https://github.com/daytonaio/daytona)** | 开发环境沙箱（对标 GitHub Codespaces） |
| **[Modal](https://github.com/modal-labs/modal)** | Serverless GPU 沙箱（Python 原生） |
| **[Casbin](https://github.com/casbin/casbin)** | 多模型权限引擎（RBAC/ABAC） |

##### 可观测性 & Eval

| 项目 | 特点 |
|------|------|
| **[Langfuse](https://github.com/langfuse/langfuse)** | 开源 LLM 可观测平台（Trace/Eval/Prompt 管理） |
| **[Helicone](https://github.com/Helicone/helicone)** | LLM 网关 + 可观测性（一行代码接入） |
| **[Phoenix (Arize)](https://github.com/Arize-AI/phoenix)** | LLM 离线评估 + 可观测 |
| **[PromptFoo](https://github.com/promptfoo/promptfoo)** | LLM 测试/评估/红队 |

### 路径 B：用本 Skill 从头搭建（当你需要完全控制时）

选择路径 A 中的开源项目无法满足以下需求时，才走我们的 reference 搭建：

1. **独特的品牌体验** — UI 交互完全定制
2. **独特的 Agent 行为** — 特殊的编排逻辑、自研算法
3. **深度 Electron 集成** — 桌面端原生能力（系统托盘、全局快捷键、跨进程）
4. **离线优先** — 不依赖任何外部云服务的全自托管
5. **学习目的** — 你真的想理解每一层的运作机制

#### 路径 A + B 的混合策略 / Hybrid

最常见也最推荐的路径：**用开源产品做基础 + 用本 Skill 做深度定制**。

| 组合 | 效果 |
|------|------|
| Dify（后端+Workflow） + 本 Skill 参考自建前端 | 省 80% 后端工时，自定义品牌 UI |
| Open WebUI（前端） + 本 Skill 参考自建 Agent 核心 | 用成熟前端体验，用自定义 Agent 逻辑 |
| LangGraph（编排） + LlamaIndex（RAG） + 本 Skill 参考做前端+Electron | 核心层全用开源，产品层自建 |
| n8n（流程） + 自建 Agent 节点 | 自动编排为主，智能决策自建 |

### Agent 决策流程

评估用户需求时，按以下顺序判断：

```
Stack0: 有没有现成开源产品直接能部署用？
  → YES: 列出2-3个候选 + 对比 → 用现成方案
  → NO: Stack1

Stack1: 有没有开源框架能覆盖70%+需求？
  → YES: 列出框架 + 空缺部分用本Skill补充 → 混合方案
  → NO: Stack2

Stack2: 业务高度定制化，需要完全控制。
  → 使用本Skill的 references/ 从头搭建
```

**无论走哪条路，references/ 里的工程经验（AI避坑、边缘场景处理、性能优化）都是通用的。**

## 🔗 连接与集成模式 / Integration Patterns

> 你选了开源项目 X 不等于工作结束。"X 怎么接入 Y"才是我们 references/ 的核心价值。

每种组合，我们都有对应的节点详细指导如何连接——**不要让用户自己去摸索怎么把 Dify 接进自己的前端，或者在 LangGraph 中加 MCP 工具。我们直接给答案。**

| 你要做什么 | 组合 | 用哪个节点 |
|-----------|------|-----------|
| Dify 后端 + 自建前端 | Dify API → WebSocket → React 消费 | 参考 01（SSE）、17（流式优化） |
| LangGraph + MCP 工具 | LangGraph AgentNode → MCP Client → 工具调用 | 参考 02（MCP Client）、05（多 Agent 编排） |
| LlamaIndex（RAG）+ 任何框架 | LlamaIndex QueryEngine → LangChain/Dify/自研 | 参考 03（记忆/RAG）、12（向量库实战） |
| LiteLLM 路由 + 多 Provider | LiteLLM Proxy → OpenAI 兼容接口 → 自研 Agent | 参考 11（Function Calling）、24（多模型路由） |
| Open WebUI 自建后端 | Open WebUI(前端) → 自研 AgentCore(后端) | 参考 01（后端基础）、17（流式高级） |
| E2B 沙箱 + 自建 Agent | Agent → E2B SDK → 隔离代码执行 | 参考 04（沙箱安全） |
| n8n + 自建 Agent 节点 | n8n MCP 节点 ↔ 自研 Agent | 参考 02（MCP Server Dev） |
| Langfuse 接入任何项目 | Langfuse SDK callback → 任意 Agent 框架 | 参考 22（Guardrails + Tracing） |
| Playwright MCP + Agent | Agent → MCP Client → Playwright MCP Server → 浏览器 | 参考 23（Computer Use） |

**原则：开源产品解决"标准能力"，我们的节点解决"连接与定制"。**

## ⛔ 强制技术栈令 / LATEST-ONLY Tech Mandate

> ⛔ **禁止使用以下过时技术——AI 最爱犯这个错：**

| ❌ 禁止 | ✅ 必须用 | 为什么 |
|---------|----------|--------|
| 原生 HTML + jQuery / 原生 DOM 操作 | **Next.js 15+ / React 19+** | SSR、Server Components、流式渲染 |
| CSS 手写 / CSS 文件散落 | **Tailwind CSS + shadcn/ui** | 原子化、组件库、无障碍、暗色模式 |
| Express.js 裸写路由 | **Fastify / Hono / Next.js API Routes** | 更快速、原生 TypeScript、schema 校验 |
| Vue 2 / Options API | **Vue 3 Composition API / Nuxt 3** 或直接用 React 阵营 | Vue 2 已 EOL，生态已全面迁移 |
| Webpack / CRA / Gulp | **Turborepo + Vite / Next.js SWC** | 构建速度快 10-100 倍 |
| 手动 fetch 调用 LLM | **Vercel AI SDK / 官方 SDK** | 流式、工具调用、多 Provider 已在 SDK 里 |
| 手写 REST CRUD（除业务逻辑） | **tRPC / Prisma / Drizzle ORM** | 端到端类型安全、迁移自动化 |
| Cookie Session 手写 | **NextAuth.js v5 / Lucia** | OAuth 内置、无安全风险、多 Provider |
| 手动 Docker 配置 | **Docker Compose + 框架自带容器** | 声明式、可复现、CI 直接消费 |
| CommonJS / require() | **ESM / package.json `"type": "module"`** | 现代标准、tree-shaking、动态 import |
| 手写 CLI 参数解析 | **Commander / Citty / Pastel** | --help 自动生成、校验、子命令 |
| 手写日志 | **Pino / Langfuse OpenTelemetry** | 结构化、异步、高性能 |
| 手写限流/缓存 | **Upstash Redis + @upstash/ratelimit** | 全球边缘、原子 Lua、零运维 |
| 手动字符串拼接 SQL | **Drizzle ORM / Prisma** | SQL 注入防护、类型推断、迁移系统 |

**如果用户在对话中提出用旧技术（"用 HTML 写个前端吧"、"用 Express 就够了"），Agent 必须：**
1. 告诉用户"这个技术已过时，现代替代方案是 X"
2. 如果用户坚持——Agent 可以执行，但必须在回复中明确标注 `@deprecation-warning` 并记录原因
3. 如果用户没指定技术栈——**默认为上表 ✅ 列，不询问**

 Use the decision tree below to determine which reference(s) to load:

```
User wants to build from scratch / create new agent project?
├── YES → Load references/01-foundation.md FIRST
│   ├── Then load layer based on what they need next:
│   ├── "tools" / "MCP" → references/02-tools-skills.md
│   ├── "memory" / "RAG" / "long-term" → references/03-memory-rag.md
│   ├── "code execution" / "sandbox" → references/04-sandbox.md
│   ├── "multiple agents" / "multi-agent" → references/05-multi-agent.md
│   ├── "human approval" / "HITL" → references/06-hitl-reflection.md
│   ├── "reflection" / "self-improve" → references/06-hitl-reflection.md
│   ├── "security" / "safety" → references/07-security.md
│   ├── "evaluate" / "benchmark" → references/08-eval-observability.md
│   ├── "monitor" / "logs" → references/08-eval-observability.md
│   └── "deploy" / "docker" / "production" → references/09-deploy.md
│   ├── Then load advanced modules:
│   ├── "prompt" / "system prompt" / "template" → references/10-prompt-protocol.md
│   ├── "function calling" / "tool call" / "multi-provider" → references/11-function-calling.md
│   ├── "vector db" / "Qdrant" / "Milvus" / "rerank" / "embedding" → references/12-vector-db-practical.md
│   ├── "structured output" / "JSON mode" / "Zod" / "schema" → references/13-structured-output.md
│   ├── "MCP server" / "build MCP" / "develop tool server" → references/14-mcp-server-dev.md
│   ├── "knowledge base" / "document management" / "multi-format RAG" → references/15-knowledge-base.md
│   ├── "multimodal" / "image" / "voice" / "TTS" / "STT" / "screen capture" → references/16-multimodal-agent.md
│   ├── "streaming performance" / "SSE optimization" / "latency" / "reconnect" → references/17-streaming-advanced.md
│   ├── "framework" / "LangGraph" / "CrewAI" / "AutoGen" / "integrate" → references/18-framework-comparison.md
│   ├── "multi-tenant" / "enterprise" / "organization" / "tenant" / "multi-user" → references/19-multi-tenancy.md
│   ├── "marketplace" / "skill store" / "agent store" / "publish" / "monetize" → references/20-agent-marketplace.md
│   ├── "fault" / "recovery" / "checkpoint" / "failover" / "retry" / "graceful" / "disconnect" → references/21-fault-recovery.md
│   ├── "guardrail" / "safety check" / "input validation" / "tripwire" → references/22-guardrails-tracing.md
│   ├── "tracing" / "observability" / "Langfuse" / "OpenTelemetry" / "debug agent" / "why agent slow" → references/22-guardrails-tracing.md
│   ├── "artifact" / "render" / "visual output" / "code widget" / "rich document" → references/23-artifacts-computer-use.md
│   ├── "computer use" / "browser" / "screenshot" / "click" / "UI automation" → references/23-artifacts-computer-use.md
│   ├── "CLI" / "headless" / "CI/CD automation" / "non-interactive" / "scheduled" → references/23-artifacts-computer-use.md
│   └── "playground" / "model routing" / "rate limit" / "cost control" / "multi-model" / "webhook" → references/24-product-layer.md
│
├── Adding to existing agent project?
│   Which layer?
│   ├── L1 context/tools → references/02-tools-skills.md
│   ├── L1 memory/RAG → references/03-memory-rag.md
│   ├── L1 sandbox → references/04-sandbox.md
│   ├── L2 multi-agent → references/05-multi-agent.md
│   ├── L2 HITL/reflection → references/06-hitl-reflection.md
│   ├── L3 security → references/07-security.md
│   ├── L3 eval/observability → references/08-eval-observability.md
│   ├── L3 deploy → references/09-deploy.md
│   ├── L4 vector db / embedding / rerank → references/12-vector-db-practical.md
│   ├── L4 structured output / JSON mode → references/13-structured-output.md
│   ├── L4 MCP server development → references/14-mcp-server-dev.md
│   ├── L4 knowledge base → references/15-knowledge-base.md
│   ├── L4 multimodal → references/16-multimodal-agent.md
│   ├── L4 streaming advanced → references/17-streaming-advanced.md
│   ├── L4 framework integration → references/18-framework-comparison.md
│   ├── L4 multi-tenancy / enterprise → references/19-multi-tenancy.md
│   ├── L4 agent marketplace → references/20-agent-marketplace.md
│   ├── L4 fault tolerance / recovery → references/21-fault-recovery.md
│   ├── L5 guardrails / safety validation → references/22-guardrails-tracing.md
│   ├── L5 observability / tracing / monitoring → references/22-guardrails-tracing.md
│   ├── L5 rich output / artifacts / browser → references/23-artifacts-computer-use.md
│   └── L5 product platform / playground / routing → references/24-product-layer.md
│
└── Agent is broken / misbehaving?
    ├── Token usage too high → references/02-tools-skills.md (context section)
    ├── Hallucinating / losing context → references/03-memory-rag.md
    ├── Tool calls failing → references/02-tools-skills.md
    ├── Running too slowly → references/17-streaming-advanced.md
    ├── Streaming breaks / stuttering → references/17-streaming-advanced.md
    ├── RAG returning bad results → references/15-knowledge-base.md
    ├── Image/voice not working → references/16-multimodal-agent.md
    ├── Disconnected mid-conversation → references/21-fault-recovery.md
    ├── Security concern → references/07-security.md
    ├── Agent produces bad/unexpected output and no one knows why → references/22-guardrails-tracing.md
    ├── Agent ignores safety rules / bypasses restrictions → references/22-guardrails-tracing.md
    ├── Output not rendering properly (tables, charts) → references/23-artifacts-computer-use.md
    ├── Agent can't interact with browser / desktop UI → references/23-artifacts-computer-use.md
    ├── Surprise cost spike / rate limit failures → references/24-product-layer.md
    ├── CI/CD agent job hangs or times out → references/23-artifacts-computer-use.md
    ├── Webhook not firing / not idempotent → references/24-product-layer.md
```

## Progressive Loading Protocol

1. **Assess** — determine which layer(s) the user needs (see tree above)
2. **Load ONE** — read only the first reference the user needs
3. **Implement** — deliver code + explanation from that reference
4. **Chain** — if the user asks for more, load the next reference in sequence
5. **Never pre-load all references** — each is 500-900 lines; loading all wastes context

## Execution Order

If building from scratch, follow this strict order (each layer depends on the previous):

| Order | Reference | What you get |
|-------|-----------|-------------|
| 1 | `01-foundation.md` | Monorepo, Agent core, SSE API, Next.js UI, Electron shell |
| 2 | `02-tools-skills.md` | Token budget, Tool Registry + MCP, Skills system |
| 3 | `03-memory-rag.md` | 3-layer memory, vector search, RAG pipeline |
| 4 | `04-sandbox.md` | Docker sandbox, secure code execution |
| 5 | `05-multi-agent.md` | Supervisor+Worker orchestration, LangGraph patterns |
| 6 | `06-hitl-reflection.md` | Human approval workflows, self-reflection loop |
| 7 | `07-security.md` | Prompt injection defense, risk classification |
| 8 | `08-eval-observability.md` | Eval framework, OpenTelemetry, dashboards |
| 9 | `09-deploy.md` | Docker Compose, CI/CD, Electron signing |
| 10 | `10-prompt-protocol.md` | 5-layer prompt architecture, template engine, versioning, injection defense |
| 11 | `11-function-calling.md` | Multi-provider adapter, retry engine, parallel dispatch, audit logger |
| 12 | `12-vector-db-practical.md` | Vector DB selection, Qdrant/Milvus SDK, Embedding abstraction + cache, Rerank, indexing strategy |
| 13 | `13-structured-output.md` | Zod-first structured output, JSON Mode per provider, loose parser, error injection retry |
| 14 | `14-mcp-server-dev.md` | MCP Server dev: Stdio+SSE transports, Resources, Prompts, auth, debug panel |
| 15 | `15-knowledge-base.md` | Multi-format parsers, Parser Registry, Delta Indexing, versioned RAG, quality evaluation, citation tracking |
| 16 | `16-multimodal-agent.md` | Modality Router, image pipeline, TTS/STT providers, screen recording, image generation, media frontend |
| 17 | `17-streaming-advanced.md` | TTFT/TPOT/E2E tuning, sub-token streaming, smart reconnect, health check, bandwidth optimization, client rendering throttle |
| 18 | `18-framework-comparison.md` | LangGraph/CrewAI/AutoGen/CAMEL/MetaGPT comparison, integration bridges, hybrid orchestration |
| 19 | `19-multi-tenancy.md` | Multi-tenant modes (RLS/DB-per-tenant), Tenant Context, quota/rate-limit, RBAC, audit, billing |
| 20 | `20-agent-marketplace.md` | Marketplace ontology, publishing API, security scan, review/rating, revenue sharing, licensing |
| 21 | `21-fault-recovery.md` | State snapshots (Redis/Postgres), SSE reconnection, idempotent tools, model fallback, timeout/retry |
| 22 | `22-guardrails-tracing.md` | Input/Output/Tool Guardrails, tripwire halt, Runner hooks, Session persistence, OpenTelemetry spans, cost tracking, Langfuse integration |
| 23 | `23-artifacts-computer-use.md` | Artifact Registry + Renderer, Computer Tool (screenshot/click/type), CLI/Headless mode, Ask User Question, CLAUDE.md/Auto Memory, Skills & Hooks |
| 24 | `24-product-layer.md` | Playground UI, Multi-model routing (LiteLLM pattern), rate limiting (token bucket), quota/budget, webhook events, CI/CD integration, Agent-as-a-Service API |

## Cross-Reference Map

When implementing a later layer, you may need to reference concepts from earlier layers:

| Later layer | Depends on |
|-------------|-----------|
| 02 Tools | 01's AbstractAgent and AgentTool types |
| 03 Memory | 01's SSE events + 02's context budget |
| 04 Sandbox | 02's ToolRegistry for execute_code tool |
| 05 Multi-Agent | 02's Tool system + 03's Memory |
| 06 HITL/Reflection | 02's tool call lifecycle |
| 07 Security | 01's SSE layer + 02's tool sandbox |
| 08 Eval | 01's AgentEvent types |
| 09 Deploy | All above as compose services |
| 10 Prompt Protocol | 01's AgentConfig.systemPrompt + 07's security patterns |
| 11 Function Calling | 02's ToolRegistry + 01's AbstractAgent ReAct loop |
| 12 Vector DB | 03's HybridRetriever and EmbeddingService abstractions |
| 13 Structured Output | 02's tool call lifecycle + 11's function calling adapter |
| 14 MCP Server Dev | 02's MCP Client + 12's vector store + 13's structured output for tool schemas |
| 15 Knowledge Base | 03's RAGRetriever + 12's VectorStore + 13's structured output for citations |
| 16 Multimodal | 01's LLM abstraction + 13's structured output for multimodal schemas |
| 17 Streaming Advanced | 01's SSE implementation + Nginx config |
| 18 Framework Comparison | 05's multi-agent patterns, 01's AbstractAgent as integration anchor |
| 19 Multi-Tenancy | 01's SSE middleware, 02's tool isolation, 03's memory isolation |
| 20 Agent Marketplace | 02's ToolRegistry, 18's framework adapter pattern, 19's RBAC |
| 21 Fault Recovery | 01's SSE event protocol, 18's LangGraph checkpoint, 03's MemoryManager archival |
| 22 Guardrails/Tracing | 01's Runner lifecycle, 02's ToolRegistry hooks, 06's HITL interruption, 08's Eval metrics |
| 23 Artifacts/ComputerUse | 01's SSE stream, 02's Tool system, 13's Structured Output, 16's Multimodal screen capture |
| 24 Product Layer | 01's Agent abstraction, 08's Observability, 11's multi-provider, 19's multi-tenancy |

## Notes for the Agent Using This Skill

- **Every reference contains**: working TypeScript code, engineering rationale (why this approach), AI-pitfall annotations (what LLMs get wrong), and a verification checklist
- **Never invent APIs** documented in references — use the exact function names and types given
- **Every code block is self-contained** within its reference, building on imports described at the top
- **Front-end**: All backend references include a Frontend Integration section showing the corresponding React/UI code
- **When in doubt about order**, follow the Execution Order table — layers are cumulative

## Domain organization: monorepo layout

All code in references assumes this workspace:

```
agent-core/
├── apps/
│   ├── web/                    # Next.js
│   └── electron/               # Electron wrapper
├── packages/
│   ├── core/                   # Framework-independent agent engine
│   └── shared/                 # Shared types/constants
├── .env.example
├── turbo.json
├── pnpm-workspace.yaml
└── docker-compose.yml          # In references/09-deploy.md
```

If the user already has a project, map these paths to their structure and adapt imports.

## 不重复造轮子铁律（所有 references 通用）

1. **优先选用以下成熟生态**：
   - LLM SDK：OpenAI SDK (兼容 DeepSeek/Ollama) / Anthropic SDK / Google GenAI SDK
   - LLM 编排：LangGraph（复杂状态机）/ CrewAI（多 Agent 角色）/ AutoGen（对话式）
   - 向量DB：Qdrant / Milvus / Chroma（自用）/ Pinecone（SaaS）
   - 结构化校验：Zod / TypeBox / JSON Schema + Ajv
   - 可观测性：OpenTelemetry SDK + Jaeger / Grafana Tempo
   - 错误处理：`neverthrow` Result 类型或 `Pino` 结构化日志
   - 流式：原生 ReadableStream + SSE（不打包自己的流协议）

2. **标注 [CUSTOM] 接口** — 实现是自定的（AbstractAgent、MCP Client 包装等）
   - 所有 [CUSTOM] 接口应在 `packages/core/src/custom/` 下独立存放
   - 与第三方库的边界用 Adapter 模式封装

3. **禁止事项**（AI 经常在无意识中违反）：
   - ✗ 不用 RegExp 去 parse 结构化数据（用 Zod / JSON.parse + try catch）
   - ✗ 不用 setTimeout 做超时控制（用 AbortSignal.timeout 或 race with signal）
   - ✗ 不在 for await loop 里做 CPU 密集计算（用 Web Worker 或 setImmediate 让出）
   - ✗ 不在 tool call arguments 字段中保存 function 或 Symbol
   - ✗ 不在 system prompt 中直接嵌入用户输入（先 sanitize）

4. **错误传播链必须统一**：
   - tool.execute → throw ToolError → Agent.run yield { type: 'tool_error' } → SSE sendEvent('tool_error') → UI 显示
   - 每个环节用自定义 error 类（ToolError, MemoryError, EmbeddingError）而非裸 Error

## Agent 常见 AI 生成错误（Strict Mode）

agent 在完成 Skill 任务时，**默认启用以下自检模式**：

1. **循环检查**：生成代码前，先列出将使用的 libraries 列表，与上方的"成熟生态"对比——不在列表中的库需要标注理由
2. **型别保护**：所有 public function 必须有 return type 宣告，所有 params 必须有型别注解
3. **边界检查**：所有 array access 必须检查长度或 use optional chaining（`arr?.[0]`）
4. **错误码标准**：API 错误需要同时提供 machine-readable code（如 `TOOL_TIMEOUT`）和 human-readable message
5. **日志规范**：结构化 JSON 日志格式 `{ timestamp, level, trace_id, msg, context }` — 不写 `console.log('got data:', data)`

## 前端约束（Skills-UI Specific）

- 所有 state mutation 通过 Zustand action 操作——不直接改 state
- 所有 async 操作通过 `useChatStream` 类 hook 完成——不在 useEffect 内裸 fetch React state
- 长列表必须用 @tanstack/react-virtual 虚拟化
- SSE 必须用 callback ref 保存 disconnect 函数——不在 state 内存 function
- 代码块必须用 Shiki 渲染——不用 dangerouslySetInnerHTML

## 与企业主流方案的对标

本 Skill 的架构决策对标以下企业级实现：
- **Claude Desktop** → MCP 协议优先，工具调用规范化
- **ChatGPT Plugins** → Skills 渐进式披露 + 安全沙箱
- **LangSmith** → 分布式追踪 + Eval 框架
- **ChatGPT Enterprise** → 多租户隔离 + 审计日志 + 权限控制
- **Copilot Studio** → Composer-style 多 Agent 编排

每个 reference 的 AI 避坑点不得少于 3 条，且必须是**可被 AST / ESLint 规则自动检查的具体行为**，而不是"要注意安全"的泛泛描述。
