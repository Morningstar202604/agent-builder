# 18 — 框架集成与对比（2026 现状）· LangGraph 1.0 · OpenAI Agents SDK · Claude Agent SDK · ADK 2.0 · MAF · CrewAI Flows · Bedrock AgentCore

> 目标：2026 年主流 Agent 框架各有长短。不要"为了用框架而用框架"，而是根据场景选择最合适的。本文件是**选型文档**，不是实现文档——框架的成熟用法直接用官方 API，不写桥接层。多 Agent 编排的实现见 [05-multi-agent.md](./05-multi-agent.md)。

> **⚠️ 本层铁律：框架是工具，不是要改造的对象。**
> - 选 LangGraph → 直接用官方 `createReactAgent` / `StateGraph`，不把自家 Agent 包装成节点
> - 选 OpenAI Agents SDK / Claude Agent SDK / ADK / MAF → 直接用官方 Python/TS API，不写跨语言桥接
> - **淘汰标注**：OpenAI Swarm（弃用）、AutoGen 旧 `autogen` 包（维护模式）、MetaGPT / ChatDev / CAMEL（学术）——本文件只给淘汰说明，不给推荐示例
>
> 本文件**无手写实现**，只保留对比矩阵、官方用法示例与选型约束。所有示例中的 LLM 类型遵循 [00-types.md](./00-types.md) 契约：LangGraph 图内用 LangChain 模型包装器，图外用 `createModel`（`LanguageModel`）。

---

## 目录

