# 对标清单：MCP 生态与桌面 Agent 客户端开源项目（2026-10）

> 调研日期：2026-10-12。star 为 2026-10 观察的近似量级（star-history.com、ossinsight、项目官网/README），精确值随时间波动；许可证以各仓库 LICENSE 为准。整体置信度：**高**（仓库状态、star、许可证均有第三方或一手来源；个别 star 为近似值）。

## 结论摘要

中小团队做"桌面 Agent 客户端 + MCP 工具生态"可直接拼装三层：**① 客户端外壳**用 electron-vite 模板 + 官方 TS SDK 自研，或直接用 Cherry Studio 做产品级原型；**② MCP 服务器**直接接 Playwright MCP（浏览器）、GitHub MCP（代码）、Filesystem MCP（文件）、crystaldba/postgres-mcp（数据库）；**③ 浏览器 Agent** 直接嵌入 Browser Use（MIT）作为库。关键坑：官方参考服务器仓库已拆分，GitHub/Postgres/Puppeteer/Slack 等已归档到 `servers-archived`，**不再维护、无安全更新**，新项目不要沿用旧教程使用。

### 可直接给自研 Agent 提供 MCP 服务器/客户端能力的项目

- **@modelcontextprotocol/typescript-sdk**（及 python-sdk/go-sdk）：自研 MCP 客户端与服务器的官方底座，客户端外壳和业务服务器都从它起，无需自造协议。
- **microsoft/playwright-mcp** 与 **github/github-mcp-server**：即装即用的现成 MCP 服务器，覆盖浏览器自动化与代码仓库操作，是自研 Agent 最优先接入的两个工具面。
- **browser-use**：不依赖 MCP 也能直接作为 Python 库嵌入 Agent，给 LLM 提供完整的浏览器控制原语，适合自研浏览器 Agent 的深度定制场景。
- **crystaldba/postgres-mcp**：把数据库读写与性能诊断直接暴露为 MCP 工具，替代已归档的官方 Postgres 参考服务器。

## 一、MCP 服务器与基础设施（可直接采用/参考）

| 项目 | 定位 | star 量级 | 许可证 | 活跃度 | 适合场景 |
|---|---|---|---|---|---|
| modelcontextprotocol/servers | 官方参考服务器集合，当前活跃 7 个：Filesystem、Git、Fetch、Memory、Sequential Thinking、Everything、Time | 万级（未取到精确值） | Apache-2.0（新贡献）/ MIT（存量） | 官方持续维护 | 参考实现范本；Filesystem/Git 可用 `npx @modelcontextprotocol/server-*` 直接运行 |
| @modelcontextprotocol/typescript-sdk | MCP 服务器/客户端官方 SDK（Node/Bun/Deno），另有 Python/Go/C# SDK | ~13.5k | Apache-2.0 / MIT（过渡中） | 随 2026-07-28 无状态规范同步更新 | **自研 MCP 能力首选**，客户端与服务器都从这里起 |
| modelcontextprotocol/registry | 官方 MCP 注册表（preview，"服务器应用商店"） | ~7.3k | 以仓库 LICENSE 为准 | preview 迭代中 | 服务器发现与发布入口 |
| punkpeye/awesome-mcp-servers | 社区 MCP 服务器精选清单，按场景分类 | ~95.8k | 以仓库 LICENSE 为准 | 每日更新 | 选型目录；找社区服务器 |
| microsoft/playwright-mcp | 微软浏览器自动化 MCP 服务器 | ~36.4k | Apache-2.0 | 高 | **直接采用**：给 Agent 提供浏览器操控 |
| github/github-mcp-server | GitHub 官方 MCP，支持本地进程与远程 OAuth 部署 | ~33.5k | MIT | 高（远程版 2025-09 GA） | **直接采用**：仓库/PR/Issue 操作 |
| crystaldba/postgres-mcp | Postgres MCP Pro：读写 + 性能分析/索引建议 | ~3.4k | 开源（以仓库 LICENSE 为准） | 高 | **直接采用**：数据库工具，替代已归档的官方 Postgres 参考服务器 |

