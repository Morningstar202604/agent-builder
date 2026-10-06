# agent-builder

> Complete, production-grade AI Agent building reference — CatPaw Skill format

[中文](README.zh.md) | [English](README.en.md)

## What This Is

A comprehensive reference guide for developers and AI Agents to build enterprise-grade AI Agents from scratch. Organized in **CatPaw Skill** format, covering the full-stack Agent development pipeline — from monorepo scaffolding to Playground UI. All references have been cross-audited multiple times, with production-grade TypeScript code and AI-pitfall annotations.

## Benchmark Standards

- **OpenAI Agents SDK** — Three-layer Guardrels + Runner architecture + Session persistence + Built-in Tracing
- **Anthropic Claude** — Artifacts protocol + Computer Use + Harness architecture + CLAUDE.md/Auto Memory/Skills/Hooks
- **MCP (Model Context Protocol)** — Client + Server bidirectional development under the latest spec
- **Langfuse / OpenTelemetry** — Full-chain observability, metering, and alerting

## Structure

```
agent-builder/
├── SKILL.md              # Router — decision tree + execution order + cross-reference map + troubleshooting
├── references/            # In-depth reference nodes (loaded on demand, each self-contained)
│   ├── 01-foundation.md          # Turborepo + AbstractAgent ReAct loop + SSE + Next.js + Electron
│   ├── 02-tools-skills.md        # Token budget + ToolRegistry + MCP Client + Skills loader
│   ├── 03-memory-rag.md          # Three-tier memory (short/long/episodic) + hybrid retrieval
│   ├── 04-sandbox.md             # Docker sandbox + network whitelist + resource limits + 7-layer boundaries
│   ├── 05-multi-agent.md         # Supervisor+Worker + LangGraph integration
│   ├── 06-hitl-reflection.md     # 4-tier HITL + LLM-as-Judge self-reflection + auto-stop
│   ├── 07-security.md            # Prompt injection defense + tool risk classification + multi-layer checks
│   ├── 08-eval-observability.md  # Eval framework + Langfuse tracing + regression testing
│   ├── 09-deploy.md              # Docker Compose + Electron signing/notarization + K8s + key management
│   ├── 10-prompt-protocol.md     # 5-layer Prompt architecture + version management + A/B testing
│   ├── 11-function-calling.md    # 3-provider adapter (OpenAI/Anthropic/Gemini) + parallel dispatch
│   ├── 12-vector-db-practical.md # Qdrant + Milvus + Chroma + hybrid retrieval + reranking
│   ├── 13-structured-output.md   # Zod Schema First + fault-tolerant JSON parser + error-injection retry
│   ├── 14-mcp-server-dev.md      # MCP Server development (Stdio + SSE transports)
│   ├── 15-knowledge-base.md      # Multi-format RAG + incremental indexing + citation tracking
│   ├── 16-multimodal-agent.md    # Modality router + image understanding + TTS/STT
│   ├── 17-streaming-advanced.md  # SSE optimization + smart reconnect + bandwidth adaptation
│   ├── 18-framework-comparison.md # LangGraph/CrewAI/AutoGen/CAMEL comparison + hybrid orchestration
│   ├── 19-multi-tenancy.md       # Multi-tenancy (RLS/DB-per-tenant) + RBAC + audit logging
│   ├── 20-agent-marketplace.md   # Agent marketplace + publishing + security scanning + revenue sharing
│   ├── 21-fault-recovery.md      # State snapshots (Redis/Postgres) + reconnection + idempotent tools
│   ├── 22-guardrails-tracing.md  # **OpenAI Guardrels 3-layer + Session + Tracing + cost tracking**
│   ├── 23-artifacts-computer-use.md # **Artifacts protocol + Computer Use + Headless CLI + Harness**
│   └── 24-product-layer.md       # **Playground + multi-model routing + webhooks + CI/CD**
└── assets/
    ├── QUICK_START.md             # Quick start guide
    └── PRE_LAUNCH_CHECKLIST.md    # Pre-launch checklist
```

## Usage

In **CatPaw**, simply say:

- "build me an Agent"
- "add multimodal support to my Agent"
- "how to secure my Agent"
- "make my Agent self-reflect"
- "render Agent output as Artifacts"

CatPaw will auto-load this Skill and read the relevant reference node on demand.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js + React + Tailwind + shadcn/ui |
| Backend | Node.js + Fastify + tRPC |
| LLM | OpenAI / Anthropic / Gemini (multi-provider routing) |
| Vector DB | Qdrant / Milvus / Chroma (hybrid retrieval) |
| Desktop | Electron (contextIsolation + sandbox) |
| Sandbox | Docker (cgroups + seccomp + cap-drop + read-only rootfs) |
| Deploy | Docker Compose + Kubernetes |
| Observability | OpenTelemetry + Langfuse |

## Core Design Principles

- **No wheel-reinvention** — Reuse mature ecosystem tools; prefer community-standard solutions
- **Production-grade, not demos** — Every node has real implementation code, not pseudocode
- **Progressive enhancement** — From foundation to advanced; each layer optional and independently upgradeable
- **AI-friendly** — Each node documents common LLM failure patterns to keep AI on track

## License

MIT License — free to use, modify, and distribute.
