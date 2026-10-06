---
name: agent-builder
description: "Build a production-grade AI Agent product (web + Electron desktop). Full-stack: monorepo scaffolding, Agent ReAct loop, SSE streaming, Next.js frontend, Electron shell, context window, MCP tools, Skills system, memory with vector search, multi-agent orchestration, RAG, HITL, self-reflection, prompt protocol, function calling abstraction, prompt injection defense, OpenTelemetry, CI/CD, Docker Compose deploy. Trigger when: user wants to build/scaffold/architect an AI Agent; create a chat agent with tool calling; add MCP tools or Skills; add memory or RAG; design prompt template or system prompt versioning; unify function calling across providers; deploy to production; harden agent security; set up eval/observability; or wrap web agent in Electron. Even if user just says 'build me an agent' or 'Claude-like app' — use this skill."
---

# Agent Builder

A router for building a complete AI Agent product. **Do not implement directly from SKILL.md** — read the appropriate reference file for the layer the user needs.

## Intent Assessment

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
│   ├── L3 deploy → references/09-deploy.json
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
