# 14 — MCP Server 开发：把业务能力暴露为 MCP

> Layer 14 目标：用官方 `@modelcontextprotocol/sdk` 开发 MCP Server——把内部业务能力（文件系统、搜索、数据库、领域 API）以 **Tools / Resources / Prompts** 三种形态暴露给 MCP Client（02 的 Agent）。读完本文件可独立开发并调试一个生产级 MCP Server。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - MCP 协议（JSON-RPC 帧、初始化握手、通知）→ **`@modelcontextprotocol/sdk`**，不要手写协议解析
> - 传输层（Stdio / SSE / Streamable HTTP）→ SDK 内置 Transport，不要手写管道或 SSE 封装
> - Resources / Prompts 机制 → SDK 的 `ResourceTemplate` 与 McpServer API，不要自己造 URI 分发
> - 调试 → 官方 **MCP Inspector**（`npx @modelcontextprotocol/inspector`），不要手写测试客户端
>
> 本层唯一允许手写的 `[CUSTOM]` 是**业务工具/资源/提示定义**——产品独有工具、资源 URI 语义、prompt 模板内容，属于业务差异层，没有现成替代。

---

## 目录

- [1.1 选型：Server 与传输](#11-选型server-与传输)
- [1.2 Stdio Server：业务定义 [CUSTOM]](#12-stdio-server业务定义-custom)
- [1.3 远程 Server（Streamable HTTP / SSE）](#13-远程-serverstreamable-http--sse)
- [1.4 Resources 暴露](#14-resources-暴露)
- [1.5 Prompts 模板](#15-prompts-模板)
- [1.6 调试：MCP Inspector](#16-调试mcp-inspector)
- [1.7 安全边界](#17-安全边界)
- [1.8 本层验收清单](#18-本层验收清单)

---

## 1.1 选型：Server 与传输

🔗 **工程逻辑**：MCP 协议本质是 JSON-RPC 2.0 + 会话管理。手写帧解析、初始化握手、错误码、通知协议在早期还有意义，现在官方 SDK 全部覆盖。你的工作只剩三层：

```
业务定义 [CUSTOM]  →  工具/资源/提示 内容（产品差异）
胶水层             →  调业务 API、鉴权、参数校验
SDK 能力           →  JSON-RPC、传输、握手、通知、回放
```

**传输选型**：

| 传输 | 适用场景 | 说明 |
|------|---------|------|
| Stdio | 本地 CLI、桌面应用 | 1:1 进程管道，最简，调试友好 |
| SSE（`SSEServerTransport`） | 远程 Web 服务 | 标准 HTTP + Server-Sent Events，SDK 内置 |
| Streamable HTTP（`StreamableHTTPServerTransport`） | 远程 Web 服务（推荐） | 单一 `/mcp` 端点，GET/POST 语义由 SDK 处理 |

> 🤖 **AI 常见错误**：用 Stdio 部署远程服务。Stdio 是本地进程间通信，不能跨网络；远程必须用 SSE / Streamable HTTP，且传输仍由 SDK 提供，不要手写 HTTP 轮询。

---

## 1.2 Stdio Server：业务定义 [CUSTOM]

使用 SDK 高层 API `McpServer`：`tool()` / `resource()` / `prompt()` 三个注册方法覆盖全部 MCP 能力，参数 schema 由 Zod 生成——你只写业务内容。

```typescript
// packages/mcp-servers/src/weather/index.ts —— 业务定义 [CUSTOM]，协议与传输全是 SDK 能力
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export async function startStdioServer(): Promise<void> {
  const server = new McpServer({ name: 'weather-mcp', version: '1.0.0' });

  // —— Tools [CUSTOM]：业务工具定义，Zod 自动生成 JSON Schema ——
  server.tool(
    'get_weather',
    { city: z.string().describe('城市名') },
    async ({ city }) => {
      const weather = await fetchWeather(city); // 胶水层：只调业务 API
      return { content: [{ type: 'text', text: JSON.stringify(weather) }] };
    }
  );

  // —— Resources [CUSTOM]：业务 URI 语义 ——
  server.resource(
    'weather-current',
    new ResourceTemplate('weather://{city}', { list: undefined }),
    async (uri) => {
      const city = decodeURIComponent(uri.pathname.replace('/', ''));
      return { contents: [{ uri: uri.href, text: JSON.stringify(await fetchWeather(city)) }] };
    }
  );

  // —— Prompts [CUSTOM]：业务模板内容 ——
  server.prompt(
    'weather_report',
    { city: z.string() },
    async ({ city }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `请用通俗语言播报 ${city} 的天气。` } }],
    })
  );

  // Stdio 传输由 SDK 处理 stdin/stdout 的 JSON-RPC 帧，禁止手写协议
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// [CUSTOM] 业务实现：接入你的天气数据源
async function fetchWeather(city: string): Promise<{ city: string; temp: number }> {
  return { city, temp: 24 };
}
```

> 🤖 **AI 常见错误**：用 `console.log` 输出日志。Stdio 的 stdout 被 JSON-RPC 帧占用，任何 `console.log` 都会污染协议导致客户端解析失败。日志必须走 `console.error`（stderr）。
>
> 🤖 **AI 常见错误**：手写 JSON-RPC 请求解析（`JSON.parse(await readStdin())`）。帧边界、批量请求、初始化握手、错误码全是 SDK 已覆盖的坑，手写必然漏边界。**检查方式**：`grep -rn "readline" packages/mcp-servers/` 应无结果。

---

## 1.3 远程 Server（Streamable HTTP / SSE）

远程部署用 SDK 的 HTTP 传输，业务定义与 1.2 完全复用——只换 Transport，不换业务代码。

```typescript
// packages/mcp-servers/src/weather/http.ts —— Streamable HTTP 远程版
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

export function startHttpServer(port = 3001): void {
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = new McpServer({ name: 'weather-mcp-http', version: '1.0.0' });

    // 业务定义 [CUSTOM] 与 Stdio 版一致，只是换传输
    server.tool('get_weather', { city: z.string() }, async ({ city }) => ({
      content: [{ type: 'text', text: JSON.stringify(await fetchWeather(city)) }],
    }));

    await server.connect(transport);
    await transport.handleRequest(req, res, server);
  });

  app.listen(port, () => {
    console.error(`weather MCP listening on :${port}`); // 日志走 stderr
  });
}
```

SSE 场景同理：把 `StreamableHTTPServerTransport` 换成 `SSEServerTransport`，`GET /sse` 建连、`POST /messages` 收消息，两端都由 SDK 处理，不需要手写 EventSource 封装。

> 🤖 **AI 常见错误**：在 `handleRequest` 前后自己拼 SSE 帧或手动管理 `sessionId`。`StreamableHTTPServerTransport` / `SSEServerTransport` 已管理会话生命周期，你只需要 `connect` + `handleRequest`。

---

## 1.4 Resources 暴露

**工程逻辑**：Resource 是 MCP 的"数据暴露层"。客户端通过 URI scheme 直接访问 Server 管理的数据——不需要定义 `read_file` tool，暴露 `file:///path` 即可。URI 语义是业务 [CUSTOM]，模板匹配与 list/read 分发是 SDK 能力。

- `ResourceTemplate('weather://{city}', { list: undefined })`：声明 URI 形状，`{city}` 是参数占位符；`list: undefined` 表示不对外列出，客户端只能按已知 URI 读取。
- 客户端 `listResources()` 时 SDK 返回模板列表，`readResource` 时 SDK 解析模板并调用你的 handler——不用手写 `uri.split(':')` 分发。

> 🔗 **工程逻辑**：不要把整个文件系统暴露成 Resource。暴露多少数据、URI 怎么设计，属于产品决策 [CUSTOM]；而 URI 匹配、MIME 类型、分页、通知都是 SDK 能力。

---

## 1.5 Prompts 模板

**工程逻辑**：Prompt 是让 Server 向客户端提供预定义模板的机制。Agent 可以 `listPrompts()` 发现模板，`getPrompt(name)` 获取内容并填入参数。模板内容与参数语义是业务 [CUSTOM]，注册与分发是 SDK 能力（见 1.2 的 `server.prompt`）。

> 🤖 **AI 常见错误**：把模板参数直接拼进 prompt 不标注边界。MCP prompt 与 LLM prompt 一样可能被注入——模板内必须明确参数边界（如 `--- 用户输入开始 ---`），或对参数做 sanitization，这是业务层的 [CUSTOM] 责任。

---

## 1.6 调试：MCP Inspector

**不要手写调试客户端**。官方 MCP Inspector 提供 GUI：连接 Stdio / SSE / Streamable HTTP，浏览工具、资源、提示，发起调用查看 JSON-RPC 往返与时间线。

```bash
# 调试本地 Stdio Server（推荐：构建后指向 dist 入口）
npx @modelcontextprotocol/inspector node packages/mcp-servers/dist/weather/index.js

# 调试远程 Streamable HTTP Server
npx @modelcontextprotocol/inspector --url http://localhost:3001/mcp
```

🔗 **工程逻辑**：Inspector 展示的是 SDK 发出的真实 JSON-RPC 帧——用它验证"业务定义 → 客户端视角"的完整链路，等价于集成测试客户端，但不需要写代码。

---

## 1.7 安全边界

MCP Server 的安全模型与普通 HTTP 服务一致，且工具即权限：调用工具 = 执行代码。

| 威胁 | 缓解 | 归属 |
|------|------|------|
| 未授权调用 | Streamable HTTP 端点挂 Bearer 认证（Express 中间件） | 胶水层 |
| 工具参数注入（路径穿越等） | handler 内做业务校验（如 `path.resolve` + 前缀检查） | `[CUSTOM]` |
| Stdio stdout 污染 | 日志一律 `console.error` | 工程纪律 |
| 资源 URI 越权 | `ResourceTemplate` 参数校验 + handler 内授权 | `[CUSTOM]` |

```typescript
// packages/mcp-servers/src/auth.ts —— 胶水层：Bearer 认证中间件，不涉及 MCP 协议
import type { Request, Response, NextFunction } from 'express';

export function bearerAuth(validTokens: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !validTokens.has(header.slice(7))) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
}
```

> 🤖 **AI 常见错误**：只校验 token 存在不校验来源。任何拿到 sessionId 的客户端都能向 SSE 会话注入工具调用——用不可预测的 `crypto.randomUUID()` 作为 sessionId，并在 handler 中做鉴权；伪造 sessionId 必须返回 401 而不是执行工具。

---

## 1.8 本层验收清单

- [ ] **类型检查**：运行 `npx tsc --noEmit -p packages/mcp-servers`，`weather/index.ts`、`http.ts`、`auth.ts` 全部 0 错误，公共 API 无 `any` 泄漏。
- [ ] **核心行为**：启动 Stdio Server 后用 MCP Inspector 连接，断言 `listTools` 返回 `get_weather`、`callTool` 返回结构化文本、Resources/Prompts 可浏览。
- [ ] **边界场景**：用伪造 `sessionId` 或缺失 `Authorization` 头调用远程端点，断言返回 401 且工具未被调用；用未知工具名调用返回 `isError: true` 而非崩溃。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs` 本文件 0 失败；`grep -rn "LLMClient" references/` 无结果；Stdio 调试时 stdout 无 `console.log` 输出。

---

## 交叉引用

- [02-tools-skills.md](02-tools-skills.md) — MCP 客户端接入：把本文件的 Server 工具转成 AI SDK `tool()`（只写胶水）
- [00-types.md](00-types.md) — 跨层类型契约：`llm` 一律是 `LanguageModel`（`ai`），创建用 01 的 `createModel`
- [07-security.md](07-security.md) — 输入输出校验、Guardrails、工具分级
- [23-artifacts-computer-use.md](23-artifacts-computer-use.md) — MCP 承载 Artifact 与浏览器操控
