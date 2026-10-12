# MCP 生态调研（2024–2026）

> 调研日期：2026-10-12。证据以官方规范文档、官方博客、GitHub 仓库与大厂公告为主；本环境无法直接抓取全文，引用基于搜索返回的页面标题与摘要，关键结论均经多来源交叉验证。整体置信度：**高**（规范版本、注册表、大厂支持、A2A 关键节点均有官方来源）；个别量化数据来自第三方统计，置信中等。

## 结论摘要

- MCP 已从 2024-11 的初版协议演进为 **2026-07-28 稳定规范**（无状态核心 + Streamable HTTP 为主），并由 Anthropic 于 2025-12 捐赠给 Linux Foundation 旗下的 Agentic AI Foundation（AAIF），OpenAI、Google、Microsoft 全部原生支持，已成为 **Agent 工具互联的事实标准**。
- 官方注册表 registry.modelcontextprotocol.io 于 2025-09 上线（preview），2026 年注册服务器已近万级；官方 SDK 覆盖 TypeScript/Python/Go/C#，调试用官方 MCP Inspector。
- A2A 协议（Google 发起、Linux Foundation 治理）于 2026-03 发布 1.0 稳定版，150+ 组织支持并落地 Azure AI Foundry / Amazon Bedrock / Salesforce Agentforce 等，但与 MCP 定位互补（Agent↔Agent vs Agent↔Tool）。**工具互联首选仍是 MCP，A2A 仅在跨 Agent 协作场景引入**。

## 1. MCP 规范现状

### 当前版本
最新规范为 **2026-07-28**，官方称为"自发布以来最大一次修订"。核心变化：协议核心改为**无状态（stateless）**，移除 initialize/initialized 握手与 Mcp-Session-Id；Streamable HTTP 传输新增 Mcp-Method / Mcp-Name 请求头。来源：官方发布博客（blog.modelcontextprotocol.io/posts/2026-07-28、/posts/2026-07-28-release-candidate）、AAIF 迁移指南（aaif.io/blog/mcp-2026-07-28-whats-changing-and-how-to-migrate）、Nango 技术博客（nango.dev/blog/stateless-mcp-how-it-changes-the-way-agents-call-tools）。

### 官方 SDK
官方 SDK 为 **TypeScript**（github.com/modelcontextprotocol/typescript-sdk）、**Python**（…/python-sdk）、**Go**（…/go-sdk）、**C#**；2026-07-28 规范发布时四个 SDK 同步更新（blog.cloudflare.com/mcp-v2）。清单见 modelcontextprotocol.io/docs/2026-07-28/sdk。

### 传输
- **stdio**：本地进程间通信，适合开发调试与单机 CLI/IDE 集成。
- **Streamable HTTP**：远程生产环境的推荐传输（单一 GET/POST 端点，支持流式响应）。
- **HTTP+SSE（旧）**：已被 Streamable HTTP 取代——2025-11-25 修订起正式替换，2026-07-28 规范不再推荐。来源：官方 Streamable HTTP 页（modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http）、TrueFoundry（"What's deprecated is the older HTTP+SSE transport"）、fka.dev（blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http）。

2026-07-28 无状态 Streamable HTTP 请求示意（省略 OAuth 令牌头）：

```
POST /mcp  HTTP/1.1
Mcp-Method: tools/call
Mcp-Name: my-server
```

### 认证与授权
规范采用 **OAuth 2.1**（而非 2.0）：客户端强制 PKCE；授权服务器发现使用 RFC 9728（Protected Resource Metadata）；MCP 服务器作为 OAuth Resource Server，令牌校验交给外部授权服务器。来源：官方授权教程（modelcontextprotocol.io/docs/2026-07-28/tutorials/security/authorization）、Authgear（authgear.com/post/mcp-authentication）、Descope（descope.com/blog/post/mcp-auth-spec）。