注意：`modelcontextprotocol/servers-archived` 中的 PostgreSQL、Puppeteer、Slack 等已停止维护（社区统计其 Postgres 服务器仍每月 31 万次安装但无安全更新），选型勿用。

**选型要点**：官方 servers 仓库适合当"实现范本"读，不适合全盘照搬——它拆分成活跃 7 个与归档仓库之后，仓库本身更像目录而非产品。真正的生产级服务器应优先取各领域官方/头部实现（微软、GitHub 官方），数据库类则从 bytebase 等横向评测里挑活跃维护的社区项目。注册表与 awesome 列表都不含质量担保，接入前必须审代码与权限模型。

## 二、桌面端 Agent 客户端

| 项目 | 定位 | star 量级 | 许可证 | 活跃度 | 适合场景 |
|---|---|---|---|---|---|
| CherryHQ/cherry-studio | 桌面 AI 客户端，多模型 + MCP + Agent（Win/Mac/Linux） | ~52.5k | AGPL-3.0 | 高 | **直接使用/二次开发**；产品原型起点 |
| chatboxai/chatbox | 跨平台 AI 客户端（社区版），支持多模型 | ~41.8k | GPLv3 | 高 | 参考产品形态与交互；改代码须遵循 GPLv3 |
| lobehub/lobe-chat | LLM 聊天框架，Web + 桌面版（v1.83 起公开测试），有插件/Agent 市场 | ~82k+ | Apache-2.0（白标/改品牌需商业授权） | 极高 | 自托管 Web/桌面；参考其插件与 Agent 生态设计 |
| Claude Desktop | Anthropic 官方桌面客户端 | 闭源 | 专有 | — | 参照物；`claude_desktop_config.json` 配 MCP 是行业模板 |
| open-webui/open-webui | 自托管 AI 平台，官方 Tauri 桌面封装（open-webui/desktop） | ~150k（主仓库） | 自定义 Open WebUI License（2025-04 起非 OSI 开源，须保留品牌） | 极高 | 自托管部署；参考其 Python 扩展管道；商用/白标需评估条款 |
| electron-vite/electron-vite-react（另有 -vue） | Electron + Vite 开箱模板 | ~5k（vue 版 4.9k） | MIT | 中高 | **直接采用**：自研桌面客户端外壳 |

**选型要点**：桌面客户端三选一看许可证与扩展深度。Cherry Studio 的 MCP 配置体验最完整，适合直接给非技术用户用；LobeChat 胜在生态（插件/Agent 市场）与自托管，但白标要商业授权；Chatbox 交互轻量，适合做体验参考。三者都是 Electron/Tauri 系，源码里 MCP 客户端接入方式值得抄作业——尤其是 Cherry Studio 对 stdio 服务器的自动配置流程。

## 三、浏览器 Agent

| 项目 | 定位 | star 量级 | 许可证 | 活跃度 | 适合场景 |
|---|---|---|---|---|---|
| browser-use/browser-use | Python 浏览器 Agent 框架（LLM 控浏览器），另有 TS SDK 与云服务 | ~10.6 万 | MIT | 极高 | **直接采用**：作为自研浏览器 Agent 的底层库 |
| Skyvern-AI/skyvern | AI 浏览器自动化平台（表单填写、工作流，视觉 + LLM） | ~23.1k | AGPL-3.0（anti-bot 部分除外） | 高 | 自托管部署，或参考其工作流引擎；商用注意 AGPL |
| microsoft/playwright-mcp | 同前：浏览器 Agent 走 MCP 通道时归此 | ~36.4k | Apache-2.0 | 高 | 与桌面客户端拼装最省事的浏览器能力 |

**选型要点**：Browser Use 与 Playwright MCP 定位不冲突——前者是"浏览器 Agent 框架"（LLM 直接驱动浏览器、适合深度定制），后者是"MCP 通道的浏览器工具"（配合任何 MCP 客户端即插即用）。若自研客户端已接 MCP，优先 Playwright MCP；若要独立浏览器 Agent 产品，用 Browser Use。Skyvern 的视觉+工作流引擎适合处理表单类重复劳动，AGPL 下自托管没问题，闭源商用需谨慎。

