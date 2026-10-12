# 02 — 工具 · Skill · Token 预算

> Layer 2 目标：在 01 的 Agent 循环上补齐三个生产能力切片——**Token 预算管理**（估算 + 压缩）、**工具层**（AI SDK 工具 + MCP）、**Skill 系统**（MCP 渐进披露）。读完本文件即可独立落地上述三个子系统的全部后端 + 前端代码。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - Token 计数 → **`tiktoken-wasm`**（或 `@langchain/core` 的 token 计数），不要手写 char/token 公式
> - 上下文压缩 / 摘要 → 直接复用 01 的 `streamText` 让模型写摘要，不要手写滑动窗口与摘要算法
> - 工具定义与 Schema → **AI SDK `tool()` + Zod**，不要手写 JSON Schema 映射
> - MCP Client / Server → **`@modelcontextprotocol/sdk`**，不要手写 JSON-RPC 帧解析
> - Skill 系统 → **MCP 承载 + 渐进披露**，业务编排 `[CUSTOM]`（产品差异层）
>
> 本层唯一允许手写的 `[CUSTOM]` 是**工具权限/分级策略**与 **Skill 业务编排**——它们是产品差异层，没有现成替代；其余一律接库。

## 目录

- [2.1 Token 预算管理](#21-token-预算管理)
  - [Token 估算——tiktoken-wasm](#1-token-估算tiktoken-wasm)
  - [上下文压缩——复用 streamText](#2-上下文压缩复用-streamtext)
  - [ContextManager 业务编排 [CUSTOM]](#3-contextmanager-业务编排-custom)
  - [集成到 Agent 循环](#4-集成到-agent-循环)
  - [前端 ContextUsageBar](#5-前端-contextusagebar)
- [2.2 工具层——AI SDK 工具 + MCP](#22-工具层ai-sdk-工具--mcp)
  - [内置工具定义——tool() + Zod](#1-内置工具定义tool--zod)
  - [MCP 客户端接入——@modelcontextprotocol/sdk](#2-mcp-客户端接入modelcontextprotocolsdk)
  - [工具权限分级 [CUSTOM]](#3-工具权限分级-custom)
  - [前端 ToolCallCard](#4-前端-toolcallcard)
- [2.3 Skill 系统——MCP 渐进披露](#23-skill-系统mcp-渐进披露)
  - [Skill 目录结构标准](#1-skill-目录结构标准)
  - [SkillLoader——gray-matter + 扫描 [CUSTOM]](#2-skillloader-gray-matter--扫描-custom)
  - [load_skill 激活工具](#3-load_skill-激活工具)
  - [SkillContextManager [CUSTOM]](#4-skillcontextmanager-custom)
  - [前端 Skills 面板](#5-前端-skills-面板)
- [2.4 交叉引用](#24-交叉引用)
- [2.5 本层验收清单](#25-本层验收清单)

---

## 2.1 Token 预算管理

### 工程逻辑概述

Agent 每一轮 ReAct 循环都在消息历史里追加内容。5 轮循环后消息列表可达 15 条，加上工具返回的大段 JSON，token 数轻松突破 30K。即使不突破上限，上下文越长模型注意力越稀释、回复质量越差。

**为什么不直接"砍掉旧消息"？** 因为 Agent 的多步推理有因果依赖——第 3 步的工具结果可能在第 5 步被引用。直接删除会让 LLM 产生幻觉。正确做法：**保留最近 N 轮完整，更早的压缩成摘要**。

压缩必须发生在 **Agent 每一轮迭代开始时**（不是用户发消息之前）。压缩后的视图只是给 LLM 看的，绝不能覆盖原始消息列表——始终在原始消息上追加，每轮从原始列表生成压缩视图。

```
┌─────────────────────────────────────────────────┐
│            LLM Context Window (e.g. 128K)        │
│  ┌─────────────────────────────────────────┐     │
│  │ System Prompt (固定)                      │     │
│  ├─────────────────────────────────────────┤     │
│  │ Token Budget（本节管理）                     │     │
│  │  ┌───────────────────────────────┐      │     │
│  │  │ 摘要区（历史对话压缩）                │      │     │
│  │  │ "用户讨论了X，做了Y..."              │      │     │
│  │  ├───────────────────────────────┤      │     │
│  │  │ 近期 N 轮（完整保留）               │      │     │
│  │  └───────────────────────────────┘      │     │
│  ├─────────────────────────────────────────┤     │
│  │ Headroom（回复余量 ~10%）                │     │
│  └─────────────────────────────────────────┘     │
└─────────────────────────────────────────────────┘
```

精确估算需要 tokenizer（tiktoken），它是个 WASM 依赖。过去我们自研 char 估算器 + WASM 切换接口，现在直接接 `tiktoken-wasm`，上层只需保留一个薄函数。

### 1. Token 估算（tiktoken-wasm）

```bash
pnpm add tiktoken-wasm
```

```typescript
// packages/core/src/context/tokenEstimator.ts —— 只保留薄封装，实现全部来自库
import { Tiktoken } from 'tiktoken-wasm';
import type { UIMessage } from 'ai';

/**
 * 用 tiktoken-wasm 精确估算消息 token 数。
 * 每条角色消息有固定开销（~4 token，与 OpenAI 官方示例一致）。
 */
export async function estimateTokens(messages: UIMessage[]): Promise<number> {
  const encoder = new Tiktoken('cl100k_base');
  try {
    let total = 0;
    for (const msg of messages) {
      total += encoder.encode(typeof msg.content === 'string' ? msg.content : '').length;
      total += 4;
    }
    return total;
  } finally {
    encoder.free(); // WASM 编码器必须显式释放，否则内存泄漏
  }
}

/** 字符估算兜底——浏览器端 / 极端速度要求时使用 */
export function estimateTokensByChars(text: string): number {
  return Math.ceil(text.length / 3);
}
```

> 🤖 **AI 常见错误**：
> 1. 每次估算都 `new Tiktoken(...)` 而忘记 `free()`——WASM 内存不断累积，进程内存暴涨。**必须 `try/finally` 保证释放**。
> 2. 在浏览器端直接引入 tiktoken-wasm——约 1MB WASM，首屏加载爆炸。前端用字符估算，服务端才用精确 tokenizer。
> 3. 用 `text.length / 4` 之类的魔法常数估算所有模型——不同模型的 tokenizer 不同（cl100k_base / o200k_base），估算器必须与模型匹配。

### 2. 上下文压缩（复用 streamText）

摘要生成不需要新抽象：01 的 `createModel` + `streamText` 就是现成摘要器。把早期消息拼成 transcript，让模型输出一段结构化摘要。

```typescript
// packages/core/src/context/compressor.ts —— 摘要生成完全复用 01 的 streamText
import { streamText, type LanguageModel } from 'ai';
import type { UIMessage } from 'ai';

const SUMMARY_SYSTEM = [
  'You are a conversation summarizer.',
  'Preserve facts, decisions, user preferences, and tool results that later steps may depend on.',
  'Output a concise third-person summary, no bullet points.',
].join(' ');

/**
 * 把一段历史消息压缩成摘要。
 * 注意：压缩是"视图"，永远不要用返回值覆盖原始消息列表。
 */
export async function summarizeConversation(model: LanguageModel, messages: UIMessage[]): Promise<string> {
  const transcript = messages
    .map(m => `[${m.role.toUpperCase()}]: ${typeof m.content === 'string' ? m.content : ''}`)
    .join('\n---\n');

  const result = streamText({
    model,
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: transcript }],
    maxSteps: 1,
  });

  return (await result.text).trim();
}
```

> 🔗 **工程逻辑**：LangChain 的 `loadSummarizationChain` 需要独立的 LangChain model 实例，会引入 `@langchain/openai` 与 `ai` 两套 LLM 类型。这里直接复用 01 的 `streamText`，**整个项目只有一个 `LanguageModel` 抽象**（见 01 的 1.3）。

### 3. ContextManager 业务编排 [CUSTOM]

**何时压缩、保留多少轮、给回复留多少余量**是产品策略，没有成熟库替你决定。这部分是 `[CUSTOM]` 业务编排——但内部实现只调用上面的两个函数，不写任何基础设施。

```typescript
// packages/core/src/context/contextManager.ts —— 业务编排 [CUSTOM]，内部实现全部引用库
import type { LanguageModel, UIMessage } from 'ai';
import { estimateTokens } from './tokenEstimator';
import { summarizeConversation } from './compressor';

export interface ContextStatus {
  totalTokens: number;
  contextWindow: number;
  usageRatio: number;
  compressed: boolean;
}

export interface ContextWindowConfig {
  contextWindow: number;
  triggerRatio?: number;
  preserveRecentRounds?: number;
  responseHeadroom?: number;
}

export class ContextManager {
  private triggerRatio: number;
  private preserveRecentRounds: number;
  private responseHeadroom: number;

  constructor(private model: LanguageModel, private config: ContextWindowConfig) {
    this.triggerRatio = config.triggerRatio ?? 0.7;
    this.preserveRecentRounds = config.preserveRecentRounds ?? 6;
    this.responseHeadroom = config.responseHeadroom ?? 4096;
  }

  async prepareMessages(messages: UIMessage[], systemPrompt?: string) {
    const systemTokens = systemPrompt
      ? await estimateTokens([{ role: 'system', content: systemPrompt } as UIMessage])
      : 0;
    const usedTokens = systemTokens + (await estimateTokens(messages));
    const threshold = Math.floor(this.config.contextWindow * this.triggerRatio);

    if (usedTokens + this.responseHeadroom > threshold) {
      const { toCompress, preserved } = this.splitByRounds(messages);
      if (toCompress.length > 0) {
        const summary = await summarizeConversation(this.model, toCompress);
        const compressedMessages: UIMessage[] = [
          { role: 'system', content: `[Previous conversation summary]\n${summary}` } as UIMessage,
          ...preserved,
        ];
        return {
          messages: compressedMessages,
          status: await this.buildStatus(compressedMessages, systemTokens, true),
        };
      }
    }

    return { messages, status: await this.buildStatus(messages, systemTokens, false) };
  }

  /** 只压缩"早期轮次"，最近 N 轮保留完整——业务规则 [CUSTOM] */
  private splitByRounds(messages: UIMessage[]) {
    const cutoff = this.preserveRecentRounds * 2;
    const start = Math.max(0, messages.length - cutoff);
    return { toCompress: messages.slice(0, start), preserved: messages.slice(start) };
  }

  private async buildStatus(messages: UIMessage[], systemTokens: number, compressed: boolean): Promise<ContextStatus> {
    const totalTokens = systemTokens + (await estimateTokens(messages));
    return {
      totalTokens,
      contextWindow: this.config.contextWindow,
      usageRatio: totalTokens / this.config.contextWindow,
      compressed,
    };
  }
}
```

### 4. 集成到 Agent 循环

每轮迭代开始前调用 `prepareMessages`，压缩状态作为 `AgentEvent` 下发（`context_status` 变体定义见 01 的 1.4）。

```typescript
// server/src/routes/chat.ts —— 把 ContextManager 接进 01 的 streamText
import { streamText, type LanguageModel, type ToolSet, type UIMessage } from 'ai';
import { ContextManager } from '@agentcore/core/context/contextManager';
import type { AgentEvent } from '@agentcore/core/agent/events';

export async function* chatLoop(
  model: LanguageModel,
  messages: UIMessage[],
  contextManager: ContextManager,
  tools: ToolSet
) {
  const prepared = await contextManager.prepareMessages(messages);

  yield ({
    type: 'context_status',
    totalTokens: prepared.status.totalTokens,
    contextWindow: prepared.status.contextWindow,
    usageRatio: prepared.status.usageRatio,
  } satisfies AgentEvent);

  const result = streamText({
    model,
    messages: prepared.messages,
    tools,
    maxSteps: 10,
  });

  for await (const chunk of result.textStream) {
    yield ({ type: 'token', content: chunk } satisfies AgentEvent);
  }
  yield ({ type: 'done', finishReason: await result.finishReason } satisfies AgentEvent);
}
```

### 5. 前端 ContextUsageBar

```tsx
// apps/web/src/components/ContextUsageBar.tsx
'use client';

interface ContextStatusProps {
  totalTokens: number;
  contextWindow: number;
  usageRatio: number;
  compressed: boolean;
}

export function ContextUsageBar({ totalTokens, contextWindow, usageRatio, compressed }: ContextStatusProps) {
  const pct = Math.min(100, Math.round(usageRatio * 100));
  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
      <div className="h-1.5 w-40 overflow-hidden rounded bg-gray-200">
        <div
          className={compressed ? 'h-full bg-amber-400' : 'h-full bg-blue-500'}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span>{totalTokens.toLocaleString()} / {contextWindow.toLocaleString()} tokens</span>
      {compressed && <span className="rounded bg-amber-100 px-1 text-amber-700">COMPRESSED</span>}
    </div>
  );
}
```

---

## 2.2 工具层——AI SDK 工具 + MCP

### 工程逻辑概述

旧的 ToolRegistry 需要维护"工具注册表 + 参数 Schema 映射 + 权限校验"三套逻辑。现在工具就是 `tool()` + Zod，`streamText` 直接消费；权限校验是业务策略 `[CUSTOM]`，与注册解耦。

### 1. 内置工具定义（tool() + Zod）

```typescript
// packages/core/src/tool/builtins.ts —— 内置工具：AI SDK tool() + Zod，不再手写 Schema 映射
import { tool } from 'ai';
import { z } from 'zod';
import * as path from 'path';
import { promises as fs } from 'fs';

const allowedPaths = (process.env.ALLOWED_PATHS ?? process.cwd()).split(path.delimiter);

export const readFileTool = tool({
  description: '读取文本文件内容（仅限白名单目录）',
  parameters: z.object({
    file_path: z.string().describe('文件路径'),
    offset: z.number().optional().describe('起始行号（1 起）'),
    limit: z.number().optional().describe('最多返回行数'),
  }),
  execute: async ({ file_path, offset, limit }) => {
    const resolved = path.resolve(file_path);
    if (!allowedPaths.some(allowed => resolved.startsWith(path.resolve(allowed)))) {
      throw new Error(`Access denied: "${file_path}" is outside allowed directories`);
    }
    const content = await fs.readFile(file_path, 'utf-8');
    if (!offset && !limit) return content;
    const lines = content.split('\n');
    const start = (offset ?? 1) - 1;
    return lines.slice(start, limit ? start + limit : undefined).join('\n');
  },
});
```

> 🤖 **AI 常见错误**：权限校验只做一次 `startsWith` 就完事——`/tmp/../etc/passwd` 能绕过。**必须 `path.resolve` 后再判断前缀**，并用 `path.sep` 结尾防止 `/tmp2` 误命中。

### 2. MCP 客户端接入（@modelcontextprotocol/sdk）

MCP 工具与内置工具一起进入 `ToolSet`。MCP 工具的参数是 JSON Schema，这里用宽松 Zod schema 透传，校验交给 MCP server。

```typescript
// packages/core/src/mcp/client.ts —— 胶水层：MCP SDK 连接 + 转成 AI SDK tool()
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { tool } from 'ai';
import { z } from 'zod';

export interface MCPServerConfig {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
}

export class MCPClient {
  private client: Client | null = null;

  constructor(private config: MCPServerConfig) {}

  async connect(): Promise<void> {
    const transport = this.config.command
      ? new StdioClientTransport({ command: this.config.command, args: this.config.args })
      : new SSEClientTransport(new URL(this.config.url!));
    this.client = new Client({ name: 'agent-core-mcp', version: '1.0.0' }, { capabilities: {} });
    await this.client.connect(transport);
  }

  /** 把 MCP 工具转成 AI SDK tool()——工具名加 server 前缀，避免同名冲突 */
  async toAISdkTools(): Promise<Record<string, ReturnType<typeof tool>>> {
    const mcp = this.client!;
    const { tools } = await mcp.listTools();
    const result: Record<string, ReturnType<typeof tool>> = {};

    for (const t of tools) {
      result[`${this.config.name}.${t.name}`] = tool({
        description: t.description,
        parameters: z.record(z.unknown()),
        execute: async (args) => {
          const res = await mcp.callTool({ name: t.name, arguments: args });
          return res.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map(c => c.text)
            .join('\n');
        },
      });
    }
    return result;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}
```

### 3. 工具权限分级 [CUSTOM]

```typescript
// packages/core/src/tool/policy.ts —— 业务差异层 [CUSTOM]：按工具名做权限分级
export type ToolCategory = 'safe' | 'confirm' | 'blocked';

const POLICY: Record<string, ToolCategory> = {
  read_file: 'safe',
  write_file: 'confirm',
  web_search: 'safe',
};

export function classifyTool(name: string): ToolCategory {
  return POLICY[name] ?? 'blocked'; // 未登记的工具默认拦截
}

export function requiresHumanApproval(name: string): boolean {
  return classifyTool(name) === 'confirm';
}
```

### 4. 前端 ToolCallCard

```tsx
// apps/web/src/components/ToolCallCard.tsx
'use client';

import type { ToolInvocation } from 'ai';

export function ToolCallCard({ invocation }: { invocation: ToolInvocation }) {
  const { toolName, state, args } = invocation;
  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-mono text-gray-600">{toolName}</span>
        {state === 'partial-call' && <span className="text-blue-500">调用中…</span>}
        {state === 'result' && <span className="text-green-600">✓ 完成</span>}
      </div>
      {state === 'partial-call' && (
        <pre className="mt-1 whitespace-pre-wrap text-gray-500">{JSON.stringify(args, null, 2)}</pre>
      )}
      {state === 'result' && 'result' in invocation && (
        <pre className="mt-1 whitespace-pre-wrap text-gray-500">{JSON.stringify(invocation.result, null, 2)}</pre>
      )}
    </div>
  );
}
```

---

## 2.3 Skill 系统——MCP 渐进披露

### 工程逻辑概述

Skill 是产品概念：把"某个任务领域的方法论 + 脚本 + 参考"打包成可安装、可启用、可淘汰的单元。传输与发现层用 **MCP** 承载，业务编排（激活数限制、LRU 淘汰、版本管理）是 `[CUSTOM]` 业务层。YAML frontmatter 解析用 `gray-matter`，不手写解析器。

### 1. Skill 目录结构标准

```
packages/core/skills/pdf-analysis/
├── SKILL.md          # YAML frontmatter + 完整指令（gray-matter 解析）
├── scripts/          # 该 Skill 附带的可执行脚本
└── references/       # 该 Skill 的参考文档
```

```markdown
---
name: pdf-analysis
version: 1.2.0
description: 解析 PDF 并抽取结构化内容
tags: [pdf, document]
priority: 80
---

# PDF 分析
...完整指令...
```

### 2. SkillLoader（gray-matter + 扫描）[CUSTOM]

```typescript
// packages/core/src/skill/loader.ts —— 业务层 [CUSTOM]：产品编排；YAML 解析交给 gray-matter
import matter from 'gray-matter';
import { promises as fs } from 'fs';
import * as path from 'path';

export interface SkillMeta {
  name: string;
  version: string;
  description: string;
  tags: string[];
  priority: number;
}

export class SkillLoader {
  private skills = new Map<string, { meta: SkillMeta; path: string; instructions: string }>();

  constructor(private skillDirs: string[]) {}

  async scan(): Promise<SkillMeta[]> {
    for (const dir of this.skillDirs) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(dir, entry.name);
        try {
          const { data, content } = matter(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8'));
          const meta: SkillMeta = {
            name: String(data.name ?? entry.name),
            version: String(data.version ?? '0.1.0'),
            description: String(data.description ?? ''),
            tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
            priority: Number(data.priority ?? 50),
          };
          this.skills.set(meta.name, { meta, path: skillDir, instructions: content.trim() });
        } catch {
          // 目录没有合法 SKILL.md，跳过
        }
      }
    }
    return [...this.skills.values()]
      .sort((a, b) => b.meta.priority - a.meta.priority)
      .map(v => v.meta);
  }

  getAllSummaries(): string[] {
    return [...this.skills.values()]
      .sort((a, b) => b.meta.priority - a.meta.priority)
      .map(s => `${s.meta.name}: ${s.meta.description}`);
  }

  getFull(name: string): { meta: SkillMeta; instructions: string } {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Skill "${name}" not found`);
    return { meta: skill.meta, instructions: skill.instructions };
  }
}
```

### 3. load_skill 激活工具

渐进披露的关键：LLM 只看到 Skill 摘要，需要细节时主动调用 `load_skill`。

```typescript
// packages/core/src/skill/activationTool.ts —— 渐进披露入口：load_skill
import { tool } from 'ai';
import { z } from 'zod';
import { SkillLoader } from './loader';

export function createLoadSkillTool(loader: SkillLoader) {
  return tool({
    description:
      '加载一个 Skill 的完整指令。可用 Skills：' + loader.getAllSummaries().join('; '),
    parameters: z.object({
      skill_name: z.string().describe('要加载的 Skill 名称'),
    }),
    execute: async ({ skill_name }) => {
      const { meta, instructions } = loader.getFull(skill_name);
      return [
        `# Skill Activated: ${meta.name}`,
        '',
        '## Instructions',
        instructions,
        `\n[Skill token cost: ~${Math.ceil(instructions.length / 3)} tokens. Use this skill's tools now.]`,
      ].join('\n');
    },
  });
}
```

### 4. SkillContextManager [CUSTOM]

```typescript
// packages/core/src/skill/context.ts —— 业务层 [CUSTOM]：限制同时激活数 + LRU 淘汰
export class SkillContextManager {
  private active = new Map<string, number>(); // skillName -> loadedAt
  private maxActive = 3;
  private timeoutMs = 5 * 60 * 1000;

  activate(skillName: string): { evicted?: string } {
    this.active.delete(skillName); // 重复激活刷新时间戳
    let evicted: string | undefined;
    if (this.active.size >= this.maxActive) {
      const oldest = [...this.active.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) {
        this.active.delete(oldest[0]);
        evicted = oldest[0];
      }
    }
    this.active.set(skillName, Date.now());
    return { evicted };
  }

  pruneExpired(): string[] {
    const now = Date.now();
    const expired: string[] = [];
    for (const [name, at] of this.active) {
      if (now - at > this.timeoutMs) {
        this.active.delete(name);
        expired.push(name);
      }
    }
    return expired;
  }

  getActive(): string[] {
    return [...this.active.keys()];
  }
}
```

> 🤖 **AI 常见错误**：把"渐进披露"做成一次性把全部 Skill 指令塞进 system prompt——几千行指令直接挤爆上下文。**必须只放摘要，详情靠 `load_skill` 按需加载**。

### 5. 前端 Skills 面板

```tsx
// apps/web/src/components/SkillsPanel.tsx（摘要）
'use client';

import { useEffect, useState } from 'react';

interface SkillItem {
  name: string;
  description: string;
  version: string;
  enabled: boolean;
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/skills')
      .then(res => res.json())
      .then(data => setSkills(data.skills))
      .catch(() => setSkills([]))
      .finally(() => setLoading(false));
  }, []);

  const toggle = async (name: string, enabled: boolean) => {
    await fetch(`/api/skills/${name}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    setSkills(prev => prev.map(s => (s.name === name ? { ...s, enabled } : s)));
  };

  return (
    <div className="space-y-2">
      {loading && <p className="text-sm opacity-50">加载中…</p>}
      {skills.map(skill => (
        <div key={skill.name} className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <div className="text-sm font-medium">{skill.name}</div>
            <div className="text-xs opacity-50">{skill.description}</div>
          </div>
          <button
            onClick={() => toggle(skill.name, !skill.enabled)}
            className={`rounded px-2 py-1 text-xs ${skill.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}
          >
            {skill.enabled ? '已启用' : '已禁用'}
          </button>
        </div>
      ))}
    </div>
  );
}
```

---


## 2.2.1 MCP 工具转 AI SDK tool() 的完整胶水

MCP 工具是"远程声明的工具"，AI SDK tool() 是"本地可执行工具"。胶水层只做一件事：把 MCP 的 `inputSchema` 转成 Zod，把 `callTool` 包进 `execute`。

```typescript
// packages/core/src/mcp/adapters.ts —— MCP → AI SDK tool()
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { jsonSchemaToZod } from './json-schema-to-zod'; // [CUSTOM] 极薄转换层

export function mcpToolsToToolSet(client: Client, serverPrefix: string): ToolSet {
  const tools: ToolSet = {};
  for (const t of await client.listTools()) {
    const zodSchema = jsonSchemaToZod(t.inputSchema);
    tools[`${serverPrefix}.${t.name}`] = tool({
      description: t.description ?? t.name,
      parameters: zodSchema as z.ZodObject<any, any>,
      execute: async (args) => {
        const res = await client.callTool({ name: t.name, arguments: args });
        return res.content;
      },
    });
  }
  return tools;
}
```

- **命名空间前缀**（`serverPrefix.toolName`）：给 LLM 上下文锚点，避免 filesystem.readFile 与 github.getFile 混淆。
- **超时**：`callTool` 传 `{ timeout: 30_000 }`，防 MCP 服务器挂起拖死 Agent。
- **重连**：`autoReconnect` + 指数退避（见 21）。

## 2.3.1 Skill 系统部署与安全

- **目录规范**：`skills/<name>/SKILL.md` + `frontmatter`（name/description/version），用 `gray-matter` 解析，不要手写 YAML 解析器。
- **渐进披露**：只把 skill 的 `name` + `description` 给 LLM，内容在工具被选中时才注入——避免上下文爆炸。
- **冲突检测**：同名工具注册时警告；`load_skill` 激活后工具前缀加 `skill:`，与 MCP 工具区分。
- **安全**：skill 内容与代码等同对待——来自第三方 skill 的指令可能是注入载荷，加载前过 07 的 PromptSanitizer。

## 2.4 交叉引用

- [01-foundation.md](01-foundation.md) — 宿主层：`LanguageModel` / `streamText` / `AgentEvent` / `useChat`
- [11-function-calling.md](11-function-calling.md) — 工具调用的 Provider 适配、重试与并行派发
- [14-mcp-server-dev.md](14-mcp-server-dev.md) — 如何编写 MCP Server（Skill 的传输层）
- [17-streaming-advanced.md](17-streaming-advanced.md) — 流式调优与重连

## 2.5 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core` 的 tokenEstimator / contextManager / tool / mcp / skill 模块全部 0 错误。
- [ ] **Token 预算**：连续 50 轮对话触发 3 次上下文压缩，`ContextUsageBar` 显示 COMPRESSED 标记，压缩后 `totalTokens` 显著下降，单次压缩耗时 < 3s。
- [ ] **工具循环**：通过 `curl 'http://localhost:3000/api/chat' -H 'Content-Type: application/json' -d '{"message":"列出可用工具并调用一次"}'`，事件流中依次出现 `tool_start` / `tool_complete`；非法参数返回 `tool_error` 而非崩溃。
- [ ] **MCP 边界**：断开 MCP server 后再次调用其工具，返回 `tool_error` 且携带连接失败原因，Agent 主循环不崩溃。
- [ ] **Skill 渐进披露**：初始 system prompt 只含 Skill 摘要；调用 `load_skill` 后才注入完整指令；同时激活超过 3 个 Skill 时最早一个被淘汰。
