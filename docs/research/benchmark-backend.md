# 对标业界成熟开源项目：Agent 后端 / 框架 / 模型网关（2026）

> 调研时间：2026-10-12；star 与许可证为 GitHub API 实测值，以各仓库主页为准；只收录成熟、活跃项目。许可结论聚焦"能否二次开发/商用"。

## 一、编排框架

| 项目 | 定位 | star | 许可证 | 活跃度 | 适合 fork 二次开发 | 适合参考架构 |
|---|---|---|---|---|---|---|
| LangGraph | 图状态机编排，生产级工作流 | ~43k | MIT | 高 | 否（生态重，难整体重写） | 是：状态图/持久化设计 |
| LangChain | 通用编排 + 工具生态 | ~148k | MIT | 高 | 否 | 是：抽象分层与工具协议 |
| CrewAI | 角色协作多智能体 | ~60k | MIT | 高 | 部分 | 是：角色分工与任务委派 |
| AutoGen（微软） | 多智能体对话 | ~61k | MIT（代码）/ CC-BY-4.0（文档） | 维护模式 | 否 | 是：对话式协作模式 |
| Microsoft Agent Framework | AutoGen + Semantic Kernel 后继 | ~14k | MIT | 高 | 部分（.NET/TS 栈） | 是：Agent 生命周期管理 |
| Google ADK | 多智能体开发套件 | ~22k | Apache-2.0 | 高 | 否 | 是：会话记忆/工具调用设计 |
| OpenAI Agents SDK | 官方轻量 Agent 循环 | ~30k | MIT | 高 | 否（作依赖集成） | 是：极简 handoff/guardrail 模型 |
| Claude Agent SDK | Anthropic 官方 SDK | ~8k | MIT | 高 | 否 | 是：权限化工具执行模型 |
| AgentScope（阿里） | 多智能体框架 | ~33k | Apache-2.0 | 高 | 部分 | 是：国产大模型适配经验 |

## 二、模型网关

| 项目 | 定位 | star | 许可证 | 活跃度 | 适合 fork | 适合参考 |
|---|---|---|---|---|---|---|
| LiteLLM | 100+ 模型统一代理/网关 | ~61k | MIT（核心；enterprise/ 目录为商业许可） | 高 | **是**：整体 fork 做公司内部网关 | 是：路由/重试/预算/计费 |
| One-API | 国内模型统一接入 | ~37k | MIT | 中 | 是 | 是：渠道管理模型 |
| new-api | One-API 增强分支 | ~50k | **AGPL-3.0** | 高 | 自用可 fork；对外 SaaS 需开源改动 | 是：渠道/计费/审计 |

## 三、完整后端参考

| 项目 | 定位 | star | 许可证 | 活跃度 | 适合 fork | 适合参考 |
|---|---|---|---|---|---|---|
| Dify | LLM 应用平台（工作流/RAG/Agent/API） | ~158k | Dify Open Source License（基于 Apache-2.0 修改：未经书面授权不得运营多租户 SaaS） | 高 | 内部自托管可 fork | **是**：前后端分离、工作流引擎、API 设计 |
| n8n | 自动化工作流平台 | ~207k | Sustainable Use License（fair-code；.ee. 文件需企业许可） | 高 | 否（许可限制商用） | **是**：节点化流程与 UI |
| LibreChat | 多模型对话后端 | ~46k | MIT | 高 | **是**：对话产品后端底座 | 是：多供应商接入层 |
| Open WebUI | 自托管对话 UI + 后端 | ~154k | Open WebUI License（基于 BSD-3-Clause 的自定义许可，含附加条款） | 高 | 内部自部署可 fork | 是：对话会话/RAG 后端 |

## 结论：中小团队自建 Agent 后端的"拼装"方案

1. **网关**：LiteLLM（MIT 核心）或 One-API（MIT），统一接入各家模型、做配额与计费。new-api 虽更完善但是 AGPL-3.0，对外提供 SaaS 需评估开源义务。
2. **编排**：轻量场景用 OpenAI Agents SDK（MIT、官方、极简）；复杂工作流用 LangGraph（MIT）。
3. **对话/产品后端**：直接 fork LibreChat（MIT）做多模型对话底座，或参考其 API 设计自写。
4. **可视化工作流（可选）**：参考 Dify 的 API 与工作流设计；内部自托管可直接用，但运营多租户 SaaS 需商业授权。
5. **注意**：n8n 为 fair-code 许可，商用受限；AutoGen 已进入维护模式，新项目优先 Microsoft Agent Framework；Open WebUI 自用无碍，对外分发需核对品牌条款。

推荐组件以 MIT / Apache-2.0 为主，可商用、可 fork。落地时固定版本并持续关注许可证变更。

## 来源

- LangGraph: https://github.com/langchain-ai/langgraph
- LangChain: https://github.com/langchain-ai/langchain
- CrewAI: https://github.com/crewAIInc/crewAI
- AutoGen: https://github.com/microsoft/autogen
- Microsoft Agent Framework: https://github.com/microsoft/agent-framework
- Google ADK: https://github.com/google/adk-python
- OpenAI Agents SDK: https://github.com/openai/openai-agents-python
- Claude Agent SDK: https://github.com/anthropics/claude-agent-sdk-python
- AgentScope: https://github.com/agentscope-ai/agentscope
- LiteLLM（许可证原文）: https://github.com/BerriAI/litellm/blob/main/LICENSE
- One-API: https://github.com/songquanpeng/one-api
- new-api: https://github.com/QuantumNous/new-api
- Dify（许可证原文）: https://github.com/langgenius/dify/blob/main/LICENSE
- n8n（许可证原文）: https://github.com/n8n-io/n8n/blob/master/LICENSE.md
- LibreChat: https://github.com/LibreChat-AI/LibreChat
- Open WebUI（许可证说明）: https://docs.openwebui.com/license