# 23 — Artifacts · Computer Use · Headless · AskUserQuestion · Harness

> Layer 5 目标：让 Agent 从"聊天机器人"升级为"能产出、能操作、能自主运行、能协作的数字化员工"——Artifacts 结构化产物渲染、Computer Use 视觉操控、Headless CLI/CI 自动化、AskUserQuestion 澄清交互，以及 Claude Code Harness 架构。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - Artifact 渲染/可视化 → **react-markdown** + **Shiki** + **Sandpack/iframe 沙箱预览**，不要手写解析器、sanitizer 或在线编译器
> - Computer Use / 浏览器操控 → **Playwright**（含 `@playwright/mcp`）或 **MCP computer-use 工具**（或 Claude Computer Use 官方模式），不要手写"截图→坐标→点击"循环；视觉对比用现成差分包
> - Headless CLI / CI 自动化 → **Commander/Citty** + **GitHub Actions**，不要手写参数解析与 cron
> - CLAUDE.md / Auto Memory / Skills / Hooks → 用 **Claude 官方能力**或成熟 Harness（见 02 的 MCP Skills），不要手写实现
>
> 本层唯一允许手写的 `[CUSTOM]`：**Artifact 决策引擎**与 **AskUserQuestion 问题协议**——它们是产品业务差异层（何时弹独立窗口、何时打断用户提问），没有现成替代；内部实现仍要全部使用成熟库。

---

## 目录

