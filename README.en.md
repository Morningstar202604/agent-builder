# 🤖 agent-builder

> **Production-Grade AI Agent Building Reference — From Zero to OpenAI/Anthropic Level**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![References: 24 Nodes](https://img.shields.io/badge/References-24%20Nodes-green.svg)](references/)
[![Bilingual](https://img.shields.io/badge/Language-中文%2FEnglish-orange.svg)](README.zh.md)

[中文文档](README.zh.md) · [English Docs](README.en.md)

---

## What This Is

A comprehensive reference guide for developers and AI Agents to **build enterprise-grade AI Agents from scratch**. Organized in **CatPaw Skill** format, covering the full-stack Agent development pipeline — from monorepo scaffolding to Playground UI. Every node includes production-grade TypeScript code, engineering rationale (🔗 Why this approach), and AI-pitfall annotations (🤖 AI pitfalls), cross-audited multiple times.

## What's Inside

| Module | Key Capabilities |
|:---:|:---|
| Foundation | Turborepo · ReAct Loop · SSE Streaming · Next.js · Electron Desktop |
| Tools & Skills | Token Budget · ToolRegistry · MCP Client · Skills Loader |
| Memory & RAG | Three-tier Memory (short/long/episodic) · Hybrid Retrieval · Qdrant/Milvus/Chroma |
| Multi-Agent | Supervisor+Worker · LangGraph Integration · Framework Comparison (LangGraph/CrewAI/AutoGen) |
| Security | Prompt Injection Defense · Guardrails · Tool Risk Classification |
| Production | Docker + K8s · CI/CD · OpenTelemetry · Webhooks · Playground UI |

## Quick Start

In **CatPaw**, simply say:

- "build me an Agent"
- "how to secure my Agent"
- "make my Agent self-reflect"
- "render Agent output as Artifacts"
- "how to make multiple Agents collaborate"

CatPaw will auto-load this Skill and read the relevant reference node on demand.

## Benchmark Standards

- **OpenAI Agents SDK** — Three-layer Guardrails + Runner architecture + Session persistence + Built-in Tracing
- **Anthropic Claude** — Artifacts protocol + Computer Use + Harness architecture + CLAUDE.md/Auto Memory/Skills/Hooks
- **MCP (Model Context Protocol)** — Client + Server bidirectional development under the latest spec
- **Langfuse / OpenTelemetry** — Full-chain observability, metering, and alerting

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

## 24 Reference Nodes

| # | Node | Covers |
|:--:|------|--------|
| 01 | [foundation](references/01-foundation.md) | Turborepo + ReAct loop + SSE + Next.js + Electron |
| 02 | [tools-skills](references/02-tools-skills.md) | Token budget + ToolRegistry + MCP + Skills |
| 03 | [memory-rag](references/03-memory-rag.md) | Three-tier memory + hybrid retrieval |
| 04 | [sandbox](references/04-sandbox.md) | Docker sandbox + 7-layer security boundaries |
| 05 | [multi-agent](references/05-multi-agent.md) | Supervisor+Worker + LangGraph integration |
| 06 | [hitl-reflection](references/06-hitl-reflection.md) | 4-tier HITL + LLM-as-Judge self-reflection |
| 07 | [security](references/07-security.md) | Prompt injection defense + Guardrails |
| 08 | [eval-observability](references/08-eval-observability.md) | Eval framework + Langfuse full-chain tracing |
| 09 | [deploy](references/09-deploy.md) | Docker Compose + Electron signing + K8s + CI/CD |
| 10 | [prompt-protocol](references/10-prompt-protocol.md) | 5-layer Prompt + version management + A/B testing |
| 11 | [function-calling](references/11-function-calling.md) | 3-provider adapter + parallel dispatch |
| 12 | [vector-db-practical](references/12-vector-db-practical.md) | Qdrant + Milvus + Chroma |
| 13 | [structured-output](references/13-structured-output.md) | Zod Schema + fault-tolerant JSON parser |
| 14 | [mcp-server-dev](references/14-mcp-server-dev.md) | MCP Server development (Stdio + SSE) |
| 15 | [knowledge-base](references/15-knowledge-base.md) | Multi-format RAG + incremental indexing |
| 16 | [multimodal-agent](references/16-multimodal-agent.md) | Modality router + TTS/STT |
| 17 | [streaming-advanced](references/17-streaming-advanced.md) | SSE optimization + smart reconnect |
| 18 | [framework-comparison](references/18-framework-comparison.md) | LangGraph/CrewAI/AutoGen comparison |
| 19 | [multi-tenancy](references/19-multi-tenancy.md) | Multi-tenancy + RBAC + audit logging |
| 20 | [agent-marketplace](references/20-agent-marketplace.md) | Marketplace + security scanning + revenue sharing |
| 21 | [fault-recovery](references/21-fault-recovery.md) | State snapshots + idempotent tools |
| 22 | [guardrails-tracing](references/22-guardrails-tracing.md) | Guardrails + Tracing + cost tracking |
| 23 | [artifacts-computer-use](references/23-artifacts-computer-use.md) | Artifacts + Computer Use + Headless CLI |
| 24 | [product-layer](references/24-product-layer.md) | Playground + multi-model routing + Webhooks |

## Core Design Principles

- **No wheel-reinvention** — Reuse mature ecosystem tools; prefer community-standard solutions
- **Production-grade, not demos** — Every node has real implementation code, not pseudocode
- **Progressive enhancement** — From foundation to advanced; each layer optional and independently upgradeable
- **AI-friendly** — Each node documents common LLM failure patterns to keep AI on track

## License

[MIT](LICENSE) — free to use, modify, and distribute.