### 官方注册表
官方 MCP Registry 于 **2025-09-08** 以 preview 上线：registry.modelcontextprotocol.io，GitHub 仓库 modelcontextprotocol/registry，定位是"MCP 服务器的应用商店"。第三方统计显示截至 2026-04 注册列表约 **9,652 个**。官方 about 页仍标注 preview，但 registry 自身 API 文档已迭代到 v1.0.0。来源：官方博客 Introducing the MCP Registry（blog.modelcontextprotocol.io/posts/2025-09-08-mcp-registry-preview）、registry.modelcontextprotocol.io/docs、Tech-Insider 统计。

### MCP Inspector
官方可视化调试工具，包名 **@modelcontextprotocol/inspector**，`npx @modelcontextprotocol/inspector` 即可启动，支持 stdio 与 HTTP 传输。来源：github.com/modelcontextprotocol/inspector、modelcontextprotocol.io/docs/2026-07-28/tools/inspector。

## 2. 生态采用证据

### 大厂支持
- **Anthropic**：2025-12-09 将 MCP 捐赠给 Linux Foundation 新成立的 Agentic AI Foundation（与 Block、OpenAI 共同创立），实现厂商中立治理（anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation）。
- **OpenAI**：Agents SDK 原生支持 MCP，stdio 与 Streamable HTTP 自动协商（openai.github.io/openai-agents-js/guides/mcp）；ChatGPT 于 2025 年秋在 Developer Mode 提供完整 MCP 支持（infoq.com/news/2025/10/chat-gpt-mcp）。
- **Google**：2025-05-20 宣布 Gemini SDK 原生支持 MCP（thenewstack.io/google-embraces-mcp）；Vertex AI 亦支持 MCP。
- **Microsoft**：Build 2025 宣布在其 Agent 平台提供广泛第一方 MCP 支持（blogs.microsoft.com/blog/2025/05/19/microsoft-build-2025-the-age-of-ai-agents-and-building-the-open-agentic-web）；VS Code 可直接配置 MCP 服务器（code.visualstudio.com/docs/agent-customization/mcp-servers）。

### 服务器生态
官方参考实现仓库 modelcontextprotocol/servers 提供 Filesystem、GitHub、Slack、Postgres 等参考服务器；社区生态中 **Playwright MCP**（微软，34k+ stars）与 **GitHub 官方 MCP**（30k+ stars）是最热门的两大服务器。2026 年选型通常从 Filesystem、GitHub、Playwright、数据库（Postgres 等）起步。来源：github.com/modelcontextprotocol/servers、ssojet.com/blog/best-mcp-servers-2026。

### 事实标准趋势
第三方统计称 MCP 已是 Agent 工具集成的事实标准：**月 SDK 下载 9700 万次、公共服务器 9400+**（toloka.ai/blog/the-future-of-mcp-enterprise-adoption）；另有统计称 2026 年 78% 企业 AI 团队已将 MCP 投入生产（tech-insider.org）。主流客户端 Claude Desktop/Code、Cursor、GitHub Copilot CLI、VS Code、Windsurf 全部支持 MCP。

## 3. Agent 间通信（A2A）

### 现状
Google 于 2025-04（Cloud Next）发布 A2A，2025-06 捐给 Linux Foundation；**2026-03-12 发布 1.0.0 稳定版**（github.com/a2aproject/A2A/releases）。2026-04-09 Linux Foundation 宣布 A2A 组织数超 **150 家**，进入主要云平台并有企业生产使用。来源：linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year。

A2A Agent Card 片段（用于跨 Agent 发现）：

```json
{
  "name": "order-agent",
  "description": "处理订单查询",
  "capabilities": { "streaming": true }
}
```

