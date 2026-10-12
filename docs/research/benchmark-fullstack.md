# 全栈 Agent 产品 / 低代码平台 / 聊天前端开源项目对标（2026-10）

> 调研日期：2026-10-12。star 数、许可证、最后推送时间为 GitHub API 实时抓取（可在各仓库页复核）；许可证条款摘自各仓库 LICENSE 原文。整体置信度：**高**（核心数据均为一手来源）。

## 一、总览表

| 项目 | 定位 | Star 量级 | 许可证 | 活跃度（最后推送） | 适合直接 fork | 不适合的场景 |
|---|---|---|---|---|---|---|
| Dify | 全栈 LLM App/Agent 平台（工作流+RAG+Agent） | ~15.8 万 | Dify 开源许可（Apache-2.0 修改版） | 活跃（当日） | 企业内网自建、单租户交付 | 多租户 SaaS、去 LOGO 商用 |
| Open WebUI | 自托管 AI 聊天前端 | ~15.4 万 | Open WebUI License（BSD-3 修改版） | 活跃（当日） | 内网自用、个人部署 | 改品牌对外做产品 |
| RAGFlow | 深度文档理解 RAG 引擎 | ~9.2 万 | Apache-2.0 | 活跃（当日） | 企业知识库产品、自由改品牌 | 纯聊天前端（需自建 UI） |
| n8n | 工作流自动化平台（原生 AI Agent） | ~20.7 万 | Sustainable Use License（fair-code） | 活跃（当日） | 内部自动化、自用流程平台 | 对外售卖/改品牌 SaaS |
| NextChat | 轻量全平台聊天前端 | ~8.9 万 | MIT | 活跃（2026-10-08） | 类 ChatGPT 套壳、快速上线 | 多用户/后台管理需求 |
| LobeChat | 现代 UI 聊天/Agent 前端 | ~8.3 万 | LobeHub Community License | 活跃（当日） | UI 参考、直接部署商用 | 改品牌分发衍生作品 |
| Cherry Studio | 桌面多模型客户端 | ~5.3 万 | AGPL-3.0 | 活跃（当日） | 桌面端二次开发（须开源） | 闭源商用桌面产品 |
| LibreChat | 自托管统一 AI 聊天平台（多模型+Agent+MCP） | ~4.6 万 | MIT | 活跃（当日） | 类 ChatGPT 产品 fork 首选 | 无（几乎无限制） |
| Chatbox | 桌面/移动 AI 客户端 | ~4.2 万 | GPL-3.0（社区版） | 活跃（2026-09-24） | 学习参考 | 闭源分发（GPL 传染） |
| chatbot-ui | 经典 AI 聊天模板 | ~3.3 万 | MIT | **已停更**（2024-06-22） | 不建议 | 新项目直接依赖 |
| FastGPT | 知识库问答+可视化 Agent 工作流 | ~3.0 万 | FastGPT 开源许可（Apache-2.0 修改版） | 活跃（当日） | 中文知识库助手、单租户交付 | 多租户 SaaS、去 LOGO |
| Vercel AI Chatbot | Next.js 聊天应用模板（AI SDK） | ~2.1 万 | Apache-2.0 | 低活跃（2026-07-08） | 自研产品代码起点 | 直接当成品用（功能太少） |

## 二、重点：哪些能直接 clone 改品牌/改 UI 做二次开发

