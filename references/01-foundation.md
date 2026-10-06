# 01 基础设施层（Foundation）

> Layer 0 目标：构建**能对话的窗口**——Monorepo + LLM 抽象 + Agent 主循环 + SSE 流式 API + React 聊天 UI + Electron 桌面壳。每完成一节，拥有一个真实可用的能力切片。

---

## 目录

- [1.1 Monorepo 初始化与工具链](#11-monorepo-初始化与工具链)
- [1.2 shared 包——跨端共用类型](#12-shared-包跨端共用类型)
- [1.3 core 包——LLM 抽象层](#13-core-包llm-抽象层)
  - [LLMMessage / LLMStreamChunk / LLMClient 接口](#llm-类型与接口)
  - [OpenAI 兼容客户端（完整实现）](#openai-兼容客户端)
  - [Anthropic 原生客户端（完整实现）](#anthropic-原生客户端)
  - [LLM 工厂](#llm-工厂)
- [1.4 Agent 核心——ReAct 主循环](#14-agent-核心react-主循环)
  - [类型系统](#agent-类型系统)
  - [AbstractAgent.run()](#abstractagent-主循环)
  - [Conversation 便捷类](#conversation-便捷类)
- [1.5 SSE 流式 HTTP API](#15-sse-流式-http-api)
  - [POST /api/chat](#post-apichat-route-handler)
  - [取消/abort](#取消abort-接口)
  - [会话存储](#会话存储独立化)
  - [SSE 重连协议](#sse-重连协议)
  - [会话列表](#会话列表接口)
  - [Nginx 配置](#nginx-配置与避坑)
- [1.6 前端——流式聊天 UI](#16-前端流式聊天-ui)
  - [SSE 解析器](#sse-解析器)
  - [API Client](#api-client)
  - [Zustand Store](#消息数据流zustand-store)
  - [useAgentStream Hook](#useagentstream-hook)
  - [消息气泡 + 流式 Markdown](#消息气泡渲染)
  - [长列表虚拟化](#长列表虚拟化)
  - [工具调用卡片](#工具调用卡片)
  - [ChatInput](#chatinput)
  - [页面主框架](#页面主框架)
- [1.7 Electron 桌面壳](#17-electron-桌面壳)
  - [主进程入口](#主进程入口)
  - [窗口创建](#窗口创建)
  - [IPC 通道](#ipc-通道设计)
  - [preload 安全 IPC](#preload--暴露安全的-browser-api)
  - [IPC Handlers](#ipc-handlers--主进程处理渲染请求)
  - [托盘 + 快捷键](#托盘与全局快捷键)
  - [Shell 适配层](#web-代码里如何调到-shell)
  - [打包与自动更新](#打包与自动更新)
- [1.8 本层验收](#18-本层验收)

---

## 1.1 Monorepo 初始化与工具链

**为什么不用 `create-next-app`？** 因为它生成的项目不含 workspace 配置，后续加 Electron 和共享包时会被 pnpm workspace 约束卡住。先搭好 workspace，上层随意加。Monorepo 的核心是让 `packages/core` 的 TypeScript 源码直接被 Next.js 和 Electron 消费——不是消费编译产物，而是消费源码本身。

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

🔗 **工程逻辑**：`dependsOn: ["^build"]` 中的 `^` 表示"依赖包必须先构建"。`pnpm build` 自动按 core -> shared -> web/electron 顺序构建。`persistent: true` 让 dev 任务保持运行。

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
      "dependsOn": ["build"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

**TypeScript 基础配置**

🔗 `verbatimModuleSyntax: true` 强制 `import { type Foo }`，让打包器正确 tree-shake。`noUncheckedIndexedAccess: true` 让 `arr[0]` 返回 `T | undefined`，杜绝"AI 认为数组非空其实运行时 undefined"的 bug。

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "baseUrl": ".",
    "paths": {
      "@agentcore/core": ["./packages/core/src/index.ts"],
      "@agentcore/core/*": ["./packages/core/src/*"],
      "@agentcore/shared": ["./packages/shared/src/index.ts"],
      "@agentcore/shared/*": ["./packages/shared/src/*"]
    }
  }
}
```

**环境变量模板**

🤖 **AI 常见错误**：把注释写在变量值同一行（如 `PORT=3000 # web port`）。pnpm 和 dotenv 对 inline 注释处理不一致，有时会把 `# web port` 当成值的一部分。**注释必须独占一行**。

```bash
# .env.example
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

ANTHROPIC_API_KEY=sk-ant-xxx
ANTHROPIC_MODEL=claude-sonnet-4-20250514

SSE_TIMEOUT_MS=120000
MAX_MESSAGES_PER_SESSION=100
MAX_MESSAGE_LENGTH_CHARS=50000

SANDBOX_TIMEOUT_MS=30000
SANDBOX_MEMORY_MB=512

PORT=3000
NEXT_PUBLIC_APP_NAME=Agent Core
```

**依赖安装顺序**

```bash
git init
echo "node_modules/" >> .gitignore
echo ".env" >> .gitignore
echo "dist/" >> .gitignore
echo ".next/" >> .gitignore
pnpm install
pnpm list --depth 0
```

**后端集成**：环境变量在 Next.js 中通过 `process.env` 读取，`NEXT_PUBLIC_` 前缀的变量会暴露到前端。Agent 配置在这里集中管理，后续节点的 tool system、sandbox 等都从这里追加变

---

## 1.2 shared 包——跨端共用类型

**工程逻辑**：shared 是所有包的"通用语言"，前端/core/Electron 都引用它，但**必须零运行时依赖**。引入 `pg`、`drizzle-orm` 等 node-only 库会导致前端打包报错。

```json
// packages/shared/package.json
{
  "name": "@agentcore/shared",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./constants": "./src/constants.ts", "./types": "./src/types.ts" }
}
```

```json
// packages/shared/tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

```typescript
// packages/shared/src/index.ts
export * from './types';
export * from './constants';
```

```typescript
// packages/shared/src/types.ts
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface BaseMessage { id: string; role: MessageRole; content: string; createdAt: number; }
export interface UserMessage extends BaseMessage { role: 'user'; }

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string; name: string; arguments: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'error';
  result?: unknown; error?: string;
}

export interface StreamEvent { type: 'token' | 'tool_call' | 'tool_result' | 'done' | 'error'; data: unknown; timestamp: number; }
```

```typescript
// packages/shared/src/constants.ts
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.7;
export const SSE_RETRY_INTERVAL_MS = 3000;
export const MAX_MESSAGE_LENGTH = 50000;
```

🤖 **AI 常见错误**：把后端专属的类型（如数据库模型）和纯共享类型混在 shared 包里。结果前端被迫引入 `pg`、`drizzle-orm` 这些 node-only 库，打包报错。**shared 包必须零运行时依赖**。

**前后端集成**：前端通过 `import { nanoid } from '@agentcore/shared'` 使用共享常量；core 通过 `"references": [{ "path": "../shared" }]` 建立类型引用。消息类型 `ToolCall`、`StreamEvent` 确保前后端数据结构对齐。

---

## 1.3 core 包——LLM 抽象层

**为什么抽象？** 不是为了"换模型方便"（顺带效果），而是 **让测试不需要真实 API key**。你能在 CI 里 mock LLM 层测 Agent 逻辑，也把"选了什么模型"变成运行时参数。

```
前端 (04)        ← 只关心事件流
    │
AbstractAgent    ← 工具注册·上下文·主循环
    │
LLMClient (抽象) ← 流式生成·工具调用·token 估算
    ├── OpenAICompatible
    └── AnthropicNative
```

### packages/c

🔗 `"main": "./src/index.ts"` 而不是 `./dist/index.js` —— workspace 内部让打包器自己处理 TS 编译。如果写 dist，改了 core 代码后 web 不会自动重新编译，一直用旧的 dist。

```json
// packages/core/package.json
{
  "name": "@agentcore/core",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./agent": "./src/agent/index.ts",
    "./llm": "./src/llm/index.ts",
    "./types": "./src/types.ts"
  },
  "dependencies": {
    "@agentcore/shared": "workspace:*",
    "openai": "^4.70.0",
    "zod": "^3.23.0",
    "nanoid": "^5.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

```json
// packages/core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [{ "path": "../shared" }],
  "exclude": ["node_modules", "dist"]
}
```

```typescript
// packages/core/src/index.ts
export { AbstractAgent } from './agent/base';
export type { AgentConfig, AgentContext, AgentTool } from './agent/types';
export { OpenAIClient } from './llm/openai';
export type { LLMMessage, LLMStreamChunk } from './llm/types';
```

### LLM 类型与接口

先定义契约再实现，避免"接口是实现的镜像"。

🔗 **为什么用 AsyncGenerator 而不是 Promise<string> 或 EventEmitter？** Promise 只能等全部完成，前端无法流式渲染；EventEmitter 没有标准取消语义且内存泄漏风险高。

```typescript
// packages/core/src/llm/types.ts

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: LLMToolCall[];
  name?: string;
}

export interface LLMToolCall {
  id: string; type: 'function';
  function: { name: string; arguments: string };  // arguments 是 JSON 字符串
}

export interface LLMToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LLMStreamChunk {
  type: 'token' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'done' | 'error';
  data: LLMStreamData;
}

export type LLMStreamData =
  | { content: string }
  | { toolCallId: string; name: string; args: string }
  | { toolCallId: string; argsDelta: string }
  | { finishReason: 'stop' | 'length' | 'tool_calls' | 'error' }
  | { error: string; code?: string };

export interface LLMClient {
  readonly provider: string;
  readonly model: string;
  stream(messages: LLMMessage[], opts?: LLMStreamOptions): AsyncGenerator<LLMStreamChunk>;
  estimateTokens(messages: LLMMessage[]): Promise<number>;
  ping(): Promise<boolean>;
}

export interface LLMStreamOptions {
  tools?: LLMToolDefinition[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}
```

### OpenAI 兼容客户端

覆盖 OpenAI / DeepSeek / 通义千问 / 本地 Ollama 等——**兼容 OpenAI Chat Completions API 的都行**。

🤖 **AI 常见错误**：① stream 里缺少 abort 检查（用户取消后 stream 仍在 yield 导致内存泄漏）② tool call 累积用数组不用 Map（同一工具 N 条破碎记录）③ catch 里不 yield 直接 throw（AsyncGenerator 里 throw 上层收不到）

```typescript
// packages/core/src/llm/openai.ts
import { OpenAI, type ClientOptions } from 'openai';
import { nanoid } from 'nanoid';
import type { LLMClient, LLMMessage, LLMStreamChunk, LLMToolDefinition, LLMStreamOptions } from './types';

export interface OpenAIClientConfig { apiKey: string; baseURL?: string; model: string; defaultTemperature?: number; defaultMaxTokens?: number; }

export class OpenAIClient implements LLMClient {
  readonly provider = 'openai-compatible';
  readonly model: string;
  private client: OpenAI;
  private defaultTemperature: number;
  private defaultMaxTokens: number;

  constructor(config: OpenAIClientConfig) {
    this.model = config.model;
    this.defaultTemperature = config.defaultTemperature ?? 0.7;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    const opts: ClientOptions = { apiKey: config.apiKey };
    if (config.baseURL) opts.baseURL = config.baseURL;
    this.client = new OpenAI(opts);
  }

  async *stream(messages: LLMMessage[], opts?: LLMStreamOptions): AsyncGenerator<LLMStreamChunk> {
    const apiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = messages.map(msg => this.toAPIMessage(msg));
    if (opts?.systemPrompt && apiMessages[0]?.role !== 'system')
      apiMessages.unshift({ role: 'system', content: opts.systemPrompt });

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined = opts?.tools?.map(t => ({
      type: 'function',
      function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters as Record<string, unknown> },
    }));

    let stream: Awaited<ReturnType<typeof this.client.chat.completions.create>>;
    try {
      stream = await this.client.chat.completions.create({
        model: this.model, messages: apiMessages, temperature: opts?.temperature ?? this.defaultTemperature,
        max_tokens: opts?.maxTokens ?? this.defaultMaxTokens, tools, stream: true,
      });
    } catch (error) {
      yield { type: 'error', data: { error: error instanceof Error ? error.message : 'Unknown API error', code: (error as { status?: number })?.status?.toString() } };
      return;
    }

    const toolCallAccum = new Map<string, { id: string; name: string; args: string }>();
    try {
      for await (const chunk of stream) {
        if (opts?.signal?.aborted) { yield { type: 'error', data: { error: 'Request aborted', code: 'ABORTED' } }; return; }
        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.delta?.content) yield { type: 'token', data: { content: choice.delta.content } };

        if (choice.delta?.tool_calls) {
          for (const delta of choice.delta.tool_calls) {
            const id = delta.id ?? nanoid();
            const existing = toolCallAccum.get(id);
            if (!existing) {
              toolCallAccum.set(id, { id, name: delta.function?.name ?? '', args: delta.function?.arguments ?? '' });
              yield { type: 'tool_call_start', data: { toolCallId: id, name: delta.function?.name ?? '' } };
            } else if (delta.function?.arguments) {
              existing.args += delta.function.arguments;
              yield { type: 'tool_call_delta', data: { toolCallId: id, argsDelta: delta.function.arguments } };
            }
          }
        }

        if (choice.finish_reason) {
          for (const [, tc] of toolCallAccum)
            yield { type: 'tool_call_end', data: { toolCallId: tc.id, name: tc.name, args: tc.args } };
          yield { type: 'done', data: { finishReason: choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'error' } };
          return;
        }
      }
    } catch (streamError) {
      yield { type: 'error', data: { error: streamError instanceof Error ? streamError.message : 'Stream broken' } };
    }
  }

  async estimateTokens(messages: LLMMessage[]): Promise<number> {
    return Math.ceil(messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / 3);
  }

  async ping(): Promise<boolean> {
    try { await this.client.models.retrieve(this.model); return true; } catch { return false; }
  }

  private toAPIMessage(msg: LLMMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    switch (msg.role) {
      case 'system': return { role: 'system', content: msg.content ?? '' };
      case 'user': return { role: 'user', content: msg.content ?? '' };
      case 'assistant':
        if (msg.tool_calls?.length) return { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.function.name, arguments: tc.function.arguments } })) };
        return { role: 'assistant', content: msg.content ?? '' };
      case 'tool': return { role: 'tool', tool_call_id: msg.tool_call_id ?? '', content: msg.content ?? '' };
    }
  }
}
```

### Anthropic 原生客户端

不走 OpenAI 兼容，用自己的 Message API。tool use 一次返回完整 tool_use block，无跨 delta 累积问题。

```typescript
// packages/core/src/llm/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMMessage, LLMStreamChunk, LLMToolDefinition, LLMStreamOptions } from './types';

export interface AnthropicClientConfig { apiKey: string; model: string; defaultTemperature?: number; defaultMaxTokens?: number; }

export class AnthropicClient implements LLMClient {
  readonly provider = 'anthropic';
  readonly model: string;
  private client: Anthropic;
  private defaultTemperature: number;
  private defaultMaxTokens: number;

  constructor(config: AnthropicClientConfig) {
    this.model = config.model;
    this.defaultTemperature = config.defaultTemperature ?? 0.7;
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  async *stream(messages: LLMMessage[], opts?: LLMStreamOptions): AsyncGenerator<LLMStreamChunk> {
    const systemPrompt = opts?.systemPrompt ?? messages.find(m => m.role === 'system')?.content ?? undefined;
    const filteredMessages = messages.filter(m => m.role !== 'system').map(m => this.toAPIMessage(m));
    const tools: Anthropic.Tool[] | undefined = opts?.tools?.map(t => ({
      name: t.function.name, description: t.function.description, input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    }));

    try {
      const stream = this.client.messages.stream({
        model: this.model, max_tokens: opts?.maxTokens ?? this.defaultMaxTokens,
        temperature: opts?.temperature ?? this.defaultTemperature, system: systemPrompt,
        messages: filteredMessages, tools,
      });

      for await (const event of stream) {
        if (opts?.signal?.aborted) { stream.controller.abort(); yield { type: 'error', data: { error: 'Request aborted', code: 'ABORTED' } }; return; }

        switch (event.type) {
          case 'content_block_start':
            if (event.content_block.type === 'tool_use')
              yield { type: 'tool_call_start', data: { toolCallId: event.content_block.id, name: event.content_block.name } };
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') yield { type: 'token', data: { content: event.delta.text } };
            else if (event.delta.type === 'input_json_delta') yield { type: 'tool_call_delta', data: { toolCallId: event.index.toString(), argsDelta: event.delta.partial_json } };
            break;
          case 'message_stop':
            yield { type: 'done', data: { finishReason: 'stop' } }; return;
        }
      }
    } catch (error) {
      yield { type: 'error', data: { error: error instanceof Error ? error.message : 'API error' } };
    }
  }

  async estimateTokens(messages: LLMMessage[]): Promise<number> {
    return Math.ceil(messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / 3);
  }

  async ping(): Promise<boolean> {
    try { await this.client.messages.countTokens({ model: this.model, messages: [{ role: 'user', content: 'ping' }] }); return true; } catch { return false; }
  }

  private toAPIMessage(msg: LLMMessage) {
    if (msg.role === 'user') return { role: 'user', content: msg.content ?? '' };
    if (msg.role === 'assistant') return { role: 'assistant', content: msg.content ?? '' };
    if (msg.role === 'tool') return { role: 'user', content: [{ type: 'tool_result' as const, tool_use_id: msg.tool_call_id ?? '', content: msg.content ?? '' }] };
    return { role: 'user', content: '' };
  }
}
```

### LLM 工厂

🔗 **工程逻辑**：`const _exhaustive: never = config` 是 TypeScript 的穷尽检查技巧。新增 provider 但忘了写 case，编译器在这里报错提醒你，而不是在运行时才炸。

```typescript
// packages/core/src/llm/factory.ts

import type { LLMClient } from './types';
import { OpenAIClient, type OpenAIClientConfig } from './openai';
import { AnthropicClient, type AnthropicClientConfig } from './anthropic';

export type LLMProviderConfig =
  | ({ provider: 'openai-compatible' } & OpenAIClientConfig)
  | ({ provider: 'anthropic' } & AnthropicClientConfig);

export function createLLMClient(config: LLMProviderConfig): LLMClient {
  switch (config.provider) {
    case 'openai-compatible':
      return new OpenAIClient(config);
    case 'anthropic':
      return new AnthropicClient(config);
    default:
      const _exhaustive: never = config;
      throw new Error(`Unknown provider: ${JSON.stringify(_exhaustive)}`);
  }
}
```

**后端集成**：`createLLMClient` 是后端唯一需要的工厂入口。Route Handler 根据 env 或用户选择创建 LLM 实例，注入到 Conversation 中。前端集成：前端不需要知道 LLM 实现，只通过 SSE 事件流消费输出。后续节点的 model selector 前端组件会把用户选择持久化到后端。

---

## 1.4 Agent 核心——ReAct 主循环

### Agent 类型系统

先抽象出"一个 Agent 需要什么"：

```typescript
// packages/core/src/agent/types.ts

import type { LLMToolDefinition, LLMStreamChunk } from '../llm/types';

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema
  execute: (args: any, ctx: ToolContext) => Promise<any>;
}

export interface ToolContext {
  signal?: AbortSignal;
  sessionId: string;
  onStart?: (toolName: string, args: any) => void;
  onComplete?: (toolName: string, result: any) => void;
}

export interface AgentConfig {
  systemPrompt: string;
  llm: import('../llm/types').LLMClient;
  tools: AgentTool[];
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentContext {
  messages: import('../llm/types').LLMMessage[];
  iteration: number;
  signal?: AbortSignal;
  sessionId: string;       // 03/06/08 用于 conversationId 路由与会话隔离
}

export type AgentEvent =
  | { type: 'token'; content: string }
  | { type: 'tool_start'; toolName: string; toolCallId: string; args: any }
  | { type: 'tool_complete'; toolName: string; toolCallId: string; result: any }
  | { type: 'tool_error'; toolName: string; toolCallId: string; error: string }
  | { type: 'done'; finishReason: string }
  | { type: 'error'; error: string }
  | { type: 'iteration'; count: number };
```

### AbstractAgent 主循环

🤖 **AI 常见错误**：① 只写 try 里的成功路径（工具抛异常=unhandled rejection）② maxIterations 不设死（bug 导致无限循环烧 token）③ 工具调用完不追加 tool result 到消息历史（LLM 反复调同一工具）④ `for await` 里 yield 错误后只 return 不清理（底层 HTTP 连接不释放）

```typescript
// packages/core/src/agent/base.ts
import { nanoid } from 'nanoid';
import type { LLMMessage } from '../llm/types';
import type { AgentConfig, AgentContext, AgentEvent } from './types';

export abstract class AbstractAgent {
  protected config: AgentConfig;
  protected maxIterations: number;

  constructor(config: AgentConfig) {
    this.config = { maxIterations: 10, ...config };
    this.maxIterations = this.config.maxIterations ?? 10;
  }

  async *run(userMessage: string, context: AgentContext): AsyncGenerator<AgentEvent> {
    context.messages.push({ id: nanoid(), role: 'user', content: userMessage, createdAt: Date.now() } as LLMMessage);

    for (let i = 0; i < this.maxIterations; i++) {
      if (context.signal?.aborted) { yield { type: 'error', error: 'Session aborted' }; return; }
      context.iteration = i + 1;
      yield { type: 'iteration', count: i + 1 };

      const toolDefs = this.config.tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));

      let assistantContent = '';
      const pendingToolCalls: Array<{ id: string; name: string; args: any }> = [];

      try {
        for await (const chunk of this.config.llm.stream(context.messages, {
          systemPrompt: this.config.systemPrompt, tools: toolDefs,
          temperature: this.config.temperature, maxTokens: this.config.maxTokens, signal: context.signal,
        })) {
          switch (chunk.type) {
            case 'token': assistantContent += chunk.data.content; yield { type: 'token', content: chunk.data.content }; break;
            case 'tool_call_end': pendingToolCalls.push({ id: chunk.data.toolCallId, name: chunk.data.name, args: JSON.parse(chunk.data.args || '{}') }); break;
            case 'error': yield { type: 'error', error: chunk.data.error }; return;
          }
        }
      } catch (error) {
        yield { type: 'error', error: error instanceof Error ? error.message : 'Stream failed' }; return;
      }

      if (pendingToolCalls.length === 0) {
        context.messages.push({ id: nanoid(), role: 'assistant', content: assistantContent, createdAt: Date.now() } as LLMMessage);
        yield { type: 'done', finishReason: 'stop' }; return;
      }

      context.messages.push({
        id: nanoid(), role: 'assistant', content: assistantContent, createdAt: Date.now(),
        tool_calls: pendingToolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
      } as LLMMessage);

      for (const tc of pendingToolCalls) {
        const tool = this.config.tools.find(t => t.name === tc.name);
        if (!tool) {
          yield { type: 'tool_error', toolName: tc.name, toolCallId: tc.id, error: `Unknown tool: ${tc.name}` };
          context.messages.push({ id: nanoid(), role: 'tool', content: JSON.stringify({ error: `Tool "${tc.name}" not found` }), tool_call_id: tc.id, createdAt: Date.now() } as LLMMessage);
          continue;
        }

        yield { type: 'tool_start', toolName: tc.name, toolCallId: tc.id, args: tc.args };
        try {
          const result = await tool.execute(tc.args, { signal: context.signal, sessionId: context.sessionId });
          yield { type: 'tool_complete', toolName: tc.name, toolCallId: tc.id, result };
          context.messages.push({ id: nanoid(), role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result), tool_call_id: tc.id, createdAt: Date.now() } as LLMMessage);
        } catch (toolError) {
          const errMsg = toolError instanceof Error ? toolError.message : 'Tool execution failed';
          yield { type: 'tool_error', toolName: tc.name, toolCallId: tc.id, error: errMsg };
          context.messages.push({ id: nanoid(), role: 'tool', content: JSON.stringify({ error: errMsg }), tool_call_id: tc.id, createdAt: Date.now() } as LLMMessage);
        }
      }
    }
    yield { type: 'error', error: 'Maximum iterations reached' };
  }
}
```

### Conversation 便捷类

```typescript
// packages/core/src/agent/conversation.ts
import { AbstractAgent } from './base';
import type { AgentConfig, AgentContext, AgentEvent } from './types';

export class Conversation {
  private agent: AbstractAgent;
  private context: AgentContext;
  private abortController: AbortController | null = null;

  constructor(config: AgentConfig) {
    this.agent = new (class extends AbstractAgent {})(config);
    this.context = { messages: [], iteration: 0, sessionId: crypto.randomUUID() };
  }

  async *send(message: string): AsyncGenerator<AgentEvent> {
    this.abortController = new AbortController();
    this.context.signal = this.abortController.signal;
    yield* this.agent.run(message, this.context);
  }

  getMessages(): AgentContext['messages'] { return [...this.context.messages]; }
  setAbortSignal(signal: AbortSignal): void { this.context.signal = signal; }
  abort(): void { this.context.signal?.abort(); this.context.signal = new AbortController().signal; }
  restore(messages: AgentContext['messages']): void { this.context.messages = messages; }
}
```

**本地测试**：

```typescript
// scripts/test-agent.ts（调试用，不进生产代码）
const llm = createLLMClient({ provider: 'openai-compatible', apiKey: process.env.OPENAI_API_KEY!, model: process.env.OPENAI_MODEL! });
const conv = new Conversation({ systemPrompt: 'You are a helpful assistant.', llm, tools: [] });
for await (const event of conv.send('Hello!')) {
  if (event.type === 'token') process.stdout.write(event.content);
  if (event.type === 'done') console.log('\n---');
}
```

**前后端集成**：前端通过 SSE `/api/chat` 调用后端，后端 Route Handler 找到对应 `Conversation`，调用 `send()`，把 AgentEvent 逐个写入 SSE 流。后续节点把 Conversation 实例从内存 Map 换到 Redis。

---

## 1.5 SSE 流式 HTTP API

**为什么不选 WebSocket？** SSE 是单向（服务端 -> 客户端），Agent 场景恰好就是单向推送。好处：自动重连、浏览器原生 EventSource、curl 能直接 debug、不需要 upgrade 握手。需要双向时加 `POST /api/abort` 即可。

### 协议设计

SSE 格式：每行 `data:` 后面跟一个 JSON，双层 `\n\n` 分隔。

🤖 **常见错误：AI 经常把 token data 写成单层 `\n`**，然后发现前端 EventSource 不触发。SSE 要求双 `\n\n` 分隔事件。

```
data: {"type":"iteration","data":{"count":1}}\n\n
data: {"type":"token","data":{"content":"你"}}\n\n
data: {"type":"tool_start","data":{"toolName":"search","toolCallId":"tc_abc","args":{}}}\n\n
data: {"type":"done","data":{"finishReason":"stop"}}\n\n
```

### POST /api/chat

🔗 **工程逻辑**：
- `X-Accel-Buffering: no` —— Nginx 默认缓冲整个响应，没有这行前端看到所有 token 同时喷出。**上线前务必加**。
- `req.signal.addEventListener('abort', ...)` —— 用户关闭 tab 时取消 Agent 继续推理，节省 API 费用。

```typescript
// apps/web/src/app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateSession } from './chat-store';

export async function POST(req: NextRequest) {
  const { content, sessionId } = await req.json();
  if (!content || typeof content !== 'string') return NextResponse.json({ error: 'content required' }, { status: 400 });
  if (content.length > 50000) return NextResponse.json({ error: 'content too long' }, { status: 413 });

  const conv = getOrCreateSession(sessionId);
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort());

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data, timestamp: Date.now() })}\n\n`));
      };
      try {
        conv.setAbortSignal(abortController.signal);
        for await (const event of conv.send(content)) {
          switch (event.type) {
            case 'token': send('token', { content: event.content }); break;
            case 'tool_start': send('tool_start', { toolName: event.toolName, toolCallId: event.toolCallId, args: event.args }); break;
            case 'tool_complete': send('tool_complete', { toolName: event.toolName, toolCallId: event.toolCallId, result: event.result }); break;
            case 'tool_error': send('tool_error', { toolName: event.toolName, toolCallId: event.toolCallId, error: event.error }); break;
            case 'iteration': send('iteration', { count: event.count }); break;
            case 'done': send('done', { finishReason: event.finishReason }); break;
            case 'error': send('error', { error: event.error }); break;
          }
        }
      } catch (err) {
        send('error', { error: 'Internal server error: ' + (err as Error).message });
      } finally { controller.close(); }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
    },
  });
}
```

### 取消/abort

```typescript
// apps/web/src/app/api/abort/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sessions } from './chat-store';

export async function POST(req: NextRequest) {
  const { sessionId } = await req.json();
  const conv = sessions.get(sessionId);
  if (!conv) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  conv.abort();
  return NextResponse.json({ ok: true });
}
```

### 会话存储独立化

抽出独立文件避免 route handler 之间 import 循环：

```typescript
// apps/web/src/app/api/chat-store.ts
import { createLLMClient } from '@agentcore/core/llm';
import { Conversation } from '@agentcore/core/agent';

export const sessions = new Map<string, Conversation>();

export function getOrCreateSession(sessionId: string): Conversation {
  let conv = sessions.get(sessionId);
  if (!conv) {
    const llm = createLLMClient({ provider: 'openai-compatible', apiKey: process.env.OPENAI_API_KEY!, baseURL: process.env.OPENAI_BASE_URL, model: process.env.OPENAI_MODEL! });
    conv = new Conversation({ systemPrompt: 'You are a helpful assistant.', llm, tools: [] });
    sessions.set(sessionId, conv);
  }
  return conv;
}

export function deleteSession(sessionId: string): void { sessions.delete(sessionId); }
export function listSessions(): Array<{ id: string; messageCount: number }> {
  return Array.from(sessions.entries()).map(([id, conv]) => ({ id, messageCount: conv.getMessages().length }));
}
```

### SSE 重连协议

🔗 **Last-Event-Id** 是 SSE 标准重连方式。EventSource 重连时自动带此 header。

```typescript
// route.ts 中带 id 的 send 函数
import { nanoid } from '@agentcore/shared';
const send = (type: string, data: unknown) => {
  const eventId = nanoid();
  controller.enqueue(encoder.encode(`id: ${eventId}\n`));
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data, timestamp: Date.now() })}\n\n`));
};

if (lastEventId) {
  const missed = await getEventsAfter(sessionId, lastEventId);
  for (const evt of missed) send(evt.type, evt.data);
}
```

### 会话列表

```typescript
// apps/web/src/app/api/sessions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { listSessions, deleteSession, getOrCreateSession } from '../chat-store';
import { nanoid } from '@agentcore/shared';

export async function GET() { return NextResponse.json({ sessions: listSessions() }); }
export async function PUT() { const s = nanoid(12); getOrCreateSession(s); return NextResponse.json({ id: s }); }
export async function DELETE(req: NextRequest) { const { sessionId } = await req.json(); deleteSession(sessionId); return NextResponse.json({ ok: true }); }
```

### Nginx + Next.js Dev 修复 + 断网处理

```nginx
location /api/chat {
    proxy_pass http://backend; proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off; proxy_read_timeout 300s; proxy_cache off;
}
```

```javascript
// apps/web/next.config.js
module.exports = {
  transpilePackages: ['@agentcore/core', '@agentcore/shared'],
  async headers() { return [{ source: '/api/:path*', headers: [{ key: 'Cache-Control', value: 'no-store' }] }]; },
};
```

```typescript
// LLM Stream 中途断网
try { for await (const chunk of llm.stream(...)) { /* ... */ } }
catch (error) {
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) yield { type: 'error', error: '请求过于频繁' };
    else if (error.status === 500) yield { type: 'error', error: '模型服务暂时不可用' };
  }
  // 不要 re-throw，SSE 需要优雅关闭
}
```

**前后端集成**：前端 `fetch('/api/chat', { method: 'POST' })` 获取 `ReadableStream`，传给 `parseSSEStream` 解析。abort 通过 `AbortController`。后端 Route Handler 做三件事：校验请求 → 获取/创建 Conversation → AgentEvent 编码为 SSE。

---

## 1.6 前端——流式聊天 UI

### SSE 解析器

🤖 **AI 常见错误**：把 buffer 逻辑写丢——`buffer = parts.pop()` 这一行。SSE 事件可能跨 TCP 包到达，必须按 `\n\n` 分割并保留不完整的尾部。

```typescript
// apps/web/src/lib/streamParser.ts

export interface SSEParseResult {
  id?: string;
  type: string;
  data: unknown;
  timestamp: number;
}

export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<SSEParseResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';  // 最后一段可能不完整

      for (const part of parts) {
        if (!part.trim()) continue;

        let id: string | undefined;
        let type = 'message';
        let data = '';

        for (const line of part.split('\n')) {
          if (line.startsWith('id:')) {
            id = line.slice(3).trim();
          } else if (line.startsWith('event:')) {
            type = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            data = line.slice(5).trim();
          }
        }

        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          yield { id, type: parsed.type ?? type, data: parsed.data, timestamp: parsed.timestamp };
        } catch {
          yield { id, type, data: data as unknown };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

### API Client

```typescript
// apps/web/src/lib/api.ts

import { parseSSEStream, type SSEParseResult } from './streamParser';

export function streamChat(params: {
  content: string;
  sessionId: string;
  lastEventId?: string;
  onEvent: (event: SSEParseResult) => void;
  onError?: (error: Error) => void;
}): { abort: () => void } {
  const controller = new AbortController();

  (async () => {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        params.onError?.(new Error(`HTTP ${response.status}`));
        return;
      }

      for await (const event of parseSSEStream(response.body)) {
        params.onEvent(event);
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        params.onError?.(error as Error);
      }
    }
  })();

  return { abort: () => controller.abort() };
}
```

### Zustand Store

```typescript
// apps/web/src/components/chat/chatStore.ts
import { create } from 'zustand';
import { nanoid } from '@agentcore/shared';

export interface UIMessage { id: string; role: 'user' | 'assistant' | 'system'; content: string; status: 'pending' | 'streaming' | 'completed' | 'error'; toolCalls: ToolCallUI[]; createdAt: number; }
export interface ToolCallUI { id: string; name: string; args: Record<string, unknown>; status: 'pending' | 'running' | 'completed' | 'error'; result?: unknown; error?: string; }

interface ChatState {
  messages: UIMessage[]; isStreaming: boolean; streamingContent: string;
  addUserMessage: (content: string) => void; appendStreamToken: (token: string) => void;
  startStreaming: () => void; finishStreaming: () => void; setError: (error: string) => void;
  addToolCall: (msgId: string, tc: ToolCallUI) => void; updateToolCall: (msgId: string, tcId: string, patch: Partial<ToolCallUI>) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [], isStreaming: false, streamingContent: '',
  addUserMessage: (content) => set((s) => ({ messages: [...s.messages, { id: nanoid(), role: 'user', content, status: 'completed', toolCalls: [], createdAt: Date.now() }] })),
  startStreaming: () => set({ isStreaming: true, streamingContent: '' }),
  appendStreamToken: (token) => set((s) => ({ streamingContent: s.streamingContent + token })),
  finishStreaming: () => set((s) => ({ isStreaming: false, streamingContent: '', messages: [...s.messages, { id: nanoid(), role: 'assistant', content: s.streamingContent, status: 'completed', toolCalls: [], createdAt: Date.now() }] })),
  setError: (error) => set((s) => ({ isStreaming: false, messages: [...s.messages, { id: nanoid(), role: 'assistant', content: `\u274c ${error}`, status: 'error', toolCalls: [], createdAt: Date.now() }] })),
  addToolCall: (msgId, tc) => set((s) => ({ messages: s.messages.map((m) => m.id === msgId ? { ...m, toolCalls: [...m.toolCalls, tc] } : m) })),
  updateToolCall: (msgId, tcId, patch) => set((s) => ({ messages: s.messages.map((m) => m.id === msgId ? { ...m, toolCalls: m.toolCalls.map((tc) => tc.id === tcId ? { ...tc, ...patch } : tc) } : m) })),
  reset: () => set({ messages: [], isStreaming: false, streamingContent: '' }),
}));
```

### useAgentStream Hook

前端与 Agent 握手的关键点。为什么不用 useEffect？因为需要支持"用户主动停止"（需要 Ref 存 controller）和"重连"（需要保存 lastEventId），组件卸载时要自动 abort。

```typescript
// apps/web/src/components/chat/useAgentStream.ts

'use client';

import { useRef, useCallback, useEffect } from 'react';
import { useChatStore, type ToolCallUI } from './chatStore';
import { streamChat } from '@/lib/api';

export function useAgentStream(sessionId: string) {
  const { addUserMessage, startStreaming, appendStreamToken,
          finishStreaming, setError, addToolCall } = useChatStore();

  const abortRef = useRef<(() => void) | null>(null);
  const streamingMsgIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => { abortRef.current?.(); };
  }, []);

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim()) return;

      addUserMessage(content);
      startStreaming();
      streamingMsgIdRef.current = 'streaming';

      const { abort } = streamChat({
        content,
        sessionId,
        onEvent: (event) => {
          switch (event.type) {
            case 'token':
              appendStreamToken(event.data.content as string);
              break;
            case 'tool_start': {
              const tc: ToolCallUI = {
                id: event.data.toolCallId as string,
                name: event.data.toolName as string,
                args: event.data.args as Record<string, unknown>,
                status: 'running',
              };
              addToolCall(streamingMsgIdRef.current!, tc);
              break;
            }
            case 'tool_complete':
              // 更新 tool call 状态
              break;
            case 'done':
              finishStreaming();
              break;
            case 'error':
              setError(event.data.error as string);
              break;
          }
        },
        onError: (error) => { setError(error.message); },
      });

      abortRef.current = abort;
    },
    [sessionId, addUserMessage, startStreaming, appendStreamToken, finishStreaming, setError, addToolCall]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.();
    finishStreaming();
  }, [finishStreaming]);

  return { sendMessage, stopGeneration };
}
```

### 消息气泡渲染

🤖 **AI 常见错误**：直接用 `<ReactMarkdown>` 不加 `safeContent` 容错。流式过程中 `"```python"` 已经输出但 `"```"` 还没来，react-markdown 会把后面所有内容当成代码块。

```typescript
// apps/web/src/components/chat/StreamingBubble.tsx

'use client';

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { code } from './MarkdownCodeBlock';
import { useChatStore } from './chatStore';

export function StreamingBubble() {
  const streamingContent = useChatStore((s) => s.streamingContent);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const safeContent = useMemo(() => {
    if (!isStreaming) return streamingContent;
    const codeBlockCount = (streamingContent.match(/```/g) || []).length;
    if (codeBlockCount % 2 === 1) {
      return streamingContent + '\n```';  // 临时闭合未闭合的代码块
    }
    return streamingContent;
  }, [streamingContent, isStreaming]);

  return (
    <div className="prose prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ code }}
      >
        {safeContent || '▌'}
      </ReactMarkdown>
    </div>
  );
}

export function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4 animate-fade-in`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 ${
          isUser
            ? 'bg-accent text-white rounded-br-sm'
            : 'bg-surface border border-border rounded-bl-sm'
        }`}
      >
        {message.role === 'assistant' ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code }}>
            {message.content}
          </ReactMarkdown>
        ) : (
          <p className="whitespace-pre-wrap">{message.content}</p>
        )}

        {message.toolCalls.length > 0 && (
          <div className="mt-3 space-y-2">
            {message.toolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

### 长列表虚拟化

🔗 **工程逻辑**：为什么流式气泡不在虚拟化列表内？虚拟化列表里所有 item height 是预估的。流式内容长度随时变化会导致光标跳动。放在外面后，totalSize 不变，只是多叠一个气泡。

```typescript
// apps/web/src/components/chat/MessageList.tsx

'use client';

import { useRef, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useChatStore } from './chatStore';
import { MessageBubble, StreamingBubble } from './StreamingBubble';

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const streamingContent = useChatStore((s) => s.streamingContent);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 10,
    getItemKey: (index) => messages[index]?.id ?? index,
  });

  // 流式消息时自动滚到底部
  useEffect(() => {
    if (isStreaming && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [isStreaming, streamingContent, messages.length, virtualizer]);

  return (
    <div ref={parentRef} className="flex-1 overflow-y-auto px-4 py-6">
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const msg = messages[virtualItem.index];
          if (!msg) return null;

          return (
            <div
              key={virtualItem.key}
              style={{
                position: 'absolute',
                top: virtualItem.start,
                left: 0,
                right: 0,
                minHeight: `${virtualItem.size}px`,
              }}
            >
              <MessageBubble message={msg} />
            </div>
          );
        })}
      </div>

      {isStreaming && streamingContent && (
        <div className="flex justify-start mb-4">
          <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-surface border border-border rounded-bl-sm">
            <StreamingBubble />
          </div>
        </div>
      )}
    </div>
  );
}
```

### 工具调用卡片

```typescript
// apps/web/src/components/chat/ToolCallCard.tsx

'use client';

import { useState } from 'react';
import type { ToolCallUI } from './chatStore';

export function ToolCallCard({ toolCall }: { toolCall: ToolCallUI }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    pending: '⏳',
    running: <span className="inline-block w-3 h-3 bg-yellow-400 rounded-full animate-pulse" />,
    completed: '✅',
    error: '❌',
  }[toolCall.status];

  return (
    <div className="rounded-lg border border-border bg-bg/50 text-sm overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-surface/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span>{statusIcon}</span>
        <span className="font-mono font-medium text-accent">{toolCall.name}</span>
        {toolCall.status === 'running' && (
          <span className="text-muted text-xs ml-auto">执行中...</span>
        )}
        <span className="text-muted text-xs ml-auto">{expanded ? '▴' : '▾'}</span>
      </button>

      {expanded && (
        <div className="border-t border-border p-3 space-y-2">
          <div>
            <div className="text-muted text-xs mb-1">参数:</div>
            <pre className="text-xs bg-bg rounded p-2 overflow-x-auto">
              {JSON.stringify(toolCall.args, null, 2)}
            </pre>
          </div>
          {(toolCall.result || toolCall.error) && (
            <div>
              <div className="text-muted text-xs mb-1">
                {toolCall.error ? '错误:' : '结果:'}
              </div>
              <pre
                className={`text-xs rounded p-2 overflow-x-auto ${
                  toolCall.error ? 'bg-red-500/10 text-red-400' : 'bg-bg'
                }`}
              >
                {toolCall.error
                  ? toolCall.error
                  : typeof toolCall.result === 'string'
                    ? toolCall.result
                    : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

### ChatInput

```typescript
// apps/web/src/components/chat/ChatInput.tsx

'use client';

import { useState, useRef, useCallback, type KeyboardEvent } from 'react';
import { useAgentStream } from './useAgentStream';
import { useChatStore } from './chatStore';

export function ChatInput({ sessionId }: { sessionId: string }) {
  const [input, setInput] = useState('');
  const { sendMessage, stopGeneration } = useAgentStream(sessionId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const handleSubmit = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) return;  // Shift+Enter 换行
      e.preventDefault();
      if (isStreaming) {
        stopGeneration();
      } else {
        handleSubmit();
      }
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  return (
    <div className="border-t border-border bg-surface p-4">
      <div className="max-w-3xl mx-auto flex gap-3 items-end">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-bg px-4 py-3
                     text-text placeholder:text-muted focus:outline-none focus:ring-2
                     focus:ring-accent/50 transition-shadow"
        />
        <button
          onClick={isStreaming ? stopGeneration : handleSubmit}
          disabled={!input.trim() && !isStreaming}
          className={`px-5 py-3 rounded-xl font-medium transition-colors ${
            isStreaming
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-accent hover:bg-accent/90 text-white disabled:opacity-50 disabled:cursor-not-allowed'
          }`}
        >
          {isStreaming ? '⏹ 停止' : '↑ 发送'}
        </button>
      </div>
    </div>
  );
}
```

### 页面主框架

```typescript
// apps/web/src/app/chat/[sessionId]/page.tsx

'use client';

import { ChatArea } from '@/components/chat/ChatArea';
import { SessionSidebar } from '@/components/sidebar/SessionSidebar';
import { ChatInput } from '@/components/chat/ChatInput';

export default function ChatPage({ params }: { params: { sessionId: string } }) {
  const { sessionId } = params;

  return (
    <div className="flex h-screen bg-bg">
      <SessionSidebar currentSessionId={sessionId} />
      <div className="flex-1 flex flex-col min-w-0">
        <ChatArea sessionId={sessionId} />
        <ChatInput sessionId={sessionId} />
      </div>
    </div>
  );
}

function ChatArea({ sessionId }: { sessionId: string }) {
  return (
    <main className="flex flex-col flex-1 min-h-0">
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <h1 className="text-text font-semibold">对话</h1>
        <span className="text-muted text-sm font-mono">{sessionId}</span>
      </header>
      <MessageList />
    </main>
  );
}
```

### Tailwind 主题配置

```typescript
// apps/web/tailwind.config.ts

import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        border: 'rgb(var(--border) / <alpha-value>)',
        text: 'rgb(var(--text) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
      },
      animation: {
        'pulse-cursor': 'pulse-cursor 1s ease-in-out infinite',
      },
      keyframes: {
        'pulse-cursor': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
};

export default config;
```

**后端集成**：前端通过 `/api/chat` SSE 接口从后端接收 AgentEvent。每个事件类型对应一种 UI 处理逻辑：`token` -> appendStreamToken，`tool_start` -> addToolCall，`done` -> finishStreaming。前端的 `sessionId` 通过 URL params 传入，与后端的 sessions map 对应。

**前端避坑汇总**：
- 流式输出闪烁：每次新 token 都重新渲染整个 Markdown —— 解决：streaming 期间累积到 streamingContent state，整体一次性渲染
- 代码块渲染异常：流式过程未闭合 —— 解决：自动追加临时 ` ``` ` 闭合
- 长列表卡死：解决：`@tanstack/react-virtual` 只渲染视口内
- 滚动时消息被回收：解决：流式时强制 scrollToIndex 到底部
- Textarea 发送后高度没重置：解决：sendMessage 后手动 `el.style.height = 'auto'`
- 工具调用看不到执行中状态：解决：需要在 stream 事件里加上 `tool_start` 事件响应

---

## 1.7 Electron 桌面壳

**核心原则：Web 是主体，Electron 是壳。** Web 代码里零 Electron API 出现（便于以后换 Tauri）。Electron 只提供"桥接层"。

### 项目结构与 package.json

🔗 `"main": "dist/main.js"`（Electron 打包后）vs workspace 内部直接用源码。

```json
// apps/electron/package.json
{
  "name": "@agentcore/electron",
  "version": "0.1.0",
  "private": true,
  "main": "dist/main.js",
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@agentcore/shared": "workspace:*"
  },
  "devDependencies": {
    "electron": "^32.0.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0"
  }
}
```

### 主进程入口

```typescript
// apps/electron/src/main/index.ts

import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerAllIpcHandlers } from './ipc';
import { registerGlobalShortcuts } from './shortcuts';
import { createTray } from './tray';
import { setupSingleInstance } from './single-instance';
import { setupAutoUpdater } from './auto-updater';

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

if (!setupSingleInstance()) {
  app.quit();
}

app.whenReady().then(() => {
  createMainWindow();
  registerGlobalShortcuts();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  if (!app.isPackaged) {
    setupAutoUpdater();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // 取消快捷键、托盘等
});
```

### 窗口创建

🔗 **工程逻辑**：
- `contextIsolation: true` + `nodeIntegration: false` = 渲染进程 **不能直接访问 Node API**。绝对不能把 nodeIntegration 设成 true——那等于给任何 XSS 攻击者一把 Node.js 万能钥匙。
- `sandbox: true` 让渲染进程跑在 Chromium 沙箱里。
- `titleBarStyle: 'hiddenInset'` 让标题栏变成 VS Code 那种 hidden 模式。

```typescript
// apps/electron/src/main/window.ts

import { BrowserWindow, shell } from 'electron';
import { join } from 'path';

let mainWindow: BrowserWindow | null = null;

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,         // 安全：隔离 Node API
      nodeIntegration: false,         // 安全：渲染进程不能直接 require
      sandbox: true,                  // 安全：沙箱渲染进程
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const isDev = !app.isPackaged;

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(
      join(__dirname, '../../web/.next/server/app/chat/[sessionId]/page.html')
    );
  }

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
```

### IPC 通道设计

命名规则 `${category}:${action}`，分三组：

```typescript
// apps/electron/src/shared/ipc-channels.ts

export const IPC_CHANNELS = {
  FILE: {
    READ: 'file:read',
    WRITE: 'file:write',
    LIST: 'file:list',
    DELETE: 'file:delete',
    WATCH_START: 'file:watch-start',
    WATCH_STOP: 'file:watch-stop',
    WATCH_EVENT: 'file:watch-event',
  },
  SYSTEM: {
    NOTIFY: 'system:notify',
    GET_PATH: 'system:get-path',
    SHOW_OPEN_DIALOG: 'system:open-dialog',
    SHOW_SAVE_DIALOG: 'system:save-dialog',
    COPY_TO_CLIPBOARD: 'system:clipboard-write',
  },
  AGENT: {
    STREAM: 'agent:stream',
    ABORT: 'agent:abort',
  },
} as const;
```

### preload ——暴露安全的 Browser API

🤖 **AI 常见错误**：`contextBridge.exposeInMainWorld('electron', { ... })` 暴露一大坨 API 其中包含 `require('fs')` 之类可以任意读文件的能力。渲染层一旦被 XSS 攻击，攻击者能读走全部本地文件。**preload 必须逐个暴露具体函数，且每个函数内部要校验入参**。

```typescript
// apps/electron/src/preload/index.ts

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';

contextBridge.exposeInMainWorld('agentShell', {
  // === 文件系统 ===
  readFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.READ, filePath),

  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.WRITE, filePath, content),

  listFiles: (dirPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.LIST, dirPath),

  deleteFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.DELETE, filePath),

  watchFile: (filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE.WATCH_START, filePath),

  onFileChange: (callback: (event: string, path: string) => void) => {
    ipcRenderer.on(IPC_CHANNELS.FILE.WATCH_EVENT, (_e, event, path) => callback(event, path));
    return () => ipcRenderer.removeAllListeners(IPC_CHANNELS.FILE.WATCH_EVENT);
  },

  // === 系统 ===
  notify: (title: string, body: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM.NOTIFY, title, body),

  getUserPath: (name: 'home' | 'documents' | 'downloads') =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM.GET_PATH, name),

  showOpenDialog: (options: Electron.OpenDialogOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM.SHOW_OPEN_DIALOG, options),

  copyToClipboard: (text: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM.COPY_TO_CLIPBOARD, text),

  // === Agent 接口 ===
  streamAgent: (params: { content: string; sessionId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT.STREAM, params),
});
```

Web 端的全局类型声明：

```typescript
// apps/web/src/types/global.d.ts

declare global {
  interface Window {
    /** 只有 Electron 环境下存在 */
    agentShell?: {
      readFile: (path: string) => Promise<string>;
      writeFile: (path: string, content: string) => Promise<void>;
      listFiles: (dirPath: string) => Promise<string[]>;
      deleteFile: (path: string) => Promise<void>;
      watchFile: (path: string) => Promise<void>;
      onFileChange: (cb: (event: string, path: string) => void) => () => void;
      notify: (title: string, body: string) => Promise<void>;
      getUserPath: (name: 'home' | 'documents' | 'downloads') => Promise<string>;
      showOpenDialog: (options: any) => Promise<string[]>;
      copyToClipboard: (text: string) => Promise<void>;
    };
  }
}

export {};
```

### IPC Handlers——主进程处理渲染请求

```typescript
// apps/electron/src/main/ipc/file-handlers.ts

import { ipcMain, Notification, clipboard } from 'electron';
import { promises as fs } from 'fs';
import { shell } from 'electron';
import chokidar from 'chokidar';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { getMainWindow } from '../window';

const fileWatchers = new Map<string, chokidar.FSWatcher>();

export function registerFileHandlers() {
  ipcMain.handle(IPC_CHANNELS.FILE.READ, async (_e, filePath: string) => {
    if (isDangerousPath(filePath)) throw new Error('Access denied: dangerous path');
    return fs.readFile(filePath, 'utf-8');
  });

  ipcMain.handle(IPC_CHANNELS.FILE.WRITE, async (_e, filePath: string, content: string) => {
    if (isDangerousPath(filePath)) throw new Error('Access denied: dangerous path');
    // 先写临时文件再 rename，防止写一半断电损坏原文件
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.FILE.LIST, async (_e, dirPath: string) => {
    return fs.readdir(dirPath, { withFileTypes: true });
  });

  ipcMain.handle(IPC_CHANNELS.FILE.DELETE, async (_e, filePath: string) => {
    if (isDangerousPath(filePath)) throw new Error('Access denied');
    await shell.trashItem(filePath);  // 软删除到 Trash
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.FILE.WATCH_START, async (_e, filePath: string) => {
    if (fileWatchers.has(filePath)) return;

    const watcher = chokidar.watch(filePath, { persistent: true });
    watcher
      .on('change', (path) => {
        getMainWindow()?.webContents.send(IPC_CHANNELS.FILE.WATCH_EVENT, 'change', path);
      })
      .on('unlink', (path) => {
        getMainWindow()?.webContents.send(IPC_CHANNELS.FILE.WATCH_EVENT, 'delete', path);
      });

    fileWatchers.set(filePath, watcher);
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM.NOTIFY, (_e, title: string, body: string) => {
    new Notification({ title, body }).show();
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM.COPY_TO_CLIPBOARD, (_e, text: string) => {
    clipboard.writeText(text);
  });
}

function isDangerousPath(p: string): boolean {
  const dangerous = ['/etc/', '/sys/', '/proc/', 'C:\\Windows\\System32'];
  return dangerous.some((d) => p.startsWith(d));
}
```

### 托盘与全局快捷键

```typescript
// apps/electron/src/main/tray.ts

import { Tray, Menu, nativeImage, app } from 'electron';
import { join } from 'path';
import { getMainWindow, createMainWindow } from './window';

let tray: Tray | null = null;

export function createTray() {
  const icon = nativeImage.createFromPath(
    join(__dirname, '../../resources/tray-icon.png')
  );
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);  // macOS template image 自动适配暗色菜单栏
  }

  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开 Agent Core',
      click: () => {
        const win = getMainWindow() || createMainWindow();
        win.show();
        win.focus();
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);

  tray.setToolTip('Agent Core — 正在运行');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    const win = getMainWindow();
    if (win) {
      win.isVisible() ? win.hide() : win.show();
    }
  });
}
```

```typescript
// apps/electron/src/main/shortcuts.ts

import { globalShortcut } from 'electron';
import { getMainWindow } from './window';

export function registerGlobalShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });
}
```

```typescript
// apps/electron/src/main/menu.ts

import { Menu } from 'electron';

export function setupAppMenu() {
  const template = [
    {
      label: 'Agent',
      submenu: [
        { label: '新建会话', accelerator: 'CmdOrCtrl+N', click: () => {} },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
```

### Web 代码里如何调到 Shell

适配层：Web 模式下 shell 不存在时回退到 HTTP API：

```typescript
// apps/web/src/lib/shell.ts

export function hasShell(): boolean {
  return typeof window !== 'undefined' && 'agentShell' in window;
}

export async function readFileSafe(path: string): Promise<string> {
  if (hasShell()) {
    return window.agentShell!.readFile(path);
  }
  return fetch(`/api/files/read?path=${encodeURIComponent(path)}`).then((r) => r.text());
}

export async function copyToClipboard(text: string): Promise<void> {
  if (hasShell()) {
    return window.agentShell!.copyToClipboard(text);
  }
  return navigator.clipboard.writeText(text);
}
```

### 打包与自动更新

```javascript
// apps/electron/electron-builder.config.js
module.exports = {
  appId: 'com.agentcore.app',
  productName: 'Agent Core',
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: ['dist/**/*', 'resources/**/*'],
  extraMetadata: {
    main: 'dist/main/index.js',
  },
  mac: {
    category: 'public.app-category.developer-tools',
    target: ['dmg', 'zip'],
    icon: 'resources/icon.icns',
  },
  win: {
    target: ['nsis', 'portable'],
    icon: 'resources/icon.ico',
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
  },
  publish: {
    provider: 'github',
    owner: 'your-org',
    repo: 'agent-core',
  },
};
```

```typescript
// apps/electron/src/main/auto-updater.ts

import { autoUpdater } from 'electron-updater';
import { getMainWindow } from './window';

export function setupAutoUpdater() {
  autoUpdater.checkForUpdates();

  autoUpdater.on('update-available', (_info) => {
    getMainWindow()?.webContents.send('app:update-available', _info.version);
  });

  autoUpdater.on('update-downloaded', (_info) => {
    getMainWindow()?.webContents.send('app:update-ready', _info.version);
  });

  setInterval(() => {
    autoUpdater.checkForUpdates();
  }, 6 * 60 * 60 * 1000);
}
```

**后端集成**：Electron 本身不运行 Agent 核心——Agent 跑在 Next.js 服务里（开发模式 localhost:3000，生产模式打包后的静态文件 + API 路由）。Electron 通过 HTTP 与 Web Agent 通信，同时通过 IPC 提供本地文件系统、系统通知、全局快捷键等原生能力。Web 代码通过 `hasShell()` 判断当前环境，决定在 Web 还是 Electron 下运行。

**Electron 避坑汇总**：
- 渲染层 `require` 报错：nodeIntegration=false 后没走 preload
- 窗口无法 mac 全屏：`titleBarStyle: 'hiddenInset'` + `trafficLightPosition`
- SSE 在 Electron 里不刷新：localhost 通信一般无问题；如果有，在 webContents.session 加 CORS
- 打包后文件路径找不到：用 `app.getAppPath()` + 相对路径；asar 文件用 `process.resourcesPath`
- 无法渲染 markdown 中的本地图片：用 custom protocol 或 data URL

---

## 1.8 本层验收

完成 Layer 0 后，你的项目应该能：

1. **Monorepo 链路完整**：`pnpm install` 无 peer conflict，`pnpm typecheck` 全 packages 通过，`packages/core/node_modules/@agentcore/shared` 软链接存在
2. **Agent 核心可运行**：给一个 mock LLM（直接返回固定 token），Agent 循环能完整走到 `done`；工具执行失败时不 crash 而是返回 `tool_error` 事件；超过 maxIterations 后强制结束
3. **SSE 流式 API 可用**：`POST /api/chat` 返回 `Content-Type: text/event-stream`，curl 测试能实时看到一块块 token 回来；浏览器关闭标签页后服务器端 Agent 循环随之停止；429 速率限制不影响全局 SSE 断连
4. **前端可交互**：用户发消息，前端实时看到一个字一个字蹦出来；Shift+Enter 换行、Enter 发送；流式输出时 Enter 能停止 Agent；100 条消息上下滚动不卡；工具调用有展开/收起
5. **Electron 壳可启动**：桌面窗口加载的 Web UI 与浏览器访问 localhost:3000 完全一致；preload API 能在控制台通过 `window.agentShell.xxx` 调用；托盘图标点击能显示/隐藏窗口；全局快捷键 Cmd+Shift+A 能唤起窗口

---

**Layer 0 总结**：完成本层后你拥有的是一个**真正可以发行的桌面 Agent 应用骨架**。往上走 Layer 1 将在此基础上添加上下文管理（Token 预算、压缩）、工具注册中心 + MCP 客户端、Skill 系统、记忆系统（短期 + 向量检索）、代码沙箱等核心能力。
