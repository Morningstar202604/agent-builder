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
  - [pnpm workspace 配置项逐个解释](#pnpm-workspace-配置项逐个解释)
  - [Turbo 管道与 CI 顺序](#turbo-管道与-ci-顺序)
  - [常见 workspace 报错与修复](#常见-workspace-报错与修复)
- [1.2 shared 包——跨端共用类型](#12-shared-包跨端共用类型)
- [1.3 LLM 层——Vercel AI SDK 统一接入](#13-llm-层vercel-ai-sdk-统一接入)
  - [模型创建入口](#模型创建入口)
  - [多 Provider 对比表](#多-provider-对比表)
  - [流式参数详解](#流式参数详解)
  - [用量与成本回调](#用量与成本回调)
  - [模型实例缓存](#模型实例缓存)
  - [为什么不再自研 LLM 客户端](#为什么不再自研-llm-客户端)
- [1.4 Agent 核心——AI SDK 工具循环](#14-agent-核心ai-sdk-工具循环)
  - [业务事件信封 AgentEvent [CUSTOM]](#agentevent-业务事件信封-custom)
  - [带工具循环的流式对话](#带工具循环的流式对话)
  - [工具循环生命周期](#工具循环生命周期)
  - [maxSteps 与失败重试的边界](#maxsteps-与失败重试的边界)
  - [UIMessage.parts 结构](#uimessageparts-结构)
  - [MCP 工具接入](#mcp-工具接入)
- [1.5 流式 HTTP API](#15-流式-http-api)
  - [POST /api/chat Route Handler](#post-apichat-route-handler)
  - [toDataStreamResponse 事件格式](#todatastreamresponse-事件格式)
  - [会话存储（Postgres/Redis，不自研）](#会话存储postgresredis)
  - [鉴权（NextAuth）](#鉴权nextauth)
  - [Nginx 配置与避坑](#nginx-配置与避坑)
- [1.6 前端——聊天 UI](#16-前端聊天-ui)
  - [useChat 接入](#usechat-接入)
  - [useChat 完整消息流](#usechat-完整消息流)
  - [流式 Markdown 与工具卡片](#流式-markdown-与工具卡片)
  - [工具卡片三态实现](#工具卡片三态实现)
  - [长列表虚拟化与调优](#长列表虚拟化与调优)
- [1.7 Electron 桌面壳](#17-electron-桌面壳)
  - [窗口创建与安全配置](#窗口创建与安全配置)
  - [preload 安全 IPC](#preload-安全-ipc)
  - [打包产物路径](#打包产物路径)
  - [自动更新](#自动更新)
  - [macOS 签名与公证](#macos-签名与公证)
- [Agent 集群演进引子](#agent-集群演进引子)
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

### pnpm workspace 配置项逐个解释

`pnpm-workspace.yaml` 只有 `packages` 一个必填键，但生产级仓库通常还会用到以下能力：

| 配置项 | 作用 | 推荐值 |
|--------|------|--------|
| `packages` | 声明哪些目录是 workspace 成员 | `["apps/*", "packages/*"]` |
| `catalog:` | 在根级统一定义依赖版本，子包用 `catalog:` 协议引用 | 需要多包锁定同一版本时使用 |
| `onlyBuiltDependencies` | 白名单允许 postinstall 脚本（如 `esbuild`、`sharp`） | `["esbuild", "sharp", "unrs-resolver"]` |
| `ignoredBuiltDependencies` | 显式忽略某些依赖的安装脚本 | 安全加固时用 |
| `engineStrict` | 强制校验 `engines`，版本不匹配直接失败 | `true`（CI 环境） |

**根 package.json 的依赖协议**：

```json
{
  "dependencies": {
    "@agentcore/core": "workspace:*",
    "@agentcore/shared": "workspace:*"
  }
}
```

- `workspace:*` 表示“永远引用当前 workspace 里的最新版本”，发布时 pnpm 会把它替换成实际版本号。
- 不要写成 `"latest"` 或固定版本号——每次 `pnpm install` 都会去 registry 拉一个不存在的包。
- `apps/*` 之间如果需要互相依赖（例如 `apps/electron` 引用 `apps/web` 的构建产物），同样用 `workspace:*`。

🤖 **AI 常见错误**：
1. 子包忘记声明依赖，直接 `import` 另一个包——pnpm 的符号链接只对**显式声明**的依赖生效，没声明就会得到 `ERR_PNPM_NO_MATCHING_VERSION` 或运行时报 `Cannot find module`。
2. 把 `nodeLinker` 改成 `hoisted`——pnpm 的隔离 node_modules 是它防幽灵依赖的根基，`hoisted` 等于退回 npm 行为，会引入幽灵依赖。
3. 在根 package.json 声明业务依赖就以为全仓可用——根依赖只对根脚本可用，`apps/web` 要用必须自己在 `apps/web/package.json` 里声明。


### Turbo 管道与 CI 顺序

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



`turbo.json` 是 Turborepo 的任务调度声明。逐项解释：

| 配置项 | 含义 | 本项目取值 |
|--------|------|-----------|
| `pipeline` | 声明每个 task 的依赖与缓存规则 | 见下 |
| `dependsOn: ["^build"]` | `^` 前缀表示“依赖包先跑 build”，本任务等它们完成后才跑 | 保证 core/shared 先于 web/electron 构建 |
| `dependsOn: ["^typecheck"]` | typecheck 也按依赖序自底向上执行 | 让类型错误最先暴露在依赖根 |
| `outputs` | 可缓存的产物路径，未命中缓存时重新生成 | `.next/**`、`dist/**`；排除 `.next/cache` |
| `cache: false` | 该任务不写缓存 | `dev` 必须关缓存 |
| `persistent: true` | 任务常驻（dev server），Turbo 不等待其退出 | `dev` 任务专用 |
| `globalEnv` | 影响缓存的全局环境变量名单 | `NODE_ENV`、`NEXT_PUBLIC_*` |

**CI 中的执行顺序**（GitHub Actions 示例）：

```yaml
# .github/workflows/ci.yml（摘要）
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm build
```

🔗 **工程逻辑**：`typecheck` 必须排在 `build` 之前——先验证类型边界，再产出可缓存的构建物；`pnpm build` 本身会通过 `dependsOn: ["^build"]` 自动按 core → shared → web/electron 拓扑排序，CI 里不需要手动指定顺序。

🤖 **AI 常见错误**：
1. 在 CI 里手动 `cd apps/web && npm run build`——绕过了 Turbo 的拓扑排序，core 没构建时 web 直接报 `Cannot find module '@agentcore/core'`。
2. `pnpm install --frozen-lockfile` 之前没有提交 `pnpm-lock.yaml`——CI 每次都会重新解析依赖，构建不可复现。
3. 把 `dev` 任务写进 `build` 的 `dependsOn`——`persistent: true` 的 dev server 永不退出，CI 会一直挂着。

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

### 常见 workspace 报错与修复

| 报错 | 根因 | 修复 |
|------|------|------|
| `ERR_PNPM_NO_MATCHING_VERSION_INSIDE_WORKSPACE` | 子包 `package.json` 写了 `workspace:*` 但依赖名不存在 | 检查包名与 `packages/*/package.json` 的 `name` 是否一致 |
| `Cannot find module '@agentcore/core'` | 引用包没在 `apps/web/package.json` 声明依赖 | `pnpm --filter web add @agentcore/core@workspace:*` |
| `ERR_PNPM_RECURSIVE_RUN_FIRST` | 在子包目录执行 `pnpm run` 时命中了 workspace 递归 | 改用 `pnpm --filter <name> run <script>` |
| `postinstall` 脚本被 pnpm 默认阻止 | pnpm 默认不执行依赖的安装脚本 | 在 `onlyBuiltDependencies` 里白名单 |
| TS 报 `cannot be resolved to a file` | 包入口指向 `.ts` 但消费方没有开启对应编译 | 子包 `main`/`types` 指向 `src/index.ts`，消费方用 TS 直接编译（`tsc -b` 或 bundler 模式） |

🤖 **AI 常见错误**：遇到 workspace 报错第一反应是 `rm -rf node_modules` 重装——大多数情况下是**依赖未声明**或**包名拼写不一致**，先 `pnpm -r ls` 检查依赖图，再决定是否重装。

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



### 多 Provider 对比表

| 方案 | 适用场景 | 流式/工具调用 | 需要自建服务 | 备注 |
|------|---------|-------------|-------------|------|
| `@ai-sdk/openai` | 生产主力，OpenAI/兼容网关 | 完整 | 否 | `baseURL` 可指向任意 OpenAI 兼容网关 |
| `@ai-sdk/anthropic` | Claude 生态 | 完整 | 否 | 工具调用格式由 SDK 转换 |
| `@ai-sdk/openai-compatible` | 本地/自托管端点（Ollama、vLLM、LM Studio） | 基本完整 | 是（端点本身） | 部分模型没有原生 tool-calling，需要提示词兜底 |
| LiteLLM Proxy（`LITELLM_API_KEY` + OpenAI 兼容端点） | 多 Provider 路由、限流、成本审计 | 由后端模型决定 | 是（代理层） | 前端仍用 `@ai-sdk/openai` 指向代理 |

🔗 **工程逻辑**：**默认只接 `@ai-sdk/openai` 和 `@ai-sdk/anthropic` 两个 Provider 工厂**。`@ai-sdk/openai-compatible` 用于本地模型实验，LiteLLM 是“公司级需要统一网关”时才引入的选项——它不是 Provider 适配器，而是一个独立服务。

🤖 **AI 常见错误**：为了“多 Provider 支持”一上来就部署 LiteLLM——单模型阶段它只是多一跳延迟。先直连，等有路由/限流/成本归集需求再引入（见 24）。

### 流式参数详解

`streamText` 的核心参数：

| 参数 | 作用 | 建议 |
|------|------|------|
| `model` | `LanguageModel` 实例 | 用 `createModel` 返回，模块级缓存 |
| `messages` | `UIMessage[]` 对话历史 | 直接透传前端消息 |
| `system` | 系统提示 | 与用户输入隔离，见 07/10 |
| `tools` | 工具注册表 | 用 `tool()` 定义 |
| `maxSteps` | 工具循环最大步数 | 10-30，必须设置 |
| `temperature` | 采样温度 | 工具型任务 0-0.3，创意任务 0.7-1.0 |
| `maxOutputTokens`（部分模型为 `maxTokens`） | 单次回复输出上限 | 按任务设定，防长回答烧钱 |
| `stop` | 停止词序列 | 结构化输出场景使用 |
| `stopWhen` | 提前终止工具循环的谓词 | 达到业务目标即停，省 token |
| `onFinish` | 完成回调（含 `usage`） | 记账、tracing 都在这里 |
| `onStepFinish` | 每个工具步骤完成回调 | 观察 ReAct 中间过程 |
| `onError` | 错误回调 | 转成 `AgentEvent` 的 `error` 事件 |
| `abortSignal` | 取消信号 | 前端停止时透传 |

`stopWhen` 是工具循环的“业务出口”：

```typescript
// packages/core/src/agent/stop.ts —— 业务完成即停止（stopWhen 谓词）
import type { StopWhen } from 'ai';

export const stopWhenGoalReached: StopWhen = async ({ status, steps }) => {
  if (status !== 'tool-result' || steps.length === 0) return false;
  const lastStep = steps[steps.length - 1];
  const results = lastStep.toolResults ?? [];
  const last = results[results.length - 1];
  const value = last?.result;
  return typeof value === 'object'
    && value !== null
    && 'goalReached' in value
    && (value as { goalReached: boolean }).goalReached === true;
};
```

### 用量与成本回调

`onFinish` 的 `usage` 字段包含 `inputTokens` / `outputTokens` / `totalTokens`，按模型单价折算成本：

```typescript
// packages/core/src/agent/cost.ts —— 用量统计与成本估算（记账钩子）
import type { LanguageModelUsage } from 'ai';

const PRICE_PER_1M: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
};

export function estimateCost(modelId: string, usage: LanguageModelUsage): number {
  const price = PRICE_PER_1M[modelId] ?? { input: 0, output: 0 };
  return (usage.inputTokens / 1_000_000) * price.input
    + (usage.outputTokens / 1_000_000) * price.output;
}

export function attachUsageCallback(modelId: string) {
  return {
    onFinish: async (result: { usage: LanguageModelUsage }) => {
      const cost = estimateCost(modelId, result.usage);
      // 将 usage 写入 Langfuse / 计费表，见 08/19
    },
  };
}
```

🤖 **AI 常见错误**：只统计 `totalTokens` 不做输入/输出拆分——输入和输出单价不同，按总量记账会导致成本估算严重偏差。

### 模型实例缓存

`createOpenAI` / `createAnthropic` 返回的 Provider 实例内部持有连接池与 token 桶，**每次请求重建会反复建立 HTTP 连接**。用模块级 Map 做缓存：

```typescript
// packages/core/src/llm.ts（续）—— 模型实例缓存
import type { LanguageModel } from 'ai';

const cache = new Map<string, LanguageModel>();

export function getModel(provider: Provider, env: Record<string, string | undefined>): LanguageModel {
  const modelId = env.OPENAI_MODEL ?? 'gpt-4o';
  const key = `${provider}:${modelId}:${env.OPENAI_BASE_URL ?? 'default'}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const model = createModel(provider, env);
  cache.set(key, model);
  return model;
}
```

🔗 **工程逻辑**：缓存的 key 必须包含 `baseURL`——切到本地 mock 或 LiteLLM 网关时，同一模型名会指向不同端点，不复用旧实例。

🤖 **AI 常见错误**：
1. 把 `createModel` 放进组件/路由函数体里每次调用——连接池被反复重建，出现 socket 泄漏和“首 token 延迟”抖动。
2. 用全局单例缓存所有 Provider 但不区分 `baseURL`——切换端点后仍然复用旧连接，请求打到错误后端。

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

### 工具循环生命周期

`streamText` 的 `maxSteps` 每执行一步，内部状态推进一个"step"。完整生命周期：

```text
POST /api/chat
  └─ streamText({ tools, maxSteps, stopWhen, onStepFinish })
       │
       ├─ step 1：LLM 生成文本增量（text-delta 逐段下发）
       │        └─ 若输出 tool_call → 进入工具执行
       ├─ 工具执行：execute() 返回结果（tool-input / tool-output 事件）
       ├─ step 2：LLM 读取工具结果，继续生成
       │        └─ 再次 tool_call → 重复
       ├─ 直到：finishReason === 'stop'，或到达 maxSteps，或 stopWhen 返回 true
       └─ onFinish({ usage, finishReason }) → 汇总记账
```

- 每一步的边界由 `onStepFinish` 回调暴露，适合记录 `AgentEvent.iteration`。
- `maxSteps` 是**步数上限**，不是 token 上限——每一步都可能产生大量输出 token。
- 工具结果会由 SDK 自动追加进内部消息上下文，前端 `messages` 不需要手动追加。

### maxSteps 与失败重试的边界

| 场景 | 行为 | 处理 |
|------|------|------|
| 到达 `maxSteps` 时还有未完成的 tool_call | SDK 以 `finishReason: 'tool-calls'` 或 `'stop'` 收尾，不再发起新调用 | 前端提示"达到最大步数"，引导用户继续提问 |
| `execute` 抛出异常 | SDK 把错误作为 `tool-result` 回传，LLM 可读取并修正 | `execute` 内 `try/catch`，返回结构化错误对象 |
| 模型连续调用同一工具（死循环） | 消耗 step 直到 `maxSteps` | 设置 `stopWhen` 检测重复结果，或限制 `maxSteps` |
| 网络中断 / API 5xx | `streamText` 抛错，`onError` 触发 | 由 `toDataStreamResponse` 输出 `error` 事件，前端展示重试 |
| 用户点击"停止" | `abortSignal` 中断当前 step | `useChat.stop()` 发送 abort，SDK 停止生成 |

🤖 **AI 常见错误**：
1. 在 `execute` 里把错误吞掉返回 `{ ok: false }`——LLM 看不到失败原因会盲目重试。应该返回包含错误信息的结果对象。
2. 以为 `maxSteps` 是 token 上限——它只是步数，长工具循环仍可能消耗大量 token，成本控制要在 `onFinish` 记账。
3. 前端在工具执行期间禁用输入框——工具循环内 LLM 还会继续生成，禁用输入反而打断多轮工具流程。

### UIMessage.parts 结构

`UIMessage` 是 `ai` 的 UI 消息类型，正文与工具调用统一放在 `parts` 数组里：

```typescript
// packages/core/src/agent/message.ts —— UIMessage.parts 结构示例（只读，不自定义）
import type { UIMessage } from 'ai';

// 一条含工具调用的助手消息，其 parts 大致如下（类型来自 ai）：
// [
//   { type: 'step-start' },
//   { type: 'text', text: '我来查询北京的天气。' },
//   {
//     type: 'tool-invocation',
//     toolInvocation: {
//       toolCallId: 'call_1',
//       toolName: 'getWeather',
//       args: { city: '北京' },
//       state: 'result',
//       result: { city: '北京', temp: 24, unit: 'C' },
//     },
//   },
//   { type: 'step-finish', finishReason: 'stop' },
// ]

export function hasToolInvocations(message: UIMessage): boolean {
  return (message.parts ?? []).some((p) => p.type === 'tool-invocation');
}
```

🔗 **工程逻辑**：不要用 `message.content` 里的字符串去解析工具调用——`parts` 才是结构化的真相来源。`content` 只是 SDK 为兼容旧版本拼接出来的纯文本。

🤖 **AI 常见错误**：
1. 自己遍历 `message.parts` 之外的字段找工具调用——没有 `parts` 的消息都是老格式，用 `parts` 判断即可。
2. 把 `toolInvocation.state === 'result'` 当成功——`result.isError === true` 才是失败，需要三态卡片区分。

### MCP 工具接入

MCP 工具通过 `@modelcontextprotocol/sdk` 读取，再包成 AI SDK `tool()`（胶水层；完整注册/权限见 02）：

```typescript
// packages/core/src/tools/mcp.ts —— MCP 工具转 AI SDK tool（胶水层）
import { tool } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

export async function loadMcpTools(url: string): Promise<Record<string, ReturnType<typeof tool>>> {
  const client = new Client({ name: 'agent-core', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);

  const { tools } = await client.listTools();
  const registry: Record<string, ReturnType<typeof tool>> = {};
  for (const mcpTool of tools) {
    registry[mcpTool.name] = tool({
      description: mcpTool.description ?? mcpTool.name,
      parameters: z.object({}), // 占位：02 用 json-schema-to-zod 从 inputSchema 生成
      execute: async (args) => client.callTool({ name: mcpTool.name, arguments: args }),
    });
  }
  return registry;
}
```

🔗 **工程逻辑**：MCP 只负责"协议"，`tool()` 只负责"AI SDK 形状"。胶水层把 `inputSchema`（JSON Schema）转成 Zod——**不要手写 JSON-RPC**。远程用 Streamable HTTP（无状态，OAuth 2.1），本机用 stdio。

🤖 **AI 常见错误**：
1. 直接把 MCP 的 `inputSchema` 当 `parameters` 传给 `tool()`——AI SDK 需要 Zod，传 JSON Schema 会运行时报错。
2. 每个请求都 `new Client(...)` + `connect`——MCP 连接要复用，连接/握手开销很大。
3. 把 MCP 工具列表缓存成静态数组——工具服务器可能动态增删工具，用 `listTools()` 刷新而不是写死。



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



### toDataStreamResponse 事件格式

`toDataStreamResponse()` 输出的是 `text/event-stream`，每行 `data:` 携带一个 JSON 信封（`DataStreamPart`）。浏览器 DevTools 里看到的大致形态：

```text
data: {"type":"text-delta","delta":"你"}

data: {"type":"text-delta","delta":"好"}

data: {"type":"tool-input","toolCallId":"call_1","toolName":"getWeather","args":{"city":"北京"}}

data: {"type":"tool-output","toolCallId":"call_1","output":{"city":"北京","temp":24}}

data: {"type":"finish","finishReason":"stop","usage":{"inputTokens":120,"outputTokens":45}}
```

| 事件类型 | 对应 `AgentEvent` | `useChat` 消费方式 |
|---------|-------------------|--------------------|
| `text-delta` | `token` | 逐 token 追加到 `message.content` |
| `tool-input` / `tool-output` | `tool_start` / `tool_complete` | 驱动工具卡片 loading → 结果 |
| `finish` | `done` | `isLoading` 置 false，`finishReason` 可用 |
| `error` | `error` | `error` state 弹出，展示重试 |

🔗 **工程逻辑**：`AgentEvent` 是**业务语义**，`DataStreamPart` 是**传输形状**——两者通过 08 层的适配器对齐，不在这一层手写协议解析。

🤖 **AI 常见错误**：在 `toDataStreamResponse` 之后再用 `Response` 包装一层手拼 `data:` ——SDK 已经输出标准事件，重复包装会破坏 `useChat` 的解析。

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



#### Postgres（drizzle-orm）

```typescript
// packages/core/src/session-store-postgres.ts —— Postgres 会话存储（生产用）
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { SessionStore } from './session-store';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export function createDrizzleSessionStore(db: NodePgDatabase): SessionStore {
  return {
    async list() {
      const rows = await db.select().from(sessions).orderBy(desc(sessions.updatedAt));
      return rows.map((r) => ({ id: r.id, title: r.title }));
    },
    async create() {
      const id = randomUUID();
      await db.insert(sessions).values({ id, title: '新会话' });
      return { id };
    },
    async remove(id: string) {
      await db.delete(sessions).where(eq(sessions.id, id));
    },
  };
}
```

#### Redis（ioredis）

```typescript
// packages/core/src/session-store-redis.ts —— Redis 会话存储（生产用）
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { SessionStore } from './session-store';

const SET_KEY = 'sessions';
const TTL = 60 * 60 * 24 * 7;

export function createRedisSessionStore(redis: Redis): SessionStore {
  return {
    async list() {
      const ids = await redis.smembers(SET_KEY);
      if (ids.length === 0) return [];
      const values = await redis.mget(ids.map((id) => `session:${id}`));
      const rows = ids.map((id, i) => {
        const raw = values[i];
        if (!raw) return null;
        return { id, title: (JSON.parse(raw) as { title: string }).title };
      });
      return rows.filter((row): row is { id: string; title: string } => row !== null);
    },
    async create() {
      const id = randomUUID();
      await redis.sadd(SET_KEY, id);
      await redis.set(`session:${id}`, JSON.stringify({ title: '新会话' }), 'EX', TTL);
      return { id };
    },
    async remove(id: string) {
      await redis.srem(SET_KEY, id);
      await redis.del(`session:${id}`);
    },
  };
}
```

🔗 **工程逻辑**：两个实现共用 `SessionStore` 接口（00-types），上层路由代码完全不变。Postgres 适合需要 SQL 联查会话元数据的场景；Redis 适合高频读写、有 TTL 需求的场景。

🤖 **AI 常见错误**：在生产切换存储时改动接口签名——`SessionStore` 是契约，Postgres/Redis 只是实现，路由层永远 `import type { SessionStore } from '@agentcore/core/session-store'`。

### 鉴权（NextAuth）

会话 API 需要登录保护。NextAuth v5（App Router）在 route handler 内直接取会话：

```typescript
// apps/web/src/app/api/chat/route.ts —— 鉴权包装（NextAuth v5）
import { auth } from '@/auth';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  // 通过后继续构造 messages 并调用 streamText（见 1.4）
}
```

🔗 **工程逻辑**：NextAuth 负责 OAuth/JWT 会话，**不要手写 session cookie**。`auth()` 在服务端返回会话对象；需要"只允许登录用户"时，也可以直接在 `middleware.ts` 里统一拦截 `/api/*`。

🤖 **AI 常见错误**：
1. 在客户端组件里 `useSession()` 判断登录态后就把 `user` 塞进请求体——客户端可伪造，必须在服务端 `auth()` 校验。
2. 自己写 JWT 签发/刷新逻辑——NextAuth 的 `jwt` 与 `session` 回调已经覆盖，自定义密钥管理反而引入漏洞。

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



### useChat 完整消息流

`useChat` 把"发消息 → SSE → 更新 UI"整条链路封装好，只暴露消息数组与几个事件处理函数：

```text
用户输入 → handleSubmit(e) [useChat]
   │
   ├─ messages 先追加 user 消息（本地乐观更新）
   ├─ POST /api/chat（body: messages）  [Next.js Route Handler]
   │     └─ streamText(...) → toDataStreamResponse()
   ├─ 读取 fetch response.body 的 SSE 流
   │     ├─ text-delta        → 追加 assistant message.content
   │     ├─ tool-input/output  → 更新 message.parts 中 tool-invocation 状态
   │     └─ finish            → isLoading = false
   └─ 出错时 error state 置位，reload() 重放同一请求
```

```tsx
// apps/web/src/app/page.tsx —— useChat 消息流接线
'use client';

import { useChat } from '@ai-sdk/react';

export function ChatPanel() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, error, reload, stop } = useChat({
    api: '/api/chat',
  });

  return (
    <div className="flex h-screen flex-col">
      <div className="flex-1 overflow-y-auto">
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'text-right' : 'text-left'}>
            <pre>{m.content}</pre>
          </div>
        ))}
      </div>
      {error ? (
        <button type="button" onClick={() => reload()}>
          重试（{error.message}）
        </button>
      ) : null}
      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} disabled={isLoading} />
        {isLoading ? (
          <button type="button" onClick={stop}>
            停止
          </button>
        ) : (
          <button type="submit">发送</button>
        )}
      </form>
    </div>
  );
}
```

🔗 **工程逻辑**：`handleSubmit` 内部已经 `preventDefault` 并维护 `messages`，服务端只做 `streamText` + 鉴权；**不要**在前端手动 `fetch` 拼接 SSE。

🤖 **AI 常见错误**：在 `useChat` 的 `onFinish` 里再次请求服务端"补全历史"——`messages` 已经包含完整往返内容，重复请求会造成消息重复。

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



#### 流式 Markdown 容错

```tsx
// apps/web/src/components/StreamingMarkdown.tsx —— 未闭合代码块容错
'use client';

import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function normalizeFence(input: string): string {
  let open = 0;
  for (const line of input.split('\n')) {
    if (line.trimStart().startsWith('```')) open += 1;
  }
  return open % 2 === 1 ? input + '\n```' : input;
}

export const StreamingMarkdown = memo(function StreamingMarkdown({ text }: { text: string }) {
  const safe = normalizeFence(text);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children }) {
          const match = /language-(\w+)/.exec(className ?? '');
          return match ? <code className={className}>{children}</code> : <code>{children}</code>;
        },
      }}
    >
      {safe}
    </ReactMarkdown>
  );
});
```

🔗 **工程逻辑**：`normalizeFence` 只统计 ` ``` ` 开头的行，奇数则补一个闭合围栏——让"代码块还没收尾"的中间态也能渲染为代码块而不是吞掉后续文本。真正渲染仍然交给 `react-markdown`，不手写语法高亮。

🤖 **AI 常见错误**：在组件里手写正则分割 token 拼 HTML——语法高亮和 GFM 表格/任务列表都应由 `react-markdown` + `remark-gfm` 处理，容错逻辑只负责**修复输入**，不负责**渲染**。

### 工具卡片三态实现

工具调用在 UI 上必须呈现"等待 → 成功/失败"三态，且失败不阻塞后续消息：

```tsx
// apps/web/src/components/ToolCallCard.tsx —— 工具调用三态
'use client';

import type { ToolInvocation } from 'ai';

export function ToolCallCard({ invocation }: { invocation: ToolInvocation }) {
  if (invocation.state === 'pending') {
    return (
      <div className="rounded border border-blue-200 bg-blue-50 p-2 text-sm">⏳ 正在调用 {invocation.toolName}…</div>
    );
  }
  if (invocation.state === 'result') {
    const { isError, output, error } = invocation.result as {
      isError?: boolean;
      output?: unknown;
      error?: string;
    };
    return isError ? (
      <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">❌ {error ?? '工具调用失败'}</div>
    ) : (
      <div className="rounded border border-green-200 bg-green-50 p-2 text-sm">
        ✅ {invocation.toolName}
        <pre>{JSON.stringify(output, null, 2)}</pre>
      </div>
    );
  }
  return null;
}
```

🔗 **工程逻辑**：`invocation.state` 由 `useChat` 从 SSE 的 `tool-input`/`tool-output` 事件驱动更新，组件只需做纯展示映射；`result.isError` 区分失败态，用户看到原因后可以手动纠正。

🤖 **AI 常见错误**：把 `output` 用 `String(output)` 直接铺到消息正文——工具结果应留在独立卡片里，避免污染对话文本流，也便于失败态单独展示。

### 长列表虚拟化与调优

#### 调优要点

```tsx
// apps/web/src/components/VirtualMessageList.tsx —— 动态高度虚拟化
'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import type { UIMessage } from 'ai';
import { MessageBubble } from './MessageBubble';

export function VirtualMessageList({ messages }: { messages: UIMessage[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80,
    getItemKey: (index) => messages[index].id,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 8,
  });

  return (
    <div ref={parentRef} className="h-[70vh] overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => (
          <div
            key={item.key}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${item.start}px)` }}
          >
            <MessageBubble message={messages[item.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}
```

| 参数 | 默认 | 调优建议 |
|------|------|----------|
| `overscan` | 10 | 代码块多/滚动快时调大到 16 减少白屏闪烁；低端机调小到 4 |
| `estimateSize` | 80 | 会话中长代码块多时调大（如 160），减少测量抖动 |
| `getItemKey` | 无 | 必须用 `message.id`；否则插入消息时滚动位置错乱 |
| `measureElement` | 无 | 动态高度消息必开；纯等高校验可用 `useWindowVirtualizer` |

🔗 **工程逻辑**：虚拟化只渲染视口内的消息，`measureElement` 在渲染后测量真实高度并修正偏移。**只有**会话可能上千轮时才值得引入——普通页面先保持完整列表，避免过早优化。


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

### 打包产物路径

| 平台 | 产物路径 | 说明 |
|------|----------|------|
| macOS | `release/mac-arm64/Agent Core.app` | dmg/zip 由 electron-builder 生成 |
| Windows | `release/win-unpacked/Agent Core.exe` | NSIS 安装包在 `release/` |
| Linux | `release/linux-unpacked/agent-core` | AppImage 在 `release/` |

```yaml
# electron-builder.yml 输出目录配置
directories:
  output: release
  buildResources: build
```

🔗 **工程逻辑**：固定输出目录后，CI 上传、自动更新发布、内部签名脚本都引用同一路径，避免"找不到产物"类问题。

🤖 **AI 常见错误**：`.gitignore` 忽略了 `dist/` 却把 `release/` 提交进 git——`release/`、`dist/`、`out/` 都要忽略。

### 自动更新

```typescript
// apps/electron/src/updater.ts —— electron-updater 运行时更新
import { autoUpdater } from 'electron-updater';
import { app } from 'electron';

export function setupAutoUpdater() {
  if (!app.isPackaged) return; // 开发模式绝不更新
  autoUpdater.autoDownload = true;
  autoUpdater.setFeedURL({ provider: 'github', owner: 'your-org', repo: 'agent-core' });
  autoUpdater.checkForUpdatesAndNotify();
}
```

🔗 **工程逻辑**：`electron-updater` 直接复用 electron-builder 的 `publish` 配置（github/generic/S3），**不要**手写下载、校验、替换逻辑；`app.isPackaged` 门禁保证开发期不触发更新请求。

🤖 **AI 常见错误**：在开发模式调用 `checkForUpdatesAndNotify()` 导致每次 `pnpm dev` 都请求 GitHub Release——必须先判断 `app.isPackaged`。

### macOS 签名与公证

```bash
# 1. 生成 entitlements（签名权限声明）
cat > build/entitlements.mac.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
EOF

# 2. 签名 + 公证（凭据由 CI Secret 注入环境变量）
export CSC_LINK="$APPLE_CERT_P12_URL"
export CSC_KEY_PASSWORD="$APPLE_CERT_PASSWORD"
export APPLE_ID="$APPLE_ID"
export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD"
export APPLE_TEAM_ID="$APPLE_TEAM_ID"
pnpm exec electron-builder --mac --publish never
```

| 配置项 | 值 | 作用 |
|--------|-----|------|
| `hardenedRuntime` | `true` | 启用运行时保护，公证必需 |
| `gatekeeperAssess` | `false` | 跳过本地 Gatekeeper 重复检查 |
| `notarize` | `true` 或 `{ teamId }` | 上传 Apple 公证 |
| `entitlements` | `build/entitlements.mac.plist` | 声明 JIT/未签名内存等权限 |

🔗 **工程逻辑**：完整链条是"Developer ID 证书签名 → 公证（notarize）→ 软件包 stapling"，三缺一都会在别的 Mac 上被 Gatekeeper 拦截。证书密码与 Apple ID 全部走 CI Secret，不写进仓库。

🤖 **AI 常见错误**：把 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` 直接写进 `electron-builder.yml`——明文凭据会进入 Release 产物与 git 历史。

## Agent 集群演进引子

| 阶段 | 形态 | 适用规模 | 落地方式 |
|------|------|---------|----------|
| 1 | 单 Agent | 个人 / 单任务 | 本文件 1.3~1.7 的单体 `streamText` 工具循环 |
| 2 | orchestrator-worker | 团队 / 多任务并行 | 主 Agent 决策，`executeAgent` 分发子任务（见 05） |
| 3 | A2A | 跨组织 / 异构系统 | 通过 MCP 暴露工具，HTTP/SSE 互调（见 05） |

> 演进原则：**先让单 Agent 稳定，再拆 orchestrator-worker，最后才谈 A2A**，第一版不要上集群。具体架构、状态同步与失败恢复见 `./05-multi-agent.md`。


---

## 1.8 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core`、`packages/shared`、`apps/web` 全部 0 错误。
- [ ] **模型接入**：`createModel('openai', { OPENAI_API_KEY: 'sk-test' })` 能返回 `LanguageModel` 实例；`baseURL` 指向本地 mock 时 `streamText` 能返回流式 token。
- [ ] **工具循环**：给 `streamText` 传 `getWeather` 工具并设置 `maxSteps: 10`，断言：LLM 发起工具调用 → SDK 自动执行 → 结果回传 → 最终 `finishReason` 为 `stop`；当工具连续失败时循环在 `maxSteps` 处终止（不会无限烧 token）。
- [ ] **SSE 流**：`POST /api/chat` 返回 `Content-Type: text/event-stream`，浏览器 DevTools Network 能看到 `data:` 分块；Nginx 下 60s+ 长响应不中断（`proxy_read_timeout 600s`）。
- [ ] **前端**：`useChat` 发送消息后逐 token 渲染；工具调用显示 loading → 成功/失败三态卡片；1000 条消息滚动不卡顿。
- [ ] **Electron 安全**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；preload 只暴露 `agentAPI` 白名单；打包后 `spctl -a -vv` 显示 `accepted`（macOS）。
- [ ] **MCP 接入**：`loadMcpTools(mcpClient)` 返回的 `tool()` 能被 `streamText` 的 `tools` 参数接收；MCP 工具调用的 `tool-input`/`tool-output` 在 DevTools Network 可见。
- [ ] **会话持久化**：Postgres/Redis 实现 `SessionStore` 后，`list`/`create`/`remove` 在路由层调用返回预期结果；重启服务后会话仍存在。
- [ ] **鉴权**：未登录请求 `/api/chat` 返回 401；登录后返回 SSE 流。
- [ ] **自动更新**：打包产物中 `app.isPackaged === true` 时触发 `checkForUpdatesAndNotify`；开发模式不触发更新请求。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本节验收清单。

---

> **与后续节点的衔接**：本层的 `createModel`（LLM 入口）、`AgentEvent`（事件信封）、`streamText` 工具循环（Agent 核心）是后续所有节点复用的地基。02 在其上加工具注册与 MCP 胶水层（1.4 的 `loadMcpTools` 就是入口）；03 在其上加记忆与 RAG；04 在其上加会话持久化与鉴权（1.5 的 SessionStore / NextAuth 直接复用）；05 在其上做 orchestrator-worker 与 A2A（见本章「Agent 集群演进引子」）。所有后续节点的 `llm` 一律指 `LanguageModel`（`ai` SDK 类型），不要再引入自定义 LLM 抽象。
