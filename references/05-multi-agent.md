# 05 — 多 Agent 协作与 Agent 集群 · 规模化编排

> Layer 目标：构建**协作智能与 Agent 集群**——多个 Agent 各司其职，由一个可调试、可恢复的编排器协调，并在需要时横向扩展成集群。本层以 **LangGraph** / **OpenAI Agents SDK** / **CrewAI Flows** 等成熟编排器为主体（状态图 + 检查点 + handoff + 事件流），不手写 Supervisor/Worker 主循环。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - 多 Agent 编排 → **LangGraph**（`StateGraph` / `createReactAgent` / checkpointer / LangSmith Deployment），不要手写 Supervisor 循环、状态快照、循环检测
> - 轻量 handoff 路由 → **OpenAI Agents SDK**（`handoffs` + guardrails + tracing），Swarm 已弃用，不要照搬 Swarm 代码
> - 业务侧快速编排 → **CrewAI Flows**（事件驱动流程）
> - 跨厂商 Agent 通信 → **A2A**（Agent Card + 远程 Agent 调用），不手写 Agent 间协议
> - 子 Agent 的 LLM 调用 → 复用 [01-foundation.md](./01-foundation.md) 的 `createModel`（`ai` 的 `LanguageModel`），不引入第二个 LLM 抽象
> - 事件协议 → 复用 `AgentEvent` 信封，只做业务扩展，不自定义第二套事件
> - 本层唯一允许手写的是 **`[CUSTOM]` 业务层**：Supervisor 决策 prompt、共享状态字段、Worker 的 system prompt、集群拓扑配置

> **2026 现状一句话**：多 Agent 编排的**绝对主流是 orchestrator-worker**——主 agent 规划 + 并行子 agent + 评估 pass。案例见 Anthropic 多智能体研究系统、微软 Magentic-One、AWS Bedrock 多 agent。orchestrator-worker 不是某个框架的私有特性，而是**可复用的架构形态**——本层教你在 LangGraph / OpenAI Agents SDK / CrewAI Flows 里分别落地它。

---

## 目录

