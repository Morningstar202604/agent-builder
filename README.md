# 🤖 agent-builder

> **Production-Grade AI Agent Building Reference — From Zero to OpenAI/Anthropic Level**
> **生产级 AI Agent 构建从零参考 — 对齐 OpenAI / Anthropic 官方水准**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![References: 24](https://img.shields.io/badge/References-24-green.svg)](references/)
[![Bilingual](https://img.shields.io/badge/语言-中文%2FEnglish-orange.svg)](README.zh.md)

[中文文档](README.zh.md) · [English Docs](README.en.md) · [快速开始](#快速开始--quick-start)

---

## 这是什么 / What This Is

一套帮助开发者和 AI Agent **从零构建企业级 AI Agent** 的完整参考指南。覆盖从 monorepo 脚手架到 Playground UI 的全栈 Agent 开发链路 —— 每个节点含完整 TypeScript 实现、工程决策理由、AI 避坑注释，经两轮以上交叉审计。

A complete reference for developers and AI Agents to **build enterprise-grade AI Agents from scratch**. Covers the full-stack pipeline from monorepo scaffolding to Playground UI — every node has production TypeScript code, engineering rationale, and AI-pitfall annotations, cross-audited multiple times.

## 涵盖内容 / What's Inside

| 模块 / Module | 核心能力 / Key Capabilities |
|:---:|:---|
| Foundation | Turborepo · ReAct Loop · SSE Streaming · Next.js · Electron |
| Tools & Skills | Token Budget · ToolRegistry · MCP Client · Skills Loader |
| Memory & RAG | Three-Tier Memory · Hybrid Retrieval · Vector DB (Qdrant/Milvus/Chroma) |
| Multi-Agent | Supervisor+Worker · LangGraph Integration · Framework Comparison |
| Security | Prompt Injection Defense · Guardrails · Tool Risk Classification |
| Production | Docker + K8s · CI/CD · OpenTelemetry · Webhooks · Playground UI |

## 快速开始 / Quick Start

在你的 AI 编程助手中直接说：

- "帮我搭一个 Agent" / _"build me an Agent"_
- "Agent 的安全怎么保障" / _"how to secure my Agent"_
- "怎样让 Agent 自我反思" / _"make my Agent self-reflect"_

Agent 自动加载本参考并按需读取对应节点。

## 对标标准 / Benchmark Standards

- **OpenAI Agents SDK** — Guardrails 三层校验 + Runner + Session + Tracing
- **Anthropic Claude** — Artifacts 协议 + Computer Use + Harness 架构
- **MCP (Model Context Protocol)** — Client + Server 双向开发
- **Langfuse / OpenTelemetry** — 全链路可追踪、可度量、可告警

## 技术栈 / Tech Stack

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

## 24 参考节点 / 24 Reference Nodes

```
references/
├── 01-foundation.md          → Turborepo + ReAct + SSE + Next.js + Electron
├── 02-tools-skills.md        → Token budget + ToolRegistry + MCP + Skills
├── 03-memory-rag.md          → 三层记忆 + 混合检索
├── 04-sandbox.md             → Docker 沙箱 + 七层安全边界
├── 05-multi-agent.md         → Supervisor+Worker + LangGraph
├── 06-hitl-reflection.md     → 四级 HITL + LLM-as-Judge 自反思
├── 07-security.md            → Prompt Injection 防御 + Guardrails
├── 08-eval-observability.md  → Eval 框架 + Langfuse 全链路
├── 09-deploy.md              → Docker Compose + Electron + K8s + CI/CD
├── 10-prompt-protocol.md     → 五层 Prompt + 版本管理 + A/B
├── 11-function-calling.md    → 三 Provider 适配 + 并行派发
├── 12-vector-db-practical.md → Qdrant + Milvus + Chroma
├── 13-structured-output.md   → Zod Schema + 容错 JSON
├── 14-mcp-server-dev.md      → MCP Server (Stdio + SSE)
├── 15-knowledge-base.md      → 多格式 RAG + 增量索引
├── 16-multimodal-agent.md    → 多模态 + TTS/STT
├── 17-streaming-advanced.md  → SSE 优化 + 智能重连
├── 18-framework-comparison.md → LangGraph/CrewAI/AutoGen 对比
├── 19-multi-tenancy.md       → 多租户 + RBAC + 审计
├── 20-agent-marketplace.md   → 市场 + 安全扫描 + 收益分成
├── 21-fault-recovery.md      → 状态快照 + 幂等工具
├── 22-guardrails-tracing.md  → OpenAI Guardrails + Tracing
├── 23-artifacts-computer-use.md → Artifacts + Computer Use + CLI
└── 24-product-layer.md       → Playground + 路由 + Webhook
```

## 核心理念 / Core Principles

- **不重复造轮子** / No wheel-reinvention — 复用成熟生态
- **生产级代码** / Production-grade — 真实实现非伪代码
- **渐进增强** / Progressive — 每层可选、可独立升级
- **AI 友好** / AI-friendly — 标注 AI 常犯错误模式

## 许可 / License

[MIT](LICENSE) — 自由使用、修改、分发 / Free to use, modify, and distribute.
