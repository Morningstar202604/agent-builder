# 01 — 基础设施层 · Foundation

> Layer 0 目标：构建**能对话的窗口**——Monorepo + LLM 接入 + Agent 主循环 + 流式 API + React 聊天 UI + Electron 桌面壳。每完成一节，拥有一个真实可用的能力切片。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - LLM 调用 / 流式 / 工具调用 → **Vercel AI SDK**（`ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic`），不要手写 HTTP 客户端
> - Agent ReAct 循环 → AI SDK `streamText` 的 `tools` + `maxSteps`（或 LangGraph `createReactAgent`），不要手写 while+switch
> - 前端流式 → `ai/react` 的 `useChat`，不要手写 SSE 拼接
> - SSE 传输 → AI SDK `toDataStreamResponse`，不要手写 EventSource 解析器
>
> 本层唯一允许手写的 `[CUSTOM]` 是**业务事件信封**（`AgentEvent`）与产品 UI 细节——这些是业务差异层，没有现成替代。

---

## 目录

- [1.1 Monorepo 初始化与工具链](#11-monorepo-初始化与工具链)
- [1.2 shared 包——跨端共用类型](#12-shared-包跨端共用类型)
- [1.3 LLM 层——Vercel AI SDK 统一接入](#13-llm-层vercel-ai-sdk-统一接入)
  - [模型创建入口](#模型创建入口)
  - [为什么不再自研 LLM 客户端](#为什么不再自研-llm-客户端)
- [1.4 Agent 核心——AI SDK 工具循环](#14-agent-核心ai-sdk-工具循环)
  - [业务事件信封 AgentEvent [CUSTOM]](#agentevent-业务事件信封-custom)
  - [带工具循环的流式对话](#带工具循环的流式对话)
- [1.5 流式 HTTP API](#15-流式-http-api)
  - [POST /api/chat](#post-apichat-route-handler)
  - [会话存储（Postgres/Redis，不自研）](#会话存储postgresredis)
  - [Nginx 配置](#nginx-配置与避坑)
- [1.6 前端——聊天 UI](#16-前端聊天-ui)
  - [useChat 接入](#usechat-接入)
  - [流式 Markdown 与工具卡片](#流式-markdown-与工具卡片)
  - [长列表虚拟化](#长列表虚拟化)
- [1.7 Electron 桌面壳](#17-electron-桌面壳)
  - [窗口创建与安全配置](#窗口创建与安全配置)
  - [preload 安全 IPC](#preload-安全-ipc)
  - [打包与自动更新](#打包与自动更新)
- [1.8 本层验收清单](#18-本层验收清单)

---

## 1.1 Monorepo 初始化与工具链

**为什么不用 `create-next-app`？** 因为它生成的项目不含 workspace 配置，后续加 Electron 和共享包时会被 pnpm workspace 约束卡住。先搭好 workspace，上层随意加。Monorepo 的核心是让 `packages/core` 的 TypeScript 源码直接被 Next.js 和 Electron 消费。

创建目录骨架：

```bash
mkdir -p agent-core/apps/web/src apps/electron/src packages/core/src packages/shared/src
cd agent-core
```

**根 package.json**

🤖 **AI 常见错误**：根 package.json 写 `"private": true` 后在子包忘记显式声明依赖。Monorepo 的依赖必须显式声明在使用它的包里，workspace root 的依赖只是"可用"不是"共享"。

```json
// package.json
{
  "name": "agent-core",
  "private": true,
  "engines": { "node": ">=20.0.0", "pnpm": ">=9.0.0" },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "typecheck": "turbo run typecheck --parallel",
    "clean": "turbo run clean && rm -rf node_modules"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "turbo": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

**pnpm workspace 配置**

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
```

保持扁平——如果 app 里嵌套 workspace，pnpm 不会递归识别。

**Turbo 管道**

🔗 **工程逻辑**：`dependsOn: ["^build"]` 中的 `^` 表示"依赖包必须先构建"。`pnpm build` 自动按 core -> shared -> web/electron 顺序构建。

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "globalEnv": ["NODE_ENV", "NEXT_PUBLIC_*"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^typecheck"]
    }
  }
}
```

**core / shared 包骨架**

```json
// packages/core/package.json
{
  "name": "@agentcore/core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ai": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "@ai-sdk/anthropic": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

```json
// packages/shared/package.json
{
  "name": "@agentcore/shared",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {}
}
```

---

## 1.2 shared 包——跨端共用类型

shared 包只放**前后端/桌面端共用、且零运行时依赖**的类型与常量。放数据库模型进 shared 会让前端被迫引入 node-only 依赖，打包报错。

```typescript
// packages/shared/src/index.ts
export const APP_NAME = 'Agent Core';
export const DEFAULT_MAX_MESSAGES = 100;

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
```

🤖 **AI 常见错误**：把后端专属类型（数据库模型、ORM schema）混进 shared 包，前端打包被迫引入 `pg`、`drizzle-orm`。shared 包必须保持零运行时依赖。

---

## 1.3 LLM 层——Vercel AI SDK 统一接入

### 模型创建入口

> 不要自己写 OpenAI/Anthropic 客户端和工厂。**Vercel AI SDK** (`ai`) 统一了流式、工具调用、多 Provider，且类型完整。本 Skill 后续所有 reference 中的 `llm` 类型均为 `LanguageModel`（来自 `ai`）。

安装：

```bash
pnpm add ai @ai-sdk/openai @ai-sdk/anthropic
# 本地 Ollama / 任意 OpenAI 兼容端点：
pnpm add @ai-sdk/openai-compatible
```

创建模型：

```typescript
// packages/core/src/llm.ts —— 全项目唯一的模型创建入口
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

export type Provider = 'openai' | 'anthropic';

export function createModel(
  provider: Provider,
  env: Record<string, string | undefined>
): LanguageModel {
  switch (provider) {
    case 'openai':
      return createOpenAI({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_BASE_URL ?? undefined,
      })(env.OPENAI_MODEL ?? 'gpt-4o');
    case 'anthropic':
      return createAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
      })(env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514');
  }
}
```

### 为什么不再自研 LLM 客户端

🔗 **工程逻辑**：手写 `LLMClient`（stream/estimateTokens/ping + provider 适配）在 2024 年还有意义，但现在：
- `LanguageModel` 是 `ai` 的核心抽象，`streamText` / `generateText` / `tool` 都围绕它；
- 工具调用帧、流式增量、取消、重连、用量统计全部由 SDK 处理；
- 后续 11（Function Calling）、13（结构化输出）、17（流式优化）复用同一个类型，不再自定义。

🤖 **AI 常见错误**：
1. 每次请求都 `new createOpenAI(...)`——连接池被反复重建，延迟和 socket 泄漏。**模型实例必须模块级缓存**。
2. 手写 `baseURL` 拼接（如 `baseURL + '/chat/completions'`）——OpenAI 兼容 SDK 只需填 `baseURL`，路径自动补全。拼接会得到双 `/chat/completions` 404。
3. 在 `LanguageModel` 外层再包一层"抽象"——多一层类型转换就多一处签名漂移。直接使用 SDK 类型，全项目统一。

---

## 1.4 Agent 核心——AI SDK 工具循环

### AgentEvent 业务事件信封 [CUSTOM]

`AgentEvent` 是本项目**业务差异层**的事件协议（SSE 下发给前端、被 03/06/08 等复用）。它不属于任何成熟库的范畴，是产品自定义的"事件信封"，因此保留手写——但内部实现全部用 SDK，不手写协议解析。

```typescript
// packages/core/src/agent/events.ts
export type AgentEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: unknown }
  | { type: 'tool_complete'; toolName: string; toolCallId: string; result: unknown }
  | { type: 'tool_error'; toolName: string; toolCallId: string; error: string }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; error: string }
  | { type: 'iteration'; count: number }
  | { type: 'context_status'; totalTokens: number; contextWindow: number; usageRatio: number };
```

🔗 **工程逻辑**：`AgentEvent` 只定义"事件长什么样"，不定义"怎么传输"。传输交给 AI SDK 的 `toDataStreamResponse`（见 1.5），传输格式由 SDK 保证，事件语义由本项目定义。这样既不自研协议，又保留产品差异化。

### 带工具循环的流式对话

ReAct 主循环（LLM 思考 → 调工具 → 拿结果 → 继续）由 AI SDK 的 `streamText` 原生支持：传 `tools` + `maxSteps`，SDK 自动完成工具调用循环。**不需要手写 `while` + `switch`。**

```typescript
// apps/web/src/app/api/chat/route.ts —— 核心 Agent 循环（SDK 一行搞定）
import { streamText, tool, type UIMessage } from 'ai';
import { z } from 'zod';
import { createModel } from '@agentcore/core/llm';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const result = streamText({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    system: '你是一个通用助手。请以有帮助、安全的方式回答用户问题。',
    messages,
    tools: {
      getWeather: tool({
        description: '查询指定城市的天气',
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }) => {
          // 实际调用天气 API；失败时抛错会被 SDK 包装成 tool_error
          return { city, temp: 24, unit: 'C' };
        },
      }),
    },
    maxSteps: 10, // ReAct 循环上限，等价于手写 while(maxIterations)，防死循环
  });

  return result.toDataStreamResponse();
}
```

🤖 **AI 常见错误**：
1. 不设 `maxSteps`——LLM 反复调同一工具时无限循环烧 token。**必须设硬上限（推荐 10-30）**。
2. 工具抛异常后不处理——`execute` 里 throw 会被 SDK 捕获并作为 `tool_error` 回传，但你必须 `try/catch` 转成对 LLM 有用的错误消息，否则模型会重复调用同一工具。
3. 手动把 `tool_calls` 追加进 `messages` 数组——SDK 内部处理了，你再追加会导致重复调用。

`UIMessage` 是 `ai` 的前端消息类型（`ai/react` 的 `useChat` 直接消费），不要自己定义消息模型。

---

## 1.5 流式 HTTP API

### POST /api/chat Route Handler

`toDataStreamResponse()` 生成标准 SSE 流，`ai/react` 的 `useChat` 原生消费——**不要手写 SSE 拼接**。

```typescript
// apps/web/src/app/api/chat/route.ts（续：会话与会话列表）
import { NextResponse } from 'next/server';
import { createSessionStore } from '@agentcore/core/session-store';

const store = createSessionStore(); // Postgres/Redis，见下方

export async function GET() {
  return NextResponse.json({ sessions: await store.list() });
}

export async function PUT() {
  const s = await store.create();
  return NextResponse.json({ id: s.id });
}

export async function DELETE(req: Request) {
  const { sessionId } = await req.json();
  await store.remove(sessionId);
  return NextResponse.json({ ok: true });
}
```

### 会话存储：Postgres/Redis

不要自己写 JSON 文件存储。开发期用内存，生产用 Postgres（`drizzle-orm`）或 Redis（`ioredis`）。

```typescript
// packages/core/src/session-store.ts —— 内存实现（开发期）；生产切换 drizzle/ioredis 即可
export interface SessionStore {
  list(): Promise<Array<{ id: string; title: string }>>;
  create(): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
}

export function createSessionStore(): SessionStore {
  const rows = new Map<string, { title: string }>();
  return {
    async list() {
      return [...rows.entries()].map(([id, r]) => ({ id, title: r.title }));
    },
    async create() {
      const id = crypto.randomUUID();
      rows.set(id, { title: '新会话' });
      return { id };
    },
    async remove(id: string) {
      rows.delete(id);
    },
  };
}
```

### Nginx 配置与避坑

SSE 在 Nginx 后必须关缓冲，否则会被整段缓存、前端收不到流式 token。

```nginx
location /api/chat {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 300s;
    proxy_cache off;
}
```

🤖 **AI 常见错误**：只关 `proxy_buffering` 不设 `proxy_read_timeout`——LLM 推理超过 60s 时连接被 Nginx 切断，前端看起来像"断流"。Agent 场景建议 `proxy_read_timeout 600s`。

---

## 1.6 前端——聊天 UI

### useChat 接入

`useChat` 处理发送、流式接收、工具调用状态、取消——**不要手写 fetch + ReadableStream + EventSource 解析**。

```tsx
// apps/web/src/app/page.tsx
'use client';

import { useChat } from 'ai/react';
import { useState } from 'react';

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, stop } = useChat({
    api: '/api/chat',
  });

  return (
    <div className="mx-auto max-w-3xl p-4">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="输入消息…"
          className="flex-1 rounded-lg border p-2"
          disabled={isLoading}
        />
        <button type="submit" disabled={isLoading} className="rounded-lg bg-black px-4 text-white">
          发送
        </button>
        {isLoading && (
          <button type="button" onClick={stop} className="rounded-lg bg-red-500 px-4 text-white">
            停止
          </button>
        )}
      </form>
    </div>
  );
}
```

### 流式 Markdown 与工具卡片

流式过程中 `"```python"` 已输出但 `"```"` 还没来时，`react-markdown` 会把后续内容当代码块吞掉。用容错渲染。

```tsx
// apps/web/src/components/MessageBubble.tsx
'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UIMessage } from 'ai';
import { memo } from 'react';

export const MessageBubble = memo(function MessageBubble({ message }: { message: UIMessage }) {
  if (message.role === 'user') {
    return <div className="mb-2 text-right"><div className="inline-block rounded-lg bg-gray-100 p-3">{message.content}</div></div>;
  }
  return (
    <div className="mb-2 text-left">
      <div className="inline-block rounded-lg bg-white p-3 shadow-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        {message.parts
          ?.filter((p) => p.type === 'tool-invocation')
          .map((p) => (
            <ToolCallCard key={p.toolInvocation.toolCallId} invocation={p.toolInvocation} />
          ))}
      </div>
    </div>
  );
});
```

🤖 **AI 常见错误**：
1. 流式渲染不防未闭合代码块——必须用 `react-markdown` + 自定义 fence 容错，否则代码块在流式中断时崩溃。
2. 直接 `JSON.stringify(message)` 渲染工具结果——要用结构化卡片（loading / 成功 / 失败三态），失败不阻塞后续消息。
3. 长列表不虚拟化——1000+ 消息时 DOM 节点爆炸。用 `@tanstack/react-virtual`。

### 长列表虚拟化

```tsx
// apps/web/src/components/VirtualList.tsx（摘要）
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';

export function VirtualList({ items }: { items: Array<{ id: string; node: React.ReactNode }> }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    overscan: 10,
  });
  return (
    <div ref={parentRef} className="h-[70vh] overflow-auto">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((vi) => (
          <div key={vi.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
            {items[vi.index].node}
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 1.7 Electron 桌面壳

Electron 本身是成熟方案，这里只写**必要的胶水层**（窗口、IPC、preload），不写任何 LLM/网络逻辑——渲染层就是 Web 版。

### 窗口创建与安全配置

```typescript
// apps/electron/src/main.ts
import { app, BrowserWindow } from 'electron';
import path from 'node:path';

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../web/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

🤖 **AI 常见错误**：`contextBridge.exposeInMainWorld('electron', { ... })` 暴露一大坨 API 且包含 `require('fs')`。渲染层一旦被 XSS，攻击者能读走本地文件。**preload 必须逐个暴露白名单函数。**

### preload 安全 IPC

```typescript
// apps/electron/src/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agentAPI', {
  sendMessage: (text: string) => ipcRenderer.invoke('agent:send', text),
  onMessage: (cb: (text: string) => void) => {
    const listener = (_: unknown, text: string) => cb(text);
    ipcRenderer.on('agent:message', listener);
    return () => ipcRenderer.removeListener('agent:message', listener);
  },
  cancelStream: () => ipcRenderer.invoke('agent:cancel'),
});
```

### 打包与自动更新

```json
// electron-builder.yml（要点）
appId: com.agentcore.app
productName: Agent Core
mac:
  hardenedRuntime: true
  notarize: true
win:
  certificateFile: cert.p12
  certificatePassword: ${env.WIN_CERT_PASSWORD}
publish:
  provider: github
  owner: your-org
  repo: agent-core
```

🔗 **工程逻辑**：`hardenedRuntime: true` + notarize 是 macOS Gatekeeper 的强制要求；Windows 证书密码走环境变量，不进 git。

---

## 1.8 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core`、`packages/shared`、`apps/web` 全部 0 错误。
- [ ] **模型接入**：`createModel('openai', { OPENAI_API_KEY: 'sk-test' })` 能返回 `LanguageModel` 实例；`baseURL` 指向本地 mock 时 `streamText` 能返回流式 token。
- [ ] **工具循环**：给 `streamText` 传 `getWeather` 工具并设置 `maxSteps: 10`，断言：LLM 发起工具调用 → SDK 自动执行 → 结果回传 → 最终 `finishReason` 为 `stop`；当工具连续失败时循环在 `maxSteps` 处终止（不会无限烧 token）。
- [ ] **SSE 流**：`POST /api/chat` 返回 `Content-Type: text/event-stream`，浏览器 DevTools Network 能看到 `data:` 分块；Nginx 下 60s+ 长响应不中断（`proxy_read_timeout 600s`）。
- [ ] **前端**：`useChat` 发送消息后逐 token 渲染；工具调用显示 loading → 成功/失败三态卡片；1000 条消息滚动不卡顿。
- [ ] **Electron 安全**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；preload 只暴露 `agentAPI` 白名单；打包后 `spctl -a -vv` 显示 `accepted`（macOS）。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本节验收清单。

---

> **与后续节点的衔接**：本层的 `createModel`（LLM 入口）、`AgentEvent`（事件信封）、`streamText` 工具循环（Agent 核心）是后续所有节点复用的地基。02 在其上加工具注册与 MCP；03 在其上加记忆与 RAG；05 在其上做多 Agent 编排。所有后续节点的 `llm` 一律指 `LanguageModel`（`ai` SDK 类型），不要再引入自定义 LLM 抽象。