### 与 MCP 的关系
两者互补而非竞争：**MCP 是 Agent↔工具，A2A 是 Agent↔Agent**。A2A 解决跨组织/跨平台 Agent 的发现与协作；IBM 的 Agent Communication Protocol（ACP）也已并入 A2A。也有批评声音认为 A2A 实施负担较重、相比 MCP 采用有限（credal.ai/blog/what-happened-to-a2a-protocol）。来源：auth0.com/blog/mcp-vs-a2a、getstream.io/blog/agent2agent-vs-mcp、github.com/orgs/i-am-bee/discussions/5。

### 谁在用
支持者包括 Google、Microsoft、AWS、Salesforce、SAP、ServiceNow、Workday、IBM、Cisco、PayPal、LangChain、MongoDB、Cohere 等（atlan.com/know/google-a2a-protocol）；生产案例集中在云平台 Agent 编排与 CRM：Azure AI Foundry、Amazon Bedrock AgentCore Runtime、Salesforce Agentforce 3 等（eco.com 相关文章）。

## 4. 关键判断（2026 选型）

1. **工具互联默认选 MCP**：客户端用官方 TS/Python SDK，或直接使用支持 MCP 的 Agent 框架（OpenAI Agents SDK、Claude Code、VS Code 等）；服务端优先用官方 SDK 实现，不要自造协议。
2. **传输选型**：开发期/本机用 **stdio**；跨网络、多客户端、生产环境用 **Streamable HTTP**（配 OAuth 2.1/PKCE 保护）。
3. **版本对齐**：新项目直接按 **2026-07-28 无状态规范** 实现（无 initialize 握手、无 Mcp-Session-Id）；存量服务按官方迁移指南升级。
4. **A2A 何时引入**：只有出现"多个独立 Agent 需要互相发现、委托任务、跨组织协作"的场景才引入 A2A（用 1.0+）；单 Agent + 工具的场景引入 A2A 属过度设计，其生态仍处早期。
5. **注册表**：自研服务器可发布到官方 Registry（虽仍为 preview，但已是事实发现入口）；私有服务仍需自维护服务器列表，不强制依赖注册表。

## 5. 淘汰清单

- **自研 JSON-RPC 工具协议**：MCP 本身就是基于 JSON-RPC 2.0 的开放标准，无需自研。
- **HTTP+SSE 双端点传输**：2025-11-25 起被 Streamable HTTP 取代，2026-07-28 规范已废弃/不再推荐。
- **有状态会话假设**：initialize 握手、Mcp-Session-Id、粘性路由（sticky session）随 2026-07-28 无状态核心一并移除。
- **为每家厂商单独维护 function calling 适配层**：各家 API 仍有私有函数调用格式，但工具接入层应统一走 MCP，减少重复适配。
- **只提供 stdio 的服务设计**：目标用户是远程 Agent 时，一开始就应提供 Streamable HTTP 端点与 OAuth 2.1 保护。

## 待证项

- 官方 Registry 正式转出 preview 的时间点（官方 about 页仍标注 preview）。
- A2A 1.0 在开源社区与中国的实际生产案例数量。
- 2026-07-28 规范对 SSE 是"移除"还是"弃用但仍可用"——建议直接读规范原文 Transport 章节确认。

## 主要来源

- MCP 官方规范与博客：modelcontextprotocol.io/specification/2026-07-28；blog.modelcontextprotocol.io/posts/2026-07-28、/2026-07-28-release-candidate、/2025-09-08-mcp-registry-preview、/2025-12-09-mcp-joins-agentic-ai-foundation
- MCP GitHub 组织：github.com/modelcontextprotocol（typescript-sdk、python-sdk、go-sdk、inspector、registry、servers）
- 大厂公告：anthropic.com/news/donating-the-model-context-protocol…；openai.github.io/openai-agents-js/guides/mcp；blogs.microsoft.com/blog/2025/05/19/microsoft-build-2025…；thenewstack.io/google-embraces-mcp
- A2A：github.com/a2aproject/A2A/releases；linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations…；auth0.com/blog/mcp-vs-a2a；credal.ai/blog/what-happened-to-a2a-protocol