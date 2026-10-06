# 🤖 agent-builder

> **生产级 AI Agent 构建从零参考 — 对齐 OpenAI / Anthropic 官方水准**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![参考资料: 24 节点](https://img.shields.io/badge/参考资料-24%20节点-green.svg)](references/)
[![中英双语](https://img.shields.io/badge/语言-中文%2FEnglish-orange.svg)](README.en.md)

[English Docs](README.en.md) · [中文文档](README.zh.md)

---

## 这是什么

一套帮助开发者和 AI Agent **从零构建企业级 AI Agent** 的完整参考指南，以**通用 Agent 可读格式**组织。覆盖从 monorepo 脚手架到 Playground UI 的全栈 Agent 开发链路 —— 每个节点含完整 TypeScript 实现、工程决策理由（🔗 工程逻辑）、AI 避坑注释（🤖 AI 避坑），经两轮以上交叉审计。

## 涵盖内容

| 模块 | 核心能力 |
|:---:|:---|
| 基础 | Turborepo · ReAct 循环 · SSE 流式 · Next.js · Electron 桌面端 |
| 工具与技能 | Token 预算 · ToolRegistry · MCP Client · Skills 加载 |
| 记忆与 RAG | 三层记忆（短期/长期/情景）· 混合检索 · Qdrant/Milvus/Chroma |
| 多 Agent | Supervisor+Worker · LangGraph 集成 · 框架对比（LangGraph/CrewAI/AutoGen） |
| 安全 | Prompt Injection 防御 · Guardrails 校验 · 工具风险分类 |
| 生产部署 | Docker + K8s · CI/CD · OpenTelemetry · Webhook · Playground UI |

## 快速开始

在你的 AI 编程助手中直接说：

- "帮我搭一个 Agent"
- "Agent 的安全怎么保障"
- "怎样让 Agent 自我反思"
- "Agent 输出如何渲染成 Artifact"
- "怎么让多个 Agent 协作"

Agent 会自动加载本参考并按需读取对应参考节点。

## 对标标准

- **OpenAI Agents SDK** — Guardrails 三层校验 + Runner 架构 + Session 持久化 + Tracing 内建
- **Anthropic Claude** — Artifacts 协议 + Computer Use + Harness 架构 + CLAUDE.md/Auto Memory/Skills/Hooks
- **MCP (Model Context Protocol)** — 最新规范下的 Client + Server 双向开发
- **Langfuse / OpenTelemetry** — 全链路可追踪、可度量、可告警

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | Next.js + React + Tailwind + shadcn/ui |
| 后端 | Node.js + Fastify + tRPC |
| LLM | OpenAI / Anthropic / Gemini（多 Provider 路由） |
| 向量库 | Qdrant / Milvus / Chroma（混合检索） |
| 桌面端 | Electron（contextIsolation + sandbox） |
| 沙箱 | Docker（cgroups + seccomp + cap-drop + 只读 rootfs） |
| 部署 | Docker Compose + Kubernetes |
| 监控 | OpenTelemetry + Langfuse |

## 24 参考节点

| # | 节点 | 覆盖内容 |
|:--:|------|----------|
| 01 | [foundation](references/01-foundation.md) | Turborepo + ReAct 循环 + SSE + Next.js + Electron |
| 02 | [tools-skills](references/02-tools-skills.md) | Token 预算 + ToolRegistry + MCP + Skills |
| 03 | [memory-rag](references/03-memory-rag.md) | 三层记忆 + 混合检索 |
| 04 | [sandbox](references/04-sandbox.md) | Docker 沙箱 + 七层安全边界 |
| 05 | [multi-agent](references/05-multi-agent.md) | Supervisor+Worker + LangGraph 集成 |
| 06 | [hitl-reflection](references/06-hitl-reflection.md) | 四级 HITL + LLM-as-Judge 自反思 |
| 07 | [security](references/07-security.md) | Prompt Injection 防御 + Guardrails |
| 08 | [eval-observability](references/08-eval-observability.md) | Eval 框架 + Langfuse 全链路 |
| 09 | [deploy](references/09-deploy.md) | Docker Compose + Electron + K8s + CI/CD |
| 10 | [prompt-protocol](references/10-prompt-protocol.md) | 五层 Prompt + 版本管理 + A/B |
| 11 | [function-calling](references/11-function-calling.md) | 三 Provider 适配 + 并行派发 |
| 12 | [vector-db-practical](references/12-vector-db-practical.md) | Qdrant + Milvus + Chroma |
| 13 | [structured-output](references/13-structured-output.md) | Zod Schema + 容错 JSON 解析 |
| 14 | [mcp-server-dev](references/14-mcp-server-dev.md) | MCP Server 开发 (Stdio + SSE) |
| 15 | [knowledge-base](references/15-knowledge-base.md) | 多格式 RAG + 增量索引 |
| 16 | [multimodal-agent](references/16-multimodal-agent.md) | 多模态 + TTS/STT |
| 17 | [streaming-advanced](references/17-streaming-advanced.md) | SSE 优化 + 智能重连 |
| 18 | [framework-comparison](references/18-framework-comparison.md) | LangGraph/CrewAI/AutoGen 对比 |
| 19 | [multi-tenancy](references/19-multi-tenancy.md) | 多租户 + RBAC + 审计 |
| 20 | [agent-marketplace](references/20-agent-marketplace.md) | 市场 + 安全扫描 + 收益分成 |
| 21 | [fault-recovery](references/21-fault-recovery.md) | 状态快照 + 幂等工具 |
| 22 | [guardrails-tracing](references/22-guardrails-tracing.md) | Guardrails + Tracing + 成本追踪 |
| 23 | [artifacts-computer-use](references/23-artifacts-computer-use.md) | Artifacts + Computer Use + CLI |
| 24 | [product-layer](references/24-product-layer.md) | Playground + 多模型路由 + Webhook |

## 核心设计理念

- **不重复造轮子** — 复用成熟生态工具，优先选择社区主流方案
- **生产级而非 Demo** — 每个节点都经真实代码实现，非伪代码
- **渐进式强化** — 从基础到高级，每一层可选、可独立升级
- **AI 友好** — 每个节点标注 LLM 常犯的错误模式，防止 AI 走偏

## 许可

MIT License — 自由使用、修改、分发。