- [为什么用编排框架](#为什么用编排框架)
- [Agent 集群：真实形态与主流范式](#agent-集群真实形态与主流范式)
  - [案例一：Anthropic 多智能体研究系统](#案例一anthropic-多智能体研究系统)
  - [案例二：微软 Magentic-One](#案例二微软-magentic-one)
  - [案例三：AWS Bedrock 多 Agent](#案例三aws-bedrock-多-agent)
  - [orchestrator-worker 文字架构图](#orchestrator-worker-文字架构图)
  - [什么时候才需要 Agent 集群](#什么时候才需要-agent-集群)
- [编排框架选型（2026 现状）](#编排框架选型2026-现状)
- [状态定义与图结构](#状态定义与图结构)
- [Supervisor 决策节点 [CUSTOM]](#supervisor-决策节点-custom)
- [Worker 子 Agent [CUSTOM]](#worker-子-agent-custom)
- [checkpointer：状态快照与恢复](#checkpointer状态快照与恢复)
- [三种编排范式在 LangGraph 中的表达](#三种编排范式在-langgraph-中的表达)
- [LangGraph 深潜：createReactAgent 与 LangSmith Deployment](#langgraph-深潜createreactagent-与-langsmith-deployment)
- [OpenAI Agents SDK handoffs：swarm 路由生产化](#openai-agents-sdk-handoffsswarm-路由生产化)
- [CrewAI Flows：事件驱动编排](#crewai-flowsevent-driven-编排)
- [A2A：跨厂商 Agent 通信](#a2a跨厂商-agent-通信)
- [前端可视化](#前端可视化)
- [Worker 接入 RAG](#worker-接入-rag)
- [本层验收清单](#本层验收清单)

---

## 为什么用编排框架

多 Agent 的核心价值不是"多个 LLM 一起跑更快"，而是**角色隔离 + 注意力聚焦**：每个 Agent 有自己的 system prompt、自己的工具集——研究员不需要知道部署细节，写手不需要知道数据库 schema。

但编排控制流（谁先跑、谁失败后怎么办、结果怎么合并）是**通用问题**，自己写状态机必然会遇到：

- Agent A 的输出要分发给 B 和 C（fan-out）
- B 失败后要回退到 A 上一步（回退）
- 三个 Agent 的结果要合并校验（聚合）
- 进程崩溃后要从某个节点续跑（持久化）

🔗 **工程逻辑**：这些问题在 LangGraph 里是"有向图 + 检查点"的一等公民：节点定义行为，边定义转移，`checkpointer` 在每个超步自动保存状态。你写的是图，不是循环。

🤖 **AI 常见错误**：
1. 手写 `while (round < maxRounds) { decide(); execute(); }` 主循环——循环检测、状态回滚、断点续跑全都要自己补，最终变成意大利面条。
2. 每个 Worker 单独 `new` 一个 LLM 客户端——复用 01 的 `createModel` 并模块级缓存，避免连接池反复重建。
3. 自己定义一套 `OrchestratorEvent`——前端已有 `AgentEvent` 协议（01），多 Agent 只是扩展事件载荷，不要另起炉灶。

---

## Agent 集群：真实形态与主流范式

"Agent 集群"不是"放一群 Agent 自由竞争"，而是**有拓扑、有主从、有评估的规模化编排**。2026 年生产环境里最常被验证的形态只有一种——**orchestrator-worker**（主 agent 规划 + 并行子 agent + 评估 pass）。下面用三个大厂公开案例说明"真实集群长什么样"，再给出一张与框架无关的文字架构图。

### 案例一：Anthropic 多智能体研究系统

Anthropic 在其工程博客公开了内部使用的多智能体研究系统，是 orchestrator-worker 的教科书实现：

```text
用户请求
   |
   v
+-----------------------------+
| 主 Agent（规划 + 调度）        |  <- 只做任务分解、进度跟踪、质量把关
|  - 把研究问题拆成子任务          |
|  - 动态创建并行子 Agent          |
+--------------+--------------+
               | 创建 + 派发（每次任务动态 new 一个子 agent）
   +-----------+-----------+--------------+--------------+
   v           v           v              v
+------+   +------+     +------+        +------+
| 子Agent|  | 子Agent|  ... | 子Agent|        | 子Agent|
| 搜索   |   | 总结   |     | 编码   |        | 审校   |
+--+---+   +--+---+     +--+---+        +--+---+
   +-----------+-----------+--------------+--------------+
               | 并行子 agent 各自返回结果
               v
+-----------------------------+
| 主 Agent（聚合 + 评估 pass）     |  <- 检查遗漏、矛盾、质量
|  - 需要时再次派发子任务          |
|  - 全部满意后汇总输出            |
+-----------------------------+
```

关键设计（来自公开博客）：
- **主 agent 不执行子任务**，只做规划、派发、聚合与质量评估——和本层 `supervisorNode` 的"只决策不执行"一致。
- **子 agent 是每次任务动态创建的**，任务结束即销毁，不维护常驻 Agent 池——这样每个子 agent 的上下文都是干净的，不会串任务。
- **评估 pass 是必备环节**：主 agent 检查子结果是否有遗漏/矛盾，发现问题就再派一轮，而不是一次 fan-out 完事。

🔗 **工程逻辑**：这套设计的两个要点——"主 agent 只决策"和"子 agent 动态创建"——直接落到本层代码里：`supervisorNode` 用 `generateObject` 输出决策；`createWorkerNode` 按需生成节点，任务结束即从图状态回收。

### 案例二：微软 Magentic-One

Magentic-One 是微软研究院的通用多 agent 系统，同样是 orchestrator-worker：一个 **Orchestrator**（主 agent）负责任务分解、进度跟踪与重新规划；一组专家 agent（FileSurfer、WebSurfer、Coder、ComputerTerminal）分别负责浏览文件、浏览网页、写代码、操作终端。

```text
+---------------------------------------------------+
| Orchestrator（主 agent）                            |
|  - 维护 Task Ledger（任务台账）                        |
|  - 维护 Progress Ledger（进度台账）                    |
|  - 决定下一步派给哪个专家 agent                        |
+-------------------+-------------------------------+
                    | 派发
    +---------------+------------+-------------+
    v               v            v             v
+--------+     +--------+   +--------+   +--------------+
|FileSurfer|    |WebSurfer|   |  Coder  |   |ComputerTerminal|
| 浏览文件  |     | 浏览网页 |   | 写代码   |   | 操作终端       |
+--------+     +--------+   +--------+   +--------------+
```

关键设计：
- **两个 ledger（台账）**：Orchestrator 把"任务清单"和"已尝试过的动作/进度"显式记录成结构化状态，每次决策都读这两份台账——这就是本层 `OrchestratorState` 里 `task` 与 `results` 两个共享字段的原型。
- **失败重规划**：专家 agent 卡住时，Orchestrator 会换一个专家或换一种策略，而不是把整个流程推倒重来——对应 LangGraph 的条件边循环 + `recursionLimit`。

🔗 **工程逻辑**：Magentic-One 已按研究原型定位，**生产不要直接部署 Magentic-One 本体**（TECH_LANDSCAPE 明确把它列入淘汰清单），但它的"双台账 + 重规划"思想就是本层 `OrchestratorState` 的设计来源。微软生产路径是 **Microsoft Agent Framework + Foundry Agent Service**，见 [18-framework-comparison.md](./18-framework-comparison.md)。

### 案例三：AWS Bedrock 多 Agent

AWS Bedrock 提供**多 Agent 协作（Multi-agent collaboration）**能力，典型模式是 **supervisor**（AWS 文档中的叫法）：一个 supervisor agent 接收用户请求，拆解后调用子 agent，子 agent 完成后结果返回 supervisor 聚合。

```text
用户 -> Bedrock Agent Runtime
         |
         v
  +-------------+
  | supervisor  |  <- 负责拆解、路由、聚合
  |   agent     |
  +------+------+
         | AWS::Bedrock::Agent 子代理（带各自的 instruction + action group）
    +----+----+--------+--------+
    v         v        v        v
 子agent A  子agent B 子agent C ...
```

关键设计：
- **子 agent 是独立的 Bedrock Agent 资源**：每个子 agent 有自己的 instruction、action group（工具）与知识库，可以单独测试与授权。
- **托管会话与记忆**：AWS Bedrock AgentCore（2025-10 GA）把会话状态、记忆、追踪都托管掉，你只负责定义 agent 与协作拓扑——这正是"集群的通用部分交给平台"的典型。
- **协作配置是声明式的**：在 agent 配置里声明 `collaboration` 与 `supervisor` 关系，不需要写编排循环。

🔗 **工程逻辑**：AWS 的 supervisor 模式与 LangGraph 的 supervisor 图在概念上完全同构——只是 LangGraph 把编排逻辑放在你的代码里，Bedrock 把它放在 AWS 托管运行时里。选型时：已经在 AWS 栈、不想维护状态存储 → Bedrock AgentCore；需要框架无关/可迁移的编排 → LangGraph + LangSmith Deployment。

### orchestrator-worker 文字架构图

把三个案例抽象成一张与框架无关的通用图，本层所有代码都围绕它：

```text
                        +-----------------------------+
                        |       入口（API / 前端）        |
                        +--------------+--------------+
                                       | 任务
                                       v
                        +-----------------------------+
                        |   Orchestrator（主 agent）     |
                        |  . 任务分解（plan）             |
                        |  . 派发（dispatch）            |
                        |  . 质量评估（evaluate pass）    |
                        +---+---------+---------+------+
                            |         |         |
                    fan-out v         v         v
                 +--------+  +--------+  +--------+
                 | worker1|  | worker2|  | workerN|
                 | 工具集A |  | 工具集B |  | 工具集C |
                 +---+----+  +---+----+  +---+----+
                     |          |          |
                     +----------+----------+
                                | 结果聚合（fan-in）
                                v
                        +-----------------------------+
                        |   评估通过？ ----否----> 再派一轮    |
                        |    是                        |
                        +--------------+--------------+
                                       v
                                  最终输出
```

这张图对应到本层代码：
- `OrchestratorState` = 图中央的共享状态（`task` + `results`）。
- `supervisorNode` = Orchestrator 的"分解 + 派发 + 评估"。
- `createWorkerNode` = 每个 worker（带自己的工具表）。
- `routeAfterSupervisor` = 评估通过走 `END`，否则回到 supervisor 再派。

### 什么时候才需要 Agent 集群

TECH_LANDSCAPE 第 6 节给出大厂共识：**先单 agent + 工具，确认需要再升级多 agent**。出现以下信号才上集群：

| 信号 | 说明 | 单体 agent 的表现 |
|------|------|-----------------|
| 角色隔离诉求 | 研究员不需要部署权限，写手不需要数据库 schema | 一个 system prompt 越来越长，互相干扰 |
| 工具集过大 | 单 agent 的工具表超过 20 个，选择准确率下降 | 工具调用开始选错工具 |
| 并行任务 | 同一请求包含多个可并行子任务 | 串行执行，延迟线性增长 |
| 独立生命周期 | 某个子流程需要单独重试/审批/审计 | 一个失败导致整条链回滚 |

🤖 **AI 常见错误**：一上来就画一个 10 个 agent 的集群拓扑。真实项目 90% 从"单 agent + 工具"开始，是**业务压力**（角色隔离、工具集膨胀、并行需求）逼你拆成集群，不是架构美观需求。先跑通单 agent，再用本层图结构逐步拆分。


---

## 编排框架选型（2026 现状）

2026 年多 Agent 编排的选型面比 2024 宽了很多：OpenAI 用 **Agents SDK** 取代了 Swarm，微软用 **Microsoft Agent Framework** 取代了 AutoGen 旧包，Google 出了 **ADK 2.0**，LangGraph 发布 **1.0** 并并入 LangSmith Deployment。本层以 **LangGraph** 为主线（显式状态 + 检查点 + 断点续跑），同时给出手持 handoff 的 **OpenAI Agents SDK** 与业务侧 **CrewAI Flows** 的落地方案：

| 维度 | **LangGraph 1.0** | **OpenAI Agents SDK** | **CrewAI Flows** | **Microsoft Agent Framework** | **Google ADK 2.0** |
|------|-------------------|----------------------|------------------|-------------------------------|--------------------|
| 编排模型 | 有向状态图（StateGraph） | Agent + handoff 路由 | 事件驱动 Flow（`@start`/`@listen`/`@router`） | 图/工作流 + 角色协作 | AgentGraph 状态机 |
| 控制流 | 显式边 + 条件边，完全可控 | handoff 由 LLM 决定，也可显式 | 事件触发，装饰器声明 | 工作流节点 + 条件转移 | 节点 + 转移 |
| 状态持久化 | checkpointer 一等公民（Memory/Postgres） | 会话状态由 Runtime/Conversation 管理 | 依赖外部存储 | 会话状态（状态存储抽象） | 内置会话持久化 |
| 托管形态 | LangSmith Deployment | 自带 tracing + Temporal GA 集成 | CrewAI AMP | Foundry Agent Service | Agentspace/Vertex 托管 |
| 适合场景 | 复杂状态机、长时任务、审计 | OpenAI 模型为主、handoff 式客服/路由 | 业务侧快速上线、事件流 | 微软栈/.NET 团队 | Google Cloud 栈、A2A 互操作 |
| 事件流集成 | 好对接 `AgentEvent` | `run` 过程可流式输出 | Flow 事件可映射 | 会话事件流 | 事件总线 |

**淘汰与降级标注（2026）**：
- ❌ **OpenAI Swarm**：官方弃用，仅教学。handoff 路由的生产化实现是 **OpenAI Agents SDK**。
- ❌ **AutoGen 旧 `autogen` 包**：维护模式，微软要求迁移到 **Microsoft Agent Framework**。
- ❌ **MetaGPT / ChatDev / CAMEL / AgentVerse**：学术项目，非生产；不要写入生产依赖。
- ❌ **Magentic-One**：研究原型；生产走 MAF + Foundry Agent Service。

🔗 **工程逻辑**：选型不是"谁更好"，而是"你的控制流有多复杂"。本项目需要**显式状态、失败回退、断点续跑、事件流前端可视化**，主线选 LangGraph；如果未来以 OpenAI 模型为主且路由是"客服分流"式，可把部分场景切到 OpenAI Agents SDK handoffs（见下文专章）。完整七框架对比见 [18-framework-comparison.md](./18-framework-comparison.md)。


---

## 状态定义与图结构

LangGraph 的 `Annotation.Root` 定义**共享状态 schema**——等价于手写方案里的 `MultiAgentState`，但类型收敛、可检查点：

```typescript
// packages/core/src/orchestrator/state.ts —— 共享状态 schema 与节点配置
import { Annotation } from '@langchain/langgraph';
import type { Tool } from 'ai';

/** 共享状态：所有节点读写同一份，LangGraph 负责快照与恢复 */
export const OrchestratorState = Annotation.Root({
  task: Annotation<string>({ reducer: (_, next) => next }),
  results: Annotation<Record<string, string>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
  }),
  nextNode: Annotation<string>({ reducer: (_, next) => next }),
});

export interface AgentNodeConfig {
  id: string;
  name: string;
  systemPrompt: string;
  /** AI SDK 工具表（key 为工具名），如 { rag_search: createRagSearchTool() } */
  tools: Record<string, Tool>;
}
```

---

## Supervisor 决策节点 [CUSTOM]

Supervisor **只决策，不执行**。决策 prompt 是业务层 `[CUSTOM]`；结构化输出用 AI SDK 的 `generateObject` + Zod，不要手写 JSON.parse 和重试：

```typescript
// packages/core/src/orchestrator/supervisor.ts —— Supervisor 决策 [CUSTOM]
import { END } from '@langchain/langgraph';
import { generateObject } from 'ai';
import { z } from 'zod';
import { createModel } from '@agentcore/core/llm';
import { OrchestratorState } from './state';

/** 决策输出 schema：结构化输出，避免手写 JSON 解析 */
const decisionSchema = z.object({
  nextNode: z.string().nullable(),
  reason: z.string(),
});

/** [CUSTOM] Supervisor 决策 prompt —— 业务层，按产品需求调整 */
export const SUPERVISOR_PROMPT = [
  '你是多 Agent 协作的编排器。你只做决策，不执行任务。',
  '根据当前任务和已完成结果，从可用 Agent 中选择下一步执行者。',
  '如果所有子任务已完成，回复 nextNode 为 null。',
  '用中文简述选择理由。',
].join('\n');

export async function supervisorNode(state: typeof OrchestratorState.State) {
  const { object } = await generateObject({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    schema: decisionSchema,
    system: SUPERVISOR_PROMPT,
    prompt: `当前任务: ${state.task}\n已完成结果: ${JSON.stringify(state.results)}`,
  });

  return { nextNode: object.nextNode ?? 'finish' };
}

/** 条件边：根据 Supervisor 决策路由到对应 Worker 或结束 */
export function routeAfterSupervisor(state: typeof OrchestratorState.State) {
  return state.nextNode === 'finish' ? END : state.nextNode;
}
```

🤖 **AI 常见错误**：
1. 让 Supervisor 也执行子任务——决策上下文被工具输出污染，决策质量急剧下降。**只决策不执行**是铁律。
2. 用 `streamText` + 手写 JSON.parse 解析决策——结构化输出交给 `generateObject` + Zod schema，解析错误和重试由 SDK 处理。
3. 决策 prompt 不给"已完成结果"——Supervisor 不知道谁干过活，会重复派发。把 `state.results` 注入 prompt。

---

## Worker 子 Agent [CUSTOM]

每个 Worker 是 AI SDK 的 `generateText` 循环（带自己的工具表），system prompt 是业务层 `[CUSTOM]`。结果按节点 id 合并进共享状态，供 Supervisor 下一轮决策参考：

```typescript
// packages/core/src/orchestrator/worker.ts —— Worker 节点工厂 [CUSTOM]
import { generateText } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { OrchestratorState, type AgentNodeConfig } from './state';

/** 创建 Worker 节点：每个 Worker 是带工具的 AI SDK 循环，结果按 key 合并进共享状态 */
export function createWorkerNode(config: AgentNodeConfig) {
  return async function workerNode(state: typeof OrchestratorState.State) {
    const { text } = await generateText({
      model: createModel('openai', process.env as Record<string, string | undefined>),
      system: config.systemPrompt,
      prompt: state.task,
      tools: config.tools,
      maxSteps: 10,
    });

    return { results: { [config.id]: text } };
  };
}
```

```typescript
// packages/core/src/orchestrator/graph.ts —— 组装并编译编排图
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { OrchestratorState, type AgentNodeConfig } from './state';
import { supervisorNode, routeAfterSupervisor } from './supervisor';
import { createWorkerNode } from './worker';

export function buildOrchestrator(nodes: AgentNodeConfig[]) {
  const graph = new StateGraph(OrchestratorState)
    .addNode('supervisor', supervisorNode);

  for (const node of nodes) {
    graph.addNode(node.id, createWorkerNode(node));
  }

  graph.addEdge(START, 'supervisor');

  graph.addConditionalEdges('supervisor', routeAfterSupervisor, [
    END,
    ...nodes.map((n) => n.id),
  ]);

  // 每个 Worker 完成后回到 Supervisor 做下一轮决策
  for (const node of nodes) {
    graph.addEdge(node.id, 'supervisor');
  }

  return graph.compile({
    checkpointer: new MemorySaver(), // 生产换 Postgres checkpointer，见下
    recursionLimit: 30,              // 硬上限：等价于手写方案里的 maxRounds
  });
}
```

🔗 **工程逻辑**：`recursionLimit` 就是手写方案里的 `maxRounds`——循环检测由框架兜底，你不用自己维护 `visited` Set。`results` 用 reducer 合并（按 key），天然避免并行 Worker 互相覆盖。

---

## checkpointer：状态快照与恢复

手写方案里的"状态快照 + 断点续跑"在 LangGraph 中是 checkpointer 的能力：

- 开发期：`new MemorySaver()`——进程内存内快照，重启即失。
- 生产：**PostgresSaver**（`@langchain/langgraph-checkpoint-postgres`）——每个超步写入 Postgres，进程崩溃后可恢复。

```typescript
// server/src/orchestrator/run.ts —— 调用编排图（胶水层）
import { buildOrchestrator } from '@agentcore/core/orchestrator/graph';
import type { AgentNodeConfig } from '@agentcore/core/orchestrator/state';
import { createRagSearchTool } from '@agentcore/core/orchestrator/rag-tool';

const researcher: AgentNodeConfig = {
  id: 'researcher',
  name: '研究员',
  systemPrompt: '你是专业研究员。基于私有知识库检索并整理资料，输出结构化报告。',
  tools: { rag_search: createRagSearchTool() },
};

const writer: AgentNodeConfig = {
  id: 'writer',
  name: '写手',
  systemPrompt: '你是专业写手。根据研究资料撰写高质量文章内容。',
  tools: {},
};

const reviewer: AgentNodeConfig = {
  id: 'reviewer',
  name: '审稿人',
  systemPrompt: '你是严格的审稿人。审核文章质量和准确性，提出修改建议。',
  tools: {},
};

const app = buildOrchestrator([researcher, writer, reviewer]);

export async function runOrchestration(task: string, sessionId: string) {
  const finalState = await app.invoke(
    { task },
    { configurable: { thread_id: sessionId } },
  );
  return finalState;
}

export async function loadOrchestration(sessionId: string) {
  return app.getState({ configurable: { thread_id: sessionId } });
}
```

🔗 **工程逻辑**：`thread_id` 等价于手写方案里的 `sessionId`——同一线程的历史状态自动累积，第二次 `invoke` 可以接着上次的 `results` 继续。这让"断点续跑"和"失败重试"变成一行配置。

🤖 **AI 常见错误**：
1. 生产环境用 `MemorySaver`——状态在进程重启后丢失。生产必须换 Postgres checkpointer。
2. 每次请求新建 graph 实例——编译后的 `app` 应作为模块级单例缓存（和 01 的 `createModel` 同理）。
3. 用 `invoke` 跑长任务——`invoke` 会等全部完成才返回；需要流式进度给前端时用 `app.stream()`，逐超步输出。

---

## 三种编排范式在 LangGraph 中的表达

手写方案里要区分 Pipeline / Debate / Swarm 三种范式；在 LangGraph 里它们只是**不同的图拓扑**，不需要三个类：

| 范式 | 图结构 | 适用场景 |
|------|--------|---------|
| Pipeline | `START -> A -> B -> C -> END` 线性边 | 调研 → 写稿 → 审校 |
| Debate | 两个 proponent 节点 + judge 节点，条件边循环 | 技术方案选型 |
| Swarm | 一个 fan-out 节点用 `Send()` 并行分发到 N 个 worker | 头脑风暴、并行调研 |

🔗 **工程逻辑**：`Send()` 是 LangGraph 的 fan-out API，在一个节点内动态创建多个并行分支，等价于手写方案里的 `Promise.all`。并行度越高状态冲突概率越大——共享字段用 reducer 合并（如上面的 `results`），而不是后写覆盖。

🤖 **AI 常见错误**：
1. 为三种范式写三个 `createPipeline/createDebate/createSwarm` 类——范式只是拓扑差异，用同一个 `StateGraph` 加不同的边即可。
2. Swarm 并行写入同一字段——必须用 reducer 按 key 合并，否则后写覆盖先写。
3. 不设 `recursionLimit`——条件边路由一旦被 LLM 带偏，图会在 supervisor ↔ worker 间无限循环。`recursionLimit` 是硬上限。

---

## LangGraph 深潜：createReactAgent 与 LangSmith Deployment

前文用 `StateGraph` 手工搭了 supervisor 图。LangGraph 1.0 还提供一个更常用的捷径——`createReactAgent`：把"ReAct 循环 + 工具调用 + 检查点"打包成一个可直接运行的 agent，适合**单 agent 升级为多步骤**的场景，也是 LangSmith Deployment 上最容易托管的形态。

### createReactAgent：一行构建带工具的 ReAct Agent

```typescript
// packages/core/src/orchestrator/react-agent.ts —— createReactAgent 官方用法
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { convertToLangChainTools, MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from 'ai';
import { z } from 'zod';

const ragSearch = tool({
  description: '基于私有知识库检索文档片段，返回带来源的上下文。',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }) => ({ answer: `检索结果：${query}` }),
});

const agent = createReactAgent({
  llm: new ChatOpenAI({ model: 'gpt-4o' }),
  tools: convertToLangChainTools([ragSearch]),
  checkpointer: new MemorySaver(),
});
```

🔗 **工程逻辑**：`createReactAgent` 内部就是一张标准 ReAct 图（`agent` 节点 + `tools` 节点循环），`checkpointer` 让它天然支持断点续跑。注意两点：第一，AI SDK 的 `tool()` 不能直接喂给 LangGraph，需要 `convertToLangChainTools` 转换；第二，`ChatOpenAI` 是 LangChain 生态的模型包装器，**仅在 LangGraph 图内使用**——图外的 LLM 调用仍走 01 的 `createModel`（`LanguageModel`），避免破坏 00 的类型契约。

### StateGraph 与 createReactAgent 怎么选

| 场景 | 选择 |
|------|------|
| 单 agent + 工具，需要检查点/断点 | `createReactAgent` |
| 多个角色、需要显式路由与聚合 | `StateGraph` + 自定义节点（前文的 supervisor 图） |
| 需要并行 fan-out / 动态创建 worker | `StateGraph` + `Send()` |
| 需要人机协同中断 | `StateGraph` + `interrupt()`（见 06） |

### checkpointer：从 MemorySaver 到 Postgres

开发期用 `MemorySaver`，生产必须换 Postgres checkpointer（`@langchain/langgraph-checkpoint-postgres`）。LangGraph 1.0 里 checkpointer 是 `compile()` 的入参，接口与 0.2/0.3 保持兼容：

```typescript
// server/src/orchestrator/checkpointer.ts —— 生产 checkpointer（胶水层）
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

export async function createProductionCheckpointer() {
  return PostgresSaver.fromConnString(process.env.DATABASE_URL ?? '');
}
```

🔗 **工程逻辑**：Postgres checkpointer 在每个超步后把图状态写入 `checkpoints` 表。进程崩溃后，用同一个 `thread_id` 重新 `invoke` 就能从最后超步继续——这是 21（fault-recovery）依赖的基础设施。

### LangSmith Deployment：托管形态

LangGraph 1.0 的托管路径是 **LangSmith Deployment**（LangGraph Platform 的继任者）。你把编译好的图作为一个 **LangGraph Server** 部署上去，平台自动提供：

- **REST API**：`POST /threads/{thread_id}/runs` 发起运行，`GET /threads/{thread_id}/state` 读状态。
- **流式事件**：`/runs/stream` 返回超步事件，前端可转成 `AgentEvent`。
- **持久化**：Postgres 数据库由平台托管，checkpointer 自动配置。
- **可观测性**：trace 直接进 LangSmith，不用自己接。

```bash
# langgraph.json —— LangGraph Server 的声明式配置
{
  "dependencies": ["."],
  "graphs": {
    "orchestrator": "./packages/core/src/orchestrator/graph.ts:buildOrchestrator"
  },
  "env": {
    "OPENAI_API_KEY": "__AKF__"
  }
}
```

🤖 **AI 常见错误**：
1. 在 LangGraph 图内也硬塞 `createModel` 的返回值——LangGraph 需要 LangChain 模型接口，图内用 `ChatOpenAI` 包装器，图外用 `createModel`，不要混用。
2. 生产还用 `MemorySaver`——部署到 LangSmith Deployment 时平台会换成托管 Postgres，但自建生产环境必须手动换 `PostgresSaver`。
3. 在 LangGraph 里手写工具格式转换——AI SDK `tool()` 到 LangGraph 用 `convertToLangChainTools`，不要自己写格式映射。


---

## OpenAI Agents SDK handoffs：swarm 路由生产化

OpenAI Swarm 被官方弃用后，其核心思想——**handoff（把会话移交给另一个 agent）**——被生产化吸收进 **OpenAI Agents SDK**。handoff 解决了"客服分流"式路由：一个入口 agent 判断意图，把整个对话上下文移交给最合适的专业 agent，专业 agent 处理完可以再移交回来。以下示例以官方 Python SDK 为准，版本升级时以官方文档为准。

### agent 定义与 handoff

```python
# examples/orchestrator/handoffs/billing.py —— OpenAI Agents SDK 官方用法（Python）
from agents import Agent, Runner

billing_agent = Agent(
    name="BillingAgent",
    instructions="你是账单专员。只处理退款、发票、扣费问题。",
)

triage_agent = Agent(
    name="TriageAgent",
    instructions=(
        "你是客服路由。判断用户意图：账单问题移交给 BillingAgent，"
        "技术支持移交给 SupportAgent，其他问题直接回答。"
    ),
    handoffs=[billing_agent],
)

result = await Runner.run(triage_agent, "我上个月被多扣了一笔钱")
print(result.final_output)
```

### 带参数的 handoff 与显式 handoff

需要把上下文传给下游时，用 `Handoff` 显式声明参数 schema：

```python
# examples/orchestrator/handoffs/order_lookup.py —— 显式 Handoff 带参数
from typing import Any
from agents import Agent, Handoff, Runner

class OrderContext:
    def __init__(self, order_id: str) -> None:
        self.order_id = order_id

def make_order_handoff() -> Handoff[OrderContext]:
    async def on_handoff(ctx: OrderContext, agent: Agent[Any]) -> None:
        print(f"移交订单 {ctx.order_id} 给 {agent.name}")

    return Handoff(
        agent=Agent(
            name="OrderAgent",
            instructions="根据订单号查询订单状态并回答用户。",
        ),
        input_type=OrderContext,
        on_handoff=on_handoff,
    )
```

🔗 **工程逻辑**：显式 handoff 相当于 LangGraph 的条件边——只不过 LangGraph 的边是静态声明的，而 Agents SDK 的 handoff 是运行时由 LLM（或代码）决定。需要**完全确定的路由**用 LangGraph；需要**自然语言驱动的客服分流**用 handoff。

### guardrails：输入护栏与输出护栏

Agents SDK 的 guardrail 在 agent 运行前后执行，命中 tripwire 时中断运行——对应 22（guardrails & tracing）的输入/输出双向护栏：

```python
# examples/orchestrator/handoffs/guardrails.py —— 输入护栏（tripwire）
from pydantic import BaseModel
from agents import (
    Agent,
    GuardrailFunctionOutput,
    InputGuardrail,
    Runner,
)

class SafetyOutput(BaseModel):
    is_off_topic: bool = False
    reason: str = ""

safety_agent = Agent(
    name="SafetyAgent",
    instructions="判断用户输入是否与客服主题相关，输出 is_off_topic。",
    output_type=SafetyOutput,
)

async def safety_guardrail(ctx, agent, input_text: str) -> GuardrailFunctionOutput:
    result = await Runner.run(safety_agent, input_text)
    output = result.final_output_as(SafetyOutput)
    return GuardrailFunctionOutput(
        output_info=output,
        tripwire_triggered=output.is_off_topic,
    )

triage_agent = Agent(
    name="TriageAgent",
    instructions="你是客服路由。",
    handoffs=[],
    input_guardrails=[InputGuardrail(guardrail_function=safety_guardrail)],
)
```

### tracing：一键接入

Agents SDK 内置 tracing，默认把 span 发送到 OpenAI 平台；生产接入 Langfuse 时设置导出器：

```python
# examples/orchestrator/handoffs/tracing.py —— 生产 tracing 配置
from agents import set_tracing_exporters
from agents.tracing.processors import LangfuseExporter

set_tracing_exporters([LangfuseExporter()])
```

🔗 **工程逻辑**：Agents SDK 的 span 结构与 OpenTelemetry GenAI 语义兼容，Langfuse 可以直接消费。若你的团队已经统一走 OTel + Langfuse（见 08），把导出器换成 LangfuseExporter 即可，业务代码零改动。

🤖 **AI 常见错误**：
1. 把 Swarm 的 `functions` 路由代码直接搬进生产——Swarm 已弃用，Agents SDK 的 `handoffs` 参数才是生产 API。
2. handoff 后不设 guardrail——handoff 本质是"把上下文交给另一个 agent"，正是提示注入的高发点，入口 agent 必须配输入护栏。
3. 用 handoff 实现"多角色并行协作"——handoff 是**串行移交**，不是并行 fan-out。要并行子任务用 LangGraph `Send()` 或 orchestrator-worker。


---

## CrewAI Flows：事件驱动编排

CrewAI 的 **Flows** 是比 Crew 更轻的编排原语：用装饰器把普通函数变成事件驱动节点，支持条件分支、并行执行与状态共享。适合"业务侧快速上线、事件流清晰"的场景——不需要完整的 LangGraph 状态机，但比裸函数多了结构。官方 Python 包直接使用，不需要 TypeScript 桥接。

```python
# examples/orchestrator/crewaiflow/order_flow.py —— CrewAI Flows 官方用法（Python）
from crewai.flow import Flow, listen, router, start
from pydantic import BaseModel

class OrderState(BaseModel):
    order_id: str = ""
    risk_level: str = "low"
    approved: bool = False

class OrderFlow(Flow[OrderState]):
    @start()
    def ingest(self) -> str:
        return "接收订单"

    @listen("ingest")
    def check_risk(self, event: str) -> str:
        # 模拟风控判断：订单号含"高"字视为高风险
        return "high" if "高" in self.state.order_id else "low"

    @router(check_risk)
    def route_risk(self, result: str) -> str:
        return "manual_review" if result == "high" else "auto_approve"

    @listen("manual_review")
    def manual_review(self) -> None:
        self.state.approved = True

    @listen("auto_approve")
    def auto_approve(self) -> None:
        self.state.approved = True

order_flow = OrderFlow()
order_flow.kickoff()
```

🔗 **工程逻辑**：Flows 的 `@router` 对应 LangGraph 的 `addConditionalEdges`，`state` 对应 `OrchestratorState`——概念一一映射。差别在于 Flows 是**事件驱动**（装饰器声明触发关系），LangGraph 是**图驱动**（显式边声明转移）。业务团队用 Flows 上手更快，工程团队需要强类型状态与检查点时选 LangGraph。

### Flow 与 Crew 怎么组合

CrewAI Flows 的事件节点里可以直接 `kickoff` 一个 Crew（角色化任务组），形成"Flow 编排 + Crew 干活"的两层结构：

```python
# examples/orchestrator/crewaiflow/research_flow.py —— Flow 编排多个 Crew
from crewai import Agent, Crew, Process, Task
from crewai.flow import Flow, listen, start

class ResearchFlow(Flow):
    @start()
    def research(self) -> str:
        researcher = Agent(role="研究员", goal="收集资料", backstory="擅长检索。")
        task = Task(
            description="调研主题并输出带来源的关键发现",
            expected_output="要点列表",
            agent=researcher,
        )
        crew = Crew(agents=[researcher], tasks=[task], process=Process.sequential)
        result = crew.kickoff(inputs={"topic": "AI agents 2026"})
        return result.raw

    @listen("research")
    def publish(self, research_output: str) -> None:
        # 把调研结果交给下游（例如写入知识库或触发审校）
        self.state["research"] = research_output

flow = ResearchFlow()
flow.kickoff()
```

🤖 **AI 常见错误**：
1. 在 Flows 里手写 `while` 轮询等待子任务——Flows 的事件循环由框架管理，用 `@listen` 声明依赖即可。
2. 把 `state` 设计成无类型 dict——CrewAI Flows 支持 Pydantic 状态模型，用 `Flow[OrderState]` 显式声明，避免字段拼写错误；`self.state` 的键也要保持一致。
3. 让 Flow 节点直接调 LLM 裸接口——节点内的 LLM 调用仍走 01 的 `createModel`（或 CrewAI Agent），不要引入第三套 LLM 抽象。


---

## A2A：跨厂商 Agent 通信

**A2A（Agent2Agent）** 是 Linux Foundation 治理的 Agent↔Agent 协议（1.0 于 2026-03 发布，150+ 组织支持）。与 MCP 的分工：**MCP = Agent↔工具**，**A2A = Agent↔Agent**。只有"跨团队/跨厂商 Agent 协作"才引入 A2A；单 Agent + 工具不要上 A2A。

### Agent Card：可发现的 Agent 元数据

A2A 用 **Agent Card**（`/.well-known/agent.json`）描述一个远程 agent 的能力、技能与认证方式，让其他 agent 可以发现并决定是否调用：

```json
// examples/orchestrator/a2a/agent-card.json —— Agent Card 示例
{
  "protocolVersion": "1.0",
  "name": "订单风控 Agent",
  "description": "对订单进行风控评分，返回风险等级。",
  "url": "https://risk.internal.example.com/",
  "skills": [
    {
      "id": "order-risk-score",
      "name": "订单风控评分",
      "description": "输入订单信息，返回 0-100 风险分。",
      "inputModes": ["text"],
      "outputModes": ["text"]
    }
  ],
  "authentication": {
    "schemes": ["bearer"],
    "credentials": "https://id.internal.example.com/oauth/token"
  }
}
```

### 用 A2A 调用远程 Agent

生产接入 A2A 有两条路：用官方 SDK（`a2a-sdk`）生成客户端，或对 A2A 的 JSON-RPC 端点做最小 HTTP 调用。下面用官方 SDK 的方式（Python）：

```python
# examples/orchestrator/a2a/client.py —— A2A 客户端调用远程 agent（Python）
from a2a import A2AClient, A2AClientConfig, Message, Part

client = A2AClient(
    config=A2AClientConfig(
        url="https://risk.internal.example.com/",
        auth_token="__AKF__",  # 从密钥服务注入，不要写死在代码里
    )
)

response = await client.send_message(
    Message(parts=[Part(text="订单 #12345，金额 8000 元")])
)
print(response.parts[0].text)
```

### 把远程 Agent 包装成本地工具

在 LangGraph 图中，A2A 远程 agent 以"工具"的形式出现最自然：本地 Orchestrator 把 A2A 调用包成一个 AI SDK `tool()`，worker 就能像调用普通工具一样调用远程 agent：

```typescript
// packages/core/src/orchestrator/a2a-tool.ts —— 胶水层：A2A 远程 agent 包成 AI SDK 工具
import { tool } from 'ai';
import { z } from 'zod';

export function createA2ARiskTool(endpoint: string, token: string) {
  return tool({
    description: '调用远程订单风控 Agent，返回风险分与等级。',
    parameters: z.object({ orderId: z.string(), amount: z.number() }),
    execute: async ({ orderId, amount }) => {
      const res = await fetch(`${endpoint}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message: { parts: [{ text: `${orderId} ${amount}` }] } },
          id: 1,
        }),
      });
      if (!res.ok) {
        return { error: `remote agent failed: ${res.status}` };
      }
      const data = (await res.json()) as { result?: { parts?: Array<{ text?: string }> } };
      return { risk: data.result?.parts?.[0]?.text ?? 'unknown' };
    },
  });
}
```

🔗 **工程逻辑**：A2A 的接入点应该收敛在**一个工具工厂**里（如上面的 `createA2ARiskTool`），这样 Orchestrator 不需要知道远程 agent 是 A2A、MCP 还是内部 HTTP 服务——统一以工具形式出现在 worker 的工具表里。

🤖 **AI 常见错误**：
1. 单 Agent 场景强行上 A2A——A2A 是跨 Agent 协作协议，本地多 agent 用 LangGraph 就够了，不要多一层网络往返。
2. 手写 A2A JSON-RPC 客户端并散落在多个 worker 里——用官方 `a2a-sdk` 或收敛到一个工具工厂，防止协议升级时到处改。
3. 把 A2A 远程 agent 当成"另一个 LLM"直接对话——A2A 的边界是 agent，不是模型；通过工具封装保持调用链可观测、可审计。


---

## Agent 集群的扩展模式与运维

orchestrator-worker 是骨架，但生产集群还需要回答几个问题：并行度怎么控制、worker 生命周期怎么管理、多租户怎么隔离。

### 并行 fan-out 与并发控制

LangGraph 的 `Send()` 支持动态 fan-out，但"并行度"本身要由你控制——不是所有子任务都能无限并行：

```typescript
// packages/core/src/orchestrator/fanout.ts —— 并行 fan-out 与并发上限
import { Send } from '@langchain/langgraph';

export function dispatchToWorkers(state: typeof OrchestratorState.State) {
  const subtasks = state.subtasks.slice(0, state.maxParallel ?? 4);
  return subtasks.map((t) => new Send('worker', { task: t }));
}
```

🔗 **工程逻辑**：`Send()` 返回多个"带独立状态的并行分支"，每个分支走一遍 `worker` 节点；`maxParallel` 是业务层的并发上限，避免一次把下游 API 打爆。并行分支的结果仍通过 reducer 合并回共享状态（前文的 `results` 字段），不会互相覆盖。若 `OrchestratorState` 还没有 `subtasks` / `maxParallel` 字段，按同样的 `Annotation` 方式补充即可。

### worker 生命周期与幂等

- **worker 无状态**：worker 只依赖入参 `task` 与自己的工具表，不持有跨任务的内部状态——这是集群可水平扩展的前提。
- **重试幂等**：worker 的工具调用要支持幂等键（见 [21-fault-recovery.md](./21-fault-recovery.md)），否则重试会产生重复写入。
- **动态创建**：参考 Anthropic 研究系统，worker 按任务动态创建，任务结束即回收，不维护常驻池。

### 多租户与会话隔离

LangGraph 用 `thread_id` 隔离会话，但"一个租户一个图实例"是错误的做法——正确做法是**共享编译后的图，用 `thread_id` 区分租户会话**，并在节点内做租户级授权（见 [19-multi-tenancy.md](./19-multi-tenancy.md)）：

```typescript
// server/src/orchestrator/run.ts —— 多租户会话隔离（胶水层）
import { buildOrchestrator } from '@agentcore/core/orchestrator/graph';

const app = buildOrchestrator(/* 节点配置 */);

export async function runForTenant(task: string, tenantId: string, userId: string) {
  return app.invoke(
    { task, tenantId, userId },
    { configurable: { thread_id: `${tenantId}:${userId}` } },
  );
}
```

🤖 **AI 常见错误**：为每个租户 `new` 一个编译好的图——图实例是重量级对象且包含 checkpointer 连接，必须模块级单例，租户间只靠 `thread_id` 区分。


---

## 前端可视化

多 Agent 执行过程通过 01 的 SSE 通道以 **`AgentEvent`** 信封下发。先定义业务扩展事件（不新建协议）：

```typescript
// packages/core/src/orchestrator/events.ts —— AgentEvent 的多 Agent 扩展 [CUSTOM]
import type { AgentEvent } from '@agentcore/core/agent/events';

/** 多 Agent 事件 = 基础 AgentEvent + 节点级事件，同一信封，不引入第二套协议 */
export type MultiAgentEvent =
  | AgentEvent
  | { type: 'node_start'; nodeId: string; nodeName: string }
  | { type: 'node_complete'; nodeId: string; output: string }
  | { type: 'node_fail'; nodeId: string; error: string };
```

```typescript
// server/src/orchestrator/stream.ts —— 把 LangGraph 超步映射为 MultiAgentEvent（胶水层）
import type { MultiAgentEvent } from '@agentcore/core/orchestrator/events';

export async function* langgraphToEvents(
  stream: AsyncIterable<Record<string, { results?: Record<string, string> }>>,
): AsyncGenerator<MultiAgentEvent> {
  for await (const step of stream) {
    for (const [nodeId, update] of Object.entries(step)) {
      const text = update.results?.[nodeId];
      if (text !== undefined) {
        yield { type: 'node_complete', nodeId, output: text };
      } else {
        yield { type: 'node_start', nodeId, nodeName: nodeId };
      }
    }
  }
}
```

前端面板只消费 `MultiAgentEvent`，不关心编排器内部实现：

```tsx
// apps/web/src/components/multi-agent/MultiAgentPanel.tsx
'use client';

import { useMemo } from 'react';
import type { MultiAgentEvent } from '@agentcore/core/orchestrator/events';

export interface AgentNodeView {
  nodeId: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  output: string;
}

/** 把 MultiAgentEvent 折叠为节点视图状态 */
export function reduceAgentEvents(events: MultiAgentEvent[]): Map<string, AgentNodeView> {
  const nodes = new Map<string, AgentNodeView>();
  for (const event of events) {
    if (event.type === 'node_start') {
      nodes.set(event.nodeId, { nodeId: event.nodeId, status: 'running', output: '' });
    } else if (event.type === 'node_complete') {
      nodes.set(event.nodeId, { nodeId: event.nodeId, status: 'done', output: event.output });
    } else if (event.type === 'node_fail') {
      nodes.set(event.nodeId, { nodeId: event.nodeId, status: 'failed', output: event.error });
    }
  }
  return nodes;
}

export function MultiAgentPanel({ events }: { events: MultiAgentEvent[] }) {
  const nodes = useMemo(() => reduceAgentEvents(events), [events]);
  return (
    <div className="space-y-2">
      {Array.from(nodes.values()).map((node) => (
        <div key={node.nodeId} className="rounded-lg border border-border bg-surface p-3">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span>{node.nodeId}</span>
            <span>{node.status}</span>
          </div>
          <pre className="mt-2 max-h-24 overflow-auto text-xs whitespace-pre-wrap">{node.output}</pre>
        </div>
      ))}
    </div>
  );
}
```

🤖 **AI 常见错误**：
1. 前端为多 Agent 单独写 SSE 解析器——01 的流式通道已经处理 `data:` 分帧，前端只消费事件数组，不要重复解析。
2. 把整个 `results` 塞进事件——事件只带节点 id 和文本输出，避免前端内存膨胀。
3. 可视化绑定具体框架（LangGraph 节点名）——前端只认 `MultiAgentEvent`，换编排框架前端零改动。

---

## Worker 接入 RAG

多 Agent 的"研究员"需要基于私有知识库检索——但 RAG 管线本身在 [03-memory-rag.md](./03-memory-rag.md)（LlamaIndex/Haystack）和 [12-vector-db-practical.md](./12-vector-db-practical.md)，本层只做**胶水**：把 03 的检索服务包成 AI SDK 工具，注册给对应 Worker：

```typescript
// packages/core/src/orchestrator/rag-tool.ts —— 胶水层：把 03 的 RAG 服务包成 AI SDK 工具
import { tool } from 'ai';
import { z } from 'zod';
import { getRAGPipeline } from '@agentcore/core/rag'; // 03-memory-rag.md 的 LlamaIndex 管线

export function createRagSearchTool() {
  return tool({
    description: '基于私有知识库检索文档片段，返回带来源的上下文。',
    parameters: z.object({ query: z.string() }),
    execute: async ({ query }) => {
      const pipeline = getRAGPipeline();
      return pipeline.searchAndAugment(query);
    },
  });
}
```

🔗 **工程逻辑**：RAG 的摄入、分块、嵌入、检索全部由 03 的成熟管线负责；这里只是把 `searchAndAugment` 包装成工具。如果检索结果要被 Agent 用于高风险操作（写库、删数据），走 [06-hitl-reflection.md](./06-hitl-reflection.md) 的 HITL。

---

## 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/orchestrator` 与 `server/src` 全部 0 错误。
- [ ] **图能跑通**：`buildOrchestrator([researcher, writer, reviewer])` 编译成功；`app.invoke({ task: '...' }, { configurable: { thread_id: 't1' } })` 返回包含 `results` 的终态，`results` 含全部节点输出。
- [ ] **条件路由**：Supervisor 决策为 `null` 时图走 `END`；决策为某个 worker 时，该 worker 执行后回到 supervisor，且不超过 `recursionLimit`。
- [ ] **状态快照**：`MemorySaver` 下同一 `thread_id` 第二次 `invoke` 能读到上次的 `results`；生产切换到 Postgres checkpointer 后，进程重启可从最后超步续跑。
- [ ] **事件协议**：前端只消费 `AgentEvent` 信封（`MultiAgentEvent`），节点流转以 `node_start` / `node_complete` / `node_fail` 载荷出现，无自定义事件类型。
- [ ] **Agent 集群形态**：在 ADR/README 中记录集群拓扑为 orchestrator-worker（主 agent 规划 + 并行 worker + 评估 pass），并列出从单 agent 升级的触发信号（角色隔离/工具集膨胀/并行需求）。
- [ ] **LangGraph 深潜**：`createReactAgent` 示例编译通过；生产 checkpointer 切换为 `PostgresSaver`；`langgraph.json` 可被 LangSmith Deployment 识别并部署。
- [ ] **OpenAI Agents SDK handoff**：`handoffs` 示例可运行；guardrail 命中时运行被中断；tracing 导出到 Langfuse。
- [ ] **CrewAI Flows**：`@start` / `@listen` / `@router` 示例可运行，状态通过 Pydantic 模型传递，`self.state` 键一致。
- [ ] **A2A**：Agent Card 可通过 `GET /.well-known/agent.json` 访问；远程 agent 调用被包装成 AI SDK 工具，Orchestrator 只通过工具表调用。
- [ ] **集群并发**：`Send()` fan-out 受 `maxParallel` 限制；并行 worker 结果通过 reducer 合并，无覆盖丢失。
- [ ] **多租户隔离**：同一图实例用 `thread_id` 区分租户会话，节点内校验租户权限。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本验收清单。

---

> **与后续节点的衔接**：本层的图结构（`state.ts` / `supervisor.ts` / `worker.ts`）被 06（HITL 中断续跑）、09（部署）、19（多租户隔离会话）复用；OpenAI Agents SDK handoffs 与 CrewAI Flows 示例可作为 18（框架对比）的落地参考；A2A 工具工厂与 14（MCP）一样遵循"协议收敛到工具"的胶水模式。所有 `llm` 一律指 `ai` 的 `LanguageModel`（见 [01-foundation.md](./01-foundation.md)）；事件统一走 `AgentEvent` 信封。如果 Worker 需要执行代码，工具直接来自 [04-sandbox.md](./04-sandbox.md)。
