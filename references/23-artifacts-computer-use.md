# 23 — 产物渲染 · 计算机操控 · 无头模式 · 澄清提问 · Harness 架构

> **⚠️ 不要重造以下东西：**
> - Artifacts 渲染 → 用 **Claude Artifacts 协议**（`<antartifact>` MIME 标准），不要自创渲染格式
> - Computer Use → 用 **MCP 协议** + **Playwright MCP Server**，不要手写 Screen→坐标→点击循环
> - 浏览器自动化 → 用 **Playwright** / **Puppeteer**（`@playwright/mcp`），不要手写 CDP 协议
> - CLI/Headless → 直接用 **OpenAI Agents SDK** 的 `Runner` + `--print --output-format json` 模式
> - Hooks/Sub-agents → 用 **OpenAI Agents SDK** 的 `hooks` + `subagents`，不要手写中间件
>
> 本 reference 的价值：覆盖 Claude Code Harness（CLAUDE.md/Auto Memory/Skills/Hooks）的完整架构。**用 OpenAI Agents SDK 做 Harness 底座，不要自己发明 Hooks/Memory/Sub-agent 协议。**

> 本 reference 覆盖现代 Agent 超越纯文本对话的四项能力——结构化产物（Artifacts）的创建与渲染、Computer Use 视觉操控、CLI/Headless 自动化执行、AskUserQuestion 澄清交互，以及 Claude Code Harness 的完整架构设计（CLAUDE.md / Auto Memory / Skills / Hooks / Sub-agents）。读完本文件可使 Agent 从"聊天机器人"升级为"全栈协作平台"。

---

## 目录

