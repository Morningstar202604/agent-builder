# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Layer 编号映射说明**：以下 Layer 0-7 是技术栈的依赖层级，与 SKILL.md / README 中按功能域编排的顺序一致。Layer 0 为地基，逐层向上构建；与 reference 文件编号（01-24）无直接对应关系。

## [Unreleased]

### Added
- 验证门禁：新增 `tools/check-skill.mjs` 与 `package.json`（运行 `npm run check`）——解析全部 TypeScript 代码块、校验相对链接、声明路径布局与 SKILL.md 承诺（每文件 ≥3 条 🤖 避坑标记 + 验收清单章节），并接入 GitHub Actions CI（`.github/workflows/verify.yml`）。
- 为 21 个 reference 补齐"本层验收清单"章节；为 11 个 reference 补齐 AI 避坑标记（均达到 ≥3 条）。

### Fixed
- 修复 8 处代码块语法错误（伪代码 `...`、对象字面量括号错配、类型括号顺序、缺失闭括号、`lines.push` 缺右括号等）。
- 检查器兼容片段代码块（class/namespace/async generator 包裹后再解析）；避坑标记检测改为统计 `🤖`（与 references 实际格式一致）；扩展允许的 monorepo 路径前缀。
- 对齐 SKILL.md 声明的 monorepo 布局与 references 实际路径（新增 `server/`、`packages/mcp-servers`、`packages/web`）。
- `.env.example` 密钥示例改为环境变量注入说明，避免硬编码占位密钥。

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

[1.0.0]: https://github.com/Morningstar202604/agent-builder/releases/tag/v1.0.0