## 四、拼装建议（中小团队）

1. **客户端**：要产品级直接上 Cherry Studio（AGPL-3.0 注意合规）；要自研用 `electron-vite-react` 模板 + `@modelcontextprotocol/typescript-sdk` 实现 MCP 客户端与服务器。
2. **MCP 服务器**：Playwright MCP（浏览器）、GitHub MCP（代码）、Filesystem MCP（文件，注意已归档但可用）、crystaldba/postgres-mcp（数据库），四个即覆盖核心工具面。
3. **浏览器 Agent**：Browser Use（MIT）可直接 pip 嵌入自研 Agent；Skyvern 作自托管平台或架构参考。
4. **发现层**：awesome-mcp-servers 做选型目录，官方 registry 做服务器发布。
5. **许可证红线**：Cherry Studio（AGPL）、Chatbox（GPLv3）、Skyvern（AGPL）、Open WebUI（自定义品牌条款）都不适合闭源商用改版；MIT/Apache-2.0 的 Browser Use、Playwright MCP、electron-vite 模板、官方 SDK 可放心拼装。

**最小可行拼装**：`electron-vite-react` 模板起壳 → `@modelcontextprotocol/typescript-sdk` 做客户端 → 配置 Playwright MCP + GitHub MCP + Filesystem MCP 三个服务器 → 自研 Agent 即可在桌面端操作浏览器、代码与文件；数据库按需加 `crystaldba/postgres-mcp`。这套组合全部 MIT/Apache-2.0，无许可证包袱，一周内可出可演示的 MVP。若想跳过客户端开发，直接用 Cherry Studio 承担同一角色，把精力全部投到自研 MCP 服务器上。

## 主要来源

- modelcontextprotocol/servers：github.com/modelcontextprotocol/servers；servers-archived：github.com/modelcontextprotocol/servers-archived；modelcontextprotocol.io/examples
- TS SDK：github.com/modelcontextprotocol/typescript-sdk（star 见 star-history.com/modelcontextprotocol/typescript-sdk）
- registry：github.com/modelcontextprotocol/registry；registry.modelcontextprotocol.io
- awesome-mcp-servers：github.com/punkpeye/awesome-mcp-servers（star 见 star-history.com/punkpeye/awesome-mcp-servers）
- Playwright MCP：github.com/microsoft/playwright-mcp（Apache-2.0，star 见 star-history.com/microsoft/playwright-mcp）
- GitHub MCP：github.com/github/github-mcp-server（MIT）；github.blog/changelog/2025-09-04-remote-github-mcp-server-is-now-generally-available
- Postgres：github.com/crystaldba/postgres-mcp；bytebase.com/blog/top-open-source-postgres-mcp-servers；dev.to/spencerpauly/why-is-anthropics-archived-postgres-mcp-server-still-getting-312k-installs-a-month-3oeh
- Cherry Studio：github.com/CherryHQ/cherry-studio（AGPL-3.0）；ossinsight.io/compare/CherryHQ/cherry-studio/chatboxai/chatbox
- Chatbox：github.com/chatboxai/chatbox（GPLv3）
- LobeChat：github.com/lobehub/lobehub（Apache-2.0，白标见 discussion #8476；桌面 beta 见 issue #7594）
- Claude Desktop：anthropic.com/engineering/desktop-extensions；code.claude.com/docs/en/desktop
- Open WebUI：github.com/open-webui/open-webui；docs.openwebui.com/license；github.com/open-webui/desktop
- electron-vite：github.com/electron-vite/electron-vite-react、github.com/electron-vite/electron-vite-vue
- Browser Use：github.com/browser-use/browser-use（MIT）；browser-use.com
- Skyvern：github.com/Skyvern-AI/skyvern（AGPL-3.0）；skyvern.com