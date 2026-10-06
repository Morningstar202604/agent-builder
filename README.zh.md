# agent-builder

> 完整的、生产级 AI Agent 构建参考 — CatPaw Skill 格式

## 这是什么

一个帮助开发者和 AI Agent 从零构建企业级 AI Agent 的完整参考指南，以 **CatPaw Skill** 格式组织。覆盖从 monorepo 脚手架到 Playground UI 的全栈 Agent 开发链路，所有节点均经两轮以上交叉审计，含完整的生产级 TypeScript 代码和 AI 避坑注释。

## 对标标准

- **OpenAI Agents SDK** — Guardrails 三层校验 + Runner 架构 + Session 持久化 + Tracing 内建
- **Anthropic Claude** — Artifacts 协议 + Computer Use + Harness 架构 + CLAUDE.md/Auto Memory/Skills/Hooks
- **MCP (Model Context Protocol)** — 最新规范下的 Client + Server 双向开发
- **Langfuse / OpenTelemetry** — 全链路可追踪、可度量、可告警

## 结构

```
agent-builder/
├── SKILL.md              # 路由器 — 决策树 + 执行顺序表 + 交叉引用图 + 故障排查映射
├── references/            # 深度参考节点（按需加载，每个节点独立完整）
│   ├── 01-foundation.md          # Turborepo + AbstractAgent ReAct 循环 + SSE + Next.js + Electron
│   ├── 02-tools-skills.md        # Token 预算 + ToolRegistry + MCP Client + Skills 加载
│   ├── 03-memory-rag.md          # 三层记忆（短期/长期/情景）+ 混合检索
│   ├── 04-sandbox.md             # Docker 沙箱 + 网络白名单 + 资源限制 + 七层安全边界
│   ├── 05-multi-agent.md         # Supervisor+Worker + LangGraph 集成
│   ├── 06-hitl-reflection.md     # 四级 HITL + LLM-as-Judge 自反思 + 自动停止
│   ├── 07-security.md            # Prompt Injection 防御 + 工具风险分类 + 多层校验
│   ├── 08-eval-observability.md  # Eval 框架 + Langfuse 全链路追踪 + 回归测试
│   ├── 09-deploy.md              # Docker Compose + Electron签名公证 + K8s + 密钥管理
│   ├── 10-prompt-protocol.md     # 五层 Prompt 架构 + 版本管理 + A/B 实验
│   ├── 11-function-calling.md    # OpenAI/Anthropic/Gemini 三 Provider 适配 + 并行派发
│   ├── 12-vector-db-practical.md # Qdrant + Milvus + Chroma + 混合检索 + 重排
│   ├── 13-structured-output.md   # Zod Schema First + 容错 JSON 解析 + 错误注入重试
│   ├── 14-mcp-server-dev.md      # MCP Server 开发（Stdio + SSE 传输）
│   ├── 15-knowledge-base.md      # 多格式 RAG + 增量索引 + 引用追踪
│   ├── 16-multimodal-agent.md    # 多模态路由 + 图片理解 + TTS/STT
│   ├── 17-streaming-advanced.md  # SSE 优化 + 智能重连 + 带宽适配
│   ├── 18-framework-comparison.md # LangGraph/CrewAI/AutoGen/CAMEL 对比 + 混合编排
│   ├── 19-multi-tenancy.md       # 多租户（RLS/DB-per-tenant）+ RBAC + 审计日志
│   ├── 20-agent-marketplace.md   # Agent 市场 + 发布流程 + 安全扫描 + 收益分成
│   ├── 21-fault-recovery.md      # 状态快照（Redis/Postgres）+ 断线重连 + 幂等工具
│   ├── 22-guardrails-tracing.md  # **OpenAI Guardrails 三层 + Session + Tracing + 成本追踪**
│   ├── 23-artifacts-computer-use.md # **Artifacts 协议 + Computer Use + Headless CLI + Harness**
│   └── 24-product-layer.md       # **Playground + 多模型路由 + Webhook + CI/CD**
└── assets/
    ├── QUICK_START.md             # 快速上手指南
    └── PRE_LAUNCH_CHECKLIST.md    # 上线检查清单
```

## 使用方式

在 **CatPaw** 中直接说：

- "帮我搭一个 Agent"
- "怎么给 Agent 加多模态"
- "Agent 的安全怎么保障"
- "怎样让 Agent 自我反思"
- "Agent 输出如何渲染成 Artifact"

CatPaw 会自动加载本 Skill 并按需读取对应参考节点。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Next.js + React + Tailwind + shadcn/ui |
| 后端 | Node.js + Fastify + tRPC |
| LLM | OpenAI / Anthropic / Gemini（多 Provider 路由） |
| 向量库 | Qdrant / Milvus / Chroma（混合检索） |
| 桌面端 | Electron（contextIsolation + sandbox） |
| 沙箱 | Docker（cgroups + seccomp + cap-drop + read-only rootfs） |
| 部署 | Docker Compose + Kubernetes |
| 监控 | OpenTelemetry + Langfuse |

## 核心设计理念

- **不重复造轮子** — 复用成熟生态工具，优先选择社区主流方案
- **生产级而非 Demo** — 每个节点都经真实代码实现，非伪代码
- **渐进式强化** — 从基础到高级，每一层可选、可独立升级
- **AI 友好** — 每个节点标注 LLM 常犯的错误模式，防止 AI 走偏

## 许可

MIT License — 自由使用、修改、分发。
