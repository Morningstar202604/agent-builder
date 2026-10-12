# 14 — MCP Server 开发：把业务能力暴露为 MCP

> Layer 14 目标：用官方 `@modelcontextprotocol/sdk` 开发 MCP Server——把内部业务能力（文件系统、搜索、数据库、领域 API）以 **Tools / Resources / Prompts** 三种形态暴露给 MCP Client（02 的 Agent）。本文件按 **2026-07-28 无状态 MCP 规范**编写：本机用 Stdio、跨网络生产用 **Streamable HTTP + OAuth 2.1 + PKCE**，HTTP+SSE 双端点与有状态握手已废弃。读完本文件可独立开发、调试并发布一个生产级 MCP Server。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - MCP 协议（JSON-RPC 帧、无状态请求/响应、通知）→ **`@modelcontextprotocol/sdk`**，不要手写协议解析
> - 传输层（Stdio / Streamable HTTP）→ SDK 内置 Transport，不要手写管道或 HTTP 封装
> - OAuth 2.1 + PKCE → SDK 的 auth helper（`OAuthClientProvider` / `OAuthServerProvider`），不要手写授权码流程
> - Resources / Prompts 机制 → SDK 的 `ResourceTemplate` 与 McpServer API，不要自己造 URI 分发
> - 调试 → 官方 **MCP Inspector**（`npx @modelcontextprotocol/inspector`），不要手写测试客户端
> - 发布 → 官方 **Registry**（registry.modelcontextprotocol.io），不要自建目录
>
> 本层唯一允许手写的 `[CUSTOM]` 是**业务工具/资源/提示定义**——产品独有工具、资源 URI 语义、prompt 模板内容，属于业务差异层，没有现成替代。

---

## 目录