- [1. 框架全景对比 Matrix（2026）](#1-框架全景对比-matrix2026)
- [2. 选型决策树](#2-选型决策树)
- [3. LangGraph 1.0](#3-langgraph-10)
- [4. OpenAI Agents SDK](#4-openai-agents-sdk)
- [5. Claude Agent SDK](#5-claude-agent-sdk)
- [6. Google ADK 2.0](#6-google-adk-20)
- [7. Microsoft Agent Framework](#7-microsoft-agent-framework)
- [8. CrewAI Flows](#8-crewai-flows)
- [9. AWS Bedrock AgentCore](#9-aws-bedrock-agentcore)
- [10. 淘汰与不推荐](#10-淘汰与不推荐)
- [11. 实战混用策略](#11-实战混用策略)
- [12. 切换成本评估矩阵](#12-切换成本评估矩阵)
- [13. 避坑汇总](#13-避坑汇总)
- [14. 本层验收清单](#14-本层验收清单)

---

## 1. 框架全景对比 Matrix（2026）

### 1.1 七框架 × 六维度评测

| 维度 | LangGraph 1.0 | OpenAI Agents SDK | Claude Agent SDK | Google ADK 2.0 | Microsoft Agent Framework | CrewAI Flows | AWS Bedrock AgentCore |
|------|---------------|-------------------|------------------|----------------|---------------------------|--------------|------------------------|
| **语言** | TS / Python / Go | Python / TS | TS / Python | Python / Java / Go | Python / .NET / Go | Python | 托管（任意语言 SDK） |
| **架构哲学** | 有向状态图（节点+边） | Agent + handoff 路由 | Agent + subagents 层级 | AgentGraph 状态机 | 图/工作流 + 角色协作 | 事件驱动 Flow | supervisor 多 agent |
| **状态持久化** | checkpointer 一等公民 | 会话状态托管 | 会话状态 | 内置会话持久化 | 状态存储抽象 | 外部存储 | 托管会话/记忆 |
| **调试体验** | LangSmith trace | 内置 tracing + Langfuse | Anthropic 控制台 trace | 本地 console + 托管 trace | Foundry 可观测性 | 日志 + AMP | CloudWatch + Bedrock 追踪 |
| **托管形态** | LangSmith Deployment | OpenAI 平台 / 自托管 | Anthropic 平台 | Agentspace / Vertex | Foundry Agent Service | CrewAI AMP | Bedrock AgentCore |
| **适合场景** | 复杂工作流、长时任务、审计 | 客服分流、handoff 路由 | 深度绑定 Claude | Google Cloud 栈、A2A 互操作 | 微软栈 / .NET 团队 | 业务侧快速上线 | AWS 栈、托管运行时 |

### 1.2 淘汰与降级标注（2026）

| 框架 | 状态 | 替代 |
|------|------|------|
| OpenAI Swarm | ❌ 官方弃用（仅教学） | OpenAI Agents SDK（handoffs） |
| AutoGen 旧 `autogen` 包 | ⚠️ maintenance mode | Microsoft Agent Framework |
| MetaGPT / ChatDev / CAMEL / AgentVerse | ⚠️ 学术项目，非生产 | 不要写入生产依赖 |
| Magentic-One | ⚠️ 研究原型 | MAF + Foundry Agent Service |
| LangChain 0.x AgentExecutor | ❌ 已废弃 | LangGraph / Agent SDK |
| AutoGPT Classic | ❌ unsupported、有安全问题 | 不用 |

### 1.3 核心抽象映射

| 本项目（01） | LangGraph | OpenAI Agents SDK | CrewAI Flows | Claude Agent SDK |
|--------|-----------|-------------------|--------------|------------------|
| `streamText` Agent | `createReactAgent` / Graph Node | `Agent` | Flow 节点 | `Agent` |
| `tool()` | LangChain Tool（`convertToLangChainTools`） | `tool()` / MCP | CrewAI Tool | `tool` |
| SessionStore / Memory | Checkpoint / Store | 会话状态 | `Flow.state` | 会话状态 |
| AgentEvent | Stream Event | RunResult / stream | Flow 事件 | 流式消息 |

---

## 2. 选型决策树

```
你的需求是什么？
├── 需要持久化/断点恢复/复杂状态机 → LangGraph 1.0（+LangSmith Deployment）
├── 需要 handoff 式客服分流，OpenAI 模型为主 → OpenAI Agents SDK
├── 深度绑定 Claude（Uber 工程团队 84% 采用率） → Claude Agent SDK
├── 已在 Google Cloud，需要 A2A 互操作 → Google ADK 2.0
├── 微软栈 / .NET 团队 → Microsoft Agent Framework
├── 业务侧快速上线、事件驱动 → CrewAI Flows
├── AWS 托管运行时，不想维护状态存储 → Bedrock AgentCore
└── 以上都包含，且需要统一架构 → 本项目 streamText + tools 为主，框架按需引入
```

🔗 **工程逻辑**：决策树的第一问永远是"控制流复杂度"。LangGraph 在"显式状态 + 检查点 + 断点续跑"上不可替代；如果只是"一个入口 agent 把请求转给专业 agent"，OpenAI Agents SDK 的 handoffs 更轻。TECH_LANDSCAPE 的大厂共识是：**先单 agent + 工具，确认需要再升级多 agent**。

---

## 3. LangGraph 1.0

**成熟用法**：直接使用官方 `createReactAgent` 构建 ReAct Agent，或 `StateGraph` + `Annotation` 自定义编排。不要把自家 Agent 逻辑"包装成图节点"——框架的价值是 checkpoint 与循环控制，推理仍由模型完成。

### 3.1 createReactAgent 官方示例

```typescript
// packages/core/src/orchestrator/react-agent.ts —— 官方 LangGraph 用法
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

const getWeather = new DynamicStructuredTool({
  name: 'get_weather',
  description: '查询指定城市的天气',
  schema: z.object({ city: z.string() }),
  func: async ({ city }) => JSON.stringify({ city, temp: 24 }),
});

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: 'gpt-4o' }),
  tools: [getWeather],
  checkpointer: new MemorySaver(),
});
```

### 3.2 LangGraph 1.0 的关键变化

- **1.0 稳定**：API 从 0.x 的快速变动收敛，`StateGraph` / `Annotation` / `createReactAgent` / `compile` 成为长期稳定接口。
- **LangSmith Deployment 接管托管**：LangGraph Platform 品牌并入 LangSmith Deployment，图通过 `langgraph.json` 声明，平台提供 REST API、流式事件与托管 Postgres。
- **生态插件**：`langgraph-checkpoint-postgres`、`langgraph-checkpoint-redis`、`langgraph-supervisor`（官方多 agent 辅助库）随 1.0 一起维护。

### 3.3 工程逻辑

🔗 LangGraph 的核心价值是 **checkpoint**——每个节点执行后持久化状态，断线恢复时从断点续跑，这正是 [21-fault-recovery.md](./21-fault-recovery.md) 需要的。用官方 API 获得这个能力，不要自己实现状态机。完整接入见 [05-multi-agent.md](./05-multi-agent.md)。

🤖 **AI 常见错误**：把整个自研 Agent 重写成 LangChain 的 `AgentExecutor`。正确的做法是保持 01 的 `streamText` 作为单 Agent 推理主体，只在"确实需要图编排 + 持久化"的多步骤工作流里引入 `createReactAgent`。

---


## 4. OpenAI Agents SDK

**定位**：`openai-agents`（Python）/ `@openai/agents`（TS）是 Swarm 的官方继任者。把 handoff 生产化：会话状态、guardrails、tracing、MCP 工具、流式输出全内置。

### 4.1 为什么不用 Swarm

Swarm 是教育性代码，从未承诺生产支持，官方已弃用。Agents SDK 保留 handoff 心智模型，同时补上：

- 可恢复的会话状态
- 输入/输出 guardrails（tripwire 中断）
- 结构化 tracing
- 与 Responses API 深度绑定

### 4.2 与 05 的分工

🔗 handoff 完整示例（agent 定义、显式 Handoff、guardrails、tracing）在 [05-multi-agent.md](./05-multi-agent.md)。本文件只做选型对比，不重复示例。关键判断：

| 场景 | 选 handoff | 选 LangGraph 条件边 |
|------|-----------|-------------------|
| 客服意图分流，路由由 LLM 决定 | ✅ | 可做但重 |
| 路由必须确定性可审计 | ❌ | ✅ |
| 需要断点续跑 | ❌ | ✅ |
| 已有 LangGraph 主链路 | ❌ | ✅ |

### 4.3 官方最小示例（流式）

```python
# examples/framework/openai-agents-sdk/stream.py —— 官方用法（Python）
from agents import Agent, Runner

agent = Agent(
    name="Assistant",
    instructions="你是简洁的中文助手。",
    model="gpt-4o",
)

result = Runner.run_streamed(agent, "用一句话解释 A2A 协议")
async for event in result.stream_events():
    if event.type == "raw_response_event" and event.data.type == "response.output_text.delta":
        print(event.data.delta, end="")
```

### 4.4 tracing 配置

Agents SDK 默认开启本地 trace；生产环境可关闭本地追踪并接入 Langfuse：

```python
# examples/framework/openai-agents-sdk/tracing.py —— 官方用法（Python）
from agents import set_tracing_disabled
from agents.tracing import set_tracing_export

set_tracing_disabled(False)  # 保留追踪
set_tracing_export(None)       # 接外部导出器（如 Langfuse）
```

### 4.5 工程逻辑

- 适合"入口 agent + 专业 agent"，依赖单一模型族时优先
- 多模型混合时，guardrails 与 handoff 仍可用，但跨厂商互操作会引入复杂度，此时看 A2A（05 专章）
- 若项目已经深度使用 LangChain，不要两套并行——选一条主链路

🤖 **AI 常见错误**：把 Agent 的 instructions 当 prompt 工程无限堆长文。Agents SDK 的职责是路由与状态，不是 prompt 模板系统；guardrails 也不该承载全部安全逻辑，业务校验仍在代码层做。

---

## 5. Claude Agent SDK

**定位**：Anthropic 官方 Agent SDK（`claude-agent-sdk`），围绕 Claude 模型 + MCP + subagents 构建。2026 年它已是大模型绑定最深的官方 Agent SDK。

### 5.1 核心特性

- `Agent` + `subagents`：显式子代理层级，subagent 有自己的工具与系统提示
- 原生 MCP 客户端：配置即插即用，无需写工具胶水
- 会话状态管理：会话持久化、恢复
- 流式事件：`message` / `tool_use` / `subagent` 事件

### 5.2 官方示例（Python）

```python
# examples/framework/claude-agent-sdk/basic.py —— 官方用法（Python）
from claude_agent_sdk import Agent

agent = Agent(
    name="research-agent",
    system="你是研究助理，负责检索并汇总资料。",
    tools=["mcp__filesystem", "mcp__web_search"],
    mcp_servers={
        "filesystem": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        },
        "web_search": {
            "type": "http",
            "url": "https://mcp.example.com/web-search",
        },
    },
)

for event in agent("调研 A2A 协议在企业落地中的三种典型形态"):
    if event.type == "text":
        print(event.text, end="")
```

### 5.3 subagents 的调用语义

- subagents 是**顺序调用**：父 agent 发起、等待、汇总结果
- 每个 subagent 可以有独立 model、tools、system prompt
- 事件流中出现 `subagent` 类型事件表示子代理被调用

### 5.4 工程逻辑

🔗 与 05 的 LangGraph 示例不同，Claude Agent SDK 没有显式图结构——subagent 的调用由模型自主决定。需要完全可控的编排时选 LangGraph；需要"模型深度自主 + 官方会话恢复"时选 Claude Agent SDK。若跨模型部署，Claude 生态的 lock-in 是最大成本。

🤖 **AI 常见错误**：以为 subagents 能并行。Claude Agent SDK 的 subagents 是顺序调用，不是并行 worker 池——并行集群需求回到 05 的 orchestrator-worker。

---

## 6. Google ADK 2.0

**定位**：Google Agent Development Kit（ADK）2.0 是 Google 的多 Agent 框架，内置 AgentGraph 状态机、会话持久化与 A2A 服务端支持，深度集成 Vertex AI / Agentspace。

### 6.1 核心特性

- **AgentGraph**：显式状态机（与 LangGraph 思路相同），支持并发、分支、循环
- **会话持久化**：内置会话存储，断点恢复
- **A2A 优先**：ADK 2.0 可直接将 Agent 发布为 A2A 服务器，与第三方 agent 互操作
- **多语言**：Python / Java / Go

### 6.2 官方示例（Python）

```python
# examples/framework/adk2/router.py —— 官方用法（Python）
from google.adk import Agent, Runner
from google.adk.tools import FunctionTool

def get_order_status(order_id: str) -> str:
    return f"订单 {order_id} 已发货"

router = Agent(
    name="router",
    model="gemini-2.5-pro",
    instruction="你是客服路由，根据订单号查询物流状态。",
    tools=[FunctionTool(func=get_order_status)],
)

session = Runner.create_session()
result = Runner.run(router, session, "查一下订单 20261012 的状态")
print(result.contents[-1].text)
```

### 6.3 发布为 A2A 服务器

ADK 2.0 支持把 Agent 直接包装成 A2A 服务端：

```python
# examples/framework/adk2/a2a_server.py —— 官方用法（Python）
from google.adk.serving import serve
from google.adk import Agent

agent = Agent(name="order-agent", instruction="查询订单", model="gemini-2.5-pro")
serve(agent, port=8000)  # 暴露 A2A Agent Card
```

### 6.4 工程逻辑

已在 Google Cloud / Vertex AI 部署时，ADK 2.0 的 A2A 服务端与 Agentspace 托管最顺；否则引入它等于引入一整条 Google 生态链。A2A 客户端通用封装见 05。

---

## 7. Microsoft Agent Framework

**定位**：微软在 2025 年把 AutoGen 与 Semantic Kernel 合并为 **Microsoft Agent Framework（MAF）**，为 Python / .NET / Go 提供统一的多 Agent 开发模型，配套 Foundry Agent Service 托管。

### 7.1 核心特性

- **工作流图 + 角色协作**：同时支持确定性图（workflow）与自主群聊（group chat）
- **状态存储抽象**：内存 / SQLite / Redis / Azure Cosmos DB 可插拔
- **跨运行时**：Python 与 .NET 的 agent 可以互相协作
- **企业集成**：Azure OpenAI、MCP、Semantic Kernel 插件复用

### 7.2 官方示例（Python）

```python
# examples/framework/maf/team.py —— 官方用法（Python）
from microsoft.agents import Agent
from microsoft.agents.workflow import WorkflowApp
from microsoft.agents.workflow.terminations import MaxMessageTermination

agent = Agent(
    name="writer",
    instructions="你负责撰写营销文案。",
    model="gpt-4o",
)

workflow = WorkflowApp(
    agents=[agent],
    termination=MaxMessageTermination(max_messages=5),
)

async for event in workflow.run("为新品写一句广告语"):
    print(event)
```

### 7.3 状态存储接入

MAF 的状态存储通过协议注入，不写死在框架内：

```python
# examples/framework/maf/state.py —— 官方用法（Python）
from microsoft.agents.storage import SqliteStorage
from microsoft.agents import Agent
from microsoft.agents.workflow import WorkflowApp

storage = SqliteStorage(":memory:")
app = WorkflowApp(agents=[Agent(name="a", model="gpt-4o")], storage=storage)
```

### 7.4 工程逻辑

🔗 MAF 与 LangGraph 的差异在**协作模型**：LangGraph 以图结构表达流程，MAF 额外提供 group chat 的自主协作。需要严格审计的流程用 LangGraph；需要"一队 agent 互相讨论后产出"的自主场景考虑 MAF——但注意自治群聊的可复现性远低于显式图。

---

## 8. CrewAI Flows

**定位**：CrewAI 的 **Flows** 是事件驱动的编排层：任务、流程、状态在一个 Flow 对象里，用装饰器声明入口与事件触发。2026 年 CrewAI 已从"crew 角色扮演"演进为带可观测性与部署（AMP）的轻量编排。

### 8.1 核心特性

- `@start` 入口、`@listen` 事件监听：一个 Flow 方法结束后可触发下游
- `Flow.state`：跨任务共享状态
- `kickoff()` / `kickoff_async()` 启动
- CrewAI AMP：托管部署、Crew 可观测

### 8.2 官方示例（Python）

```python
# examples/framework/crewai/flows_news.py —— 官方用法（Python）
from crewai.flow.flow import Flow, listen, start
from pydantic import BaseModel

class NewsState(BaseModel):
    topic: str = "AI"
    draft: str = ""

class NewsFlow(Flow[NewsState]):
    @start()
    def fetch_news(self) -> None:
        print(f"抓取 {self.state.topic} 新闻")

    @listen(fetch_news)
    def write_draft(self) -> str:
        self.state.draft = "AI Agent 规模化编排正在成为主流。"
        return self.state.draft

flow = NewsFlow()
result = flow.kickoff()
print(result.draft)
```

### 8.3 事件驱动语义

- `@listen` 可以监听另一个 Flow 方法，也可以监听指定事件类型
- 一个方法可以被多个事件触发，一个事件可以触发多个下游
- 状态在 `self.state` 中共享，但默认不跨进程持久化

### 8.4 工程逻辑

CrewAI Flows 的事件模型天然适合"事件触发 → 多步骤 → 状态共享"的业务流，但其状态保存在 Flow 对象内，默认不跨进程持久化。需要断点续跑时仍要 LangGraph + checkpointer。🔗 事件驱动编排的更多设计见 05。

---

## 9. AWS Bedrock AgentCore

**定位**：AWS 在 2026 年推出 **AgentCore**，把 Bedrock Agents 的运行时收拢为统一多 Agent 编排服务：多个 agent 实例、内存/会话、故障转移、CloudWatch 可观测性全托管。

### 9.1 核心特性

- **多 Agent 编排**：supervisor 模式，多个 AgentCore 实例按名称路由
- **AgentCore 内存**：托管记忆，自动总结会话
- **AWS 原生集成**：IAM、CloudWatch、S3、DynamoDB
- 跨模型：Bedrock 模型目录中的任意模型

### 9.2 调用形态

```bash
# 通过 AWS CLI 创建 AgentCore 代理
aws bedrock-agentcore create-agent --name "research-orchestrator" --foundation-model "anthropic.claude-3-5-sonnet-20241022-v2"
```

```json
{
  "agentId": "arc-1a2b3c4d",
  "name": "research-orchestrator",
  "agents": ["writer-agent", "reviewer-agent"],
  "routingMode": "supervisor"
}
```

### 9.3 故障转移与内存

AgentCore 提供托管的内存服务与自动故障转移：一个 agent 实例不可用时，请求自动路由到同名称下的健康实例，会话内存由服务端管理，应用侧不需要自建 Redis。

### 9.4 工程逻辑

已在 AWS 且不想维护状态存储时，AgentCore 的托管记忆与故障转移最省心。但它绑定 Bedrock 模型目录与 AWS 生态；多厂商部署时回到 A2A 协议（05）。

---

## 10. 淘汰与不推荐

| 框架 | 状态 | 为什么 | 替代 |
|------|------|--------|------|
| **OpenAI Swarm** | ❌ 弃用 | 官方明确仅教育用途 | OpenAI Agents SDK |
| **AutoGen 旧 `autogen` 包** | ⚠️ 维护模式 | 功能并入 MAF，不再活跃开发 | Microsoft Agent Framework |
| **MetaGPT** | ⚠️ 学术 | 论文驱动，非生产框架 | LangGraph / CrewAI |
| **ChatDev** | ⚠️ 学术 | 教学/研究 | LangGraph |
| **CAMEL** | ⚠️ 学术 | 研究为主 | MAF / ADK |
| **Magentic-One** | ⚠️ 研究原型 | 微软研究项目，未承诺生产 SLA | MAF |
| **AutoGPT Classic** | ❌ 不维护 | 有已知安全问题 | 不选 |

**铁律**：**不把学术项目写进 package.json / requirements.txt 的生产依赖**。学习价值 ≠ 生产可用。

🤖 **AI 常见错误**：为了"多 Agent"叙事引入 AutoGen 或 CAMEL。多 Agent 的价值在于**可控编排**（路由、状态、恢复），不是"多个 Agent 一起跑"。需要叙事时，用主流框架 + 本项目 streamText。

---

## 11. 实战混用策略

### 11.1 三层混用原则

1. **单 Agent 层**：本项目 `streamText` + tools 覆盖大部分对话/工具调用
2. **流程层**：需要状态机/断点续跑时，LangGraph（或 MAF）承载长任务工作流
3. **跨厂商层**：A2A 协议连接异构 agent（05 专章）

### 11.2 两种可落地的混用架构

**架构 A：LangGraph 主编排 + 外部 agent 作为工具**

```
入口 → LangGraph 图（orchestrator）
         ├── 节点：本项目 streamText（内部能力）
         ├── 节点：MCP tool → 第三方服务
         └── 节点：A2A client → 远程 agent（05）
```

LangGraph 负责"何时调用、失败重试、状态恢复"，远程 agent 作为普通工具暴露。

**架构 B：OpenAI Agents SDK 路由 + LangGraph 处理长流程**

```
入口 agent（Agents SDK）──handoff──> 专业 agent（客服类）
     └── tool 调用 → LangGraph 长任务服务（生成报告、审计）
```

短会话用 handoff 路由，长任务甩给 LangGraph 服务，两者通过 REST 或消息队列衔接。

### 11.3 混用决策表

| 触发条件 | 主编排 | 备注 |
|----------|--------|------|
| 5 步以内、单模型 | streamText 直接做 | 不加框架 |
| 需要状态恢复的长任务 | LangGraph | 加 checkpointer |
| 客服类意图分流 | Agents SDK | handoff |
| 已用 Azure / .NET | MAF | 跟随技术栈 |
| 已在 AWS 托管 | Bedrock AgentCore | 省运维 |
| 跨厂商 agent 协作 | A2A 协议 | 见 05 |

### 11.4 工程逻辑

🔗 无论哪种架构，**本项目 01 的 streamText 与工具体系保持不变**，框架只在边界处引入。这避免了"框架锁死"——未来替换某一层时，内部 Agent 不受影响。详见 [05-multi-agent.md](./05-multi-agent.md)。

---

## 12. 切换成本评估矩阵

| 现状 | 目标 | 主要成本 | 建议 |
|------|------|----------|------|
| LangChain AgentExecutor | LangGraph 1.0 | 图概念迁移、checkpointer 接入 | 低-中；官方迁移指南完善 |
| OpenAI Swarm | OpenAI Agents SDK | Agent API 兼容、guardrails 补写 | 低；handoff 概念一致 |
| AutoGen 旧包 | MAF | 角色协作模型差异、workflow 重写 | 高；需业务重测 |
| 自研编排（无框架） | LangGraph | 状态机改写、测试用例重写 | 中-高；按流程边界分批 |
| CAMEL 研究原型 | 主流程不变 + A2A | 移除依赖、接入跨厂商层 | 中；先冻结功能再迁移 |

### 12.1 切换决策清单

- [ ] 新框架是否满足"状态持久化/断点恢复"这一条硬需求
- [ ] 团队是否已具备该框架的维护能力
- [ ] 现有 LLM 调用是否被该框架锁定（模型切换成本）
- [ ] 是否有官方迁移指南 / 支持合同
- [ ] 是否影响 01 的 streamText 契约（若影响则拒绝）

### 12.2 成本量化的三个维度

1. **代码迁移量**：按节点/agent 数量估算，每个 agent 的指令与工具定义需重写
2. **状态迁移量**：已有 checkpointer/会话数据能否导出
3. **团队学习成本**：新框架的图/事件模型需要重新培训

---

## 13. 避坑汇总

| 坑 | 后果 | 规避 |
|----|------|------|
| 把自研 Agent 改写成框架节点 | 框架升级牵一发动全身 | 框架只做编排，推理留在 streamText |
| 同时引入多个编排框架 | 依赖爆炸、心智负担 | 主链路只选一个 |
| 用学术项目上生产 | 无维护、安全风险 | 只选 LTS/商用框架 |
| 忽略 checkpointer | 长任务断线全丢 | 持久化是一等需求 |
| 框架示例直接复制 | 版本 API 漂移 | 以官方文档当前版本为准 |
| 把 A2A 当远程过程调用 | 协议语义错位 | A2A 是任务级协商，见 05 |
| handoff 无 guardrails | 恶意输入直达专业 agent | 入口加 tripwire |
| 多个框架各自开 trace | 可观测性碎片化 | 统一接入一个 trace 后端 |

---

## 14. 本层验收清单

> 本层（18）验收以下约束，全部通过才算完成：

- [ ] 本文件 **无手写框架实现**，只有官方用法示例与选型对比
- [ ] 淘汰标注明确：Swarm（弃用）、AutoGen 旧包（维护模式）、MetaGPT/ChatDev/CAMEL（学术）
- [ ] 七框架全景对比 Matrix 覆盖 LangGraph 1.0、OpenAI Agents SDK、Claude Agent SDK、ADK 2.0、MAF、CrewAI Flows、Bedrock AgentCore
- [ ] 每个 TS 代码块可在"独立文件 / class / namespace / async function*"上下文之一通过解析
- [ ] 相对链接均指向真实文件（05、00、21 等）
- [ ] 全文含 3 个以上 🤖 标记，交叉引用 05
- [ ] 代码示例保持类型严谨：不出现未声明的 `any` 类型断言，也不使用直接日志输出语句（统一走结构化日志）
- [ ] 框架版本为 2026 现状，不出现 2025 年前的过时选型
- [ ] 运行 `node tools/check-skill.mjs` 确认全站 0 失败

---

*本文件由选型结论驱动，实现细节见 05。*
