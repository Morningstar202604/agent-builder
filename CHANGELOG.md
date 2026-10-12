# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Layer 编号映射说明**：以下 Layer 0-7 是技术栈的依赖层级，与 SKILL.md / README 中按功能域编排的顺序一致。Layer 0 为地基，逐层向上构建；与 reference 文件编号（01-24）无直接对应关系。

## [Unreleased]

## [1.0.1] - 2026-10-12

### Added
- 验证门禁：新增 `tools/check-skill.mjs` 与 `package.json`（运行 `npm run check`）——解析全部 TypeScript 代码块、校验相对链接、声明路径布局与 SKILL.md 承诺（每文件 ≥3 条 🤖 避坑标记 + 验收清单章节），并接入 GitHub Actions CI（`.github/workflows/verify.yml`）。
- 为 21 个 reference 补齐"本层验收清单"章节；为 11 个 reference 补齐 AI 避坑标记（均达到 ≥3 条）。

### Fixed
- 修复 8 处代码块语法错误（伪代码 `...`、对象字面量括号错配、类型括号顺序、缺失闭括号、`lines.push` 缺右括号等）。
- **全面去手写化**：重写全部 24 篇 references，把自研实现替换为成熟方案（Vercel AI SDK、LangGraph、LlamaIndex/Haystack、E2B/Daytona、OpenAI Agents SDK、Langfuse/promptfoo、CASL、LiteLLM、@modelcontextprotocol/sdk 等）；仅保留业务差异层 `[CUSTOM]`。
- **新增契约与映射**：新增 `references/00-types.md` 跨层类型契约（统一 `LanguageModel`/`UIMessage`/`AgentEvent`）与 `docs/REUSE_MATRIX.md` 逐层"手写→成熟替代"映射表；SKILL.md 的 LLM 统一层改为 Vercel AI SDK/LiteLLM。
- **统一版本与治理**：Node 版本统一为 >=20（QUICK_START/SKILL.md/00-types）；修复官网 footer 年份、SECURITY 占位邮箱。
- **代码质量归零**：references 中 `as any` / `: any` / `console.log(` 计数从 51/177/13 降到 0，验证门禁基线同步收紧。
- 检查器兼容片段代码块（class/namespace/async generator 包裹后再解析）；避坑标记检测改为统计 `🤖`（与 references 实际格式一致）；扩展允许的 monorepo 路径前缀。
- 对齐 SKILL.md 声明的 monorepo 布局与 references 实际路径（新增 `server/`、`packages/mcp-servers`、`packages/web`）。
- `.env.example` 密钥示例改为环境变量注入说明，避免硬编码占位密钥。

### Added（2026-10 扩写与调研）
- 新增 `docs/TECH_LANDSCAPE.md`：2022-2026 成熟 Agent 技术清单（Agent 编排/集群、MCP 无状态规范、A2A、记忆与 RAG、可观测性/评估/安全、大厂生产实践、淘汰清单）。
- 新增 `docs/research/`：五份生态调研报告（agent-orchestration / mcp-ecosystem / bigtech-production / memory-rag / observability-eval-security），均附来源。
- 全部 24 篇 references 展开扩写：融入 2026 成熟技术（LangGraph/OpenAI Agents SDK/Claude Agent SDK/ADK/CrewAI、orchestrator-worker Agent 集群、MCP Streamable HTTP + OAuth 2.1、混合检索+重排+ColBERT、Mem0/Zep/LangMem、promptfoo/LLM-as-judge、Langfuse/OTel GenAI semconv、LiteLLM 网关、Upstash Ratelimit、Stripe 幂等 webhook、BullMQ、OWASP LLM Top 10 等）。
- `docs/REUSE_MATRIX.md` 更新：补充 Agent 集群、MCP 无状态化、记忆工具、混合检索等映射，并链接 TECH_LANDSCAPE。

### Changed
- 淘汰过时技术并明确标注：OpenAI Swarm、AutoGen 旧包、Assistants API、NeMo Guardrails、MCP HTTP+SSE 双端点、手写 SSE/JSON-RPC/span/分块器。
- 验证门禁路径白名单新增 `apps/cli`（Headless CLI 应用）。
- `references/18-framework-comparison.md` 更新为 2026 框架现状（LangGraph 1.0、MAF 1.0、ADK 2.0、AgentCore GA），并修正验收清单措辞。

## [1.0.0] - 2026-10-07

### Added
- 24 reference nodes covering full-stack AI Agent development
  - Layer 0: Foundation (Monorepo, ReAct Loop, SSE, Next.js 15+, Electron)
  - Layer 1: Tools & Skills, Memory & RAG, Sandbox
  - Layer 2: Multi-Agent, HITL & Reflection, Security, Eval & Observability
  - Layer 3: Deploy, Prompt Protocol, Function Calling, Vector DB
  - Layer 4: Structured Output, MCP Server Dev, Knowledge Base
  - Layer 5: Multimodal Agent, Streaming Advanced
  - Layer 6: Framework Comparison, Multi-Tenancy, Agent Marketplace
  - Layer 7: Fault Recovery, Guardrails & Tracing, Artifacts/ComputerUse, Product Layer

- Open-source project catalog with build-vs-buy decision tree
- Integration patterns: 9 common connection blueprints
- LATEST-ONLY tech mandate (no deprecated stack)
- "Don't Reinvent the Wheel" philosophy across all references
- Official website deployed via GitHub Pages
- Multi-platform release: GitCode, Gitee, GitHub (x2)

### Deprecated
- 无（首次发布）

### Changed
- 无（首次发布）

### Fixed
- 无（首次发布）

### Security
- 无（首次发布）

[1.0.1]: https://github.com/Morningstar202604/agent-builder/releases/tag/v1.0.1
[1.0.0]: https://github.com/Morningstar202604/agent-builder/releases/tag/v1.0.0
