# 00 — 跨层类型契约 · Cross-Layer Type Contract

> 本文件定义所有 reference **必须遵守的统一类型契约**，解决"AI 拼装各节点时接口签名不一致"的问题。任何 reference 中出现以下类型，必须与本文件一致；如需扩展，先更新本文件。

> **铁律：不再自定义 `LLMClient` / `LLMMessage` / `AgentTool` 等中层类型。** LLM 类型用 `ai`（Vercel AI SDK）的 `LanguageModel`，消息用 `UIMessage`，工具调用由 SDK 的 `tool()` 统一。

---

## 1. LLM 类型：一律用 `LanguageModel`

所有节点的 `llm` / `model` 参数类型都是 `LanguageModel`（来自 `ai`）：

```typescript
import type { LanguageModel } from 'ai';
```

- **为什么**：`LanguageModel` 是 Vercel AI SDK 的核心抽象，统一了 OpenAI / Anthropic / 兼容端点 / 本地模型；`streamText` / `generateText` / `tool` 都围绕它。手写 `LLMClient`（stream / estimateTokens / ping + provider 适配）已被 SDK 覆盖。
- **创建入口**：只用 01-foundation.md 定义的 `createModel`：

```typescript
// packages/core/src/llm.ts（契约：全项目唯一模型创建入口）
export type Provider = 'openai' | 'anthropic';
export function createModel(provider: Provider, env: Record<string, string | undefined>): LanguageModel;
```

- **禁止**：任何 reference 自行 new OpenAI / Anthropic 客户端或封装 `LLMClient`。需要自定义 Provider 时用 `@ai-sdk/openai-compatible`，而不是写新客户端。
🤖 **AI 常见错误**：每次请求都重新 `createModel(...)` 或试图给 `LanguageModel` 再加一层抽象类——连接池被反复重建，且多一层类型转换就多一处签名漂移。**检查方式**：`grep -rn "new OpenAI(" references/` 应无结果；`createModel` 只允许出现在 01 的 `llm.ts`。


## 2. 消息类型：一律用 `UIMessage`

前端消息与 API 载荷使用 `UIMessage`（`ai` 导出）：

```typescript
import type { UIMessage } from 'ai';
```

- `useChat` 收发 `UIMessage`；`streamText({ messages })` 直接消费 `UIMessage[]`。
- 工具调用在 `message.parts`（`tool-invocation`）里表达，不要自定义 tool_call 消息结构。

## 3. 业务事件信封：用 `AgentEvent`（来自 01）

SSE 下发给前端的业务事件统一使用 01-foundation.md 定义的 `AgentEvent` 联合类型。它只定义**事件语义**，不定义传输协议（传输由 AI SDK `toDataStreamResponse` 保证）：

```typescript
// packages/core/src/agent/events.ts（契约：业务事件信封）
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

- 03（记忆）、06（HITL）、08（Eval）等节点复用 `AgentEvent` 扩展字段时，通过类型**交叉扩展**而不是重命名。
- `AgentEvent` 是 `[CUSTOM]` 业务层，但它不手写协议解析。

## 4. 工具定义：统一转成 AI SDK `tool`

各节点注册工具时，统一使用 AI SDK 的 `tool()`（Zod schema 生成参数）：

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const getWeather = tool({
  description: '查询指定城市的天气',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, temp: 24 }),
});
```

- MCP 工具（02/14）通过 `@modelcontextprotocol/sdk` 读取后，转成 `tool()` 的 `execute` 壳（只写胶水，不写协议）。
🤖 **AI 常见错误**：MCP 工具转成 `tool()` 时把 `parameters` 写成 `z.any()` 或直传原始 JSON Schema——丢失类型安全，AI 拼装时参数校验失效。**检查方式**：每个 `tool()` 的 `parameters` 必须是 `z.object({...})`，不允许 `z.any()`。

- LangGraph 工具（05/18）用 `convertToLangChainTools` 或直接 `createReactAgent` 的工具数组，不做二次封装。

## 5. 会话存储：统一 `SessionStore` 接口

```typescript
// packages/core/src/session-store.ts（契约）
export interface SessionStore {
  list(): Promise<Array<{ id: string; title: string }>>;
  create(): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
}
```

- 开发期用内存实现（01）；生产切换 drizzle-orm（Postgres）或 ioredis（Redis），接口不变。

## 6. 版本基线（快照 2026-10）

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 20.0 | 全仓库统一，不再出现 18.x |
| pnpm | >= 9.0 | workspace 协议 |
| ai | ^4.0.0 | Vercel AI SDK |
| @ai-sdk/openai / @ai-sdk/anthropic / @ai-sdk/openai-compatible | ^1.0.0 | Provider 适配 |
| zod | ^3.23.0 | 结构化输出 |
| @modelcontextprotocol/sdk | 最新 | MCP 客户端/服务端 |
| LangGraph（@langchain/langgraph） | 最新 | 多 Agent 编排（可选） |
| LlamaIndex / Haystack | 最新 | RAG 管线（可选） |

> 版本号会过时：升级时**只改本文件**，各 reference 不要各自写死版本。

## 7. 契约违规自查清单

🤖 **AI 常见错误**：
1. 在 02/03/05/11/13 里继续 `import type { LLMClient } from '../llm/types'`——该文件已不存在，应改为 `import type { LanguageModel } from 'ai'` 或 `import { createModel } from '@agentcore/core/llm'`。**检查方式**：`grep -rn "LLMClient" references/` 应无结果。
2. 自己定义 `LLMMessage` / `UIMessage` 的替代品——前端与 SDK 之间类型漂移，流式渲染崩溃。**检查方式**：`grep -rn "interface LLMMessage" references/` 应无结果。
3. 在 `streamText` 之外手写 SSE 拼接（`data: ${JSON.stringify(...)}`）——传输交给 `toDataStreamResponse`。**检查方式**：除 01 的 Nginx 配置外，`grep -rn "text/event-stream" references/` 只应出现在"如何接入 SDK"的说明中。
4. 各文件版本号不一致（Node 18 vs 20、SDK 版本各写各的）——**检查方式**：`grep -rn "18.17" .` 应无结果。

## 8. 契约验收

- [ ] 运行 `node tools/check-skill.mjs`：0 失败。
- [ ] 运行 `grep -rn "LLMClient" references/`：无结果（历史遗留已清除）。
- [ ] 运行 `grep -rn "18.17" assets references SKILL.md`：无结果。
- [ ] 抽查 02/03/05/11/13 的 `llm` 类型，确认全部是 `LanguageModel` 或 `createModel` 的返回值。
- [ ] 抽查 02/14 的 MCP 工具转换，确认只写胶水、不手写 JSON-RPC。