**许可证允许、推荐直接 fork 的：**
- **LibreChat**（MIT，~4.6 万 star）：自托管、多用户、多模型，带 Agent/MCP/Artifacts 的完整 ChatGPT 克隆，MIT 允许改品牌、商用、闭源分发。做"类 ChatGPT 产品"最合适。[https://github.com/LibreChat-AI/LibreChat](https://github.com/LibreChat-AI/LibreChat)
- **NextChat**（MIT，~8.9 万 star）：零配置轻量纯前端，可一键部署 Vercel，MIT 自由改品牌，适合快速做聊天站点/轻量套壳；弱点是多用户与后台管理能力不足。[https://github.com/ChatGPTNextWeb/NextChat](https://github.com/ChatGPTNextWeb/NextChat)
- **Vercel AI Chatbot**（Apache-2.0，~2.1 万 star）：Next.js + AI SDK 官方模板，代码干净、可 hack，适合作为自研产品起点；但它是"模板"而非"成品"，无后台、单用户。[https://github.com/vercel/chatbot](https://github.com/vercel/chatbot)
- **RAGFlow**（Apache-2.0，~9.2 万 star）：企业知识库 RAG 引擎，文档解析（DeepDoc）是强项，Apache-2.0 可自由改品牌商用；聊天 UI 需自建或搭配前端。[https://github.com/infiniflow/ragflow](https://github.com/infiniflow/ragflow)

**许可证有限制、改品牌/商用前必须读 LICENSE：**
- **Open WebUI**（~15.4 万 star）：自托管 AI 前端标杆。当前为自定义 **Open WebUI License**，明确禁止移除/替换 "Open WebUI" 品牌，除非终端用户 ≤50 人、获书面许可或购买企业版。即"内网自用随便，对外改品牌做产品不行"。[LICENSE 原文](https://github.com/open-webui/open-webui/blob/main/LICENSE)
- **LobeChat**（~8.3 万 star）：UI 设计出色，插件/Agent 市场完善。**LobeHub Community License** 允许直接商用部署，但"基于它开发并分发衍生作品"需商业许可——改品牌后对外分发要联系 LobeHub。做 UI 参考可以，fork 改品牌需谨慎。[https://github.com/lobehub/lobe-chat](https://github.com/lobehub/lobe-chat)
- **Dify**（~15.8 万 star）：全栈 LLM App 平台，业界最成熟。许可证要求**不能移除前端 LOGO/版权**；未经书面授权**不能做多租户 SaaS**。企业内网、单租户交付没问题，商用多租户 SaaS 需商业许可。[LICENSE 原文](https://github.com/langgenius/dify/blob/main/LICENSE)
- **FastGPT**（~3.0 万 star）：中文知识库问答+可视化工作流，中文生态好。同样要求保留 LOGO、多租户 SaaS 需商业许可。[LICENSE 原文](https://github.com/labring/FastGPT/blob/main/LICENSE)
- **n8n**（~20.7 万 star）：工作流自动化+AI Agent。**Sustainable Use License**（fair-code）只允许内部自用/非商业用途，禁止对外商业分发（不能改品牌卖 SaaS）；企业自用可以，做成产品卖不行。[LICENSE 原文](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)
- **Cherry Studio**（AGPL-3.0，~5.3 万 star）：桌面多模型客户端，体验好；AGPL 传染，若改代码做网络服务对外提供须开源修改部分。[https://github.com/CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)
- **Chatbox**（GPL-3.0，~4.2 万 star）：桌面/移动客户端，社区版 GPL-3.0 传染，且官网主打商业版（付费 License）。[https://github.com/chatboxai/chatbox](https://github.com/chatboxai/chatbox)

## 三、场景结论（中小团队）

1. **做"类 ChatGPT 产品"**：首选 **LibreChat**（MIT，直接 fork 改品牌，功能最全：多模型切换、多用户、Agent、MCP、文件上传）；要轻量快上线选 **NextChat**（纯前端，改标题/Logo/模型配置即可发布）；要自研 Next.js 技术栈、后续深度定制选 **Vercel AI Chatbot** 做起点；UI 参考 **LobeChat**（注意衍生作品需商业许可）。
2. **做"企业知识库助手"**：文档解析要求高、要商用选 **RAGFlow**（Apache-2.0，DeepDoc 对 PDF/表格/扫描件处理能力强）；中文场景、要开箱即用工作流选 **FastGPT**（保留 LOGO、单租户交付即可）；要全套平台（知识库+工作流+Agent+监控）选 **Dify**（自部署单租户或企业版）；企业内网自用（不对外改品牌）**Open WebUI** 是最佳免费选择，连接 Ollama/OpenAI 兼容接口即用。
3. **做"低代码 Agent 平台"**：**Dify** 是首选参考（可视化编排+RAG+Agent+可观测性最完整，注意多租户条款）；**n8n** 适合内部自动化流程和 AI Agent 工作流，但 fair-code 限制对外销售；**FastGPT** 可作为中文工作流参考，上手门槛最低。

## 五、快速决策表

| 你的需求 | 直接 fork 哪个 | 许可证风险 |
|---|---|---|
| 类 ChatGPT 多用户产品 | LibreChat | 无（MIT） |
| 轻量聊天套壳 | NextChat | 无（MIT） |
| Next.js 自研聊天应用 | Vercel AI Chatbot | 无（Apache-2.0） |
| 企业知识库商用 | RAGFlow | 无（Apache-2.0） |
| 中文知识库助手 | FastGPT | 保留 LOGO、单租户 |
| 全套 Agent 平台 | Dify | 去 LOGO/多租户需商业许可 |
| 内网免费自用前端 | Open WebUI | 不对外改品牌即可 |

## 四、需要警惕

- **chatbot-ui 已停更**：最后提交 2024-06-22，不要在新项目里 fork 依赖它。
- **Open WebUI 许可证已收紧**（不可去品牌），网上"BSD-3 随便改"的旧文章已过时，以仓库 LICENSE 为准。
- **许可证决定商业模式**：MIT/Apache-2.0（LibreChat、NextChat、Vercel AI Chatbot、RAGFlow）可自由改品牌商用；GPL/AGPL（Cherry Studio、Chatbox）有传染性；Dify/FastGPT/LobeChat/Open WebUI 的自定义许可证和 n8n 的 fair-code 各有额外限制，动手前必须读 LICENSE。

## 数据来源

- GitHub 仓库页与 GitHub API（2026-10-12 抓取 star/许可证/最后推送时间）：上文各仓库 URL 均可复核。
- 许可证原文：各仓库 `LICENSE` / `LICENSE.md` 文件（Dify、Open WebUI、LobeChat、FastGPT、n8n、Vercel AI Chatbot、Cherry Studio、Chatbox 已逐一抓取核对）。