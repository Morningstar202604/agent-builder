# agent-builder

> 完整的、生产级 AI Agent 构建参考 — CatPaw Skill 格式

## 这是什么

一个帮助开发者和 AI Agent 从零构建企业级 AI Agent 的完整参考指南，以 **CatPaw Skill** 格式组织。包含 24 个深度参考节点（共 40,000+ 行），覆盖从 monorepo 脚手架到 Playground UI 的全栈 Agent 开发链路。

## 对标标准

- **OpenAI Agents SDK** — Guardrails 三层校验 + Runner 架构 + Session 管理
- **Anthropic Claude** — Artifacts 协议 + Computer Use + Harness 架构
- **MCP (Model Context Protocol)** — 2026-07-28 最新规范
- **Langfuse / OpenTelemetry** — 全链路可观测性

## 结构

```
agent-builder/
├── SKILL.md              # 路由器（<500行）— 决策树 + 执行顺序表 + 交叉引用
├── references/            # 24 个深度参考节点（按需加载）
│   ├── 01-foundation.md          # Turborepo + AbstractAgent + SSE + Next.js + Electron
│   ├── 02-tools-skills.md        # Token budget + ToolRegistry + MCP Client + Skills
│   ├── 03-memory-rag.md          # 3层记忆 + HybridRetriever
│   ├── 04-sandbox.md             # Docker 沙箱 + 7 层安全边界
│   ├── 05-multi-agent.md         # Supervisor+Worker + LangGraph
│   ├── 06-hitl-reflection.md     # HITL 4级 + Self-Reflection
│   ├── 07-security.md            # Prompt Injection + 工具风险
│   ├── 08-eval-observability.md  # Eval 框架 + Langfuse 追踪
│   ├── 09-deploy.md              # Docker Compose + Electron 签名 + K8s
│   ├── 10-prompt-protocol.md     # 5层 Prompt 架构
│   ├── 11-function-calling.md    # 3 Provider 适配
│   ├── 12-vector-db-practical.md # Qdrant + Milvus + 混合检索
│   ├── 13-structured-output.md   # Zod Schema First + 容错 JSON 解析
│   ├── 14-mcp-server-dev.md      # MCP Server 开发
│   ├── 15-knowledge-base.md      # 多格式 RAG + Delta Indexing
│   ├── 16-multimodal-agent.md    # 多模态路由 + TTS/STT
│   ├── 17-streaming-advanced.md  # SSE 优化 + 重连
│   ├── 18-framework-comparison.md # LangGraph/CrewAI/AutoGen 对比
│   ├── 19-multi-tenancy.md       # 多租户 + RBAC
│   ├── 20-agent-marketplace.md   # Agent 市场 + 发布
│   ├── 21-fault-recovery.md      # 故障恢复 + 快照
│   ├── 22-guardrails-tracing.md  # OpenAI Guardrels + Tracing（新增）
│   ├── 23-artifacts-computer-use.md # Artifacts + Computer Use + Headless（新增）
│   └── 24-product-layer.md       # Playground + 多模型路由 + Webhook（新增）
└── assets/
    ├── QUICK_START.md             # 5步快速上手
    └── PRE_LAUNCH_CHECKLIST.md    # 75项上线检查清单
```

## 使用方式

在 **CatPaw** 中直接说：
- "帮我搭一个 Agent"
- "怎么给 Agent 加多模态"
- "Agent 的安全怎么保障"

CatPaw 会自动加载本 Skill 并按需读取对应参考节点。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Next.js 14 + React 18 + Tailwind + shadcn/ui |
| 后端 | Node.js + Fastify + tRPC |
| LLM | OpenAI / Anthropic / Gemini (多 Provider) |
| 向量库 | Qdrant / Milvus / Chroma |
| 桌面端 | Electron 28+ |
| 沙箱 | Docker (cgroups + seccomp + cap-drop) |
| 部署 | Docker Compose + Kubernetes |
| 监控 | OpenTelemetry + Langfuse |

## 验证状态

- 24 references — 全部含 AI 避坑注释（覆盖率 100%）
- Eval 验证通过：with_skill A级 vs baseline B-
- 零 P0/P1 错误（经两轮交叉审计修复）
- SKILL.md 路由器 — 242 行命令，24 项路由全闭合

## 许可

MIT License

## 贡献

欢迎提 Issue 和 PR。请参考 `24-product-layer.md` 中的开发规范。