- [工程逻辑：超越对话的 Agent 能力](#工程逻辑超越对话的-agent-能力)
- [1. Artifacts 产物渲染](#1-artifacts-产物渲染)
  - [1.1 决策引擎（业务规则 [CUSTOM]）](#11-决策引擎业务规则-custom)
  - [1.2 渲染栈：成熟库组合](#12-渲染栈成熟库组合)
  - [1.3 沙箱预览与版本化](#13-沙箱预览与版本化)
  - [1.4 持久化与共享](#14-持久化与共享)
  - [1.5 与 Structured Output 的关系](#15-与-structured-output-的关系)
- [2. Computer Use 计算机操控](#2-computer-use-计算机操控)
  - [2.1 架构：官方模式 vs 自研循环](#21-架构官方模式-vs-自研循环)
  - [2.2 Playwright 接入（浏览器优先）](#22-playwright-接入浏览器优先)
  - [2.3 MCP computer-use 与视觉对比](#23-mcp-computer-use-与视觉对比)
  - [2.4 安全与审计](#24-安全与审计)
- [3. CLI/Headless 无头模式](#3-cliheadless-无头模式)
  - [3.1 CLI 框架：Commander](#31-cli-框架commander)
  - [3.2 输出格式与退出码](#32-输出格式与退出码)
  - [3.3 CI/CD 与调度：GitHub Actions](#33-cicd-与调度github-actions)
- [4. AskUserQuestion 澄清提问 [CUSTOM]](#4-askuserquestion-澄清提问-custom)
  - [4.1 何时提问 vs 何时假设](#41-何时提问-vs-何时假设)
  - [4.2 暂停/恢复与前端接入](#42-暂停恢复与前端接入)
- [5. Claude Code Harness 架构](#5-claude-code-harness-架构)
  - [5.1 CLAUDE.md / AGENTS.md](#51-claudemd--agentsmd)
  - [5.2 Auto Memory](#52-auto-memory)
  - [5.3 Skills](#53-skills)
  - [5.4 Hooks](#54-hooks)
  - [5.5 Sub-agents](#55-sub-agents)
- [6. AI 避坑汇总](#6-ai-避坑汇总)
- [7. 本层验收清单](#7-本层验收清单)
- [交叉参考](#交叉参考)

---

## 工程逻辑：超越对话的 Agent 能力

Agent ≠ Chatbot。现代 Agent 的能力边界远超纯文本对话：

1. **产物能力**：创造独立内容（HTML/React/SVG/文档/代码），值得独立窗口渲染 → Artifacts
2. **视觉操控**：读取屏幕像素、输出鼠标/键盘动作，操控没有 API 的桌面/Web 应用 → Computer Use
3. **无头自动化**：通过 CLI 接口参与 CI/CD、批量任务 → Headless Mode
4. **主动澄清**：遇到歧义时暂停并提出问题，而非盲目假设 → AskUserQuestion
5. **完整 Harness**：持久记忆、可复用技能、钩子约束、子代理分工 → Harness Architecture

这五项能力的共同原则：**能力可选、渐进引入**。产品可以先只有"行内回复 + 澄清提问"，再逐步加入 Artifact、Computer Use、Headless。演进路径：结构化输出（13）→ 多模态理解（16）→ Artifact 渲染 → Headless CLI → Computer Use → AskUserQuestion → Harness。

---

## 1. Artifacts 产物渲染

### 1.1 决策引擎（业务规则 [CUSTOM]）

🔗 **工程逻辑**：Artifact 系统最核心的不是"怎么渲染"（渲染有成熟库），而是"什么内容值得独立窗口"。这个阈值是产品业务差异层（Claude.ai 内部同样是业务规则），没有现成替代，保留手写并标注 `[CUSTOM]`；但决策引擎内部**不手写解析器**。

```typescript
// packages/core/src/artifacts/decision-engine.ts —— 业务规则 [CUSTOM]
// 为什么没有现成替代：Artifact 阈值是产品交互决策（何时弹独立窗口），
// 依赖产品定位，不是通用基础设施；内部实现仍全部使用成熟库。
export interface ArtifactDecisionInput {
  contentLength: number;
  contentType: string;
  isSelfContained: boolean;
  requiresRendering: boolean;
  purpose: 'reference' | 'deliverable' | 'scratch' | 'illustration';
}

export interface ArtifactDecisionOutput {
  shouldCreateArtifact: boolean;
  reason: string;
  suggestedCategory?: string;
}

export function decideArtifactUse(input: ArtifactDecisionInput): ArtifactDecisionOutput {
  // 短内容 + 纯文本解释 → 行内渲染，不弹独立窗口
  if (input.contentLength < 400 && !input.requiresRendering) {
    return { shouldCreateArtifact: false, reason: 'Short content stays inline' };
  }
  // 草稿/参考内容 → 行内
  if (input.purpose === 'reference' || input.purpose === 'scratch') {
    return { shouldCreateArtifact: false, reason: 'Reference/scratch stays in conversation' };
  }
  // 自成一体且需要特殊渲染 → 独立窗口
  if (input.isSelfContained && input.requiresRendering) {
    return { shouldCreateArtifact: true, reason: 'Self-contained rendered content' };
  }
  return { shouldCreateArtifact: false, reason: 'Below artifact threshold' };
}
```

🤖 **AI 常见错误**：
1. 把所有 >15 行的输出都包装成 Artifact，对话流被"独立窗口"割裂。决策引擎必须硬编码三种行内场景：`<15 行代码块`、`纯文本解释`、`用户要求对话里显示`。
2. 把决策逻辑写死在渲染器里，导致换渲染栈时业务规则丢失。决策引擎独立成模块，渲染层只负责"怎么画"。

### 1.2 渲染栈：成熟库组合

🔗 **工程逻辑**：不要手写 HTML sanitizer、Markdown 解析器、语法高亮、React 在线编译。按 MIME 类型映射到成熟库，前端只写"选择渲染器"的胶水层：

| MIME 类型 | 成熟方案 | 说明 |
|-----------|----------|------|
| `text/markdown` | **react-markdown** + remark-gfm | 流式容错渲染，见 01 |
| `text/html` / React 单文件 | **Sandpack** | iframe 沙箱预览，不手写 Blob URL 编译 |
| `image/svg+xml` | **DOMPurify** + 原生 `<svg>` 注入 | sanitize 交给 DOMPurify，不手写正则 |
| 代码文件 | **Shiki** | 与 VS Code 同引擎（TextMate grammars） |
| `application/json` / `text/csv` | **@uiw/react-json-view** / **@tanstack/react-table** | 可交互查看，不手写树组件 |

```tsx
// packages/web/src/components/artifacts/ArtifactViewer.tsx
'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Sandpack } from '@codesandbox/sandpack-react';

export function ArtifactViewer({ mimeType, content }: { mimeType: string; content: string }) {
  if (mimeType === 'text/markdown') {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
  }
  if (mimeType === 'text/html') {
    return <Sandpack template="vanilla" files={{ '/index.html': content }} theme="dark" />;
  }
  return <div className="artifact-raw">{content}</div>;
}
```

### 1.3 沙箱预览与版本化

🔗 **工程逻辑**：HTML/React 产物必须进沙箱预览。Sandpack 本身就是沙箱（iframe + 受限依赖），不需要手写 `iframe.sandbox` 属性或正则清理脚本。修订版本化中的"变更比例"是通用算法，用 `jsdiff`（Myers diff），不手写逐行对齐。

```typescript
// packages/core/src/artifacts/update-protocol.ts
import { diffLines } from 'jsdiff';

// 用成熟 diff 库计算变更比例；决策阈值（update/replace）属于业务规则 [CUSTOM]
export function computeDiffRatio(a: string, b: string): number {
  const changes = diffLines(a, b);
  const changed = changes.filter((c) => c.added || c.removed).length;
  const total = Math.max(a.split('\n').length, b.split('\n').length);
  return total === 0 ? 0 : changed / total;
}
```

### 1.4 持久化与共享

🔗 **工程逻辑**：Artifact 元数据 + 内容存 Postgres（drizzle-orm，同 01 会话存储），大对象/文件存 S3，分享链接用对象存储预签名 URL。不要手写 JSON 文件存储或文件上传服务。

```typescript
// packages/core/src/artifacts/persistence.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, integer } from 'drizzle-orm/pg-core';

// drizzle-kit 生成的 schema 示例；实际用 `drizzle-kit generate` 从 schema.ts 生成 SQL
export const artifactTable = pgTable('artifacts', {
  identifier: text('identifier').primaryKey(),
  conversationId: text('conversation_id'),
  mimeType: text('mime_type'),
  title: text('title'),
  raw: text('raw_content'),
  version: integer('version'),
});

export type ArtifactRow = typeof artifactTable.$inferSelect;

export async function saveArtifact(db: ReturnType<typeof drizzle>, row: ArtifactRow) {
  await db.insert(artifactTable).values(row).onConflictDoUpdate({
    target: artifactTable.identifier,
    set: { raw: row.raw, version: row.version },
  });
}
```

### 1.5 与 Structured Output 的关系

Artifact 与 Structured Output（[13-structured-output.md](13-structured-output.md)）配合：Structured Output 确保模型输出可解析的 JSON；Artifact 渲染确保内容在 UI 中呈现为独立、可交互的产物。两者都基于 Zod schema + AI SDK，不手写 JSON 解析。

---

## 2. Computer Use 计算机操控

### 2.1 架构：官方模式 vs 自研循环

🔗 **工程逻辑**：Computer Use 的核心是"感知 → 推理 → 行动"闭环。这个闭环**不要自己写**：
- 云端完整闭环 → **Claude Computer Use 官方模式**（API 原生支持 computer tool）
- 本地浏览器 → **Playwright**（DOM 级定位，比像素坐标可靠）
- 通用桌面 → **MCP computer-use 工具**（社区/官方实现）

下面的胶水层用 AI SDK 声明 computer 工具，执行器由 Playwright/MCP 提供。`llm` 一律是 `ai` 的 `LanguageModel`（01 的 `createModel` 返回类型），不引入自定义 LLM 抽象。

```typescript
// packages/core/src/computer-use/session.ts
import { streamText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';

// llm = ai 的 LanguageModel（01 createModel 的返回类型）；循环上限由 maxSteps 保证
export function createComputerSession(model: LanguageModel) {
  return streamText({
    model,
    tools: {
      computer: tool({
        description: 'Control the local browser via Playwright',
        parameters: z.object({
          action: z.enum(['click', 'type', 'key', 'scroll']),
          x: z.number().optional(),
          y: z.number().optional(),
          text: z.string().optional(),
        }),
        execute: async (params) => {
          // 胶水层：转发给 Playwright 适配器（见 2.2），只写集成，不写实现
          return { ok: true, params };
        },
      }),
    },
    maxSteps: 20,
  });
}
```

🤖 **AI 常见错误**：把 Computer Use 实现为 `while` + 截图 + 坐标循环，自己管理截图历史、错误注入、终止条件。这些框架都有：AI SDK `maxSteps` 管循环终止，Playwright 管动作执行，视觉反馈用现成差分包。

### 2.2 Playwright 接入（浏览器优先）

🔗 **工程逻辑**：目标如果是浏览器 Web 应用，永远优先 Playwright（CSS 选择器 / ARIA 快照）而不是像素坐标。`@playwright/mcp` 直接把浏览器暴露成 MCP 工具给 Agent；即使自建适配器，也只写"动作翻译"胶水层。

```typescript
// packages/mcp-servers/playwright/computer-adapter.ts —— 胶水层（只做动作翻译）
import { chromium, type Page } from 'playwright';

export class PlaywrightComputer {
  private page: Page | null = null;

  async launch(headless: boolean, viewport: { width: number; height: number }) {
    const browser = await chromium.launch({ headless });
    this.page = await browser.newPage({ viewport });
  }

  async execute(action: { action: string; x?: number; y?: number; text?: string }) {
    if (!this.page) throw new Error('Browser not launched');
    switch (action.action) {
      case 'click':
        await this.page.mouse.click(action.x ?? 0, action.y ?? 0);
        return { ok: true };
      case 'type':
        await this.page.keyboard.type(action.text ?? '');
        return { ok: true };
      case 'key':
        await this.page.keyboard.press(action.text ?? '');
        return { ok: true };
      case 'scroll':
        await this.page.mouse.wheel(0, action.y ?? 300);
        return { ok: true };
      default:
        return { ok: true }; // screenshot 由上层直接调 page.screenshot()
    }
  }
}
```

### 2.3 MCP computer-use 与视觉对比

🔗 **工程逻辑**：要操控桌面应用，或需要"截图对比"验证 UI 时，用现成方案：`@playwright/mcp` 提供浏览器 MCP 工具；视觉断言用 Playwright 内置 `toHaveScreenshot()`（底层是成熟像素对比），或 `pixelmatch` 做差异图。不要手写截图对比循环。

```typescript
// packages/core/src/computer-use/visual-check.ts
import { expect, type Page } from '@playwright/test';

// 用 Playwright 内置快照对比验证 UI，不手写像素循环
export async function assertVisualStable(page: Page, name: string) {
  await expect(page).toHaveScreenshot(`${name}.png`, { maxDiffPixelRatio: 0.01 });
}
```

### 2.4 安全与审计

🔗 **工程逻辑**：破坏性操作（删除/支付/提交）必须 HITL 确认，用 LangGraph interrupts / OpenAI Agents SDK HITL（见 [06-hitl-reflection.md](06-hitl-reflection.md)），不手写 SafetyGuard 状态机；审计日志用 Langfuse（见 [08-eval-observability.md](08-eval-observability.md)）。安全级别（permissive/standard/strict）是业务策略，可标注 `[CUSTOM]`，但挂在成熟 HITL 机制上。

---

## 3. CLI/Headless 无头模式

### 3.1 CLI 框架：Commander

🔗 **工程逻辑**：CLI 参数解析用 **Commander**（或 **Citty**），不手写 `process.argv` 循环；配置校验用 Zod。CI 触发、管道化、调度是 Headless 的核心价值。

```typescript
// packages/mcp-servers/headless/cli.ts —— CLI 入口（胶水层）
import { Command } from 'commander';
import { z } from 'zod';

const HeadlessArgs = z.object({
  prompt: z.string(),
  maxTurns: z.coerce.number().default(10),
  output: z.enum(['text', 'json', 'stream-json']).default('text'),
  sessionId: z.string().optional(),
});

export function parseCli(argv: string[]) {
  const program = new Command();
  program
    .requiredOption('-p, --prompt <text>', 'task prompt')
    .option('--max-turns <n>', 'max loop turns', '10')
    .option('-o, --output <format>', 'text|json|stream-json', 'text')
    .option('--session-id <id>', 'resume session');
  program.parse(argv);
  return HeadlessArgs.parse(program.opts());
}
```

### 3.2 输出格式与退出码

🔗 **工程逻辑**：`stream-json` 用 NDJSON 行输出，下游用 `split2` + `ndjson` 消费；退出码是 CI 判断成功/失败的唯一依据。事件流来自 AI SDK `streamText`（已见 01），直接序列化为 NDJSON，不手写事件协议。

```typescript
// packages/mcp-servers/headless/output.ts
export type HeadlessEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; tool: string; input: unknown }
  | { type: 'result'; ok: boolean; turns: number };

// NDJSON：每行一个 JSON 对象，CI 可直接消费
export function toNdjson(event: HeadlessEvent): string {
  return JSON.stringify(event);
}
```

### 3.3 CI/CD 与调度：GitHub Actions

🔗 **工程逻辑**：定时/批量调度用 GitHub Actions cron（或 CI 平台），不手写 cron 解析器；通知用成熟 action。模型密钥通过 GitHub Secrets 注入，不进入 git。

```yaml
# .github/workflows/headless-nightly.yml —— 声明式调度，不手写 cron
name: nightly-agent
on:
  schedule:
    - cron: "0 9 * * 1-5"
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx agent-headless -p "生成每日报告" -o json
```

---

## 4. AskUserQuestion 澄清提问 [CUSTOM]

### 4.1 何时提问 vs 何时假设

🔗 **工程逻辑**：最小化交互——只在关键歧义点提问。这个"何时问"是产品业务规则（交互策略），保留 `[CUSTOM]`；但"暂停/恢复"机制用 LangGraph interrupts / OpenAI Agents SDK HITL（见 06），不手写状态机。

```typescript
// packages/core/src/ask-user-question/decision.ts —— 业务规则 [CUSTOM]
// 为什么没有现成替代：提问阈值是产品交互策略（何时打断用户），依赖产品定位。
export interface AmbiguityContext {
  severity: 'critical' | 'moderate' | 'minor';
  questionType: string;
  defaultValue?: unknown;
  impactIfWrong: string;
}

export function shouldAskUser(ambiguity: AmbiguityContext): { shouldAsk: boolean; reason: string } {
  if (ambiguity.severity === 'critical') {
    return { shouldAsk: true, reason: `Critical ambiguity: ${ambiguity.impactIfWrong}` };
  }
  if (ambiguity.severity === 'moderate' && ambiguity.defaultValue !== undefined) {
    return { shouldAsk: false, reason: 'Reasonable default exists; state assumption' };
  }
  if (ambiguity.severity === 'minor') {
    return { shouldAsk: false, reason: 'Low cost to guess; user can correct' };
  }
  return { shouldAsk: true, reason: 'Unresolved ambiguity' };
}
```

🤖 **AI 常见错误**：对每个细节都提问（"用什么框架？""数据库选哪个？"），用户被问题轰炸。`severity: 'minor'` 必须直接假设；每会话最多 3 个 `critical` 问题。

### 4.2 暂停/恢复与前端接入

🔗 **工程逻辑**：Agent 提问后暂停、用户回答后恢复——这是框架能力，用 LangGraph `interrupt()` / OpenAI Agents SDK HITL，不手写 `PausableExecutor`。前端展示用 `ai/react` 的 `useChat` 事件帧渲染工具卡片（见 01）。

```tsx
// apps/web/src/components/chat/AskUserQuestionCard.tsx
'use client';

export interface AskQuestion {
  id: string;
  text: string;
  options?: Array<{ id: string; label: string }>;
}

export function AskUserQuestionCard({ question, onAnswer }: {
  question: AskQuestion;
  onAnswer: (value: string) => void;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p>{question.text}</p>
      {question.options?.map((opt) => (
        <button key={opt.id} onClick={() => onAnswer(opt.id)} className="mr-2 rounded bg-gray-100 px-3 py-1">
          {opt.label}
        </button>
      ))}
    </div>
  );
}
```

---

## 5. Claude Code Harness 架构

🔗 **工程逻辑**：CLAUDE.md / Auto Memory / Skills / Hooks / Sub-agents 是 Claude Code 的官方能力。**本仓库不自研 Harness**：要么直接用 Claude Code 官方 CLI，要么用成熟 Harness（本仓库 02 的 MCP Skills 渐进披露）。本节只描述"官方能力用法 + 与其它节点的对应关系"，不提供手写实现。

### 5.1 CLAUDE.md / AGENTS.md

- **官方能力**：`CLAUDE.md`（项目级）、`~/.claude/CLAUDE.md`（用户级）在会话启动时注入，摘要压缩后重新注入。
- **约束**：文件 < 50KB，否则模型忽略；细节文档放 `/docs/` 按需加载。
- **本仓库对应**：项目上下文注入；模型类型统一用 `LanguageModel`（`ai`），入口用 01 的 `createModel`。

```markdown
# CLAUDE.md —— 项目持久指令（内容示例，非代码）
- 构建命令：pnpm build
- 测试命令：pnpm test
- 约定：所有 LLM 类型使用 `LanguageModel`（来自 `ai`），模型入口用 01 的 `createModel`
```

### 5.2 Auto Memory

- **官方能力**：Claude Code 的自动记忆（`/memory`、CLAUDE.md 中 `@memories` 注入）。
- **本仓库对应**：[03-memory-rag.md](03-memory-rag.md) 用 LlamaIndex/Haystack 实现跨会话记忆，不要手写记忆引擎。
- **提示**：显式记忆（"记住 X"）与纠正模式是业务规则，可放 `[CUSTOM]`，但存储/检索用成熟向量库。

### 5.3 Skills

- **官方能力**：Claude Code Skills（`SKILL.md` + 资源文件，渐进披露）。
- **本仓库对应**：[02-tools-skills.md](02-tools-skills.md) 的 MCP Skills 系统，用 MCP 协议承载，不要手写注册器与 frontmatter 解析。

### 5.4 Hooks

- **官方能力**：Claude Code Hooks 生命周期事件（`PreToolUse`、`PostToolUse`、`Notification` 等）。
- **本仓库对应**：安全/Guardrails 用 OpenAI Agents SDK Guardrails + Langfuse（见 [22-guardrails-tracing.md](22-guardrails-tracing.md)），HITL 用 LangGraph interrupts（见 06）。
- **`[CUSTOM]`**：业务级钩子（如"拦截 curl 命令"）是业务策略，但挂在官方 Hooks 事件上，不自研中间件管道。

### 5.5 Sub-agents

- **官方能力**：Claude Code Subagents（`CLAUDE.md` 中定义子代理，独立上下文）。
- **本仓库对应**：[05-multi-agent.md](05-multi-agent.md) 用 LangGraph/CrewAI/AutoGen 编排，不要手写拓扑排序与并行调度。

---

## 6. AI 避坑汇总

> 🤖 **AI 常见错误**：

1. **手写 Artifact 渲染器**：自研 HTML sanitizer 正则、React 在线编译、Markdown 解析器。这些都有成熟库（Sandpack、DOMPurify、react-markdown、Shiki）。检查方式：代码中不应出现 `new HTMLCompiler()` / `sanitizeHTML()` 这类实现。
2. **手写 Computer Use 截图循环**：自己维护"截图→坐标→点击→再截图"的 while 循环，且没有终止保护。应使用 Playwright/MCP/官方模式 + AI SDK `maxSteps`。
3. **浏览器场景误用 Computer Use**：目标是 Web 应用时用像素坐标点击（5 步循环），而 Playwright 一行 `page.goto` + `locator.click` 就完成。决策树：浏览器 → Playwright；桌面无 API → Computer Use；有 API → 直接调 API。
4. **Headless 不设 maxTurns/超时**：CI 中 Agent 无限循环，跑数小时后才超时。CLI 必须设 `--max-turns`（10-30）与 `timeoutSeconds`（300-600s）作为第二层保护。
5. **AskUserQuestion 过度使用**：对每个细节都提问，用户被问题轰炸。`shouldAskUser()` 必须对 `minor` 歧义直接假设；每会话最多 3 个 `critical` 问题。
6. **CLAUDE.md 无限膨胀**：把 CLAUDE.md 当无限上下文仓库，写到几百 KB，模型在 50KB 后忽略。超过 20KB 警告，超过 50KB 强制拆分。
7. **自研 Harness**：自己写 Hooks 中间件、Memory 引擎、Skill 注册器、Sub-agent 调度器。这些用 Claude 官方能力或本仓库 02/03/05/06/22 的成熟方案。

---

## 7. 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本验收清单。
- [ ] **Artifact 决策**：构造 `<15 行代码块` 与 `纯文本解释`，断言 `decideArtifactUse()` 返回 `shouldCreateArtifact: false`；构造独立 HTML 产物断言返回 `true`。
- [ ] **Artifact 渲染**：`ArtifactViewer` 对 markdown 用 react-markdown 渲染、对 HTML 用 Sandpack 沙箱；渲染含 `<script>` 的 HTML 不执行脚本。
- [ ] **Computer Use**：Playwright 适配器在 headless 浏览器执行 click/type/scroll；`assertVisualStable` 用 `toHaveScreenshot` 对比通过。
- [ ] **Headless CLI**：`node cli.js -p "..." -o stream-json` 每行输出是合法 JSON；退出码 0/1/2 映射正确。
- [ ] **CI 调度**：GitHub Actions cron 触发 nightly 任务；密钥从 Secrets 注入，不进入 git。
- [ ] **AskUserQuestion**：`shouldAskUser()` 对 minor 歧义返回 `false`；暂停/恢复通过 LangGraph interrupts 验证。
- [ ] **Harness**：项目 CLAUDE.md < 50KB；Skills 通过 02 的 MCP 加载；Hooks 挂在官方事件上。

---

## 交叉参考

- [01-foundation.md](01-foundation.md)：`createModel`（LLM 入口）、`LanguageModel` 类型、`useChat` 流式与工具卡片
- [02-tools-skills.md](02-tools-skills.md)：MCP Skills 渐进披露
- [03-memory-rag.md](03-memory-rag.md)：Auto Memory 的检索/存储
- [05-multi-agent.md](05-multi-agent.md)：Sub-agents 编排
- [06-hitl-reflection.md](06-hitl-reflection.md)：暂停/恢复与人工确认（HITL）
- [08-eval-observability.md](08-eval-observability.md)：审计日志与追踪
- [13-structured-output.md](13-structured-output.md)：Artifact 与结构化输出的关系
- [16-multimodal-agent.md](16-multimodal-agent.md)：多模态截图理解
- [22-guardrails-tracing.md](22-guardrails-tracing.md)：Guardrails 与 Hooks 的对应