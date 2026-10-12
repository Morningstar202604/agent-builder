# 05 — 多 Agent 协作 · LangGraph 编排

> Layer 目标：构建**协作智能**——多个 Agent 各司其职，由一个可调试、可恢复的编排器协调。本层用 **LangGraph** 做编排（状态图 + 检查点 + 循环控制），不手写 Supervisor/Worker 主循环。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - 多 Agent 编排 → **LangGraph**（`StateGraph` / `createReactAgent` / checkpointer），不要手写 Supervisor 循环、状态快照、循环检测
> - 备选框架 → **CrewAI**（角色化任务派发）、**AutoGen**（对话式多智能体），选型对比见下
> - 子 Agent 的 LLM 调用 → 复用 [01-foundation.md](./01-foundation.md) 的 `createModel`（`ai` 的 `LanguageModel`），不引入第二个 LLM 抽象
> - 事件协议 → 复用 `AgentEvent` 信封，只做业务扩展，不自定义第二套事件
> - 本层唯一允许手写的是 **`[CUSTOM]` 业务层**：Supervisor 决策 prompt、共享状态字段、Worker 的 system prompt
>
> 编排是"胶水 + 业务"，不是基础设施。状态持久化、断点续跑、循环检测都是 LangGraph 的能力，你的工作是设计图结构和业务 prompt。

---

## 目录

- [为什么用编排框架](#为什么用编排框架)
- [LangGraph vs CrewAI vs AutoGen](#langgraph-vs-crewai-vs-autogen)
- [状态定义与图结构](#状态定义与图结构)
- [Supervisor 决策节点 [CUSTOM]](#supervisor-决策节点-custom)
- [Worker 子 Agent [CUSTOM]](#worker-子-agent-custom)
- [checkpointer：状态快照与恢复](#checkpointer状态快照与恢复)
- [三种编排范式在 LangGraph 中的表达](#三种编排范式在-langgraph-中的表达)
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

## LangGraph vs CrewAI vs AutoGen

| 维度 | **LangGraph** | **CrewAI** | **AutoGen** |
|------|--------------|-----------|-------------|
| 编排模型 | 有向状态图（StateGraph） | 角色（Role）+ 任务（Task） | 对话式多智能体 |
| 控制流 | 显式边 + 条件边，完全可控 | 流程由任务依赖自动推导 | Agent 间对话驱动 |
| 状态持久化 | checkpointer 一等公民 | 有限 | 有限 |
| 适合场景 | 复杂状态机、断点续跑、审计 | 快速搭建角色化流水线 | 对话/辩论式协作 |
| 学习成本 | 中（图思维） | 低 | 中 |
| 事件流集成 | 好对接 `AgentEvent` | 偏 Python | 偏 Python |

🔗 **工程逻辑**：选型不是"谁更好"，而是"你的控制流有多复杂"。本项目需要**显式状态、失败回退、断点续跑、事件流前端可视化**，所以选 LangGraph。CrewAI 适合原型期快速出活；AutoGen 适合需要 Agent 间自然对话协商的场景。

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
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本验收清单。

---

> **与后续节点的衔接**：本层的图结构（`state.ts` / `supervisor.ts` / `worker.ts`）被 06（HITL 中断续跑）、09（部署）、19（多租户隔离会话）复用。所有 `llm` 一律指 `ai` 的 `LanguageModel`（见 [01-foundation.md](./01-foundation.md)）；事件统一走 `AgentEvent` 信封。如果 Worker 需要执行代码，工具直接来自 [04-sandbox.md](./04-sandbox.md)。