- [工程逻辑：超越对话的 Agent 能力](#工程逻辑超越对话的-agent-能力)
- [1. Claude Artifacts 产物渲染](#1-claude-artifacts-产物渲染)
  - [1.1 <antartifact> 协议与 MIME 类型体系](#11-antartifact-协议与-mime-类型体系)
  - [1.2 Artifact vs 行内内容的决策判据](#12 artifact-vs-行内内容的决策判据)
  - [1.3 Artifact Registry 实现](#13-artifact-registry-实现)
  - [1.4 Renderer 多态渲染](#14-renderer-多态渲染)
  - [1.5 修订版本化与更新协议](#15-修订版本化与更新协议)
  - [1.6 持久化与共享](#16-持久化与共享)
- [2. Computer Use 计算机操控](#2-computer-use-计算机操控)
  - [2.1 视觉-动作闭环架构](#21-视觉-动作闭环架构)
  - [2.2 Computer Tool Schema 定义](#22-computer-tool-schema-定义)
  - [2.3 执行循环实现](#23-执行循环实现)
  - [2.4 安全层：确认与审计](#24-安全层确认与审计)
  - [2.5 本地替代：Playwright/Puppeteer](#25-本地替代playwrightpuppeteer)
  - [2.6 与多模态理解的集成](#26-与多模态理解的集成)
- [3. CLI/Headless 无头模式](#3-clcliheadless-无头模式)
  - [3.1 Headless 模式核心参数](#31-headless-模式核心参数)
  - [3.2 输出格式设计](#32-输出格式设计)
  - [3.3 Session Resume 断点续跑](#33-session-resume-断点续跑)
  - [3.4 批量与调度](#34-批量与调度)
  - [3.5 错误处理与退出码体系](#35-错误处理与退出码体系)
- [4. AskUserQuestion 澄清提问](#4-askuserquestion-澄清提问)
  - [4.1 何时提问 vs 何时假设](#41-何时提问-vs-何时假设)
  - [4.2 问题类型与设计](#42-问题类型与设计)
  - [4.3 异步暂停/恢复协议](#43-异步暂停恢复协议)
  - [4.4 前端组件实现](#44-前端组件实现)
- [5. Claude Code Harness 架构](#5-claude-code-harness-架构)
  - [5.1 CLAUDE.md / AGENTS.md 持久指令](#51-claude-md--agents-md-持久指令)
  - [5.2 Auto Memory 跨会话学习](#52-auto-memory-跨会话学习)
  - [5.3 Skills 封装可复用流程](#53-skills-封装可复用流程)
  - [5.4 Hooks 生命周期拦截器](#54-hooks-生命周期拦截器)
  - [5.5 Sub-agents 并行执行与领导协调](#55-sub-agents-并行执行与领导协调)
- [6. AI 避坑汇总](#6-ai-避坑汇总)
- [交叉参考](#交叉参考)

---

## 工程逻辑：超越对话的 Agent 能力

Agent ≠ Chatbot。现代 Agent 的能力边界远超纯文本对话：

1. **产物能力**：Agent 不只是回复——它创造独立内容（HTML/React/SVG/文档/代码），这些内容值得独立窗口渲染而非埋在对话流里 → Artifacts 系统
2. **视觉操控**：Agent 读取屏幕像素、输出鼠标/键盘动作，操控没有 API 的桌面/Web 应用 → Computer Use
3. **无头自动化**：在没有人类参与时，Agent 通过 CLI 接口参与 CI/CD、批量任务 → Headless Mode
4. **主动澄清**：遇到歧义时 Agent 暂停并提出问题，而非盲目假设 → AskUserQuestion
5. **完整 Harness**：Agent 框架本身需要持久记忆、可复用技能、钩子约束、子代理分工 → Harness Architecture

这五项能力的共同目标是：**把 Agent 从"一问一答的聊天机器人"升级为"能产出、能操作、能自主运行、能协作的数字化员工"。**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    现代 Agent 能力全景                                      │
│                                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Artifacts│  │Computer  │  │ Headless │  │   Ask    │  │ Harness  │  │
│  │ 产物渲染 │  │   Use    │  │   CLI    │  │ Question │  │  架构    │  │
│  │          │  │ 视觉操控 │  │ 无头模式 │  │ 澄清提问 │  │ 记忆/技能│  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │              │              │        │
│       ▼              ▼              ▼              ▼              ▼        │
│  ┌──────────────────────────────────────────────────────────────────────┐│
│  │                     Agent Harness 框架                                ││
│  │  CLAUDE.md + Auto Memory + Skills + Hooks + Sub-agents               ││
│  └──────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Claude Artifacts 产物渲染

### 1.1 <antartifact> 协议与 MIME 类型体系

**工程逻辑**：当 Agent 创建的内容足够"实质性、自成一体"（substantive, self-contained）时，应将其封装为独立的 Artifact，在专用 UI 窗口中渲染，而非嵌在对话流里，让用户能独立查看、编辑、复用。

**<antartifact> 协议**是 Claude.ai 内部使用的结构化产物标记协议，核心字段：
- `identifier`：唯一标识符（UUID），用于后续更新引用
- `type`：产物类型（code / document / html / svg / react / mermaid）
- `mimeType`：精确的 MIME 类型声明
- `title`：产物标题
- `content`：产物原始内容

```typescript
// packages/core/src/artifacts/types.ts

/**
 * <antartifact> 协议核心类型
 * 参考 Claude.ai 的内部实现（2024-06 版与后续演进）
 */
export type ArtifactMimeType =
  | 'text/html'                    // 完整 HTML 页面（含内联 CSS/JS）
  | 'image/svg+xml'                // SVG 矢量图形
  | 'text/markdown'                // Markdown 文档
  | 'application/vnd.ant.react'    // React 单文件组件（JSX + CSS in one file）
  | 'application/vnd.ant.code'     // 代码文件（带语言标记）
  | 'application/json'             // JSON 数据/配置
  | 'text/csv'                     // 表格数据
  | 'application/vnd.ant.mermaid'  // Mermaid 图表源码
  | 'application/vnd.ant.python';  // Python 脚本

export type ArtifactCategory =
  | 'code'       // 代码产物：脚本、组件、配置
  | 'document'   // 文档产物：报告、邮件、演示
  | 'visual'     // 视觉产物：图表、SVG、信息图
  | 'interactive' // 交互式产物：HTML 应用、工具、原型
  | 'data';      // 数据产物：表格、JSON、CSV

export interface ArtifactMetadata {
  identifier: string;          // 全局唯一 ID（如 "art_2vPqN5Lx"）
  version: number;             // 版本号（从 1 开始递增）
  mimeType: ArtifactMimeType;
  category: ArtifactCategory;
  title: string;
  createdAt: string;           // ISO 8601
  updatedAt: string;
  modelVersion: string;        // 生成产物的模型版本
  conversationId: string;      // 所属会话
  messageId: string;           // 生成产物的消息 ID
  sizeBytes: number;
  isVersioned: boolean;        // 是否保留历史版本
}

export interface ArtifactContent {
  raw: string;                 // 原始内容文本
  language?: string;           // 代码语言（application/vnd.ant.code 时）
  isExecutable: boolean;       // 是否可在沙箱中执行/预览
  sandboxRestrictions?: string[]; // 沙箱限制清单
}

export interface Artifact {
  metadata: ArtifactMetadata;
  content: ArtifactContent;
  revisions?: ArtifactRevision[];  // 历史版本（可选）
}

export interface ArtifactRevision {
  version: number;
  raw: string;
  updatedAt: string;
  changeDescription?: string;
}
```

### 1.2 Artifact vs 行内内容的决策判据

**这是 Artifact 系统最核心的设计决策**。用得恰到好处是"惊艳"，用得过滥是"割裂"。

```typescript
// packages/core/src/artifacts/decision-engine.ts

export interface ArtifactDecisionInput {
  contentLength: number;          // 内容字符数
  contentType: ArtifactMimeType;
  isSelfContained: boolean;       // 是否独立可理解
  isUserLikelyToEdit: boolean;    // 用户是否可能反复修改
  isUserLikelyToShare: boolean;   // 用户是否可能分享到对话之外
  requiresRendering: boolean;     // 是否需要特殊渲染（SVG/HTML/图表等）
  containsDesign: boolean;        // 是否包含视觉设计要素
  complexity: 'low' | 'medium' | 'high';
  purpose: 'reference' | 'deliverable' | 'scratch' | 'illustration';
}

export interface ArtifactDecisionOutput {
  shouldCreateArtifact: boolean;
  reason: string;
  suggestedCategory?: ArtifactCategory;
  suggestedTitle?: string;
  confidence: number;  // 0-1
}

/**
 * Artifact 决策引擎
 * 
 * 基于 Claude.ai 系统提示词中的决策规则（2024-06 泄露版 + Claude Sonnet 4.5 演进）：
 * 
 * 必须创建 Artifact 的场景：
 * 1. 单文件 HTML 页面/应用，>15 行
 * 2. React 单文件组件，>15 行  
 * 3. Python/其他语言脚本，>15 行
 * 4. SVG 图形/图表
 * 5. Mermaid 流程图/架构图
 * 6. Markdown 文档/报告，>15 行
 * 7. CSV/JSON 数据表格，用户会下载或复用
 * 
 * 绝对不应创建 Artifact 的场景：
 * 1. 代码片段 < 15 行（应使用行内代码块）
 * 2. JSON 配置 < 20 行且是 tool_call 的结果
 * 3. 纯文本解释（即使很长）
 * 4. 用户要求"放在对话里"的明确指令
 */
export function decideArtifactUse(input: ArtifactDecisionInput): ArtifactDecisionOutput {
  // 强制行内规则——低复杂度内容不配独立窗口
  if (input.contentLength < 400 && input.complexity === 'low') {
    return {
      shouldCreateArtifact: false,
      reason: 'Content is short and simple; inline rendering provides better flow',
      confidence: 0.95,
    };
  }

  // 如果用户明确说"对话里显示"，尊重用户意愿
  if (input.purpose === 'reference' && !input.requiresRendering) {
    return {
      shouldCreateArtifact: false,
      reason: 'Reference content belongs in conversation flow',
      confidence: 0.85,
    };
  }

  // 草稿/临时产物不创建 Artifact
  if (input.purpose === 'scratch') {
    return {
      shouldCreateArtifact: false,
      reason: 'Scratch/working content should not clutter artifact panel',
      confidence: 0.8,
    };
  }

  // 长代码块、HTML、React、SVG ——经典 Artifact 场景
  if (
    input.isSelfContained &&
    (input.requiresRendering || input.contentLength > 1000)
  ) {
    return {
      shouldCreateArtifact: true,
      reason: `Self-contained ${input.contentType} worth independent window`,
      suggestedCategory: categorizeArtifact(input.contentType),
      suggestedTitle: generateArtifactTitle(input),
      confidence: 0.9,
    };
  }

  // 可交付产物（报告、邮件、演示）
  if (input.isUserLikelyToShare && input.isSelfContained) {
    return {
      shouldCreateArtifact: true,
      reason: 'Deliverable content likely to be shared outside conversation',
      suggestedCategory: 'document',
      confidence: 0.88,
    };
  }

  // 可能迭代修改的内容
  if (input.isUserLikelyToEdit && input.complexity !== 'low') {
    return {
      shouldCreateArtifact: true,
      reason: 'Content likely to be iteratively refined by user',
      suggestedCategory: 'code',
      confidence: 0.82,
    };
  }

  return {
    shouldCreateArtifact: false,
    reason: 'Content does not meet artifact threshold; prefer inline',
    confidence: 0.6,
  };
}

function categorizeArtifact(mime: ArtifactMimeType): ArtifactCategory {
  if (mime.includes('html') || mime.includes('react')) return 'interactive';
  if (mime.includes('svg') || mime.includes('mermaid')) return 'visual';
  if (mime.includes('code') || mime.includes('python')) return 'code';
  if (mime.includes('markdown') || mime.includes('json') || mime.includes('csv')) return 'data';
  return 'document';
}
```

### 1.3 Artifact Registry 实现

**工程逻辑**：Artifact Registry 是整个子系统的核心存储层。Agent 每创建一个产物必须注册，后续通过 identifier 做增量更新。Registry 负责版本追踪、索引查询、生命周期管理。

```typescript
// packages/core/src/artifacts/registry.ts

import { randomUUID } from 'crypto';

export interface ArtifactRegistryConfig {
  maxPerConversation: number;    // 默认 50
  maxTotalSizeMB: number;        // 默认 100
  retentionDays: number;         // 默认 30
  enableVersioning: boolean;     // 是否保留历史版本
  maxVersionsPerArtifact: number; // 默认 20
  persistTo: 'memory' | 'postgres' | 's3';
}

export class ArtifactRegistry {
  private artifacts: Map<string, Artifact> = new Map();
  private conversationIndex: Map<string, Set<string>> = new Map();
  private titleIndex: Map<string, string> = new Map();
  private revisionStore: Map<string, ArtifactRevision[]> = new Map();

  constructor(
    private config: ArtifactRegistryConfig,
    private persistenceAdapter: ArtifactPersistenceAdapter,
  ) {}

  /**
   * 注册新 Artifact
   * 返回完整 Artifact 对象，前端可用 identifier 独立渲染
   */
  async register(params: {
    mimeType: ArtifactMimeType;
    category: ArtifactCategory;
    title: string;
    raw: string;
    conversationId: string;
    messageId: string;
    modelVersion: string;
    language?: string;
  }): Promise<Artifact> {
    // 强制限制检查
    const count = this.getConversationArtifacts(params.conversationId).length;
    if (count >= this.config.maxPerConversation) {
      throw new ArtifactQuotaError(
        `Conversation artifact limit reached (${this.config.maxPerConversation})`
      );
    }

    const identifier = this.generateIdentifier();
    const metadata: ArtifactMetadata = {
      identifier,
      version: 1,
      mimeType: params.mimeType,
      category: params.category,
      title: params.title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modelVersion: params.modelVersion,
      conversationId: params.conversationId,
      messageId: params.messageId,
      sizeBytes: Buffer.byteLength(params.raw, 'utf-8'),
      isVersioned: this.config.enableVersioning,
    };

    const isExecutable = this.isExecutableType(params.mimeType);
    const artifact: Artifact = {
      metadata,
      content: {
        raw: params.raw,
        language: params.language,
        isExecutable,
        sandboxRestrictions: isExecutable
          ? this.getSandboxRestrictions(params.mimeType)
          : undefined,
      },
      revisions: this.config.enableVersioning
        ? [{ version: 1, raw: params.raw, updatedAt: metadata.createdAt }]
        : undefined,
    };

    this.artifacts.set(identifier, artifact);
    this.conversationIndex
      .getOrSet(params.conversationId, () => new Set())
      .add(identifier);
    this.titleIndex.set(`${params.conversationId}:${params.title.toLowerCase()}`, identifier);

    // 持久化
    await this.persistenceAdapter.save(artifact);

    return artifact;
  }

  /**
   * 更新 Artifact（非重写）
   * 仅更新差异部分，保留版本历史
   */
  async update(
    identifier: string,
    newRaw: string,
    changeDescription?: string,
  ): Promise<Artifact> {
    const artifact = this.artifacts.get(identifier);
    if (!artifact) throw new ArtifactNotFoundError(identifier);

    // 如果完全相同，不做更新
    if (artifact.content.raw === newRaw) return artifact;

    const oldRaw = artifact.content.raw;
    artifact.content.raw = newRaw;
    artifact.metadata.sizeBytes = Buffer.byteLength(newRaw, 'utf-8');
    artifact.metadata.updatedAt = new Date().toISOString();
    artifact.metadata.version += 1;

    // 保存到版本历史
    if (this.config.enableVersioning && artifact.revisions) {
      if (artifact.revisions.length >= this.config.maxVersionsPerArtifact) {
        artifact.revisions.shift(); // 保留最近 N 个版本
      }
      artifact.revisions.push({
        version: artifact.metadata.version,
        raw: newRaw,
        updatedAt: artifact.metadata.updatedAt,
        changeDescription,
      });
    }

    await this.persistenceAdapter.save(artifact);
    return artifact;
  }

  /**
   * 获取特定 Artifact 的所有版本
   */
  getRevisions(identifier: string): ArtifactRevision[] {
    const artifact = this.artifacts.get(identifier);
    return artifact?.revisions ?? [];
  }

  /**
   * 回滚到特定版本
   */
  async rollback(identifier: string, targetVersion: number): Promise<Artifact> {
    const artifact = this.artifacts.get(identifier);
    if (!artifact) throw new ArtifactNotFoundError(identifier);

    const revision = artifact.revisions?.find((r) => r.version === targetVersion);
    if (!revision) throw new RevisionNotFoundError(identifier, targetVersion);

    return this.update(identifier, revision.raw, `Rollback to v${targetVersion}`);
  }

  /**
   * 列出某会话的所有 Artifacts（按更新时间倒序）
   */
  getConversationArtifacts(conversationId: string): Artifact[] {
    const ids = this.conversationIndex.get(conversationId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.artifacts.get(id)!)
      .filter(Boolean)
      .sort((a, b) => b.metadata.updatedAt.localeCompare(a.metadata.updatedAt));
  }

  /**
   * 搜索 Artifacts（标题 + 内容）
   */
  search(query: string, conversationId?: string): Artifact[] {
    const candidates = conversationId
      ? this.getConversationArtifacts(conversationId)
      : Array.from(this.artifacts.values());

    const lowerQuery = query.toLowerCase();
    return candidates.filter(
      (a) =>
        a.metadata.title.toLowerCase().includes(lowerQuery) ||
        a.content.raw.toLowerCase().includes(lowerQuery)
    );
  }

  private generateIdentifier(): string {
    return `art_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  private isExecutableType(mime: ArtifactMimeType): boolean {
    return (
      mime === 'text/html' ||
      mime === 'application/vnd.ant.react' ||
      mime === 'image/svg+xml' ||
      mime === 'application/vnd.ant.python'
    );
  }

  private getSandboxRestrictions(mime: ArtifactMimeType): string[] {
    const base = ['no-network', 'no-storage-api', 'no-external-resources'];
    if (mime === 'application/vnd.ant.react') {
      return [...base, 'no-node-apis', 'client-side-only'];
    }
    return base;
  }
}
```

### 1.4 Renderer 多态渲染

**工程逻辑**：不同类型的 Artifact 需要不同的渲染策略。HTML 进沙箱 iframe、SVG 直接注入 DOM 但需 sanitization、React 在线编译、Markdown 用 remark 管道。

```typescript
// packages/core/src/artifacts/renderer.ts

export type RenderTarget = 'sandpit' | 'inline-replace' | 'tab' | 'new-window';

export interface RenderContext {
  artifact: Artifact;
  target: RenderTarget;
  sandboxed: boolean;
  allowCopy: boolean;
  allowDownload: boolean;
  onContentChange?: (newContent: string) => void;
}

export interface RenderResult {
  element: HTMLElement | null;     // DOM 元素（React 返回 null，自己挂载）
  dispose?: () => void;            // 清理函数
  revokeUrls?: () => void;         // 释放 Blob URL
}

export class ArtifactRenderer {
  private compilers = new Map<string, ArtifactCompiler>([
    ['text/html', new HTMLCompiler()],
    ['application/vnd.ant.react', new ReactCompiler()],
    ['image/svg+xml', new SVGCompiler()],
    ['application/vnd.ant.mermaid', new MermaidCompiler()],
    ['text/markdown', new MarkdownCompiler()],
    ['application/vnd.ant.code', new CodeCompiler()],
    ['application/json', new JSONCompiler()],
    ['text/csv', new CSVCompiler()],
  ]);

  /**
   * 核心渲染入口
   */
  render(ctx: RenderContext): RenderResult {
    const compiler = this.compilers.get(ctx.artifact.metadata.mimeType);
    if (!compiler) {
      return this.renderFallback(ctx);
    }

    try {
      return compiler.compile(ctx);
    } catch (error) {
      return this.renderError(ctx, error as Error);
    }
  }

  private renderFallback(ctx: RenderContext): RenderResult {
    const pre = document.createElement('pre');
    pre.className = 'artifact-raw-fallback';
    pre.textContent = ctx.artifact.content.raw;
    return { element: pre };
  }

  private renderError(ctx: RenderContext, error: Error): RenderResult {
    const div = document.createElement('div');
    div.className = 'artifact-render-error';
    div.innerHTML = `
      <div class="error-header">Rendering Error</div>
      <div class="error-message">${escapeHtml(error.message)}</div>
      <details>
        <summary>Raw Content</summary>
        <pre>${escapeHtml(ctx.artifact.content.raw.slice(0, 500))}</pre>
      </details>
    `;
    return { element: div };
  }
}

// ---- 各编译器实现 ----

class HTMLCompiler implements ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult {
    if (ctx.sandboxed) {
      // 沙箱 iframe：隔离执行 HTML/CSS/JS
      const iframe = document.createElement('iframe');
      iframe.className = 'artifact-html-sandbox';
      iframe.sandbox.add('allow-scripts'); // 允许 JS，禁止网络/存储
      iframe.srcdoc = this.sanitizeHTML(ctx.artifact.content.raw);

      return {
        element: iframe,
        dispose: () => {
          // 清理 iframe 内容防止内存泄漏
          iframe.srcdoc = '';
        },
      };
    } else {
      // 信任模式：直接注入 DOM（仅限可信来源）
      const container = document.createElement('div');
      container.className = 'artifact-html-direct';
      container.innerHTML = ctx.artifact.content.raw;
      return { element: container };
    }
  }

  private sanitizeHTML(raw: string): string {
    // 移除危险标签和事件处理器
    const dangerousTags = ['script', 'object', 'embed', 'iframe', 'form'];
    let result = raw;
    for (const tag of dangerousTags) {
      result = result.replace(
        new RegExp(`<${tag}[^>]*>.*?</${tag}>`, 'gis'),
        `<!-- ${tag} removed by sandbox -->`,
      );
    }
    // 移除内联事件处理器
    result = result.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
    return result;
  }
}

class ReactCompiler implements ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult {
    const container = document.createElement('div');
    container.className = 'artifact-react-root';

    // 将单文件 React 编译为可执行模块
    // 使用 Babel standalone 或 SWC WASM 在浏览器端编译
    const compiled = this.compileJSX(ctx.artifact.content.raw);

    // 通过 Blob URL 创建模块脚本
    const blob = new Blob([compiled], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);

    const script = document.createElement('script');
    script.type = 'module';
    script.textContent = `
      import { createRoot } from 'https://esm.sh/react-dom@18/client';
      import React from 'https://esm.sh/react@18';
      import { default: App } from '${url}';
      const container = document.querySelector('[data-artifact-id="${ctx.artifact.metadata.identifier}"]');
      createRoot(container).render(React.createElement(App));
    `;
    container.setAttribute('data-artifact-id', ctx.artifact.metadata.identifier);
    container.appendChild(script);

    return {
      element: container,
      revokeUrls: () => URL.revokeObjectURL(url),
    };
  }

  private compileJSX(source: string): string {
    // 实际实现使用 Babel.transform 或 SWC compile
    // 这里为简化示意
    return source
      .replace(/import\s+['"]([^'"]+)['"]/g, "import 'https://esm.sh/$1'")
      .replace(/export\s+default\s+/g, 'export default ');
  }
}

class SVGCompiler implements ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult {
    const container = document.createElement('div');
    container.className = 'artifact-svg-container';

    // 严格 sanitization：SVG 可以包含 <script>、事件处理器甚至 XSS
    const sanitized = this.sanitizeSVG(ctx.artifact.content.raw);
    container.innerHTML = sanitized;

    // 使 SVG 可缩放
    const svg = container.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', 'auto');
      svg.style.maxWidth = '100%';
    }

    return { element: container };
  }

  private sanitizeSVG(raw: string): string {
    // 移除 script 标签
    let result = raw.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    // 移除事件处理器属性
    result = result.replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '');
    // 移除 foreignObject（可以嵌入 HTML）
    result = result.replace(/<foreignObject[^>]*>[\s\S]*?<\/foreignObject>/gi, '');
    return result;
  }
}

// 编译器接口
export interface ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult;
}

class MarkdownCompiler implements ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult {
    const container = document.createElement('div');
    container.className = 'artifact-markdown-body';
    // 使用 marked + DOMPurify 渲染
    // container.innerHTML = DOMPurify.sanitize(marked.parse(ctx.artifact.content.raw));
    return { element: container };
  }
}

class MermaidCompiler implements ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult {
    const container = document.createElement('div');
    container.className = 'artifact-mermaid';
    // 使用 mermaid.js 在浏览器端渲染图表
    // mermaid.render('mermaid-' + Date.now(), ctx.artifact.content.raw);
    return { element: container };
  }
}

class CodeCompiler implements ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult {
    const pre = document.createElement('pre');
    pre.className = `artifact-code language-${ctx.artifact.content.language ?? 'unknown'}`;
    // 使用 Prism.js 或 Shiki 做语法高亮
    // pre.innerHTML = highlightCode(ctx.artifact.content.raw, ctx.artifact.content.language);
    return { element: pre };
  }
}

class JSONCompiler implements ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult {
    const container = document.createElement('div');
    container.className = 'artifact-json-viewer';
    // 使用 react-json-view 或类似组件
    return { element: container };
  }
}

class CSVCompiler implements ArtifactCompiler {
  compile(ctx: RenderContext): RenderResult {
    const container = document.createElement('div');
    container.className = 'artifact-csv-viewer';
    // 使用 handsontable 或 ag-grid 渲染可编辑表格
    return { element: container };
  }
}
```

### 1.5 修订版本化与更新协议

**工程逻辑**：用户修改 Artifact 后，需要决定是 update（更新现有产物）还是 replace（创建全新产物）。Claude.ai 的规则是：如果修改不超过 50% 且主体结构未变，用 update；否则创建新 Artifact。

```typescript
// packages/core/src/artifacts/update-protocol.ts

export interface UpdateDecision {
  action: 'update' | 'replace';
  identifier?: string;       // update 时
  changeDescription: string;
  diffRatio: number;         // 0-1，变更比例
}

/**
 * 决定是更新还是替换 Artifact
 * 
 * 规则（基于 Claude.ai 实际行为）：
 * - update：变更 < 50% 且未改变核心结构
 * - replace：变更 >= 50% / 类型改变 / 主体逻辑重写
 */
export function decideUpdateAction(
  original: string,
  modified: string,
  mimeType: ArtifactMimeType,
): UpdateDecision {
  const diffRatio = computeDiffRatio(original, modified);
  const structureChanged = detectStructureChange(original, modified, mimeType);

  if (diffRatio < 0.5 && !structureChanged) {
    return {
      action: 'update',
      changeDescription: `Updated ${describeChanges(original, modified)}`,
      diffRatio,
    };
  }

  return {
    action: 'replace',
    changeDescription: `Rewritten: significant structural changes`,
    diffRatio,
  };
}

/**
 * 计算文本差异率
 */
function computeDiffRatio(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return 1;

  const linesA = a.split('\n');
  const linesB = b.split('\n');
  const maxLines = Math.max(linesA.length, linesB.length);

  let changedLines = 0;
  for (let i = 0; i < maxLines; i++) {
    if (linesA[i] !== linesB[i]) changedLines++;
  }

  return changedLines / maxLines;
}

/**
 * 检测结构变更（对于代码：函数签名、导入、组件结构）
 */
function detectStructureChange(
  original: string,
  modified: string,
  mimeType: ArtifactMimeType,
): boolean {
  if (mimeType === 'application/vnd.ant.code' || mimeType === 'application/vnd.ant.react') {
    // 提取函数/类定义，比较骨架是否变化
    const originalStructure = extractCodeSkeleton(original);
    const modifiedStructure = extractCodeSkeleton(modified);
    return JSON.stringify(originalStructure) !== JSON.stringify(modifiedStructure);
  }

  if (mimeType === 'text/html') {
    // 比较 DOM 结构标签树
    const originalTags = extractTopLevelTags(original);
    const modifiedTags = extractTopLevelTags(modified);
    return JSON.stringify(originalTags) !== JSON.stringify(modifiedTags);
  }

  return false;
}

function extractCodeSkeleton(code: string): { functions: string[]; imports: string[] } {
  const functions = code.match(/(?:function|const|let|var)\s+(\w+)/g) ?? [];
  const imports = code.match(/import\s+.*from/g) ?? [];
  return { functions, imports };
}

function extractTopLevelTags(html: string): string[] {
  // 简化实现：提取一级标签
  const matches = html.match(/<(\w+)[\s>]/g) ?? [];
  return matches.map((m) => m.replace(/[<>\s]/g, ''));
}

function describeChanges(original: string, modified: string): string {
  // 简化：返回首行差异
  const firstAdded = modified.split('\n').find((line) => !original.includes(line));
  return firstAdded ? `Added: "${firstAdded.trim().slice(0, 50)}..."` : 'minor edits';
}
```

### 1.6 持久化与共享

**工程逻辑**：Artifact 不只是会话内存在——它需要跨会话持久化、支持下载导出、支持跨用户共享链接。

```typescript
// packages/core/src/artifacts/persistence.ts

export interface ArtifactPersistenceAdapter {
  save(artifact: Artifact): Promise<void>;
  load(identifier: string): Promise<Artifact | null>;
  delete(identifier: string): Promise<void>;
  list(conversationId: string): Promise<ArtifactMetadata[]>;
}

export class PostgresArtifactAdapter implements ArtifactPersistenceAdapter {
  constructor(private db: Knex) {}

  async save(artifact: Artifact): Promise<void> {
    await this.db('artifacts')
      .insert({
        identifier: artifact.metadata.identifier,
        conversation_id: artifact.metadata.conversationId,
        mime_type: artifact.metadata.mimeType,
        category: artifact.metadata.category,
        title: artifact.metadata.title,
        raw_content: artifact.content.raw,
        language: artifact.content.language,
        version: artifact.metadata.version,
        size_bytes: artifact.metadata.sizeBytes,
        model_version: artifact.metadata.modelVersion,
        message_id: artifact.metadata.messageId,
        is_executable: artifact.content.isExecutable,
      })
      .onConflict('identifier')
      .merge();
  }

  async load(identifier: string): Promise<Artifact | null> {
    const row = await this.db('artifacts').where({ identifier }).first();
    if (!row) return null;

    // 加载版本历史
    const revisions = await this.db('artifact_revisions')
      .where({ artifact_identifier: identifier })
      .orderBy('version', 'desc')
      .limit(50);

    return {
      metadata: {
        identifier: row.identifier,
        version: row.version,
        mimeType: row.mime_mime_type,
        category: row.category,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        modelVersion: row.model_version,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        sizeBytes: row.size_bytes,
        isVersioned: true,
      },
      content: {
        raw: row.raw_content,
        language: row.language,
        isExecutable: row.is_executable,
      },
      revisions: revisions.map((r) => ({
        version: r.version,
        raw: r.raw_content,
        updatedAt: r.updated_at,
        changeDescription: r.change_description,
      })),
    };
  }

  async delete(identifier: string): Promise<void> {
    await this.db('artifacts').where({ identifier }).delete();
  }

  async list(conversationId: string): Promise<ArtifactMetadata[]> {
    return this.db('artifacts')
      .where({ conversation_id: conversationId })
      .orderBy('updated_at', 'desc')
      .select(
        'identifier', 'title', 'mime_type', 'category',
        'version', 'updated_at', 'size_bytes',
      );
  }
}

/**
 * 导出为可下载文件
 */
export function exportArtifactToFile(artifact: Artifact): {
  filename: string;
  mimeType: string;
  content: string;
} {
  const ext = getExtensionForMime(artifact.metadata.mimeType);
  const filename = `${slugify(artifact.metadata.title)}.${ext}`;

  return {
    filename,
    mimeType: artifact.metadata.mimeType,
    content: artifact.content.raw,
  };
}

function getExtensionForMime(mime: ArtifactMimeType): string {
  const map: Record<ArtifactMimeType, string> = {
    'text/html': 'html',
    'image/svg+xml': 'svg',
    'text/markdown': 'md',
    'application/vnd.ant.react': 'jsx',
    'application/vnd.ant.code': 'txt',
    'application/json': 'json',
    'text/csv': 'csv',
    'application/vnd.ant.mermaid': 'mmd',
    'application/vnd.ant.python': 'py',
  };
  return map[mime] ?? 'txt';
}
```

### 1.7 Artifact 与 Structured Output 的关系

Artifact 与 Structured Output（参见节点 13）的关系是：**Structured Output 确保模型输出可解析的 JSON；Artifact 渲染确保模型输出的内容在 UI 中呈现为独立、可交互的产物。** 两者配合使得 Agent 既能生成结构化数据，也能将数据转化为可视化的最终交付物。

```
模型输出 → Structured Output（解析 JSON）
    └── 如果是 Artifact 类型内容
        └── 进入 Artifact Registry（版本化）
            └── Renderer 渲染到独立窗口
                └── 用户编辑 → Update 协议决定 update/replace
```

---

## 2. Computer Use 计算机操控

### 2.1 视觉-动作闭环架构

**工程逻辑**：Computer Use 让模型像人类一样操作计算机——通过截屏"看"界面，通过坐标+动作"操作"界面。其核心是一个「感知 → 推理 → 行动」的闭环，每一步行动后都需要重新截屏获取反馈。

这个架构有三个根本挑战：
1. **感知**：从截图理解 UI 语义（像素 → 语义映射）
2. **定位**：把意图映射到屏幕坐标（如"点击保存按钮" → 坐标 (543, 321)）
3. **鲁棒性**：从错误中恢复（点错了弹窗、页面还没加载完等）

```
┌──────────────────────────────────────────────────────────────────────────┐
│                  Computer Use 视觉-动作闭环                                │
│                                                                            │
│   ┌──────────┐         ┌───────────┐         ┌──────────┐               │
│   │ 截屏采集  │────────▶│ 多模态模型 │────────▶│ 动作决策  │               │
│   │(screenshot)│        │(注意力推理) │        │(tool_use) │               │
│   └──────────┘         └───────────┘         └─────┬──────┘               │
│        ▲                                           │                       │
│        │            ┌───────────┐                  │                       │
│        └────────────│ 操作系统   │◀─────────────────┘                       │
│                     │ 执行动作   │                                          │
│                     │(click/type)│                                          │
│                     └───────────┘                                           │
│                                                                            │
│   关键约束：                                                               │
│   - 每一步后必须重新截屏（不能盲操作）                                      │
│   - 坐标基于 display_width_px × display_height_px                          │
│   - 超出 20 步未完成任务应询问用户                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

```typescript
// packages/core/src/computer-use/types.ts

/**
 * Computer Use 工具定义
 * 基于 Anthropic Computer Use API 规范（computer_20241022）
 */
export type ComputerAction =
  | { type: 'screenshot' }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { type: 'double_click'; x: number; y: number }
  | { type: 'triple_click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'key'; text: string }         // 组合键如 "Enter", "Control+a"
  | { type: 'scroll'; x: number; y: number; scroll_x: number; scroll_y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'drag'; path: Array<{ x: number; y: number }> }
  | { type: 'wait'; duration_ms: number }
  | { type: 'screenshot_region'; x: number; y: number; width: number; height: number };

export interface DisplayConfig {
  width_px: number;      // 1024（标准要求）
  height_px: number;     // 768（标准要求）
  display_number: number; // 多屏时显示器编号
  scale_factor: number;   // HiDPI 缩放因子
}

export interface ScreenshotResult {
  base64: string;
  mimeType: 'image/png';
  displayConfig: DisplayConfig;
  timestamp: string;
  // 图像质量元数据
  fileSizeBytes: number;
  width: number;
  height: number;
}

export interface ComputerToolDefinition {
  type: 'computer_20241022';
  name: 'computer';
  display_width_px: number;
  display_height_px: number;
  display_number: number;
}

/**
 * Computer Use 工具定义的 JSON Schema（传给 LLM）
 */
export function getComputerToolSchema(display: DisplayConfig): ComputerToolDefinition {
  return {
    type: 'computer_20241022',
    name: 'computer',
    display_width_px: display.width_px,
    display_height_px: display.height_px,
    display_number: display.display_number,
  };
}
```

### 2.2 Computer Tool Schema 定义

**工程逻辑**：Computer Use 的工具调用协议高度标准化。模型每次输出一个 `tool_use` 块，包含 action 类型和前端执行器所需的全部参数。

```typescript
// packages/core/src/computer-use/tool-calling.ts

/**
 * 工具调用的 JSON Schema（在 tool definition 中传给 LLM）
 * 
 * 这个 schema 告诉模型：computer 工具有哪些 action，
 * 各 action 需要什么参数，参数的类型和约束。
 */
export const computerToolInputSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'screenshot',
        'left_click', 'right_click', 'middle_click',
        'double_click', 'triple_click',
        'left_click_drag',
        'type', 'key',
        'scroll_up', 'scroll_down', 'scroll_left', 'scroll_right',
        'mouse_move',
        'wait',
      ],
      description: 'The type of action to perform',
    },
    // --- 坐标类参数 ---
    coordinate: {
      type: 'array',
      items: { type: 'integer' },
      minItems: 2,
      maxItems: 2,
      description: '[x, y] coordinates for click/move/drag actions. Origin is top-left.',
    },
    // --- 文本类参数 ---
    text: {
      type: 'string',
      description: 'Text to type or key to press (e.g., "Enter", "Control+c")',
    },
    // --- 滚动参数 ---
    scroll_amount: {
      type: 'integer',
      description: 'Amount to scroll (positive=down/right, negative=up/left)',
      default: 3,
    },
    // --- 等待参数 ---
    duration_ms: {
      type: 'integer',
      description: 'Duration to wait in milliseconds',
      default: 1000,
      minimum: 100,
      maximum: 30000,
    },
  },
  required: ['action'],
} as const;

/**
 * 完整的 Tool Definition 清单（和 bash_20241022、str_replace_editor 一起传给 Claude）
 */
export function getToolsForComputerUse(display: DisplayConfig) {
  return [
    getComputerToolSchema(display),
    {
      type: 'bash_20241022',
      name: 'bash',
    },
    {
      type: 'text_editor_20241022',
      name: 'str_replace_editor',
    },
  ];
}
```

### 2.3 执行循环实现

**工程逻辑**：Computer Use 的执行循环是最考验工程能力的模块。关键约束是：**每次 action 执行后必须把最新截图回传给模型**，模型基于新截图决定下一步。这个循环有三个失败路径需要处理：

1. **截图为空/全黑**：前置条件不满足
2. **坐标越界**：模型输出超出显示区域
3. **超时**：单步动作超过预期时间

```typescript
// packages/core/src/computer-use/executor.ts

export interface ComputerUseSession {
  id: string;
  displayConfig: DisplayConfig;
  aim: string;           // 用户原始意图
  maxSteps: number;      // 默认 50
  currentStep: number;
  screenshotHistory: ScreenshotResult[];
  actionHistory: ComputerAction[];
  status: 'running' | 'paused' | 'completed' | 'failed';
  auditLog: AuditEntry[];
}

export interface AuditEntry {
  timestamp: string;
  action: ComputerAction;
  screenshotBefore: string;  // 截图 base64
  screenshotAfter: string;   // 执行动作后的截图 base64
  modelReasoning: string;   // 模型为何选择这个动作
  executed: boolean;
  error?: string;
}

export interface ComputerUseExecutorConfig {
  maxSteps: number;
  confirmationThreshold: 'none' | 'medium' | 'high'; // 安全级别
  confirmationCallback?: (action: ComputerAction, context: { reason: string }) => Promise<boolean>;
  actionHandler: (action: ComputerAction) => Promise<{ success: boolean; error?: string }>;
  screenshotProvider: () => Promise<ScreenshotResult>;
  modelCall: (messages: any[]) => Promise<any>;
  onStepComplete?: (step: number, action: ComputerAction, result: any) => void;
  onAuditLog?: (entry: AuditEntry) => void;
}

export class ComputerUseExecutor {
  session: ComputerUseSession | null = null;

  constructor(private config: ComputerUseExecutorConfig) {}

  /**
   * 启动 Computer Use 闭环
   */
  async start(
    aim: string,
    displayConfig: DisplayConfig,
  ): Promise<ComputerUseSession> {
    this.session = {
      id: randomUUID(),
      displayConfig,
      aim,
      maxSteps: this.config.maxSteps,
      currentStep: 0,
      screenshotHistory: [],
      actionHistory: [],
      status: 'running',
      auditLog: [],
    };

    return this.runLoop();
  }

  /**
   * 主执行循环
   */
  private async runLoop(): Promise<ComputerUseSession> {
    while (!this.session || this.session.currentStep >= this.session.maxSteps) break;
    if (this.session.status !== 'running') break;

    try {
      // 1. 获取当前屏幕截图
      const screenshot = await this.config.screenshotProvider();
      this.session.screenshotHistory.push(screenshot);

      // 2. 构建 prompt：先前的截图历史 + 当前截图 + 用户意图
      const messages = this.buildMessages(screenshot);

      // 3. 调用模型，获取下一个动作
      const response = await this.config.modelCall(messages);

      // 4. 解析工具调用
      const toolCalls = this.parseToolCalls(response);

      // 5. 执行每个工具调用
      for (const toolCall of toolCalls) {
        if (toolCall.name === 'computer') {
          const action = toolCall.input as ComputerAction;

          // 安全检查：确认是否需要用户确认
          const confirmed = await this.handleConfirmation(action);
          if (!confirmed) {
            return this.complete('paused', 'User denied confirmation');
          }

          // 执行前截图（审计用）
          const screenshotBefore = screenshot.base64;

          // 执行动作
          const result = await this.config.actionHandler(action);

          // 记录审计日志
          const auditEntry: AuditEntry = {
            timestamp: new Date().toISOString(),
            action,
            screenshotBefore,
            screenshotAfter: '', // 下次循环会更新
            modelReasoning: response.content?.find((c: any) => c.type === 'text')?.text ?? '',
            executed: result.success,
            error: result.error,
          };
          this.session.auditLog.push(auditEntry);
          this.config.onAuditLog?.(auditEntry);

          if (!result.success) {
            // 注入错误反馈让模型重试
            this.injectErrorFeedback(result.error!);
          }

          this.session.actionHistory.push(action);
        }
      }

      this.session.currentStep++;
      this.config.onStepComplete?.(
        this.session.currentStep,
        this.session.actionHistory[this.session.actionHistory.length - 1],
        { messages, toolCalls }
      );

      // 6. 检查是否调用了 stop 条件（stop_reason: end_turn）
      if (this.isComplete(response)) {
        return this.complete('completed', 'Task completed by model');
      }
    } catch (error) {
      return this.complete('failed', (error as Error).message);
    }

    return this.complete('completed', 'Max steps reached');
  }

  /**
   * 将历史截图 + 当前截图构建为多模态消息
   */
  private buildMessages(currentScreenshot: ScreenshotResult): any[] {
    const messages: any[] = [];

    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: currentScreenshot.base64,
          },
        },
        {
          type: 'text',
          text: `You are operating a computer. Here is the current screen screenshot. Your task: "${this.session?.aim}". Output a tool call to interact with the screen. Use screenshot() to re-capture if the screen has changed, click(x,y) to interact, type() to input text, key() for keyboard shortcuts, scroll() to scroll.`,
        },
      ],
    });

    return messages;
  }

  /**
   * 安全检查：确认是否需要用户手动确认
   */
  private async handleConfirmation(action: ComputerAction): Promise<boolean> {
    if (this.config.confirmationThreshold === 'none') return true;

    const isDestructive = this.isDestructiveAction(action);
    if (!isDestructive) return true;

    if (this.config.confirmationCallback) {
      return this.config.confirmationCallback(action, {
        reason: `Destructive action detected: ${action.type}`,
      });
    }

    return true;
  }

  /**
   * 判断动作是否具有破坏性
   */
  private isDestructiveAction(action: ComputerAction): boolean {
    if (action.type === 'scroll' || action.type === 'move' || action.type === 'wait') {
      return false;
    }
    // click 和 type 通常不需要确认，除非在特定场景
    return false;
  }

  private parseToolCalls(response: any): any[] {
    return response.content?.filter((block: any) => block.type === 'tool_use') ?? [];
  }

  private isComplete(response: any): boolean {
    return response.stop_reason === 'end_turn';
  }

  private injectErrorFeedback(error: string): void {
    // 将错误信息注入到消息历史中，让模型知道上一步失败了
    // 实现略
  }

  private complete(status: ComputerUseSession['status'], reason: string): ComputerUseSession {
    if (!this.session) throw new Error('No active session');
    this.session.status = status;
    console.log(`[ComputerUse] Session ${this.session.id} ${status}: ${reason}`);
    return this.session;
  }
}
```

### 2.4 安全层：确认与审计

**工程逻辑**：Computer Use 开了「让 AI 操作真实计算机」的大门，安全至关重要。核心安全措施：

1. **破坏性操作确认**：删除、支付、表单提交等需要人工确认
2. **截图审计轨迹**：每个动作前后都截图，可追溯
3. **坐标白名单**：可限制模型只能点击特定区域
4. **动作频率限制**：防止模型"狂点"

```typescript
// packages/core/src/computer-use/safety.ts

export type SafetyLevel = 'permissive' | 'standard' | 'strict';

export interface SafetyPolicy {
  level: SafetyLevel;
  blockedActions: ComputerAction['type'][];
  confirmActions: ComputerAction['type'][];
  coordinateWhitelist?: Array<{ x: number; y: number; radius: number }>;
  maxActionsPerMinute: number;
  requireHumanPassword: boolean;
  blockedUrls: string[];        // 禁止访问的域名
  requireConfirmationPatterns: RegExp[];  // 匹配到则询问
}

export const SAFETY_POLICIES: Record<SafetyLevel, SafetyPolicy> = {
  permissive: {
    level: 'permissive',
    blockedActions: [],
    confirmActions: ['drag'],
    maxActionsPerMinute: 30,
    requireHumanPassword: false,
    blockedUrls: [],
    requireConfirmationPatterns: [],
  },
  standard: {
    level: 'standard',
    blockedActions: [],
    confirmActions: ['drag'],
    maxActionsPerMinute: 15,
    requireHumanPassword: true,
    blockedUrls: ['paypal.com', 'stripe.com', 'github.com/settings'],
    requireConfirmationPatterns: [
      /delete|remove|uninstall/i,
      /payment|purchase|subscribe/i,
      /password|secret|credential/i,
    ],
  },
  strict: {
    level: 'strict',
    blockedActions: ['drag'],
    confirmActions: ['click', 'key', 'type'],
    maxActionsPerMinute: 5,
    requireHumanPassword: true,
    blockedUrls: ['*'],  // 禁止所有网络访问，仅操作本地应用
    requireConfirmationPatterns: [/.*/],  // 所有动作都确认
  },
};

export class SafetyGuard {
  private actionTimestamps: number[] = [];

  constructor(private policy: SafetyPolicy) {}

  /**
   * 检查动作是否可通过安全策略
   */
  check(action: ComputerAction, context: { pageUrl?: string; pageText?: string }): SafetyCheckResult {
    // 检查动作类型是否被禁止
    if (this.policy.blockedActions.includes(action.type)) {
      return { allowed: false, reason: `Action "${action.type}" is blocked by policy "${this.policy.level}"` };
    }

    // 检查 URL 黑名单
    if (context.pageUrl) {
      for (const blocked of this.policy.blockedUrls) {
        if (blocked === '*' || context.pageUrl.includes(blocked)) {
          return { allowed: false, reason: `URL blocked: ${context.pageUrl}` };
        }
      }
    }

    // 检查频率限制
    this.actionTimestamps = this.actionTimestamps.filter(
      (t) => Date.now() - t < 60_000,
    );
    if (this.actionTimestamps.length >= this.policy.maxActionsPerMinute) {
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${this.policy.maxActionsPerMinute} actions/min`,
      };
    }

    // 检查是否需要确认
    if (this.policy.confirmActions.includes(action.type)) {
      const needsConfirmation = this.policy.requireConfirmationPatterns.some((p) => {
        const text = action.type === 'type' ? (action as any).text : context.pageText || '';
        return p.test(text);
      });

      if (needsConfirmation) {
        return { allowed: true, requiresConfirmation: true, reason: 'Confirmation required' };
      }
    }

    this.actionTimestamps.push(Date.now());
    return { allowed: true, requiresConfirmation: false };
  }
}

export interface SafetyCheckResult {
  allowed: boolean;
  requiresConfirmation?: boolean;
  reason: string;
}
```

### 2.5 本地替代：Playwright/Puppeteer

**工程逻辑**：Computer Use 依赖截图+坐标的"像素级"操控，这在本地环境（Headless Browser）可以用更精确的 DOM 方式替代。Playwright/Puppeteer 提供基于 Accessibility Tree 或 CSS Selector 的精确元素定位，比坐标点击更可靠。

```typescript
// packages/core/src/computer-use/playwright-adapter.ts

import { chromium, Browser, Page } from 'playwright';

export interface PlaywrightComputerConfig {
  headless: boolean;
  viewport: { width: number; height: number };
  allowedDomains: string[];
  userAgent?: string;
}

/**
 * 将 Computer Use 的 action 翻译为 Playwright 调用
 * 优势：基于 DOM selector 而非坐标，更精确
 * 劣势：不能操控非浏览器应用（桌面应用、系统设置）
 */
export class PlaywrightComputerAdapter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private auditLog: AuditEntry[] = [];

  constructor(private config: PlaywrightComputerConfig) {}

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
    });
    this.page = await this.browser.newPage({
      viewport: this.config.viewport,
      userAgent: this.config.userAgent,
    });

    // 限制只能访问白名单域名
    if (this.config.allowedDomains.length > 0) {
      this.page.route('**/*', (route) => {
        const url = route.request().url();
        if (this.config.allowedDomains.some((d) => url.includes(d))) {
          route.continue();
        } else {
          route.abort();
        }
      });
    }
  }

  /**
   * 将 Computer Use 动作转化为 Playwright 操作
   */
  async executeAction(action: ComputerAction): Promise<{ success: boolean; error?: string }> {
    if (!this.page) throw new Error('Browser not initialized');

    try {
      switch (action.type) {
        case 'screenshot':
          return { success: true };

        case 'click':
        case 'left_click': {
          // 优先用 aria-label / text 定位，fallback 到坐标
          const handle = await this.locateElementAt(action.x, action.y);
          if (handle) {
            await handle.click();
          } else {
            await this.page.mouse.click(action.x, action.y);
          }
          return { success: true };
        }

        case 'type':
          await this.page.keyboard.type(action.text, { delay: 50 });
          return { success: true };

        case 'key':
          await this.page.keyboard.press(action.text);
          return { success: true };

        case 'scroll':
        case 'scroll_down':
          await this.page.mouse.wheel(0, action.scroll_y ?? 300);
          return { success: true };

        case 'scroll_up':
          await this.page.mouse.wheel(0, -(action.scroll_y ?? 300));
          return { success: true };

        default:
          // 通用 fallback：直接用坐标
          await this.page.mouse.click(action.x ?? 0, action.y ?? 0);
          return { success: true };
      }
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * 获取当前截图
   */
  async takeScreenshot(): Promise<ScreenshotResult> {
    if (!this.page) throw new Error('Browser not initialized');
    const buffer = await this.page.screenshot({ type: 'png' });
    const base64 = buffer.toString('base64');
    return {
      base64,
      mimeType: 'image/png',
      displayConfig: {
        width_px: this.config.viewport.width,
        height_px: this.config.viewport.height,
        display_number: 1,
        scale_factor: 1,
      },
      timestamp: new Date().toISOString(),
      fileSizeBytes: buffer.length,
      width: this.config.viewport.width,
      height: this.config.viewport.height,
    };
  }

  /**
   * 尝试通过 Accessibility Tree 找到坐标对应的 DOM 元素
   * 这比纯坐标更可靠，因为有语义信息
   */
  private async locateElementAt(x: number, y: number): Promise<any | null> {
    if (!this.page) return null;

    // 方法1：通过 elementFromPoint 获取 DOM 元素
    const handle = await this.page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y) as HTMLElement;
        if (!el) return null;
        // 返回一个有唯一标识的元素
        return {
          ariaLabel: el.getAttribute('aria-label'),
          text: el.textContent?.trim()?.slice(0, 50),
          tagName: el.tagName,
          role: el.getAttribute('role'),
          id: el.id,
        };
      },
      [x, y],
    );

    if (handle?.ariaLabel) {
      return this.page.locator(`[aria-label="${handle.ariaLabel}"]`).first();
    }

    return null;
  }

  /**
   * 获取当前页面的可访问性树（给 AI 决策参考）
   */
  async getAccessibilityTree(): Promise<any> {
    if (!this.page) return null;
    return this.page.locator('body').ariaSnapshot();
  }

  async dispose(): Promise<void> {
    await this.browser?.close();
  }
}
```

### 2.6 与多模态理解的集成

**工程逻辑**：Computer Use 依赖模型"看懂"截图——这和多模态 Agent（参见节点 16）的图片理解能力共享底层技术：Vision Transformer 编码、图像 Token 化、视觉-语言对齐。区别在于 MultiModal Agent 更关注"理解内容"，Computer Use 更关注"基于内容做动作"。

```typescript
// packages/core/src/computer-use/multimodal-integration.ts

/**
 * Computer Use 如何复用多模态模型能力
 * 
 * 核心链路：
 * 1. Screenshot → Vision Encoder → Image Tokens
 * 2. Image Tokens + Task Description → LLM 推理
 * 3. LLM 推理 → Tool Call（click/type/scroll）
 * 4. 执行 → 新 Screenshot → 循环
 * 
 * 与 MultiModal Agent（节点 16）的区别：
 * - MultiModal: "理解这张图讲了什么" → 文本回答
 * - Computer Use: "理解这张图 + 决定下一步操作" → 动作输出
 * 
 * 与 Structured Output（节点 13）的关系：
 * - Computer Use 的 tool_use 输出必须严格符合 JSON Schema
 * - 任何格式偏差都会导致前端执行器解析失败
 */

/**
 * 为 Computer Use 构建多模态消息
 * 关键：截图必须以 base64 内联，不能传 URL（安全+延迟）
 */
export function buildComputerUseMessage(
  history: Array<{ action: ComputerAction; screenshot: ScreenshotResult }>,
  currentScreenshot: ScreenshotResult,
  task: string,
): any {
  const content: any[] = [];

  // 当前截图（最重要，必须在最前面）
  content.push({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: currentScreenshot.base64,
    },
  });

  // 任务描述
  content.push({
    type: 'text',
    text: `Task: ${task}\n\nHistory of ${history.length} actions. Current screen shown. Decide the next action.`,
  });

  // 可选：历史截图摘要（仅文字描述，不传原图以节省 token）
  if (history.length > 0) {
    const summary = history
      .slice(-3)
      .map((h, i) => `${i + 1}. ${h.action.type} → success`)
      .join('\n');
    content.push({
      type: 'text',
      text: `Last 3 actions:\n${summary}`,
    });
  }

  return {
    role: 'user',
    content,
  };
}
```

---

## 3. CLI/Headless 无头模式

### 3.1 Headless 模式核心参数

**工程逻辑**：CLI/Headless 模式让 Agent 在没有人类 UI 交互的情况下运行，由脚本、Webhook、CI/CD 触发。核心价值：可自动化、可管道化、可调度。关键特性是 `Agent = Model + Harness`——模型负责推理，Harness 负责执行和管控制。

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Headless Mode 全景                                    │
│                                                                            │
│   ┌────────┐    ┌──────────┐    ┌───────────┐    ┌────────────┐         │
│   │  CI/CD │───▶│  CLI     │───▶│  Harness  │───▶│ Structured │         │
│   │ 触发    │    │ 参数解析 │    │ 循环执行  │    │ Output     │         │
│   └────────┘    └──────────┘    └─────┬─────┘    └────────────┘         │
│                                       │                                  │
│                        ┌──────────────┴───────────────┐                  │
│                        │  Constraints                  │                  │
│                        │  - --max-turns (最大轮次)     │                  │
│                        │  - --allowedTools (工具白名单) │                  │
│                        │  - --output-format (输出格式)  │                  │
│                        └──────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────────────┘
```

```typescript
// packages/core/src/headless/types.ts

export type OutputFormat = 'text' | 'json' | 'stream-json';
export type PermissionMode = 'default' | 'bypassPermissions' | 'strict';

export interface HeadlessSessionConfig {
  // 输入
  prompt: string;
  stdin?: string;              // 可选的 stdin 输入
  workingDir: string;
  
  // 执行约束
  maxTurns: number;            // 默认 10，防止无限循环
  allowedTools: string[];      // 允许调用的工具白名单
  disallowedTools: string[];   // 黑名单
  permissionMode: PermissionMode;
  
  // 输出
  outputFormat: OutputFormat;
  verbose: boolean;
  includeCost: boolean;        // 是否包含 token 成本信息
  
  // 恢复/调度
  sessionId?: string;          // 恢复会话
  resumeBackground: boolean;   // 后台运行
  cronExpression?: string;     // 定时调度
  webhookUrl?: string;         // 完成通知
  
  // 安全
  sandboxRoot: string;         // 限制只能操作此目录
  maxFileSizeBytes: number;    // 最大文件读写
  timeoutSeconds: number;      // 整体超时
}

export const DEFAULT_HEADLESS_CONFIG: Pick<
  HeadlessSessionConfig,
  'maxTurns' | 'outputFormat' | 'verbose' | 'includeCost' | 'permissionMode'
> = {
  maxTurns: 10,
  outputFormat: 'text',
  verbose: false,
  includeCost: false,
  permissionMode: 'default',
};

/**
 * Headless 配置的 CLI 参数解析
 */
export function parseHeadlessArgs(argv: string[]): HeadlessSessionConfig {
  // 实际使用 commander 或 yargs 解析
  // 这里展示核心参数映射
  const args = {
    prompt: '',
    workingDir: process.cwd(),
    maxTurns: DEFAULT_HEADLESS_CONFIG.maxTurns,
    outputFormat: DEFAULT_HEADLESS_CONFIG.outputFormat as OutputFormat,
    verbose: DEFAULT_HEADLESS_CONFIG.verbose,
    permissionMode: DEFAULT_HEADLESS_CONFIG.permissionMode as PermissionMode,
    allowedTools: [] as string[],
    disallowedTools: [] as string[],
    stdin: undefined as string | undefined,
    sessionId: undefined as string | undefined,
    resumeBackground: false,
    includeCost: DEFAULT_HEADLESS_CONFIG.includeCost,
    cronExpression: undefined as string | undefined,
    webhookUrl: undefined as string | undefined,
    sandboxRoot: process.cwd(),
    maxFileSizeBytes: 10 * 1024 * 1024, // 10MB
    timeoutSeconds: 600, // 10 min
  };

  // 伪代码：实际解析逻辑
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--max-turns') args.maxTurns = parseInt(argv[++i]);
    if (arg === '--output-format') args.outputFormat = argv[++i] as OutputFormat;
    if (arg === '--allowedTools') args.allowedTools = argv[++i].split(',');
    if (arg === '--permission-mode') args.permissionMode = argv[++i] as PermissionMode;
    if (arg === '--sessionId') args.sessionId = argv[++i];
    if (arg === '--resume') args.resumeBackground = true;
    if (arg === '--cron') args.cronExpression = argv[++i];
  }

  return args;
}
```

### 3.2 输出格式设计

**工程逻辑**：Headless 模式有三种输出格式，各有适用场景。`text` 适合人读但脚本解析痛苦；`stream-json` 是流式结构化事件流，适合实时消费；`json` 是最终一次性 JSON 输出，适合简单的批量处理。

```typescript
// packages/core/src/headless/output-formatter.ts

/**
 * Stream-JSON 事件类型
 * 每个事件是一个 JSON 对象，以换行分隔（NDJSON）
 * 适用于：实时监控、进度追踪、流水线集成
 */
export type StreamEvent =
  | { type: 'system'; subtype: 'init'; sessionId: string; model: string; timestamp: string }
  | { type: 'assistant'; subtype: 'text'; text: string; timestamp: string }
  | { type: 'assistant'; subtype: 'tool_use'; tool: string; input: any; toolUseId: string; timestamp: string }
  | { type: 'user'; subtype: 'tool_result'; toolUseId: string; content: any; isError?: boolean; timestamp: string }
  | { type: 'result'; subtype: 'success'; summary: string; durationMs: number; totalCost: number; numTurns: number }
  | { type: 'result'; subtype: 'error'; error: string; errorCode: string; numTurns: number }
  | { type: 'progress'; currentTurn: number; maxTurns: number; note?: string };

/**
 * 输出格式化器
 * 根据 OutputFormat 决定如何将内部事件序列化为 CLI 输出
 */
export class OutputFormatter {
  private streamBuffer: string[] = [];

  constructor(private format: OutputFormat) {}

  emit(event: StreamEvent): void {
    switch (this.format) {
      case 'text':
        this.emitText(event);
        break;
      case 'json':
        this.streamBuffer.push(JSON.stringify(event));
        break;
      case 'stream-json':
        process.stdout.write(JSON.stringify(event) + '\n');
        break;
    }
  }

  private emitText(event: StreamEvent): void {
    switch (event.type) {
      case 'assistant':
        if (event.subtype === 'text') {
          process.stdout.write(event.text);
        } else if (event.subtype === 'tool_use') {
          if (process.env.VERBOSE) {
            process.stderr.write(`\n[tool:${event.tool}] ${JSON.stringify(event.input)}\n`);
          }
        }
        break;
      case 'result':
        if (event.subtype === 'success') {
          process.stderr.write(
            `\n✓ Completed in ${event.durationMs}ms (${event.numTurns} turns, $${event.totalCost.toFixed(4)})\n`,
          );
        } else {
          process.stderr.write(
            `\n✗ Error: ${event.error} (code: ${event.errorCode}, after ${event.numTurns} turns)\n`,
          );
        }
        break;
    }
  }

  /**
   * Finalize（仅在 json 模式下输出完整 JSON）
   */
  finalize(): void {
    if (this.format === 'json') {
      const events = this.streamBuffer
        .map((line) => JSON.parse(line) as StreamEvent)
        .filter((e) => e.type === 'result');

      process.stdout.write(JSON.stringify(events[events.length - 1] ?? {}, null, 2));
    }
  }

  /**
   * 退出码计算
   */
  static getExitCode(lastEvent: StreamEvent): number {
    if (lastEvent.type === 'result') {
      return lastEvent.subtype === 'success' ? 0 : 1;
    }
    if (lastEvent.type === 'result' && lastEvent.subtype === 'error') {
      // 特定错误码映射
      if ('errorCode' in lastEvent) {
        const errorCode = (lastEvent as any).errorCode;
        if (errorCode === 'MAX_TURNS_EXCEEDED') return 2;
        if (errorCode === 'TIMEOUT') return 3;
        if (errorCode === 'TOOL_PERMISSION_DENIED') return 4;
        if (errorCode === 'AUTH_FAILURE') return 5;
      }
      return 1;
    }
    return 0;
  }
}
```

### 3.3 Session Resume 断点续跑

**工程逻辑**：Headless 模式的 Session Resume 是防止"20 分钟工作白费"的关键机制。实现要点：快照内容必须包含足以恢复状态的完整信息（对话历史、工具结果、文件状态摘要）。

```typescript
// packages/core/src/headless/session-resume.ts

export interface SessionSnapshot {
  sessionId: string;
  status: 'active' | 'completed' | 'failed' | 'timeout';
  startedAt: string;
  updatedAt: string;
  config: HeadlessSessionConfig;
  
  // 核心状态
  messages: any[];             // 完整对话历史
  lastToolResults: any[];      // 最近的工具结果
  
  // 执行状态
  currentTurn: number;
  totalTokensUsed: number;
  totalCost: number;
  
  // 文件操作摘要（用于安全检查）
  filesRead: string[];
  filesWritten: string[];
  commandsExecuted: string[];
}

export interface SessionResumeAdapter {
  save(snapshot: SessionSnapshot): Promise<void>;
  load(sessionId: string): Promise<SessionSnapshot | null>;
  list(active: boolean): Promise<SessionSnapshot[]>;
}

/**
 * 判断是否可以从快照恢复
 * 有多个条件必须满足：快照未损坏、依赖工具仍可用、上下文未被截断
 */
export function canResume(snapshot: SessionSnapshot): { can: boolean; reason?: string } {
  // 检查快照完整性
  if (!snapshot.messages?.length) {
    return { can: false, reason: 'Snapshot has no messages (corrupted)' };
  }

  // 检查对话长度是否超出模型上下文
  const estimatedTokens = estimateMessagesTokens(snapshot.messages);
  if (estimatedTokens > 180_000) {
    return {
      can: false,
      reason: `Snapshot too large (${estimatedTokens} tokens > 180K limit); need to start fresh`,
    };
  }

  // 检查工具是否仍然可用
  if (snapshot.config.allowedTools.length > 0) {
    const lastTool = snapshot.messages
      .filter((m: any) => m.role === 'assistant')
      .flatMap((m: any) => m.content ?? [])
      .filter((c: any) => c.type === 'tool_use')
      .pop();
    if (lastTool && !snapshot.config.allowedTools.includes(lastTool.name)) {
      return { can: false, reason: `Required tool "${lastTool.name}" no longer in allowed list` };
    }
  }

  // 检查文件是否还存在
  if (snapshot.filesWritten.length > 0) {
    // 异步检查在外部实现
    return { can: true }; // 假设文件仍存在
  }

  return { can: true };
}

/**
 * 恢复会话后的首条消息
 * 告诉 Agent "你之前在做这个任务，已到 N/M 轮，继续"
 */
export function buildResumePrompt(snapshot: SessionSnapshot): string {
  return `Resuming session ${snapshot.sessionId}. 
You were working on: "${snapshot.config.prompt}"
Progress: ${snapshot.currentTurn}/${snapshot.config.maxTurns} turns completed.
Last tool results are available. Continue from where you left off.
Summary of previous actions: ${snapshot.commandsExecuted.join(', ')} 
Keys files: ${snapshot.filesWritten.join(', ')}`;
}
```

### 3.4 批量与调度

**工程逻辑**：Headless 模式的真正价值在于自动化。通过 cron 表达式、Webhook 和批量管道，Agent 无需人类触发即可工作。

```typescript
// packages/core/src/headless/scheduler.ts

export interface ScheduledTask {
  id: string;
  name: string;
  config: HeadlessSessionConfig;
  status: 'pending' | 'running' | 'completed' | 'failed';
  
  // 调度配置
  cronExpression?: string;     // "0 9 * * 1-5" = 每个工作日 9 点
  webhookTrigger?: {
    url: string;
    headers?: Record<string, string>;
    authToken?: string;
  };
  runImmediate: boolean;
  
  // 执行策略
  retryOnFailure: boolean;
  maxRetries: number;
  retryDelayMs: number;
  
  // 通知
  notifyOnComplete?: string[];     // email/slack/webhook
  notifyOnError?: string[];
}

export class HeadlessScheduler {
  private cronJobs = new Map<string, any>();
  private adapter: SessionResumeAdapter;

  constructor(adapter: SessionResumeAdapter) {
    this.adapter = adapter;
  }

  /**
   * 注册定时任务
   */
  async schedule(task: ScheduledTask): Promise<void> {
    if (task.cronExpression) {
      const job = setInterval(async () => {
        await this.executeTask(task);
      }, this.cronToMs(task.cronExpression));
      this.cronJobs.set(task.id, job);
    }

    if (task.runImmediate) {
      await this.executeTask(task);
    }
  }

  /**
   * 执行任务（含重试逻辑）
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    let attempt = 0;
    const maxAttempts = task.maxRetries + 1;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const sessionId = randomUUID();
        // 运行 headless session
        const result = await this.runHeadlessSession(task.config, sessionId);
        
        await this.notify(task.notifyOnComplete, { task, result });
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          await this.notify(task.notifyOnError, { task, error });
        } else {
          await sleep(task.retryDelayMs);
        }
      }
    }
  }

  /**
   * 通过 Webhook 触发任务
   */
  async handleWebhook(
    url: string,
    payload: { prompt?: string; config?: Partial<HeadlessSessionConfig> },
  ): Promise<{ taskId: string; status: string }> {
    const task: ScheduledTask = {
      id: randomUUID(),
      name: `webhook-${Date.now()}`,
      config: { ...DEFAULT_HEADLESS_CONFIG, prompt: payload.prompt ?? '', ...payload.config } as HeadlessSessionConfig,
      status: 'pending',
      runImmediate: true,
      retryOnFailure: false,
      maxRetries: 0,
      retryDelayMs: 0,
    };

    await this.executeTask(task);
    return { taskId: task.id, status: task.status };
  }

  /**
   * 批量执行（管道式）
   */
  async batch(
    tasks: HeadlessSessionConfig[],
    concurrency: number = 3,
  ): Promise<{ config: HeadlessSessionConfig; result: any }[]> {
    const results: { config: HeadlessSessionConfig; result: any }[] = [];
    
    // 分批执行，控制并发
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((config) =>
          this.runHeadlessSession(config).catch((error) => ({
            success: false,
            error: error.message,
          })),
        ),
      );
      batch.forEach((config, idx) => {
        results.push({ config, result: batchResults[idx] });
      });
    }

    return results;
  }

  private async runHeadlessSession(
    config: HeadlessSessionConfig,
    sessionId?: string,
  ): Promise<any> {
    // 实际调用 Model Executor
    throw new Error('Not implemented');
  }

  private cronToMs(cron: string): number {
    // 简化：将 cron 转为下次运行的 ms 间隔
    return 60_000; // 假设每分钟
  }

  private async notify(targets: string[] | undefined, data: any): Promise<void> {
    if (!targets?.length) return;
    // 发送通知：email/slack/webwebhook
  }
}
```

### 3.5 错误处理与退出码体系

**工程逻辑**：在 CI/CD 中，退出码是下游判断成功/失败的唯一依据。必须设计清晰的错误码体系，让 CI 脚本能据此做出决策（重试、报回滚、报警）。

```typescript
// packages/core/src/headless/error-codes.ts

export enum HeadlessErrorCode {
  SUCCESS = 0,
  GENERIC_FAILURE = 1,
  MAX_TURNS_EXCEEDED = 2,
  TIMEOUT = 3,
  TOOL_PERMISSION_DENIED = 4,
  AUTH_FAILURE = 5,
  SANDBOX_VIOLATION = 6,
  RESUME_FAILED = 7,
  INVALID_CONFIG = 8,
  MODEL_UNAVAILABLE = 9,
}

export class HeadlessError extends Error {
  constructor(
    public code: HeadlessErrorCode,
    message: string,
    public context?: Record<string, any>,
  ) {
    super(message);
    this.name = 'HeadlessError';
  }

  toJSON(): object {
    return {
      code: this.code,
      codeName: HeadlessErrorCode[this.code],
      message: this.message,
      context: this.context,
    };
  }
}

/**
 * 错误分类与恢复策略
 */
export function getRecoveryStrategy(error: HeadlessError): {
  retryable: boolean;
  fallbackModel?: string;
  userAction?: string;
} {
  switch (error.code) {
    case HeadlessErrorCode.MAX_TURNS_EXCEEDED:
      return {
        retryable: true,
        userAction: 'Increase --max-turns or break the task into smaller steps',
      };
    case HeadlessErrorCode.TIMEOUT:
      return {
        retryable: true,
        userAction: 'Increase --timeout or use --resume to continue later',
      };
    case HeadlessErrorCode.AUTH_FAILURE:
      return {
        retryable: false,
        userAction: 'Check API key and permissions',
      };
    case HeadlessErrorCode.TOOL_PERMISSION_DENIED:
      return {
        retryable: false,
        userAction: `Add "${error.context?.tool}" to --allowedTools`,
      };
    case HeadlessErrorCode.SANDBOX_VIOLATION:
      return {
        retryable: false,
        userAction: `File access outside sandbox: ${error.context?.path}`,
      };
    case HeadlessErrorCode.RESUME_FAILED:
      return {
        retryable: true,
        userAction: 'Start a new session instead of resuming',
      };
    case HeadlessErrorCode.MODEL_UNAVAILABLE:
      return {
        retryable: true,
        fallbackModel: 'claude-3-5-sonnet-20241022',
      };
    default:
      return { retryable: false };
  }
}

/**
 * 标准管道命令模板
 * 用于 CI、Git Hooks、自动化脚本
 */
export const PIPELINE_TEMPLATES = {
  // 代码审查
  codeReview: (files: string) =>
    `claude -p "Review this code for bugs, security issues, and code quality: ${files}" --permission-mode bypassPermissions --output-format stream-json --verbose`,

  // Git Hook: commit message 检查
  commitCheck: () =>
    `claude -p "Analyze this commit message for clarity and convention compliance: $(git log -1 --pretty=%B)" --output-format text`,

  // Issue 自动分类
  issueClassifier: (body: string) =>
    `claude -p "Classify this GitHub issue and suggest labels: ${body}" --output-format json`,

  // 安全审查
  securityAudit: (changes: string) =>
    `claude -p "Security audit of these code changes: ${changes}" --permission-mode strict --allowedTools "Read,Bash,Glob,Grep" --max-turns 30 --output-format stream-json`,

  // 文档翻译
  translate: (file: string, targetLang: string) =>
    `claude -p "Translate ${file} to ${targetLang}. Preserve formatting and technical terms." --output-format text`,
};
```

---

## 4. AskUserQuestion 澄清提问

### 4.1 何时提问 vs 何时假设

**工程逻辑**：AskUserQuestion 的核心是"最小化交互"原则——只在关键歧义点提问，而非事无巨细都问。过度提问是 CI 用户体验的头号杀手。

```typescript
// packages/core/src/ask-user-question/decision.ts

export interface AmbiguityContext {
  questionType: 'goal' | 'constraint' | 'format' | 'scope' | 'target';
  severity: 'critical' | 'moderate' | 'minor';
  defaultValue?: any;
  impactIfWrong: string;  // 如果猜错了会怎样
}

/**
 * 何时应该提问（Ask），何时应该假设（Assume）
 * 
 * 引用 Anthropic 的设计原则：
 * - "Prefer in-line content" → "Prefer making reasonable assumptions"
 * - 只有当歧义会导致错误后果时才提问
 * - 如果猜错的代价很低，不如直接做（让用户再改一次）
 */
export function shouldAskUser(ambiguity: AmbiguityContext): {
  shouldAsk: boolean;
  reason: string;
} {
  // 严重歧义且可能产生重大后果 → 必须提问
  if (ambiguity.severity === 'critical') {
    return {
      shouldAsk: true,
      reason: `Critical ambiguity in ${ambiguity.questionType}: ${ambiguity.impactIfWrong}`,
    };
  }

  // 有合理默认值的中等歧义 → 使用默认值并在回答中说明
  if (ambiguity.severity === 'moderate' && ambiguity.defaultValue !== undefined) {
    return {
      shouldAsk: false,
      reason: `Moderate ambiguity but has reasonable default: ${ambiguity.defaultValue}. Will state assumption.`,
    };
  }

  // 有歧义但猜错的代价很低 → 直接假设
  if (ambiguity.severity === 'minor') {
    return {
      shouldAsk: false,
      reason: `Minor ambiguity, guessing is acceptable; user can correct`,
    };
  }

  return {
    shouldAsk: true,
    reason: `Unresolved ambiguity in ${ambiguity.questionType}`,
  };
}

/**
 * 好的问题 vs 坏的问题示例
 * 
 * ❌ 坏问题（问得太浅）：
 *   "你想用什么编程语言？"（用户说了"帮我写个 web 应用"→默认 React）
 * 
 * ✅ 好问题（问在关键分水岭）：
 *   "这个 API 需要支持用户认证吗？还是纯公开接口？"（两种方案实现完全不同）
 * 
 * ❌ 坏问题（太多选项）：
 *   "选择配色方案：A. 明亮 B. 暗黑 C. 自动 D. 高对比..."（4 个选项让用户焦虑）
 * 
 * ✅ 好问题（二选一）：
 *   "需要支持暗黑模式吗？[是/否]"
 */
```

### 4.2 问题类型与设计

**工程逻辑**：AskUserQuestion 的问题类型决定了 UI 交互形态。三种子类型各有适用场景：

```typescript
// packages/core/src/ask-user-question/types.ts

export type QuestionType = 'multiple_choice' | 'free_text' | 'file_picker' | 'confirmation';

export interface AskUserQuestionPayload {
  id: string;
  question: string;
  context?: string;          // 帮助用户做判断的上下文
  type: QuestionType;
  options?: QuestionOption[]; // multiple_choice 时
  allowMultiple?: boolean;    // 是否多选
  required: boolean;
  defaultValue?: any;
  placeholder?: string;       // free_text 时
  validationRegex?: string;   // free_text 时的验证规则
  dismissable: boolean;       // 是否可跳过
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;      // 推荐选项
  icon?: string;
}

export interface UserAnswer {
  questionId: string;
  value: any;
  answeredAt: string;
  skipped: boolean;
}

/**
 * 问题构建器（Builder）模式
 * 在 Agent reasoning 过程中按需构造问题
 */
export class QuestionBuilder {
  private payload: Partial<AskUserQuestionPayload> = { id: randomUUID() };

  constructor(question: string) {
    this.payload.question = question;
    this.payload.type = 'free_text';
    this.payload.required = true;
    this.payload.dismissable = false;
  }

  withContext(ctx: string): this {
    this.payload.context = ctx;
    return this;
  }

  asMultipleChoice(options: QuestionOption[]): this {
    this.payload.type = 'multiple_choice';
    this.payload.options = options;
    return this;
  }

  asFilePicker(): this {
    this.payload.type = 'file_picker';
    return this;
  }

  asConfirmation(): this {
    this.payload.type = 'confirmation';
    this.payload.options = [
      { id: 'yes', label: 'Yes', recommended: true },
      { id: 'no', label: 'No' },
    ];
    return this;
  }

  withDefault(value: any): this {
    this.payload.defaultValue = value;
    this.payload.dismissable = true;
    return this;
  }

  optional(): this {
    this.payload.required = false;
    return this;
  }

  dismissable(): this {
    this.payload.dismissable = true;
    return this;
  }

  build(): AskUserQuestionPayload {
    return this.payload as AskUserQuestionPayload;
  }
}

// ---- 使用示例 ----

/**
 * 好的问题示例
 */
export const EXAMPLE_GOOD_QUESTIONS = {
  // 选择题：影响架构的关键决策
  authStrategy: new QuestionBuilder('这个 API 需要什么级别的身份验证？')
    .withContext('不同的认证方案影响数据库设计、中间件和部署配置。')
    .asMultipleChoice([
      { id: 'none', label: '无需认证', description: '纯公开接口，任何人可访问', recommended: false },
      { id: 'api_key', label: 'API Key', description: '通过 X-API-Key 头验证，适合服务间调用', recommended: true },
      { id: 'oauth2', label: 'OAuth 2.0', description: '通过第三方身份提供商（Google/GitHub）验证', recommended: false },
      { id: 'jwt', label: 'JWT Token', description: '自包含 Token，适合移动端/SPA', recommended: false },
    ])
    .build(),

  // 文件选择：需要知道文件位置
  targetFile: new QuestionBuilder('请提供需要分析的文件路径')
    .asFilePicker()
    .optional()
    .build(),

  // 确认：需要用户认可
  deployConfirmation: new QuestionBuilder('确定要部署到生产环境吗？')
    .withContext('这将影响线上用户。')
    .asConfirmation()
    .build(),
};
```

### 4.3 异步暂停/恢复协议

**工程逻辑**：Agent 提问后必须"暂停"（发出 pause_turn），用户回答后"恢复"继续推理。这要求 Harness 支持可中断的执行循环——不能在等待时占用进程或 token 配额。

```typescript
// packages/core/src/ask-user-question/pause-resume.ts

export type ExecutionPhase = 'reasoning' | 'waiting_for_input' | 'resuming' | 'completed';

export interface PauseState {
  sessionId: string;
  pausedAt: string;
  pendingQuestion: AskUserQuestionPayload;
  conversationState: any;     // 完整的对话上下文序列化
  resumeToken: string;        // 恢复令牌（防伪造）
}

/**
 * AskUserQuestion 驱动的可中断执行循环
 * 
 * 核心流程：
 * 1. Agent 决定提问 → 发出 AskUserQuestion tool_use
 * 2. Harness 暂停循环 → 保存快照
 * 3. 前端收到问题 → 用户回答
 * 4. Harness 收到用户答案 → 恢复循环
 * 5. Agent 基于答案继续推理
 */
export class PausableExecutor {
  private phase: ExecutionPhase = 'reasoning';
  private pauseState: PauseState | null = null;
  private snapshotAdapter: PauseSnapshotAdapter;

  constructor(private config: {
    modelCall: (messages: any[]) => Promise<any>;
    toolHandler: (toolUse: any) => Promise<any>;
    onPause: (state: PauseState) => void;
    onResume: (state: PauseState) => void;
    maxResumeAttempts: number;
  }) {
    this.snapshotAdapter = new RedisPauseSnapshotAdapter(); // 实现略
  }

  /**
   * 执行一段 Agent reasoning
   * 如果遇到 AskUserQuestion，会暂停并返回
   */
  async run(messages: any[]): Promise<ExecutorResult> {
    let currentMessages = [...messages];
    let turns = 0;

    while (turns < 50) {
      turns++;
      const response = await this.config.modelCall(currentMessages);
      
      // 检查是否调用了 AskUserQuestion 工具
      const askQuestionCall = response.content?.find(
        (c: any) => c.type === 'tool_use' && c.name === 'AskUserQuestion',
      );

      if (askQuestionCall) {
        // 暂停循环
        this.phase = 'waiting_for_input';
        this.pauseState = await this.pause(askQuestionCall.input, currentMessages);
        this.config.onPause(this.pauseState);
        return { status: 'waiting_for_user_input', question: askQuestionCall.input };
      }

      // 检查是否还有其他工具调用
      const toolCalls = response.content?.filter((c: any) => c.type === 'tool_use') ?? [];
      if (toolCalls.length === 0 && response.stop_reason === 'end_turn') {
        this.phase = 'completed';
        return { status: 'completed', messages: currentMessages, response };
      }

      // 执行工具并继续
      const toolResults = await Promise.all(
        toolCalls.map((tc: any) => this.config.toolHandler(tc)),
      );

      currentMessages = [
        ...currentMessages,
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: toolResults.map((r: any, i: number) => ({
            type: 'tool_result',
            tool_use_id: toolCalls[i].id,
            content: r,
          })),
        },
      ];
    }

    return { status: 'max_turns_exceeded', messages: currentMessages };
  }

  /**
   * 回答问题后恢复执行
   */
  async resume(
    questionId: string,
    answer: UserAnswer,
  ): Promise<ExecutorResult> {
    if (!this.pauseState) {
      throw new Error('No active pause state to resume from');
    }
    if (this.pauseState.pendingQuestion.id !== questionId) {
      throw new Error(`Question ID mismatch: expected ${this.pauseState.pendingQuestion.id}, got ${questionId}`);
    }

    this.phase = 'resuming';

    // 注入用户答案
    const toolResultMessage = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: questionId,
          content: JSON.stringify(answer),
        },
      ],
    };

    const resumedMessages = [
      ...this.pauseState.conversationState,
      toolResultMessage,
    ];

    this.config.onResume(this.pauseState);
    this.pauseState = null;
    this.phase = 'reasoning';

    return this.run(resumedMessages);
  }

  private async pause(
    question: AskUserQuestionPayload,
    conversationState: any[],
  ): Promise<PauseState> {
    const state: PauseState = {
      sessionId: randomUUID(),
      pausedAt: new Date().toISOString(),
      pendingQuestion: question,
      conversationState,
      resumeToken: randomUUID().replace(/-/g, ''),
    };

    await this.snapshotAdapter.save(state);
    return state;
  }

  get currentPhase(): ExecutionPhase {
    return this.phase;
  }
}

export interface ExecutorResult {
  status: 'completed' | 'waiting_for_user_input' | 'max_turns_exceeded';
  messages?: any[];
  response?: any;
  question?: AskUserQuestionPayload;
}

export interface PauseSnapshotAdapter {
  save(state: PauseState): Promise<void>;
  load(sessionId: string): Promise<PauseState | null>;
}
```

### 4.4 前端组件实现

**工程逻辑**：AskUserQuestion 的前端组件需要能：中断正常对话流、接受多种输入类型、answer 后无缝恢复。

```typescript
// packages/web/src/components/AskUserQuestionPanel.tsx

import React, { useState } from 'react';

interface AskUserQuestionPanelProps {
  question: AskUserQuestionPayload;
  onAnswer: (answer: UserAnswer) => void;
  onSkip?: () => void;
}

export const AskUserQuestionPanel: React.FC<AskUserQuestionPanelProps> = ({
  question,
  onAnswer,
  onSkip,
}) => {
  const [selected, setSelected] = useState<string[]>(
    question.defaultValue ? [question.defaultValue] : [],
  );
  const [freeText, setFreeText] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const handleSubmit = () => {
    let value: any;
    switch (question.type) {
      case 'multiple_choice':
        value = question.allowMultiple ? selected : selected[0];
        break;
      case 'free_text':
        value = freeText;
        break;
      case 'file_picker':
        value = files.map((f) => f.name);
        break;
      case 'confirmation':
        value = selected[0] === 'yes';
        break;
    }

    onAnswer({
      questionId: question.id,
      value,
      answeredAt: new Date().toISOString(),
      skipped: false,
    });
  };

  return (
    <div className="ask-user-question-panel">
      <div className="question-card">
        {question.context && (
          <div className="question-context">{question.context}</div>
        )}
        <h4 className="question-text">{question.question}</h4>

        {question.type === 'multiple_choice' && question.options && (
          <div className="question-options">
            {question.options.map((opt) => (
              <button
                key={opt.id}
                className={`option-btn ${selected.includes(opt.id) ? 'selected' : ''} ${
                  opt.recommended ? 'recommended' : ''
                }`}
                onClick={() => {
                  if (question.allowMultiple) {
                    setSelected((prev) =>
                      prev.includes(opt.id)
                        ? prev.filter((s) => s !== opt.id)
                        : [...prev, opt.id],
                    );
                  } else {
                    setSelected([opt.id]);
                  }
                }}
              >
                <span className="option-label">{opt.label}</span>
                {opt.description && (
                  <span className="option-desc">{opt.description}</span>
                )}
                {opt.recommended && <span className="badge">推荐</span>}
              </button>
            ))}
          </div>
        )}

        {question.type === 'free_text' && (
          <textarea
            className="question-input"
            placeholder={question.placeholder}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            rows={4}
          />
        )}

        {question.type === 'file_picker' && (
          <input
            type="file"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        )}

        {question.type === 'confirmation' && (
          <div className="confirmation-buttons">
            <button className="btn-yes" onClick={() => setSelected(['yes'])}>
              确认
            </button>
            <button className="btn-no" onClick={() => setSelected(['no'])}>
              取消
            </button>
          </div>
        )}

        <div className="question-actions">
          <button
            className="btn-submit"
            disabled={question.required && selected.length === 0 && !freeText && files.length === 0}
            onClick={handleSubmit}
          >
            提交回答
          </button>
          {!question.required && onSkip && (
            <button className="btn-skip" onClick={onSkip}>
              跳过此题
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
```

---

## 5. Claude Code Harness 架构

### 5.1 CLAUDE.md / AGENTS.md 持久指令

**工程逻辑**：CLAUDE.md 是 Claude Code 的"每会话全局知识注入"机制。它的关键特性是**在摘要压缩后被重新注入**，因此不受长对话上下文丢失的影响。

```typescript
// packages/core/src/harness/claude-md.ts

export interface ClaudeMdConfig {
  autoLoadGlobPath: string[];
  autoLoadWorkspace: boolean;
  watchChanges: boolean;
  maxFileSizeKB: number;
  reactivateOnCompaction: boolean;  // 关键：摘要压缩后重新注入
  priority: 'high' | 'medium' | 'low';
}

/**
 * CLAUDE.md 内容类型
 * 基于 Claude Code 官方文档
 */
export interface ClaudeMdContent {
  // 项目级规则（./CLAUDE.md）
  buildCommand?: string[];     // 构建命令
  testCommand?: string[];      // 测试命令
  styleGuide?: string[];       // 样式约定
  architectureNotes?: string[];// 架构说明
  
  // 用户级规则（~/.claude/CLAUDE.md）
  preferences?: string[];      // 个人偏好
  codeStyle?: string[];        // 代码注释风格
  
  // Claude Code 特有的钩子
  autoMemoryRules?: string[];  // 自动保存 memory 的规则
  skillTriggers?: string[];    // Skill 触发条件
}

/**
 * CLAUDE.md Loader
 */
export class ClaudeMdLoader {
  private cache: Map<string, ClaudeMdContent> = new Map();
  private fileWatchers: Map<string, any> = new Map();

  constructor(private config: ClaudeMdConfig) {}

  /**
   * 加载项目级 + 用户级 CLAUDE.md
   */
  async load(workingDir: string): Promise<string> {
    const projectMd = await this.loadFile(`${workingDir}/CLAUDE.md`);
    const userMd = await this.loadFile(`${homedir()}/.claude/CLAUDE.md`);

    // 合并（项目级优先）
    const combined = [...(userMd ? [userMd] : []), ...(projectMd ? [projectMd] : [])];

    return `# Project Context\n\n${combined.join('\n\n---\n\n')}`;
  }

  /**
   * 解析为结构化内容（用于 ESLint 规则生成等）
   */
  async parse(workingDir: string): Promise<ClaudeMdContent> {
    const raw = await this.load(workingDir);
    return this.parseContent(raw);
  }

  /**
   * 监听文件变更（热重载）
   */
  watch(workingDir: string, onInvalidate: () => void): void {
    if (!this.config.watchChanges) return;
    const watcher = chokidar.watch(
      [`${workingDir}/CLAUDE.md`, `${homedir()}/.claude/CLAUDE.md`],
      { ignoreInitial: true },
    );
    watcher.on('change', () => {
      this.cache.clear();
      onInvalidate();
    });
    this.fileWatchers.set(workingDir, watcher);
  }

  private async loadFile(path: string): Promise<string | null> {
    try {
      const stat = await fs.stat(path);
      if (stat.size > this.config.maxFileSizeKB * 1024) {
        console.warn(`[ClaudeMdLoader] ${path} exceeds max size (${this.config.maxFileSizeKB}KB)`);
        return `# [File too large: ${path}]`;
      }
      return fs.readFile(path, 'utf-8');
    } catch {
      return null;
    }
  }
}

/**
 * CLAUDE.md 质量检查
 * 防止用户将无限的上下文塞进去（>50KB 模型忽略）
 */
export function validateClaudeMdSize(content: string): {
  valid: boolean;
  sizeKb: number;
  warning?: string;
} {
  const sizeBytes = Buffer.byteLength(content, 'utf-8');
  const sizeKb = Math.round(sizeBytes / 1024);

  if (sizeKb > 50) {
    return {
      valid: false,
      sizeKb,
      warning: `CLAUDE.md is ${sizeKb}KB. Models may ignore content after ~50KB. Consider splitting into multiple files.`,
    };
  }

  return { valid: true, sizeKb };
}
```

### 5.2 Auto Memory 跨会话学习

**工程逻辑**：Claude 在对话中会"学习"项目信息、用户偏好、常用模式。Auto Memory 让这些学习跨会话持久化——下次不用再解释一遍。

```typescript
// packages/core/src/harness/auto-memory.ts

export interface Memory {
  id: string;
  content: string;
  type: 'project_fact' | 'user_preference' | 'pattern' | 'correction' | 'shortcut';
  importance: 'high' | 'medium' | 'low';
  createdAt: string;
  source: 'user_explicit' | 'agent_learned' | 'conversation_context';
  conversationId?: string;
  evidence?: string;       // 从哪条消息推断出来的
  lastAccessed: string;
  accessCount: number;
}

export interface AutoMemoryAdapter {
  save(memory: Memory): Promise<void>;
  recall(query: string, maxResults: number): Promise<Memory[]>;
  list(limit: number): Promise<Memory[]>;
  forget(memoryId: string): Promise<void>;
  export(): Promise<Memory[]>;
  import(memories: Memory[]): Promise<void>;
}

/**
 * Auto Memory 引擎
 * 
 * 触发条件（基于 Claude Code 行为）：
 * 1. 用户说"记住 X" → 显式保存
 * 2. 用户纠正了 Claude → 保存纠正模式
 * 3. 对话中发现了稳定的项目事实 → 自动推断
 * 4. 重复出现的模式 → 保存为 shortcut
 */
export class AutoMemoryEngine {
  private pendingMemories: Memory[] = [];

  constructor(
    private adapter: AutoMemoryAdapter,
    private relevanceThreshold: number = 0.7,
  ) {}

  /**
   * 从对话消息中提取值得记忆的信息
   */
  async learnFromMessage(message: any): Promise<void> {
    const extracted = this.extractMemories(message);
    for (const memory of extracted) {
      // 去重：检查是否已有相同记忆
      const existing = await this.adapter.recall(memory.content, 3);
      if (existing.length > 0 && existing[0].content === memory.content) {
        continue;
      }

      // 重要性过滤
      if (memory.importance === 'low' && !memory.source.includes('user')) {
        continue;
      }

      await this.adapter.save(memory);
    }
  }

  /**
   * 召回与当前上下文相关的记忆
   * 使用语义相似度（embedding cosine distance）
   */
  async recallForContext(query: string, maxResults: number = 10): Promise<Memory[]> {
    const memories = await this.adapter.recall(query, maxResults);
    return memories.filter((m) => m.importance === 'high' || m.accessCount > 2);
  }

  /**
   * 将录用的记忆格式化为 Claude.md 风格
   */
  formatClaudeMd(memories: Memory[]): string {
    const lines: string[] = ['# Auto Memory\n'];
    
    const grouped = groupBy(memories, 'type');
    for (const [type, group] of Object.entries(grouped)) {
      lines.push(`## ${type}\n`);
      for (const m of group) {
        lines.push(`- ${m.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private extractMemories(message: any): Memory[] {
    const memories: Memory[] = [];
    
    if (message.role !== 'user') return memories;

    const text = message.content;
    
    // 显式记忆："记住 XXX"
    if (/记住|memorize|save this/i.test(text)) {
      const content = text.replace(/记住[：:]\s*/i, '').trim();
      memories.push({
        id: randomUUID(),
        content,
        type: 'user_preference',
        importance: 'high',
        createdAt: new Date().toISOString(),
        source: 'user_explicit',
        lastAccessed: new Date().toISOString(),
        accessCount: 0,
      });
    }

    // 纠正模式："不对，应该是 XXX" / "你搞错了"
    if (/不对|不正确|应该是|你搞错了|you're wrong/i.test(text)) {
      memories.push({
        id: randomUUID(),
        content,
        type: 'correction',
        importance: 'high',
        createdAt: new Date().toISOString(),
        source: 'conversation_context',
        lastAccessed: new Date().toISOString(),
        accessCount: 0,
      });
    }

    return memories;
  }
}
```

### 5.3 Skills 封装可复用流程

**工程逻辑**：Skills 是"按需加载的可复用流程文档"——与 CLAUDE.md 不同，Skills 不是在每次会话时全量加载，而是当用户调用 /deploy-staging 或 Agent 匹配到对应技能时才被加载。

```typescript
// packages/core/src/harness/skills.ts

export interface Skill {
  id: string;
  name: string;
  description: string;       // 触发描述（Agent 据此判断何时触发）
  path: string;              // SKILL.md 文件路径
  autoTriggerPatterns?: RegExp[];  // 自动触发（用户消息匹配这些正则）
  requiresConfirmation: boolean;
  maxTurns?: number;         // Skill 级别的轮次限制
  allowedTools?: string[];   // Skill 可使用的工具白名单
  content?: string;          // SKILL.md 加载后的正文
}

export interface SkillsRegistry {
  discover(skillsDir: string): Promise<Skill[]>;
  load(skillId: string): Promise<Skill>;
  trigger(skillName: string, context: any): Promise<SkillTriggerResult>;
}

export interface SkillTriggerResult {
  skill: Skill;
  instruction: string;        // 注入到 Agent 的内容
  constraints: {
    maxTurns: number;
    allowedTools: string[];
    mustConfirm: boolean;
  };
}

/**
 * Skill 注册器
 */
export class LocalSkillsRegistry implements SkillsRegistry {
  private skills: Map<string, Skill> = new Map();

  async discover(skillsDir: string): Promise<Skill[]> {
    // 扫描 .claude/skills/*/SKILL.md
    const files = await glob(`${skillsDir}/**/SKILL.md`);
    
    for (const filePath of files) {
      const content = await fs.readFile(filePath, 'utf-8');
      const metadata = this.parseSkillMetadata(content);
      
      const skill: Skill = {
        id: randomUUID(),
        name: metadata.name ?? path.basename(path.dirname(filePath)),
        description: metadata.description ?? '',
        path: filePath,
        autoTriggerPatterns: metadata.triggers?.map((t) => new RegExp(t, 'i')),
        requiresConfirmation: metadata.requiresConfirmation ?? false,
        maxTurns: metadata.maxTurns ?? 20,
        allowedTools: metadata.allowedTools,
        content,
      };

      this.skills.set(skill.name, skill);
    }

    return Array.from(this.skills.values());
  }

  async load(skillName: string): Promise<Skill> {
    const skill = this.skill.get(skillName);
    if (!skill) throw new Error(`Skill "${skillName}" not found`);
    
    if (!skill.content) {
      skill.content = await fs.readFile(skill.path, 'utf-8');
    }
    return skill;
  }

  async trigger(skillName: string, context: any): Promise<SkillTriggerResult> {
    const skill = await this.load(skillName);
    return {
      skill,
      instruction: skill.content ?? '',
      constraints: {
        maxTurns: skill.maxTurns ?? 20,
        allowedTools: skill.allowedTools ?? [],
        mustConfirm: skill.requiresConfirmation,
      },
    };
  }

  /**
   * 自动检测是否应该触发 Skill
   */
  detect(userMessage: string): Skill | null {
    for (const skill of this.skills.values()) {
      if (skill.autoTriggerPatterns?.some((p) => p.test(userMessage))) {
        return skill;
      }
    }
    return null;
  }

  private parseSkillMetadata(content: string): Record<string, any> {
    // 从 SKILL.md frontmatter 解析
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) return {};

    // 简化的 YAML 解析
    const metadata: Record<string, any> = {};
    for (const line of frontmatter[1].split('\n')) {
      const [key, ...rest] = line.split(':');
      if (key && rest.length > 0) {
        metadata[key.trim()] = rest.join(':').trim();
      }
    }
    return metadata;
  }
}
```

### 5.4 Hooks 生命周期拦截器

**工程逻辑**：Hooks 是 Claude Code 四大定制机制中"唯一有硬约束力"的机制。它不依赖模型的"理解"和"遵从"——它直接在代码层面拦截或修改工具调用。Hooks 解决的是"业务规则必须被强制执行"的需求。

```typescript
// packages/core/src/harness/hooks.ts

export type HookEvent =
  | 'tool.call'          // 工具调用前
  | 'tool.result'        // 工具调用后
  | 'prompt.send'        // prompt 发给模型前
  | 'permission.request' // 请求权限时
  | 'ui.render'          // UI 渲染时
  | 'session.start'      // 会话开始
  | 'session.end';       // 会话结束

export type HookAction = 'observe' | 'modify' | 'intercept';

export interface HookContext {
  // $: Mods API —— session, state, store, fs, process, http, tool, command, model, ui
  state: Record<string, any>;
  session: { id: string; messages: any[] };
}

export interface HookEventPayload {
  tool?: string;          // tool.call 时
  input?: any;            // 工具调用参数
  output?: any;           // 工具调用结果
  prompt?: string;        // prompt.send 时
}

export interface HookHandler {
  (ctx: HookContext, event: HookEventPayload, next: (event: HookEventPayload) => Promise<any>): Promise<any>;
}

export interface HookRegistration {
  event: HookEvent;
  matcher?: { tool?: string; command?: string };
  handler: HookHandler;
  priority: number;
}

/**
 * Hooks 引擎
 * 
 * Hook 可以执行三种动作：
 * - observe: 先调 next 再看结果（监听/日志）
 * - modify: 修改 event 后再调用 next（改写 prompt/工具参数）
 * - intercept: 不调用 next，直接返回结果（拒绝/接管）
 */
export class HooksEngine {
  private registrations: HookRegistration[] = [];

  register(reg: HookRegistration): void {
    this.registrations.push(reg);
    // 按 priority 排序（先注册的先执行）
    this.registrations.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 执行事件
   */
  async execute(
    event: HookEvent,
    payload: HookEventPayload,
    ctx: HookContext,
  ): Promise<{ allowed: boolean; modifiedPayload?: HookEventPayload; customResult?: any }> {
    const applicable = this.registrations
      .filter((r) => r.event === event)
      .filter((r) => this.matchesMatcher(r.matcher, payload));

    if (applicable.length === 0) {
      return { allowed: true };
    }

    let currentPayload = { ...payload };
    let intercepted = false;
    let customResult: any;

    const executeChain = async (index: number): Promise<void> => {
      if (index >= applicable.length) return;
      if (intercepted) return;

      const reg = applicable[index];
      await reg.handler(ctx, currentPayload, async (modifiedPayload: any) => {
        // next 函数——调用链中的下一个
        currentPayload = modifiedPayload;
        await executeChain(index + 1);
      });
    };

    // 检查是否为拦截模式（第一个 handler 不调用 next）
    if (applicable.length > 0) {
      let nextCalled = false;
      await applicable[0].handler(ctx, currentPayload, async () => {
        nextCalled = true;
        await executeChain(1);
      });

      if (!nextCalled) {
        intercepted = true;
        customResult = { reason: 'Blocked by hook' };
      }
    }

    return {
      allowed: !intercepted || intercepted === false,
      modifiedPayload: currentPayload,
      customResult,
    };
  }

  private matchesMatcher(
    matcher: HookRegistration['matcher'],
    payload: HookEventPayload,
  ): boolean {
    if (!matcher) return true;
    if (matcher.tool && payload.tool !== matcher.tool) return false;
    if (matcher.command && !payload.input?.command?.includes(matcher.command)) return false;
    return true;
  }
}

/**
 * Hook 使用示例
 */
export function setupCommonHooks(engine: HooksEngine): void {
  // 示例1：拦截包含 curl 的 Bash 调用
  engine.register({
    event: 'tool.call',
    matcher: { tool: 'Bash' },
    priority: 1,
    handler: async (ctx, event, next) => {
      if (event.input?.command?.includes('curl')) {
        // intercept：不调用 next = 拒绝执行
        return { reason: 'curl commands are not allowed in this session' };
      }
      return next(event);
    },
  });

  // 示例2：在 prompt 中注入上下文（modify）
  engine.register({
    event: 'prompt.send',
    priority: 0,
    handler: async (ctx, event, next) => {
      const modifiedPrompt = `[Working on: ${ctx.session.id}]\n\n${event.prompt}`;
      return next({ ...event, prompt: modifiedPrompt });
    },
  });

  // 示例3：工具结果脱敏（observe + modify）
  engine.register({
    event: 'tool.result',
    priority: 0,
    handler: async (ctx, event, next) => {
      const output = event.output;
      if (typeof output === 'string' && output.includes('API_KEY')) {
        const sanitized = output.replace(/API_KEY=([^\s]+)/g, 'API_KEY=***');
        return next({ ...event, output: sanitized });
      }
      return next(event);
    },
  });

  // 示例4：UI 渲染自定义（改主题/样式）
  engine.register({
    event: 'ui.render',
    priority: 0,
    handler: async (ctx, event, next) => {
      // 自定义 tool use 显示样式
      return next(event);
    },
  });
}
```

### 5.5 Sub-agents 并行执行与领导协调

**工程逻辑**：Sub-agents 解决两个问题：
1. **隔离上下文**：探索任务（代码搜索、依赖分析）不需要占用主会话的 context window
2. **并行执行**：独立的子任务可以同时执行

```typescript
// packages/core/src/harness/sub-agents.ts

export interface SubAgentDefinition {
  id: string;
  name: string;
  description: string;
  model?: string;              // 子代理可用不同模型（如用小模型做探索，大模型做综合）
  allowedTools: string[];      // 严格限制工具权限
  maxTurns: number;
  outputFormat: 'summary' | 'structured' | 'raw';
  contextIsolation: boolean;   // 是否完全隔离上下文
}

export interface SubAgentTask {
  agentId: string;
  instruction: string;
  attachments?: string[];      // 关联文件路径
  dependsOn?: string[];        // 依赖的其他子任务 ID
  priority: number;
  assignedTools: string[];
}

export interface SubAgentResult {
  taskId: string;
  agentId: string;
  status: 'completed' | 'failed' | 'timeout';
  output: any;
  tokensUsed: number;
  durationMs: number;
  error?: string;
}

/**
 * Sub-agent 执行器
 * 支持并行执行和依赖协调
 */
export class SubAgentOrchestrator {
  private results: Map<string, SubAgentResult> = new Map();

  constructor(
    private agentDefs: SubAgentDefinition[],
    private leadModel: any,  // 主 agent 的模型调用入口
    private config: {
      maxConcurrency: number;
      totalTokenBudget: number;
      failFast: boolean;
    },
  ) {}

  /**
   * 执行一组相关子任务
   * 自动处理任务依赖和并行调度
   */
  async executeTasks(tasks: SubAgentTask[]): Promise<Map<string, SubAgentResult>> {
    // 拓扑排序：确保依赖先执行
    const sorted = this.topologicalSort(tasks);
    
    // 分批执行：受并发限制
    for (const batch of this.batchByConcurrency(sorted, this.config.maxConcurrency)) {
      const promises = batch.map((task) => this.executeSingle(task));
      const batchResults = await Promise.allSettled(promises);

      // 检查是否需要 fail-fast
      if (this.config.failFast) {
        const failures = batchResults.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
          break;
        }
      }

      // 保存结果
      batchResults.forEach((result, idx) => {
        const task = batch[idx];
        if (result.status === 'fulfilled') {
          this.results.set(task.agentId, result.value);
        } else {
          this.results.set(task.agentId, {
            taskId: task.agentId,
            agentId: task.agentId,
            status: 'failed',
            output: null,
            tokensUsed: 0,
            durationMs: 0,
            error: result.reason?.message ?? 'Unknown error',
          });
        }
      });
    }

    return this.results;
  }

  /**
   * 让主 Agent 决定是否需要 spawn sub-agent
   * 这通常通过工具调用实现：
   * { tool_use: "spawn_subagent", input: { task: "analyze dependencies", allowedTools: ["Read", "Glob"] } }
   */
  async spawnSubAgent(task: SubAgentTask): Promise<SubAgentResult> {
    const startTime = Date.now();

    try {
      // 构建隔离子会话
      const isolatedMessages = [
        {
          role: 'system',
          content: `You are a sub-agent. Your task: ${task.instruction}. Output in ${this.agentDefs.find((a) => a.id === task.agentId)?.outputFormat ?? 'summary'} format.`,
        },
        {
          role: 'user',
          content: task.instruction,
        },
      ];

      // 使用受限工具调用模型
      const result = await this.leadModel.call(isolatedMessages, {
        allowedTools: task.assignedTools,
        maxTurns: this.agentDefs.find((a) => a.id === task.agentId)?.maxTurns ?? 5,
        model: this.agentDefs.find((a) => a.id === task.agentId)?.model,
      });

      return {
        taskId: task.agentId,
        agentId: task.agentId,
        status: 'completed',
        output: result,
        tokensUsed: result.tokensUsed ?? 0,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        taskId: task.agentId,
        agentId: task.agentId,
        status: 'failed',
        output: null,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 合并子任务结果（Lead coordination）
   */
  leadCoordination(
    originalTask: string,
    results: Map<string, SubAgentResult>,
  ): {
    summary: string;
    findings: string[];
    recommendations: string[];
    hasConflicts: boolean;
  } {
    const allOutputs = Array.from(this.results.values())
      .filter((r) => r.status === 'completed')
      .map((r) => r.output);

    const findings = allOutputs.flatMap((o: any) => o.findings ?? []);
    const recommendations = allOutputs.flatMap((o: any) => o.recommendations ?? []);

    return {
      summary: `Completed ${results.size} sub-tasks. ${findings.length} findings, ${recommendations.length} recommendations.`,
      findings,
      recommendations,
      hasConflicts: findings.some((f) => f.includes('CONFLICT')),
    };
  }

  private topologicalSort(tasks: SubAgentTask[]): SubAgentTask[] {
    // 简化实现：按依赖关系排序
    return tasks.sort((a, b) => {
      if (a.dependsOn?.includes(b.agentId)) return 1;
      if (b.dependsOn?.includes(a.agentId)) return -1;
      return 0;
    });
  }

  private batchByConcurrency(tasks: SubAgentTask[], concurrency: number): SubAgentTask[][] {
    const batches: SubAgentTask[][] = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
      batches.push(tasks.slice(i, i + concurrency));
    }
    return batches;
  }
}
```

---

## 6. AI 避坑汇总

> 🤖 **AI 常见错误**：
>
> 1. **所有东西都用 Artifact 渲染**：AI 倾向于将每个超过 20 行的输出都包装为 Artifact，导致对话流充满"独立窗口"，用户体验割裂。**检查方式**：`decideArtifactUse()` 函数必须严格执行——`<15 行代码块`、`纯文本解释`、`"用户要求对话里显示"` 三种情况绝对不能使用 Artifact。如果检测到 Artifact 使用率 > 30%（正常应为 5-10%），说明决策引擎配置有问题。
>
> 2. **Computer Use 对破坏性操作不确认**：AI 模型可能直接执行 `click(关闭按钮)` 或 `type(删除命令)` 而不经过用户确认，导致数据丢失。**检查方式**：所有 Computer Action 在执行前必须经 `SafetyGuard.check()` 评估；`SafetyPolicy.stdAndAbove` 级别的策略中 `delete|remove|payment|restart` 等动作必须弹确认对话框。审计日志需要记录每次确认的 result（approved/denied），不可缺省为 true。
>
> 3. **Headless 模式未设置 --max-turns 上限**：在 CI/CD 场景中，如果 Agent 陷入无限循环（模型反复调用同一个工具期望不同结果），每次调用的成本和延迟都会累积，最终 CI 运行 4 小时后才超时。**检查方式**：所有 Headless Session 必须强制设置 `maxTurns`（推荐 10-30）；CI 环境集成时必须有 `timeoutSeconds`（推荐 300-600s）作为第二层保护。断言 `config.maxTurns >= 5 && config.maxTurns <= 100`。
>
> 4. **未实现 Session Resume**：当 Headless Session 因网络中断或进程被杀而终止时，所有中间状态丢失，重跑需要重新消耗 token 且结果可能不一致。**检查方式**：Session 状态必须在每轮循环后持久化到 `SessionResumeAdapter`；恢复时使用 `canResume()` 检查快照完整性和大小（>180K token 不能恢复需告知用户）；恢复后向 Agent 注入 `buildResumePrompt()` 摘要消息。
>
> 5. **AskUserQuestion 过度使用（频繁打断用户）**：AI 倾向于对每个细节都提问："用什么框架？""数据库选哪个？??"错误处理选 try-catch 还是 Result 类型？"——用户被 20 个问题轰炸后直接放弃使用。**检查方式**：`shouldAskUser()` 中 `severity: 'minor'` 的规则必须问"这个有合理默认值吗？如果有，直接用默认值+在回答中声明假设"；每会话最多允许 3 个 `severity: 'critical'` 的问题；如果用户在第一条消息中提供了足够的信息（如"用 React + TypeScript 写一个 Todo API 用 SQLite"），Agent 应该 0 个问题直接开始。
>
> 6. **CLAUDE.md 当作无限上下文仓库**：AI 引导用户把 CLAUDE.md 写得越来越长（几百 KB），以为"写得越多模型越听话"。实际上大约在 50KB 之后模型注意力急剧下降，后面的规则被完全忽略。**检查方式**：启动时调用 `validateClaudeMdSize()` 检查 CLAUDE.md 大小；超过 20KB 警告、超过 50KB 强制报错要求用户精简。推荐的结构是：关键规则写 CLAUDE.md（< 10KB），细节文档放在单独的 `/docs/` 目录按需加载。
>
> 7. **Playwright 与 Computer Use 模式混淆**：AI 经常在不适用 Computer Use 的场景使用 Computer Use——例如用户说"打开 baidu.com 搜 Python 教程"，Agent 需要截图 → 解析 → 点搜索框 → 输入 → 点搜索按钮（5 步循环，每次 2s 延迟）才能完成 Playwright Playwright 一行代码 `page.goto('https://baidu.com'); page.fill('#kw','Python 教程'); page.click('#su')` 只 0.5s 的事。**检查方式**：决策树第一层判断"目标是否是浏览器Web 应用？如果是 → 优先 Playwright；如果是桌面应用或无 API 但有 UI → 用 Computer Use；如果 API 可用 → 直接调 API"。
>
> 8. **Stream-Json 输出中夹带非 JSON 文本**：AI 在 stream-json 输出模式中偶尔在 JSON 行中插入非 JSON 文本（如注释或模型理由），导致下游 JSON 解析器崩溃。**检查方式**：`OutputFormatter` emit 时必须针对 `stream-json` 模式做 JSON.stringify 验证；每行输出必须以 `{` 开头并以 `}` 结尾；使用 `NDJSON` 库（如 `split2` + `ndjson`）消费，任何 parse error 行跳过后继续而非终止。
>
> 9. **Sub-agent 上下文泄漏**：AI 没有完全隔离子 agent 的上下文，导致子 agent 知道了主会话的内部信息（如用户身份、敏感文件路径），违反最小权限原则。**检查方式**：SubAgentTask 必须明确 `contextIsolation: true`；子 agent 的 system prompt 中不包含用户身份、未被授权的文件路径；子 agent 的 `allowedTools` 严格白名单（如只能 `Read + Glob`，禁止 `Write + Bash`）。断言 `subAgent.allowedTools.every(t => leadAgentTools.includes(t))`。
>
> 10. **Hooks 逻辑写入 Harness 层而非业务层**：AI 把所有钩子逻辑（prompt 脱敏、错误拦截、工具改写）都堆在 `HooksEngine` 中，导致 Harness 框架和业务逻辑耦合，更换 Harness 时所有逻辑失效。**检查方式**：HooksEngine 应只提供基础设施（中间件管道）；具体 hook 函数应放在业务代码中（如 `setupSecurityHooks()`, `setupCustomThemeHooks()`）；测试时 hook 可被 mock，不依赖 Harness 实现细节。

---

*本节点属于 Layer 5 体验与集成层——Agent 的价值最终体现在用户体验上。Artifacts 让模型输出从"对话中的文字"升级为"可独立操作的产物"；Computer Use 让模型从"文本生成器"进化为"桌面操作员"；Headless 模式让 Agent 从"人类陪伴"延伸到"自动化劳动力"；AskUserQuestion 让 Agent 从"盲目执行"进化为"主动协作者"；Harness 架构是所有这些能力的容器和骨架。实现时有一个核心原则：**每一项能力必须是可选的、渐进的**——产品可以先只有"行内回复 + 澄清提问"，后续逐步加入 Artifact、Computer Use、Headless；不要一次性 All-in 导致维护成本激增。演进路径：先做结构化输出（节点 13）→ 做多模态理解（节点 16）→ 加 Artifact 渲染 → 加 Headless CLI/调度 → 加 Computer Use 视觉操控 → 加 AskUserQuestion 澄清 → 最后完善 Harness（Memory/Skills/Hooks/Sub-agents）。*