- [1.1 选型：Server 与传输（2026-07-28 无状态规范）](#11-选型server-与传输2026-07-28-无状态规范)
- [1.2 Stdio Server（本机）：业务定义 [CUSTOM]](#12-stdio-server本机业务定义-custom)
- [1.3 Streamable HTTP Server（生产）：业务定义 + OAuth 2.1 + PKCE](#13-streamable-http-server生产业务定义--oauth-21--pkce)
- [1.4 Resources 暴露：业务 URI 语义 [CUSTOM]](#14-resources-暴露业务-uri-语义-custom)
- [1.5 Prompts 模板：复用高质量指令 [CUSTOM]](#15-prompts-模板复用高质量指令-custom)
- [1.6 协议语义与错误处理（SDK 覆盖，但要理解）](#16-协议语义与错误处理sdk-覆盖但要理解)
- [1.7 调试：官方 MCP Inspector 完整流程](#17-调试官方-mcp-inspector-完整流程)
- [1.8 发布到官方 MCP Registry](#18-发布到官方-mcp-registry)
- [1.9 A2A 简章：与 MCP 的分工](#19-a2a-简章与-mcp-的分工)
- [1.10 安全边界](#110-安全边界)
- [1.11 迁移指南：从 HTTP+SSE / 有状态规范升级](#111-迁移指南从-httpsses--有状态规范升级)
- [1.12 本层验收清单](#112-本层验收清单)

---

## 1.1 选型：Server 与传输（2026-07-28 无状态规范）

🔗 **工程逻辑**：MCP 协议本质是 JSON-RPC 2.0。2026-07-28 规范修订移除了 `initialize`/`initialized` 握手与 `Mcp-Session-Id`，改为**无状态核心**：客户端不需要先建会话，直接发请求；服务端通过新增的 `Mcp-Method` / `Mcp-Name` 请求头识别调用意图。手写帧解析、错误码、通知协议在早期还有意义，现在官方 SDK 全部覆盖。你的工作只剩三层：

```
业务定义 [CUSTOM]  →  工具/资源/提示 内容（产品差异）
胶水层             →  调业务 API、鉴权（OAuth 2.1）、参数校验
SDK 能力           →  JSON-RPC、传输、无状态请求/响应、通知、回放
```

**无状态协议要点**（写客户端/服务端时对照）：

| 变化 | 旧规范（废弃） | 2026-07-28 无状态规范 |
|------|---------------|----------------------|
| 握手 | `initialize` / `initialized` 必须先完成 | 无握手，直接发请求 |
| 会话 | `Mcp-Session-Id` 头 + 服务端会话表 | 无会话头；状态由客户端持有 |
| 调用标识 | `Mcp-Session-Id` 关联 | `Mcp-Method`（如 `tools/call`）+ `Mcp-Name`（客户端名） |
| 传输 | HTTP+SSE 双端点（`GET /sse` + `POST /messages`） | 单一 `POST /mcp`（Streamable HTTP） |

**传输选型**（只有两条路）：

| 传输 | 适用场景 | 连接方式 | 认证 |
|------|---------|---------|------|
| **Stdio** | 本机 CLI、桌面应用、单租户 | 1:1 进程管道（stdin/stdout） | 无（本机信任） |
| **Streamable HTTP** | 跨网络、生产环境（推荐） | 单一 `POST /mcp` 端点 | OAuth 2.1 + PKCE（Bearer token） |

❌ **已废弃（不要写）**：
- HTTP + SSE 双端点（`GET /sse` + `POST /messages`）——规范已移除，新服务端禁止实现。
- 有状态会话假设（`Mcp-Session-Id`、`initialize` 握手）——客户端不应依赖，服务端不应生成。
- 手写 HTTP 轮询 / 手写 EventSource 封装——SDK 的 `StreamableHTTPServerTransport` 已覆盖。

> 🤖 **AI 常见错误**：用 Stdio 部署远程服务。Stdio 是本地进程间通信，不能跨网络；远程必须用 Streamable HTTP。若在旧教程里看到 `SSEServerTransport` + `sessionIdGenerator`，那是 2026-07 之前的写法，直接跳过。

---

## 1.2 Stdio Server（本机）：业务定义 [CUSTOM]

使用 SDK 高层 API `McpServer`：`tool()` / `resource()` / `prompt()` 三个注册方法覆盖全部 MCP 能力，参数 schema 由 Zod 生成——你只写业务内容。Stdio 不涉及网络与认证，无状态规范对它的影响为零：仍然是「启动进程 → 读 stdin 帧 → 写 stdout 帧」的 1:1 管道。

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

**Stdio 部署纪律**：
1. 入口必须是独立可执行文件——`package.json` 里配置 `bin`，或构建后直接 `node dist/weather/index.js`，MCP Client 才能拉起进程。
2. stdout 只允许输出 JSON-RPC 帧——一切日志走 `console.error`（stderr）。
3. 无状态规范下 Stdio 仍是「进程即会话」：客户端拉起进程、用完杀掉，进程内不要保存跨客户端状态。

**工具实现模式（业务层 [CUSTOM]）**：
1. **输入校验**：Zod schema 只做类型校验；业务约束（如城市名必须存在）在 handler 里校验，不合法返回 `{ content: [...], isError: true }`。
2. **输出结构**：优先返回结构化文本（JSON 字符串），方便 LLM 直接消费；需要多段输出时用多个 content 项。
3. **错误处理**：业务错误不要 throw 到协议层——返回 `isError: true`，让客户端把它当作工具结果而非传输故障。

```typescript
// packages/mcp-servers/src/weather/toolPatterns.ts —— 工具实现模式 [CUSTOM]
server.tool(
  'get_weather',
  { city: z.string().describe('城市名') },
  async ({ city }) => {
    if (!city.trim()) {
      return {
        content: [{ type: 'text', text: 'city 不能为空' }],
        isError: true,
      };
    }
    const weather = await fetchWeather(city);
    return {
      content: [
        { type: 'text', text: `城市：${weather.city}` },
        { type: 'text', text: `温度：${weather.temp}°C` },
      ],
    };
  }
);
```

> 🤖 **AI 常见错误**：用 `console.log` 输出日志。Stdio 的 stdout 被 JSON-RPC 帧占用，任何 `console.log` 都会污染协议导致客户端解析失败。日志必须走 `console.error`（stderr）。
>
> 🤖 **AI 常见错误**：手写 JSON-RPC 请求解析（`JSON.parse(await readStdin())`）。帧边界、批量请求、错误码、通知全是 SDK 已覆盖的坑，手写必然漏边界。**检查方式**：`grep -rn "readline" packages/mcp-servers/` 应无结果。
>
> 🤖 **AI 常见错误**：在 Stdio Server 里保存跨请求会话状态（如 `Map<sessionId, ...>`）。无状态规范下进程可能被随时重启，状态必须外置到数据库/缓存，Server 进程保持无状态。

---

## 1.3 Streamable HTTP Server（生产）：业务定义 + OAuth 2.1 + PKCE

远程部署用 SDK 的 Streamable HTTP 传输，业务定义与 1.2 完全复用——只换 Transport，不换业务代码。生产环境必须挂在 **OAuth 2.1 + PKCE** 之后：MCP 端点就是执行代码的入口，裸奔等于把数据库查询、文件写入开放到公网。

**无状态 HTTP 语义**（由 `StreamableHTTPServerTransport` 处理）：
- `POST /mcp`：携带 JSON-RPC 请求体；响应可以是单个 JSON（无流式请求）或 SSE 流（`tools/call` 等流式场景）。
- 请求头 `Mcp-Method`：声明本次调用意图（如 `tools/call`、`resources/read`），服务端据此路由。
- 请求头 `Mcp-Name`：客户端自报名称，用于服务端审计日志。
- 没有 `Mcp-Session-Id`：每次请求都是独立事务；需要跨请求状态的业务（如长任务）由客户端持有任务 ID。

```typescript
// packages/mcp-servers/src/weather/http.ts —— Streamable HTTP 远程版（2026-07-28 无状态规范）
import express from 'express';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const app = express();
app.use(express.json());

// 业务定义 [CUSTOM] 与 1.2 完全一致——只换传输，不换业务代码
function createWeatherServer(): McpServer {
  const server = new McpServer({ name: 'weather-mcp-http', version: '1.0.0' });

  server.tool('get_weather', { city: z.string().describe('城市名') }, async ({ city }) => ({
    content: [{ type: 'text', text: JSON.stringify(await fetchWeather(city)) }],
  }));

  server.resource(
    'weather-current',
    new ResourceTemplate('weather://{city}', { list: undefined }),
    async (uri) => ({
      contents: [{ uri: uri.href, text: JSON.stringify(await fetchWeather(decodeURIComponent(uri.pathname.replace('/', '')))) }],
    })
  );

  server.prompt('weather_report', { city: z.string() }, async ({ city }) => ({
    messages: [{ role: 'user', content: { type: 'text', text: `请用通俗语言播报 ${city} 的天气。` } }],
  }));

  return server;
}

export function startHttpServer(port = 3001): void {
  app.post('/mcp', async (req, res) => {
    const server = createWeatherServer();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true, // 无状态：单次请求优先返回 JSON，而不是 SSE 长连接
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, server);
  });

  app.listen(port, () => {
    console.error(`weather MCP listening on :${port}`); // 日志走 stderr
  });
}
```

**认证中间件挂载**：把 1.10 的 `bearerAuth` 中间件挂到 `/mcp` 路由上（`app.post('/mcp', bearerAuth(validTokens), handler)`）；生产环境把 `validTokens` 换成 OAuth 2.1 + PKCE 的 token 校验（见下）。

**OAuth 2.1 + PKCE 流程**（MCP 官方推荐的远程认证）：

| 步骤 | 参与方 | 动作 |
|------|--------|------|
| 1 | Client → Server | `GET /mcp`，服务端返回授权服务器元数据（`401` + `WWW-Authenticate`） |
| 2 | Client → 授权服务器 | 发起授权码请求，携带 `code_challenge`（S256） |
| 3 | 用户 → 授权服务器 | 登录并授权 scope（如 `tools:read`） |
| 4 | 授权服务器 → Client | 回调 `redirect_uri` 下发授权码 |
| 5 | Client → 授权服务器 | 用授权码 + `code_verifier` 换 `access_token`（PKCE 校验） |
| 6 | Client → Server | 后续 MCP 请求带 `Authorization: Bearer <access_token>` |

要点：
- `token_endpoint_auth_method` 必须是 `none`——公开客户端不能持有 client_secret，安全性由 PKCE 保证。
- scope 建议按能力拆分（`tools:read` / `resources:read` / `prompts:read`），服务端在 `authorize` 回调里做授权判定。
- **不要手写**授权码流程：SDK 提供 `OAuthClientProvider`（客户端）与 `OAuthServerProvider`（服务端），你只提供业务回调（注册客户端、签发/校验 token、用户授权页）。

**客户端接入示例**（把 02 的 `MCPClient` 升级到 OAuth 2.1 + PKCE）：

```typescript
// packages/web/src/mcp/oauthClient.ts —— OAuth 2.1 + PKCE 客户端接入（SDK auth helper）
import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// 业务回调：localStorage / window.open 由你的应用实现
const provider: OAuthClientProvider = {
  clientMetadata: {
    client_name: 'agent-core-web',
    redirect_uris: ['https://app.example.com/mcp/callback'],
    token_endpoint_auth_method: 'none',
  },
  async getClientInformation() {
    return { client_id: 'agent-core-web' };
  },
  async saveClientInformation(info) {
    await store('mcp:client', info);
  },
  async getTokens() {
    return (await load('mcp:tokens')) ?? null;
  },
  async saveTokens(tokens) {
    await store('mcp:tokens', tokens);
  },
  async getAuthorizationCode(authorizationUrl) {
    const code = await openAuthWindow(authorizationUrl);
    return { code, verifier: loadPkceVerifier() };
  },
};

export function createRemoteTransport(url: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(url), { authProvider: provider });
}
```

> 🤖 **AI 常见错误**：在 `handleRequest` 前后自己拼 SSE 帧或手动管理会话 ID。`StreamableHTTPServerTransport` 已管理无状态请求/响应，你只需要 `connect` + `handleRequest`；任何 `Mcp-Session-Id` 相关代码都是旧规范遗留。
>
> 🤖 **AI 常见错误**：把 `createWeatherServer()` 写在 `app.post` 回调里导致每个请求都重建 server。示例为了演示「每请求一 transport」，生产上应把 `McpServer` 实例提升到模块级，只创建一次；`StreamableHTTPServerTransport` 按请求创建，两者职责不同。

**已废弃的 HTTP+SSE（不要写）**：
旧教程的远程方案是 `SSEServerTransport`：`GET /sse` 建立长连接、`POST /messages` 推送消息、`Mcp-Session-Id` 维护会话。2026-07-28 规范已移除该模式，新代码一律用 Streamable HTTP。如果你在维护 2026 年 7 月之前的服务端代码，迁移路径见 1.11。

---

## 1.4 Resources 暴露：业务 URI 语义 [CUSTOM]

**工程逻辑**：Resource 是 MCP 的「数据暴露层」。客户端通过 URI scheme 直接访问 Server 管理的数据——不需要定义 `read_file` tool，暴露 `weather://{city}` 即可。URI 语义是业务 [CUSTOM]，模板匹配与 list/read 分发是 SDK 能力。

**两类资源注册**：

| 方式 | API | 适用 |
|------|-----|------|
| 单资源 | `server.resource(name, uri, handler)` | 固定 URI，如 `weather://current` |
| 模板资源 | `server.resource(name, new ResourceTemplate('weather://{city}', opts), handler)` | 参数化 URI，如 `weather://{city}` |

**ResourceTemplate 的 `list` 选项**：

```typescript
// packages/mcp-servers/src/weather/resources.ts —— Resources 业务定义 [CUSTOM]
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

// list: undefined —— 不对外列出，客户端只能按已知 URI 读取（适合私有数据）
server.resource(
  'weather-current',
  new ResourceTemplate('weather://{city}', { list: undefined }),
  async (uri) => {
    const city = decodeURIComponent(uri.pathname.replace('/', ''));
    return { contents: [{ uri: uri.href, text: JSON.stringify(await fetchWeather(city)) }] };
  }
);

// list: 回调 —— 对外列出全部可用资源（适合目录型数据）
server.resource(
  'weather-archive',
  new ResourceTemplate('weather-archive://{date}', {
    list: async () => ({
      resources: [
        { uri: 'weather-archive://2026-10-01', name: '2026-10-01 气象存档' },
        { uri: 'weather-archive://2026-10-02', name: '2026-10-02 气象存档' },
      ],
    }),
  }),
  async (uri) => {
    const date = decodeURIComponent(uri.pathname.replace('/', ''));
    return { contents: [{ uri: uri.href, text: JSON.stringify(await fetchArchive(date)) }] };
  }
);
```

**客户端视角**：`listResources()` 返回模板/资源清单，`readResource(uri)` 命中模板时 SDK 解析占位符并调用你的 handler——不用手写 `uri.split(':')` 分发。

**订阅与通知**：资源变更时，服务端可调用 `server.notification({ uri })` 通知已订阅的客户端（SDK 能力）。订阅管理适合「文件系统、实时数据」类资源；只读快照型资源（如天气）不需要实现订阅。

> 🤖 **AI 常见错误**：把整个文件系统暴露成 Resource。`file://` 模板一旦注册，任何 URI 都会被 handler 解析——等于把任意文件读取开放给 LLM。暴露多少数据、URI 怎么设计，属于产品决策 [CUSTOM]；而 URI 匹配、MIME 类型、分页、通知都是 SDK 能力。

---

## 1.5 Prompts 模板：复用高质量指令 [CUSTOM]

**工程逻辑**：Prompt 是 Server 向客户端提供预定义模板的机制。典型用途：把领域专家总结的「查询技巧」固化成模板，让 LLM 调用时直接复用，而不是每次手写。**模板内容、参数边界属于业务 [CUSTOM]**；模板注册、参数校验、消息组装是 SDK 能力。

**完整示例**：城市天气对比查询模板

```typescript
// packages/mcp-servers/src/weather/prompts.ts —— Prompt 模板定义 [CUSTOM]
import { z } from 'zod';

server.prompt('compare-cities', {
  description: '对比两座城市未来 7 天天气，并给出穿衣建议',
  args: {
    cityA: z.string().describe('第一座城市名'),
    cityB: z.string().describe('第二座城市名'),
  },
  handler: async (args) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `请对比 ${args.cityA} 与 ${args.cityB} 未来 7 天天气，` +
            `格式：逐日对比表 + 总结 + 穿衣建议。`,
        },
      },
    ],
  }),
});
```

**客户端调用**：`getPrompt('compare-cities', { cityA: '北京', cityB: '上海' })` 得到消息列表，可直接注入对话上下文——注意 MCP Prompt 返回的是消息列表，不是 LLM 输出。

**参数边界（不要在 MCP 层做重逻辑）**：

| 事情 | 归属 | 说明 |
|------|------|------|
| 模板文案、参数名 | [CUSTOM] | 业务语义，必须由业务方定义 |
| 参数 Zod 校验、必填/可选 | SDK 能力 | `args` 直接声明在注册处，客户端自动校验 |
| 提示词注入防护 | 客户端/LLM 侧 | 模板拼接用户输入时，客户端负责做注入防护 |
| prompt 内嵌 tool 调用 | 不建议 | MCP Prompt 语义是「纯消息模板」，需要工具能力请走工具通道 |

> 🤖 **AI 常见错误**：用 MCP Prompt 去返回「分析结果」而不是「指令模板」。Prompt 的作用是组织输入，不是执行任务；执行应该交给工具。另一个常见错误是把 `getPrompt` 当作 RPC 端点拼 SQL——那是工具（tool）的职责，不是模板的职责。模板内容属于业务 [CUSTOM]，注册与分发是 SDK 能力。
---

## 1.6 协议语义与错误处理（SDK 覆盖，但要理解）

**工程逻辑**：MCP 协议是 JSON-RPC 2.0 的子集。SDK 负责编解码、错误码映射、生命周期，但你在业务层仍然要理解：方法名、错误码约定、长任务如何处理。选型判断不依赖具体 SDK 实现，以下方法表与错误码表在 2026-07-28 无状态规范下依然成立。

**核心方法一览（无状态规范）**：

| 方向 | 方法 | 说明 |
|------|------|------|
| C → S | `initialize` | 连接建立时的能力协商（版本、传输、工具数量） |
| C → S | `tools/list` / `tools/call` | 发现工具 / 调用工具 |
| C → S | `resources/list` / `resources/read` | 发现资源 / 读取资源内容 |
| C → S | `prompts/list` / `prompts/get` | 发现模板 / 获取填充后的消息 |
| C → S | `notifications/initialized` | 初始化完成通知（不需要响应） |
| S → C | `notifications/tools/list_changed` | 工具清单变更通知 |

**错误码约定（JSON-RPC）**：

| 错误码 | 含义 | 业务层应对 |
|--------|------|------------|
| `-32700` | 解析错误（JSON 语法非法） | 客户端 bug，直接抛 |
| `-32601` | 方法不存在 | 工具名写错，检查 `tools/list` 返回 |
| `-32602` | 参数非法 | 暴露给 LLM 的参数 schema 错误，检查 Zod 定义 |
| `-32603` | 内部错误 | 工具 handler 抛异常，返回结构化错误给客户端 |
| `-32000..` | 服务器自定义错误 | 业务错误码，如权限不足、数据不存在 |

**业务层错误处理示例**：

```typescript
// packages/mcp-servers/src/weather/errors.ts —— 业务错误码映射 [CUSTOM]
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export class WeatherNotFoundError extends McpError {
  constructor(city: string) {
    super(
      ErrorCode.InvalidParams,
      `未找到城市 ${city}，可用城市见 listResources 返回的 weather:// 清单`
    );
  }
}
```

**长任务与进度通知**：无状态规范下，一个 `tools/call` 请求对应一个 HTTP 响应。超过分钟级的任务不适合塞进单次工具调用——正确姿势是：工具入队并立即返回任务 ID，另提供 `get_task_status` 工具轮询，或通过通知通道推送进度。**不要在工具 handler 里 sleep 几分钟等结果**，这会让 HTTP 连接超时、客户端体验变差。

> 🤖 **AI 常见错误**：在工具 handler 里同步等待长任务完成再返回。MCP 工具调用是「请求-响应」模型，长任务应返回任务 ID 并提供状态查询工具；这是 2026 无状态规范下跨网络调用的基本要求。

---

## 1.7 调试：官方 MCP Inspector 完整流程

**不要手写调试客户端**。官方 MCP Inspector 提供 GUI：连接 Stdio / Streamable HTTP，浏览工具、资源、提示，发起调用查看 JSON-RPC 往返与时间线。

**前置条件**：

```bash
# 1) 构建 server（TS → dist），确认入口可独立运行
npm run build -w packages/mcp-servers

# 2) 直接运行一次，确认无启动时报错
node packages/mcp-servers/dist/weather/index.js
```

**调试本地 Stdio Server**：

```bash
npx @modelcontextprotocol/inspector node packages/mcp-servers/dist/weather/index.js
```

Inspector 会启动本地 GUI（默认 http://localhost:6274），并拉起你的 Stdio 子进程。左侧面板依次操作：

1. **Tools** 页签 → 应看到 `get_weather` 等工具与描述；点击工具、填参、调用，右侧展示原始 JSON-RPC 请求/响应。
2. **Resources** 页签 → 浏览 `weather://{city}` 模板与 list 结果；点击资源 URI 触发 `resources/read`。
3. **Prompts** 页签 → 选择 `compare-cities` 模板，填参，查看展开后的消息列表。
4. **Console** 页签 → 查看 stderr 日志与协议帧时间线，确认无乱序、无超时。

**调试远程 Streamable HTTP Server**：

```bash
# 需要 OAuth：Inspector 会引导你完成授权码流程（浏览器跳转 + 回调）
npx @modelcontextprotocol/inspector --url http://localhost:3001/mcp
```

**自动化回归**：Inspector 的 GUI 操作等价于真实客户端链路，但回归测试不要依赖 GUI。用 SDK 写集成测试（见 1.2 的测试方法），CI 里跑 `node --test`；Inspector 只用于人工排查协议帧、调试 OAuth 握手、核对错误码。

**常见排查路径**：

| 现象 | 排查步骤 | 常见根因 |
|------|----------|----------|
| GUI 连接后 Tools 为空 | 看 Console 页签 stderr | Server 启动抛错或 `registerTool` 被条件跳过 |
| `tools/call` 返回 `-32602` | 检查传入参数与 Zod schema | 参数名拼写不一致 |
| 远程连接 401 | 检查 OAuth 流程是否走完 | 未授权、PKCE code_verifier 丢失 |
| 调用超时 | 看时间线中请求耗时 | 长任务未返回任务 ID（违反 1.6 原则） |

🔗 **工程逻辑**：Inspector 展示的是 SDK 发出的真实 JSON-RPC 帧——用它验证「业务定义 → 客户端视角」的完整链路，等价于集成测试客户端，但不需要写代码。
---

## 1.8 发布到官方 MCP Registry

**工程逻辑**：官方 Registry（registry.modelcontextprotocol.io）是 MCP Server 的「应用商店」。发布后，任何支持 MCP 的客户端（Claude、Cursor、自研 Agent）都能通过包名搜索并一键接入你的 Server。发布内容是元数据 + 传输信息，业务代码不需要任何改动。

**前置条件**：

| 项目 | 要求 |
|------|------|
| 服务包名 | `@scope/server-name`，需在 npm 上可解析 |
| 传输 | 必须提供 `streamable-http` 端点（生产）；本机工具可另附 `stdio` 入口 |
| 认证 | 公开服务：OAuth 2.1 + PKCE；私有服务：注明鉴权方式与申请渠道 |
| 文档 | README 写明启动命令、环境变量、示例 URI（`weather://北京`） |

**发布流程**：

```bash
# 1) 全局安装 Registry CLI
npm install -g @modelcontextprotocol/registry-cli

# 2) 登录（浏览器完成 OAuth 授权）
npx @modelcontextprotocol/registry-cli login

# 3) 校验并发布（自动读取 package.json 的 name/description）
npx @modelcontextprotocol/registry-cli publish
```

**发布后维护**：

- 每次发版 `npm version patch` 后重新 publish，Registry 会自动更新。
- 修改工具/资源清单后，客户端通过 `notifications/tools/list_changed` 感知——发布版本号不变时，缓存会延迟更新，影响用户体验。
- 下线服务：`npx @modelcontextprotocol/registry-cli unpublish`，并保留一个 HTTP 错误页说明下线原因。

**上架清单（发布前逐项核对）**：

- [ ] `package.json` 的 `name`/`description`/`repository` 完整
- [ ] README 包含快速开始命令与本仓库约定的路径前缀（`packages/mcp-servers`）
- [ ] Streamable HTTP 端点已通过 1.7 的 Inspector 联调
- [ ] OAuth 2.1 + PKCE 授权流程完整走通
- [ ] `npx @modelcontextprotocol/registry-cli validate` 通过（无网络时可离线检查元数据格式）

> 🤖 **AI 常见错误**：把 dev 环境地址（`http://localhost:3001/mcp`）写进 Registry 元数据。Registry 展示的是公网可访问端点；本地调试请用 `--url` 直接连，不要发布内网地址。

---

## 1.9 A2A 简章：与 MCP 的分工

**工程逻辑**：MCP 解决「LLM ↔ 工具/数据」的最后一公里；**A2A（Agent-to-Agent）** 解决「Agent ↔ Agent」的跨系统协作。两者互补，不冲突。当你的服务需要被「另一个智能体」而非「单个 LLM 会话」调用时，才考虑 A2A。

**分工表**：

| 维度 | MCP（本文件） | A2A |
|------|---------------|-----|
| 调用方 | LLM / Agent（单次会话） | Agent（自主任务编排） |
| 交互单元 | Tool / Resource / Prompt | Task（异步任务卡） |
| 协议 | JSON-RPC 2.0（无状态） | JSON-RPC 2.0 + Task 状态机 |
| 典型场景 | 给 LLM 加工具 | 多 Agent 协作、人机审批流 |
| 传输 | Stdio / Streamable HTTP | HTTP（支持回调） |

**决策规则**：

1. 交互是「请求 → 结果」：用 **MCP Tool**。
2. 交互是「提交任务 → 异步追踪进度 → 人工审批」：用 **A2A Task**。
3. 一个服务可以同时暴露 MCP 端点与 A2A 端点，但不要在 MCP 工具里模拟 A2A 的异步状态机——那是 1.6 节明令禁止的长任务模式。

**A2A 最小示例**（仅示意分工，不展开实现）：

```typescript
// packages/mcp-servers/src/a2a/task.ts —— A2A 任务卡语义（分工参考，非 MCP）
type A2ATask = {
  id: string;
  status: 'submitted' | 'working' | 'awaiting-input' | 'completed' | 'failed';
  artifact?: { parts: Array<{ kind: 'text' | 'file'; text?: string; uri?: string }> };
};
```

**本仓库立场**：当前阶段只实现 MCP Server（02 的 Agent 作为 MCP Client 使用工具）；A2A 作为协议认知保留在文档层，不引入新依赖。

---

## 1.10 安全边界

MCP Server 的安全模型与普通 HTTP 服务一致，且工具即权限：调用工具 = 执行代码。

**威胁模型与缓解**：

| 威胁 | 缓解 | 归属 |
|------|------|------|
| 未授权调用 | Streamable HTTP 端点挂 Bearer 认证（Express 中间件）或 OAuth 2.1 + PKCE | 胶水层 |
| 工具参数注入（路径穿越等） | handler 内做业务校验（如 `path.resolve` + 前缀检查） | `[CUSTOM]` |
| Stdio stdout 污染 | 日志一律 `console.error` | 工程纪律 |
| 资源 URI 越权 | `ResourceTemplate` 参数校验 + handler 内授权 | `[CUSTOM]` |
| OAuth 授权码泄露 | PKCE + 短有效期 + 拒绝重复使用 code | 胶水层 |

**两种认证方式的选择**：

1. **内部服务 / 本机工具**：Bearer Token 即可。token 通过环境变量注入（`MCP_BEARER_TOKEN`），进程内不要硬编码。
2. **面向公网 / Registry 发布**：必须 OAuth 2.1 + PKCE。用户通过浏览器完成授权，Server 只接收短期 access_token，不接触长期凭证。

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

**无状态规范下的安全要点**：

- **不要维护 session**：无状态 MCP 不生成 `Mcp-Session-Id`。每个请求独立鉴权；「登录态」由 access_token 的过期时间决定，而不是服务端会话。
- **token 校验必须与业务授权分离**：`bearerAuth` 只做「你是谁」，工具 handler 内还要做「你能否做这个动作」——例如 `get_weather` 只允许白名单城市。
- **OAuth 的 `authToken` 只放内存/请求头**：不写入日志、不进入 `console.error` 输出（Stdio 场景 stderr 仍会被日志平台采集）。
- **错误响应不泄露内部细节**：401 返回固定文案；`-32603` 内部错误不要把堆栈拼进 MCP 响应文本。

> 🤖 **AI 常见错误**：把认证做成「先登录拿 sessionId，后续请求带 sessionId」的有状态模型。2026-07-28 无状态规范下没有 session——`Mcp-Session-Id` 已是废弃概念；继续写 session 中间件既不符合规范，也让 Server 无法水平扩展。任何涉及 `sessionIdGenerator`、`Mcp-Session-Id` 的旧教程代码都不要再抄。

---

## 1.11 迁移指南：从 HTTP+SSE / 有状态规范升级

**工程逻辑**：2026-07-28 起，官方规范废弃了「HTTP+SSE 双端点」与「有状态握手（sessionId）」。存量项目迁移到无状态 Streamable HTTP 是必要动作，不是可选优化。迁移核心只有两件事：传输层换 `StreamableHTTPServerTransport`、认证换 OAuth 2.1 + PKCE（或 Bearer）。业务工具代码可以原样保留。

**迁移步骤**：

1. 删除 `SSEServerTransport` 与 `sessionIdGenerator` 相关代码（它们是旧规范的标志）。
2. 把 `sse` 路由替换为 `mcp` 单端点：POST 承载 JSON-RPC，GET 承载 SSE 流（Streamable HTTP 语义）。
3. 认证从「session 中间件」换成无状态 Bearer / OAuth 2.1 + PKCE（见 1.10）。
4. 客户端从 `SSEClientTransport` 换成 `StreamableHTTPClientTransport`（见 02 的 MCP 客户端接入）。
5. 用 1.7 的 Inspector 重新联调，确认 OAuth 流程与工具调用正常。

**不要这样写（旧规范遗留）**：

```typescript
// ❌ 废弃写法：有状态握手 + SSE 双端点（2026-07-28 起不再支持）
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const transports: Map<string, SSEServerTransport> = new Map();

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.headers['mcpx-session-id'] as string;
  const transport = transports.get(sessionId);
  if (!transport) { res.status(400).send('No session'); return; }
  await transport.handlePostMessage(req, res);
});
```

**要这样写（无状态 Streamable HTTP）**：见 1.3 的 `createWeatherServer()` + `StreamableHTTPServerTransport`。两者对比，业务层 `registerTool` 完全不用动——SDK 把协议差异隔离在传输层。

**回归检查命令**：

```bash
grep -rn "SSEServerTransport\|sessionIdGenerator\|Mcp-Session-Id\|SSEClientTransport" packages/ references/ || true
```

输出为空即迁移完成。

> 🤖 **AI 常见错误**：在迁移时「顺手重构」业务工具。传输层替换与业务代码无关——`registerTool`、`ResourceTemplate`、`prompt` 注册代码在新旧规范下完全一致。迁移 PR 应该只有传输与认证文件的 diff，避免把协议升级和业务重构混在一起，增大回归风险。

---

## 1.12 本层验收清单

- [ ] **类型检查**：运行 `npx tsc --noEmit -p packages/mcp-servers`，`weather/index.ts`、`http.ts`、`auth.ts` 全部 0 错误，公共 API 无 `any` 泄漏。
- [ ] **核心行为**：启动 Stdio Server 后用 MCP Inspector 连接，断言 `listTools` 返回 `get_weather`、`callTool` 返回结构化文本、Resources/Prompts 可浏览。
- [ ] **无状态合规**：代码库中无 `SSEServerTransport`、`sessionIdGenerator`、`Mcp-Session-Id`、`SSEClientTransport` 引用（见 1.11 的 grep 命令）。
- [ ] **认证边界**：缺失 `Authorization` 头或伪造 Bearer token 调用远程端点，断言返回 401 且工具未被调用；用未知工具名调用返回 `isError: true` 而非崩溃。
- [ ] **OAuth 流程**：公网端点走通 OAuth 2.1 + PKCE 全流程；`authToken` 不出现在日志与 MCP 响应文本中。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs` 本文件 0 失败；`grep -rn "LLMClient" references/` 无结果；Stdio 调试时 stdout 无 `console.log` 输出。
---

## 交叉引用

- [02-tools-skills.md](02-tools-skills.md) — MCP 客户端接入：把本文件的 Server 工具转成 AI SDK `tool()`（只写胶水）
- [00-types.md](00-types.md) — 跨层类型契约：`llm` 一律是 `LanguageModel`（`ai`），创建用 01 的 `createModel`
- [07-security.md](07-security.md) — 输入输出校验、Guardrails、工具分级
- [23-artifacts-computer-use.md](23-artifacts-computer-use.md) — MCP 承载 Artifact 与浏览器操控
