# 05 — 多 Agent 协作 + RAG 检索增强

> **Layer 2：协作智能** — 单个 Agent 的能力有天花板。复杂任务需要多个 Agent 各司其职，由一个编排器协调。与此同时，Agent 需要基于私有知识库做出精准回答，而不是靠 LLM 的通用知识来猜测。本 reference 覆盖 Supervisor-Worker 多 Agent 编排的完整实现，以及 RAG（检索增强生成）管道从文档摄入到语义检索的全链路。

> **⚠️ 不要重造以下东西：**
> - 多 Agent 编排 → 用 **LangGraph**（`StateGraph` + `addEdge` + `addConditionalEdges`），不要手写 Supervisor 循环
> - Agent 间通信 → 用 **MCP** + LangGraph 的 `Send()` API，不要手写消息队列
> - RAG 管道 → 用 **LlamaIndex** / **Haystack**，不要手写 chunk→embed→retrieve→rerank
> - 向量检索 → 用 **Qdrant / Milvus / Chroma 官方 SDK**，不要手写 ANN 逻辑
> - Re-ranking → 用 **Cohere Rerank** / **Flashrank** / **bge-reranker**，不要手写排序
>
> **第一选择永远是接入，不是自研。** 本 reference 的参考实现仅在 LangGraph/LlamaIndex 等框架无法满足业务特定编排逻辑时作为 fallback 参考。

---

## 目录

- [1. 多 Agent 编排概览](#1-多-agent-编排概览)
- [2. 类型系统与状态定义](#2-类型系统与状态定义)
- [3. Supervisor 决策引擎](#3-supervisor-决策引擎)
- [4. Worker 子 Agent 执行引擎](#4-worker-子-agent-执行引擎)
- [5. 编排器主循环](#5-编排器主循环)
- [6. 三种编排范式对比与选择](#6-三种编排范式对比与选择)
- [7. 多 Agent 前端可视化](#7-多-agent-前端可视化)
- [8. 后端 Orchestrator API](#8-后端-orchestrator-api)
- [9. 多 Agent 常见陷阱](#9-多-agent-常见陷阱)
- [10. RAG 检索增强生成概览](#10-rag-检索增强生成概览)
- [11. 文档摄入与解析](#11-文档摄入与解析)
- [12. 分块策略](#12-分块策略)
- [13. Embedding 与向量存储](#13-embedding-与向量存储)
- [14. 检索增强生成引擎](#14-检索增强生成引擎)
- [15. RAG 管道编排](#15-rag-管道编排)
- [16. RAG 前端知识库管理](#16-rag-前端知识库管理)
- [17. RAG 后端 API](#17-rag-后端-api)
- [18. RAG 常见陷阱](#18-rag-常见陷阱)
- [19. 最佳实践总结](#19-最佳实践总结)

---

## 1. 多 Agent 编排概览

单个 Agent 能做的事有天花板。让一个 Agent 同时做调研、写代码、审文档——它会互相干扰，角色混乱。这就像让一个人同时当产品经理、开发、测试，谁都干不好。

多 Agent 的核心价值不是"多个 LLM 一起跑更快"，而是**角色隔离 + 注意力聚焦**。每个 Agent 有自己的 system prompt、自己的记忆、自己的工具集。研究员 Agent 不需要知道部署的细节，写手 Agent 不需要知道数据库 schema。

🔗 **工程逻辑**：为什么要用 LangGraph 而不是自己写状态机？因为你迟早会遇到这些场景：Agent A 的输出要分发给 Agent B 和 C、Agent B 失败后要回退到 Agent A 上一步、三个 Agent 的结果要合并校验。自己写这些控制流最终会变成意大利面条。LangGraph 用有向图（DAG）描述 Agent 间的转移条件，逻辑清晰、可调试、可扩展。

```
┌──────────────────────────────────────────────────────────┐
│                    MultiAgentOrchestrator                 │
│                                                          │
│  ┌─────────┐     ┌──────────┐     ┌──────────┐         │
│  │researcher│────▶│  writer  │────▶│ reviewer │         │
│  └─────────┘     └──────────┘     └──────────┘         │
│       │                │                 │               │
│       ▼                ▼                 ▼               │
│  [搜索工具]        [写入工具]        [评估工具]          │
│                                                          │
│  ┌─────────────────────────────────────────────┐        │
│  │           Shared State (黑board)              │        │
│  │  { topic, notes, draft, review, status }     │        │
│  └─────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────┘
                   │
                   ▼
        ┌──────────────────┐
        │  Frontend (11)   │  图谱视图 + 执行日志 + 消息流
        └──────────────────┘
```

系统由三个核心组件构成：

1. **Supervisor**（大管家）：接收任务 → 决定分给谁 → 收集结果 → 决定下一步。它不亲自干活，只做决策。
2. **Worker**（执行者）：执行一个子 Agent，输入是共享状态的快照，输出是 Agent 的纯文本响应。
3. **MultiAgentOrchestrator**（编排器）：主循环，依次调用 Supervisor 决策 → Worker 执行 → 收集结果 → 循环。

---

## 2. 类型系统与状态定义

多 Agent 的类型系统定义了所有参与者的"合同"——每个 Agent 的能力、共享状态的结构、事件流的格式。

```typescript
// packages/core/src/orchestrator/types.ts

import type { LLMClient } from '../llm/types';
import type { AgentTool } from '../agent/types';

/** 子 Agent 角色定义 */
export interface AgentNode {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  llm: LLMClient;
  tools: AgentTool[];
  /** 此 Agent 的最大输出 token */
  maxOutputTokens?: number;
  /** 是否允许修改共享状态(write) 或只能读(read) */
  accessMode: 'read-write' | 'read-only';
}

/** 多 Agent 共享状态 —— 所有 Agent 都能看到的"黑板" */
export interface MultiAgentState {
  /** 用户最初输入的任务 */
  task: string;
  /** 全局共享数据（各 Agent 往里写自己负责的字段） */
  shared: Record<string, unknown>;
  /** 每个 Agent 的执行结果 */
  results: Record<string, AgentResult>;
  /** 当前活跃的 Agent */
  currentNode: string | null;
  /** 执行历史（审计用） */
  history: AgentExecutionRecord[];
  /** 整体状态 */
  status: 'idle' | 'running' | 'waiting' | 'completed' | 'failed';
  /** 错误信息 */
  error?: string;
  /** 取消信号 */
  signal?: AbortSignal;
}

export interface AgentResult {
  nodeId: string;
  output: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface AgentExecutionRecord {
  nodeId: string;
  event: 'start' | 'complete' | 'fail' | 'handoff';
  timestamp: number;
  detail?: string;
  targetNode?: string;  // handoff 到哪个节点
}

/** 编排图定义 */
export interface OrchestrationGraph {
  nodes: AgentNode[];
  edges: AgentEdge[];
  /** 起始节点 */
  entryNodeId: string;
  /** 终止节点列表（任一到即结束） */
  exitNodeIds: string[];
}

/** 边：节点间的转移条件 */
export interface AgentEdge {
  from: string;           // 节点 id，'supervisor' 为特殊值
  to: string;
  /** 转移条件：supervisor LLM 输出中的标识 */
  condition?: string;
  /** 是否无条件转移（上节点结束就到下节点） */
  always?: boolean;
}

/** 编排事件（前端订阅） */
export type OrchestratorEvent =
  | { type: 'state'; state: MultiAgentState }
  | { type: 'node_start'; nodeId: string; nodeName: string }
  | { type: 'node_complete'; nodeId: string; output: string }
  | { type: 'node_fail'; nodeId: string; error: string }
  | { type: 'handoff'; from: string; to: string; reason: string }
  | { type: 'token'; nodeId: string; content: string }
  | { type: 'done'; results: Record<string, AgentResult> }
  | { type: 'error'; error: string };
```

---

## 3. Supervisor 决策引擎

```typescript
// packages/core/src/orchestrator/supervisor.ts

import { nanoid } from 'nanoid';
import type { LLMClient } from '../llm/types';
import type { AgentNode, MultiAgentState, AgentEdge, AgentResult } from './types';

export class Supervisor {
  private llm: LLMClient;
  private nodes: Map<string, AgentNode>;
  private edgesFromSupervisor: AgentEdge[];

  constructor(config: {
    llm: LLMClient;
    nodes: AgentNode[];
    edges: AgentEdge[];
  }) {
    this.llm = config.llm;
    this.nodes = new Map(config.nodes.map(n => [n.id, n]));
    this.edgesFromSupervisor = config.edges.filter(e => e.from === 'supervisor');
  }

  /**
   * 给定当前状态 + 最近一个 Agent 的输出，决定下一步谁执行。
   * 返回下一个节点的 id，或 null 表示结束。
   */
  async decide(
    state: MultiAgentState,
    lastResult?: AgentResult
  ): Promise<{ nextNodeId: string; reason: string } | null> {
    // 如果已经有 exit 节点完成了，直接结束
    const allExitsCompleted = this.getAllExitNodeIds(state).every(
      id => state.results[id]?.status === 'completed'
    );
    if (allExitsCompleted) {
      return null;
    }

    // 构造 supervisor 的决策 prompt
    const decisionPrompt = this.buildDecisionPrompt(state, lastResult);

    // 调 LLM 决策（非流式，因为决策通常很短）
    let decisionText = '';
    for await (const chunk of this.llm.stream(
      [{ role: 'user', content: decisionPrompt }],
      { maxTokens: 500, state: state.signal ? { signal: state.signal } : undefined } as any
    )) {
      if (chunk.type === 'token') {
        decisionText += (chunk.data as { content: string }).content;
      }
    }

    return this.parseDecision(decisionText);
  }

  private buildDecisionPrompt(
    state: MultiAgentState,
    lastResult?: AgentResult
  ): string {
    const nodeDescriptions = Array.from(this.nodes.values())
      .map(n => `- ${n.id}: ${n.description}`)
      .join('\n');

    const completedResults = Object.entries(state.results)
      .filter(([, r]) => r.status === 'completed')
      .map(([id, r]) => `[${id}]: ${r.output.slice(0, 300)}`)
      .join('\n');

    return `你是一个任务编排器。根据当前状态决定下一步由哪个 Agent 执行。

可用的 Agent:
${nodeDescriptions}

当前任务: ${state.task}

已完成的结果:
${completedResults || '(无)'}

${lastResult ? `最近完成的 Agent: ${lastResult.nodeId}，输出摘要: ${lastResult.output.slice(0, 200)}` : ''}

请用以下 JSON 格式回复下一步决策:
{"next_node": "agent_id", "reason": "为什么选它"}

如果没有 Agent 还需要执行，回复:
{"next_node": null, "reason": "所有任务已完成"}`;
  }

  private parseDecision(text: string): { nextNodeId: string; reason: string } | null {
    try {
      // 从 LLM 输出中提取 JSON
      const match = text.match(/\{[^}]+\}/);
      if (!match) throw new Error('No JSON found in decision');

      const parsed = JSON.parse(match[0]);
      if (parsed.next_node === null) return null;
      return { nextNodeId: parsed.next_node, reason: parsed.reason ?? '' };
    } catch {
      // LLM 没返回合法 JSON —— 按第一个可用节点 fallback
      const available = this.edgesFromSupervisor[0];
      if (available) return { nextNodeId: available.to, reason: 'fallback: parse error' };
      return null;
    }
  }

  private getAllExitNodeIds(state: MultiAgentState): string[] {
    // 从已注册的 node 里找没有出边的 = exit nodes
    const hasOutgoing = new Set<string>();
    for (const edge of this.edgesFromSupervisor) {
      hasOutgoing.add(edge.to);
    }
    return Array.from(this.nodes.keys()).filter(id => !hasOutgoing.has(id));
  }
}
```

🤖 **常见错误**：AI 经常写一个"让 supervisor 自己干活"的实现——调 LLM 判断后直接在这个函数里执行子任务。这违反了"Supervisor 只决策不执行"的原则。Supervisor 必须自己不干活的理由是：它的 LLM 上下文被决策逻辑占满后，理解子任务的能力会下降。

🤖 **常见错误**：AI 经常在 `Supervisor.decide` 里做递归调用——"如果 LLM 选择了不存在的节点，再重新问一遍"。这会导致 Supervisor 的 LLM 上下文被之前的错误尝试填满，决策质量急剧下降。正确的做法是：解析失败用一个确定性的 fallback（选第一个可用节点），不重复问 LLM。

---

## 4. Worker 子 Agent 执行引擎

Worker 负责执行一个子 Agent。它需要的不是用户消息，而是从 Supervisor 来的"任务描述"，并且它的结果要写回共享状态，而不是直接给前端。

```typescript
// packages/core/src/orchestrator/worker.ts

import type { AgentNode, MultiAgentState } from './types';
import type { LLMStreamChunk } from '../llm/types';

/**
 * 执行一个子 Agent。输入是共享状态的快照，输出是 Agent 的纯文本响应。
 *
 * 为什么不直接调 AbstractAgent.run? 因为子 Agent 有两个差异：
 * 1. 它需要的不是用户消息，而是从 Supervisor 来的"任务描述"
 * 2. 它的结果要写回共享状态，而不是直接给前端
 */
export class Worker {
  constructor(private node: AgentNode) {}

  /**
   * 执行子 Agent，流式返回 token（前端需要展示谁在说什么）。
   * taskDescription 是 Supervisor 分配的具体任务。
   */
  async *execute(
    taskDescription: string,
    sharedState: Record<string, unknown>,
    signal?: AbortSignal
  ): AsyncGenerator<{ type: 'token'; content: string } | { type: 'done'; output: string }> {
    // 构造上下文：把共享状态摘要注入 system prompt
    const contextSummary = this.buildContextSummary(sharedState);
    const fullSystemPrompt = `${this.node.systemPrompt}\n\n## 当前共享上下文\n${contextSummary}`;

    // 把任务发给 LLM（带工具）
    const toolDefs = this.node.tools.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    let fullOutput = '';
    let pendingTools: Array<{ id: string; name: string; args: string }> = [];

    for await (const chunk of this.node.llm.stream(
      [{ role: 'user', content: taskDescription }],
      {
        systemPrompt: fullSystemPrompt,
        tools: toolDefs,
        maxTokens: this.node.maxOutputTokens ?? 2048,
        signal,
      }
    )) {
      if (chunk.type === 'token') {
        fullOutput += chunk.data.content;
        yield { type: 'token', content: chunk.data.content };
      }
      if (chunk.type === 'tool_call_end') {
        pendingTools.push({
          id: chunk.data.toolCallId,
          name: chunk.data.name,
          args: chunk.data.args,
        });
      }
    }

    // 处理工具调用（简化版：顺序执行，结果拼在输出后面）
    for (const tc of pendingTools) {
      const tool = this.node.tools.find(t => t.name === tc.name);
      if (!tool) continue;

      try {
        const result = await tool.execute(JSON.parse(tc.args || '{}'), {
          sessionId: `multi-agent-${this.node.id}`,
          signal,
        });
        fullOutput += `\n\n[Tool: ${tc.name} result]: ${JSON.stringify(result)}`;
      } catch {
        fullOutput += `\n\n[Tool: ${tc.name} error]: execution failed`;
      }
    }

    yield { type: 'done', output: fullOutput };
  }

  private buildContextSummary(shared: Record<string, unknown>): string {
    const entries = Object.entries(shared);
    if (entries.length === 0) return '(无上下文)';
    return entries
      .map(([key, value]) => {
        const display = typeof value === 'string' ? value.slice(0, 500) : JSON.stringify(value).slice(0, 500);
        return `### ${key}\n${display}`;
      })
      .join('\n\n');
  }
}
```

🔗 **工程逻辑**：`buildContextSummary` 把共享状态限制在 500 字符以内。为什么不传全量？因为每个子 Agent 的上下文窗口有限，如果共享状态有几万字，LLM 就没空间理解任务了。每个子 Agent 只应看到与自己相关的状态字段——后续优化时可以给 AgentNode 加 `relevantStateKeys: string[]` 过滤。

---

## 5. 编排器主循环

编排器是串联 Supervisor 和 Worker 的主循环，负责管理整体状态、轮数限制和 abort 信号。

```typescript
// packages/core/src/orchestrator/orchestrator.ts

import { nanoid } from 'nanoid';
import type {
  OrchestrationGraph, MultiAgentState, AgentResult, OrchestratorEvent
} from './types';
import { Supervisor } from './supervisor';
import { Worker } from './worker';
import type { LLMClient } from '../llm/types';

export class MultiAgentOrchestrator {
  private graph: OrchestrationGraph;
  private supervisor: Supervisor;
  private workers: Map<string, Worker>;

  constructor(config: {
    graph: OrchestrationGraph;
    supervisorLLM: LLMClient;
    nodeLLMProvider: (nodeId: string) => LLMClient;  // 每个节点可以有不同 LLM
  }) {
    this.graph = config.graph;
    this.supervisor = new Supervisor({
      llm: config.supervisorLLM,
      nodes: config.graph.nodes,
      edges: config.graph.edges,
    });
    this.workers = new Map(
      config.graph.nodes.map(n => [n.id, new Worker(n)])
    );
  }

  /**
   * 启动多 Agent 协作，返回事件流。
   * 前端通过 for await 消费：每完成一个节点就收到 token。
   */
  async *run(
    task: string,
    signal?: AbortSignal
  ): AsyncGenerator<OrchestratorEvent> {
    const initialState: MultiAgentState = {
      task,
      shared: {},
      results: {},
      currentNode: null,
      history: [],
      status: 'running',
      signal,
    };

    yield { type: 'state', state: initialState };

    let state = initialState;
    let lastResult: AgentResult | undefined;

    // 最大轮数 = 节点数 × 3（防止循环）
    const maxRounds = this.graph.nodes.length * 3;
    let round = 0;

    while (round < maxRounds) {
      if (signal?.aborted) {
        yield { type: 'error', error: 'Orchestration aborted' };
        return;
      }
      round++;

      // 1. Supervisor 决定下一步
      const decision = await this.supervisor.decide(state, lastResult);

      if (!decision) {
        // 没有 Agent 还需要跑 → 完成
        state.status = 'completed';
        yield { type: 'state', state: { ...state } };
        yield { type: 'done', results: state.results };
        return;
      }

      // 2. 检查目标节点是否存在
      const worker = this.workers.get(decision.nextNodeId);
      if (!worker) {
        yield { type: 'error', error: `Unknown node: ${decision.nextNodeId}` };
        return;
      }

      // 3. 执行节点
      state.currentNode = decision.nextNodeId;
      state.history.push({
        nodeId: decision.nextNodeId,
        event: 'start',
        timestamp: Date.now(),
      });

      yield { type: 'node_start', nodeId: decision.nextNodeId, nodeName: decision.nextNodeId };

      if (lastResult) {
        yield {
          type: 'handoff',
          from: lastResult.nodeId,
          to: decision.nextNodeId,
          reason: decision.reason,
        };
      }

      // 4. 构造任务描述给 worker
      const taskDesc = this.buildTaskDescription(state, decision);

      let nodeOutput = '';
      let nodeError: string | undefined;

      try {
        for await (const event of worker.execute(taskDesc, state.shared, signal)) {
          if (event.type === 'token') {
            yield { type: 'token', nodeId: decision.nextNodeId, content: event.content };
          }
          if (event.type === 'done') {
            nodeOutput = event.output;
          }
        }
      } catch (error) {
        nodeError = error instanceof Error ? error.message : 'Worker failed';
      }

      // 5. 记录结果
      const result: AgentResult = {
        nodeId: decision.nextNodeId,
        output: nodeOutput,
        status: nodeError ? 'failed' : 'completed',
        completedAt: Date.now(),
        error: nodeError,
      };
      state.results[decision.nextNodeId] = result;

      if (nodeError) {
        yield { type: 'node_fail', nodeId: decision.nextNodeId, error: nodeError };
        state.history.push({
          nodeId: decision.nextNodeId,
          event: 'fail',
          timestamp: Date.now(),
          detail: nodeError,
        });
        // 节点失败不终止整个编排，Supervisor 决定下一步怎么补偿
      } else {
        yield { type: 'node_complete', nodeId: decision.nextNodeId, output: nodeOutput };
        state.history.push({
          nodeId: decision.nextNodeId,
          event: 'complete',
          timestamp: Date.now(),
        });

        // 如果节点有写权限，共享它的结果
        const node = this.graph.nodes.find(n => n.id === decision.nextNodeId);
        if (node?.accessMode === 'read-write') {
          state.shared[decision.nextNodeId] = nodeOutput;
        }
      }

      lastResult = result;
    }

    // 超过最大轮数
    state.status = 'failed';
    yield { type: 'error', error: 'Maximum orchestration rounds reached' };
  }

  private buildTaskDescription(
    state: MultiAgentState,
    decision: { nextNodeId: string; reason: string }
  ): string {
    return `你的任务ID: ${decision.nextNodeId}
分配原因: ${decision.reason}

请执行你的工作，结果会自动加入共享上下文供后续 Agent 使用。

原始用户任务: ${state.task}`;
  }
}
```

---

## 6. 三种编排范式对比与选择

上面的 Supervisor + Worker 模式是最通用的。但不同场景有不同的最佳范式：

```typescript
// packages/core/src/orchestrator/paradigms.ts

/**
 * 范式一：Pipeline（流水线）
 * 适用：任务有明确的线性步骤，如"调研→写初稿→润色→审校"
 * 实现：固定边，Supervisor 不做 LLM 决策，按顺序执行
 */

export function createPipeline(graph: OrchestrationGraph) {
  return {
    type: 'pipeline',
    // Pipeline 不需要 Supervisor 的 LLM 决策
    async *run(orchestrator: MultiAgentOrchestrator, task: string, signal?: AbortSignal) {
      let currentNodeId = graph.entryNodeId;
      const visited = new Set<string>();

      while (currentNodeId && !visited.has(currentNodeId)) {
        visited.add(currentNodeId);
        // ... 执行当前节点
        // 找下一个节点（Pipeline 的 edge 只有一个）
        const nextEdge = graph.edges.find(e => e.from === currentNodeId);
        currentNodeId = nextEdge?.to ?? null;
      }
    },
  };
}

/**
 * 范式二：Debate（辩论协商）
 * 适用：有多种可能方案，如"选技术方案"、"产品决策"
 * 实现：两个 Agent 对同一问题给出方案 → 第三个 Agent 裁判出胜者
 */

export function createDebate(propponentIds: string[], judgeId: string) {
  return {
    type: 'debate',
    rounds: 2,
    // 每轮：proponents 分别陈述 → judge 给出反馈 → proponents 改进
    // 最后一轮：judge 直接选 winner
  };
}

/**
 * 范式三：Swarm（自由选择）
 * 适用：开放探索，如"创意发头脑风暴"、"开放式调研"
 * 实现：所有 Agent 同时拿到任务，各自并行执行 → 汇总
 * 特点：不确定性最高但创意空间最大
 */

export function createSwarm(participantIds: string[], aggregatorId: string) {
  return {
    type: 'swarm',
    // 所有 participant 并行启动（Promise.all）
    // 全部完成后由 aggregator 做汇总
  };
}
```

🔗 **工程逻辑**：三种范式的关键差异在于**并行度**。Pipeline 是 x=1（一次只有1个 Agent），Debate 是 x=2（两个并行对辩），Swarm 是 x=N（全部并行）。并行度越高，总耗时越短，但状态冲突的概率越大。如果你的团队同时改一个文件，Swarm 模式就会互相覆盖。按场景选：线性任务用 Pipeline，选方案用 Debate，创意发散用 Swarm。

**范式对比表：**

| 维度 | Pipeline | Debate | Swarm |
|------|----------|--------|-------|
| **适用场景** | 线性明确的任务 | 多方案选择 | 开放式探索 |
| **并行度** | 1 (串行) | 2-3 (并行对辩) | N (全部并行) |
| **Supervisor 复杂度** | 低 (固定路径) | 中 (需管理轮次) | 低 (并行+汇总) |
| **状态冲突风险** | 无 | 低 | 高 |
| **总耗时** | 长 (串行累加) | 中 | 短 (并行) |
| **输出确定性** | 高 | 中 | 低 |
| **实现难度** | 低 | 中 | 中高 |
| **典型失败模式** | 中间节点卡死 | 评委被带偏 | 产出碎片化 |

---

## 7. 多 Agent 前端可视化

```typescript
// apps/web/src/components/multi-agent/MultiAgentPanel.tsx

import { useEffect, useRef } from 'react';
import { useOrchestratorStore } from './orchestratorStore';

/** 多 Agent 执行面板：左侧图谱视图 + 右侧执行日志 */
export function MultiAgentPanel({ graph, task }: { graph: any; task: string }) {
  const { state, events, start, abort } = useOrchestratorStore();
  const logRef = useRef<HTMLDivElement>(null);

  // 自动滚动日志到底部
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [events]);

  return (
    <div className="multi-agent-panel grid grid-cols-[320px_1fr] h-full">
      {/* 左侧：图谱视图 */}
      <div className="border-r border-border p-4 overflow-y-auto">
        <AgentGraphView nodes={graph.nodes} state={state} />
      </div>

      {/* 右侧：执行日志 + 消息流 */}
      <div className="flex flex-col">
        <div className="p-3 border-b border-border flex justify-between">
          <h3 className="text-sm font-medium">协作执行</h3>
          <div className="flex gap-2">
            {state.status !== 'running' ? (
              <button onClick={() => start(task)} className="btn-sm btn-primary">
                启动协作
              </button>
            ) : (
              <button onClick={abort} className="btn-sm btn-danger">
                中止
              </button>
            )}
          </div>
        </div>

        {/* 消息流区域 */}
        <div ref={logRef} className="flex-1 overflow-y-auto p-4 space-y-2">
          {events.map((event, idx) => (
            <AgentEventLine key={idx} event={event} />
          ))}
        </div>

        {/* 状态概览 */}
        <StatusBar status={state.status} currentNode={state.currentNode} />
      </div>
    </div>
  );
}

/** 图谱视图：展示节点 + 边 + 实时高亮 */
function AgentGraphView({ nodes, state }: { nodes: any[]; state: any }) {
  return (
    <div className="relative">
      {nodes.map((node, idx) => {
        const isActive = state.currentNode === node.id;
        const result = state.results[node.id];
        const isCompleted = result?.status === 'completed';
        const isFailed = result?.status === 'failed';

        return (
          <div
            key={node.id}
            className={`
              rounded-lg p-3 mb-2 transition-all
              ${isActive ? 'ring-2 ring-accent bg-accent/10' : 'bg-surface'}
              ${isCompleted ? 'border-l-4 border-green-500' : ''}
              ${isFailed ? 'border-l-4 border-red-500' : ''}
            `}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-muted">{node.id}</span>
              {isActive && <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />}
            </div>
            <p className="text-xs mt-1 text-muted">{node.description}</p>
            {result?.output && (
              <div className="mt-2 text-xs bg-bg rounded p-2 max-h-20 overflow-hidden">
                {result.output.slice(0, 120)}...
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 单条事件渲染 */
function AgentEventLine({ event }: { event: any }) {
  switch (event.type) {
    case 'node_start':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="w-2 h-2 rounded-full bg-blue-400" />
          <span className="font-mono text-blue-400">{event.nodeName}</span>
          <span className="text-muted">开始执行</span>
        </div>
      );
    case 'handoff':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted">──▶</span>
          <span className="font-mono">{event.from}</span>
          <span className="text-muted">→</span>
          <span className="font-mono text-accent">{event.to}</span>
          <span className="text-muted">({event.reason})</span>
        </div>
      );
    case 'token':
      return (
        <div className="ml-4 text-sm leading-relaxed">
          <span className="font-mono text-xs text-muted">{event.nodeId}: </span>
          <span>{event.content}</span>
        </div>
      );
    case 'node_complete':
      return (
        <div className="flex items-center gap-2 text-xs text-green-400">
          <span className="w-2 h-2 rounded-full bg-green-400" />
          <span className="font-mono">{event.nodeId}</span>
          <span>完成</span>
        </div>
      );
    default:
      return null;
  }
}

// 右侧：状态栏
function StatusBar({ status, currentNode }: { status: string; currentNode: string | null }) {
  return (
    <div className="p-2 border-t border-border bg-surface text-xs flex justify-between">
      <span className="text-muted">状态: {status}</span>
      {currentNode && <span className="text-muted">当前: {currentNode}</span>}
    </div>
  );
}
```

### 编排器 Store（Zustand）

```typescript
// apps/web/src/components/multi-agent/orchestratorStore.ts

import { create } from 'zustand';

interface OrchestratorStoreState {
  state: any;
  events: any[];
  start: (task: string) => void;
  abort: () => void;
}

let abortController: AbortController | null = null;

export const useOrchestratorStore = create<OrchestratorStoreState>((set) => ({
  state: { status: 'idle', results: {}, currentNode: null, history: [] },
  events: [],

  start: (task: string) => {
    abortController = new AbortController();
    set({ state: { status: 'running', results: {}, currentNode: null, history: [] }, events: [] });

    (async () => {
      try {
        const response = await fetch('/api/orchestrate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ task, graphId: 'default-graph' }),
          signal: abortController.signal,
        });

        if (!response.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            if (!part.trim()) continue;
            const dataLine = part.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue;
            const json = JSON.parse(dataLine.slice(5).trim());

            if (json.type === 'state') {
              set({ state: json.data });
            } else {
              set((s) => ({ events: [...s.events, json] }));
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.error('Orchestrator error:', error);
        }
      }
    })();
  },

  abort: () => {
    abortController?.abort();
    set({ state: { status: 'idle' } });
  },
}));
```

---

## 8. 后端 Orchestrator API

```typescript
// apps/web/src/app/api/orchestrate/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';

// 项目中预定义的协作图
const GRAPHS: Record<string, any> = {
  'research-writer': {
    nodes: [
      {
        id: 'researcher',
        name: '研究员',
        description: '收集信息、整理资料',
        systemPrompt: '你是一个专业研究员。负责搜索和整理信息，输出结构化研究报告。',
        tools: ['web_search', 'file_read'],
        accessMode: 'read-write',
      },
      {
        id: 'writer',
        name: '写手',
        description: '根据研究资料撰写内容',
        systemPrompt: '你是一个专业写手。根据研究员的资料，撰写高质量文章内容。',
        tools: ['file_write'],
        accessMode: 'read-write',
      },
      {
        id: 'reviewer',
        name: '审稿人',
        description: '审核质量、提出修改建议',
        systemPrompt: '你是一个严格的审稿人。审核文章质量和准确性。',
        tools: [],
        accessMode: 'read-only',
      },
    ],
    edges: [
      { from: 'supervisor', to: 'researcher', condition: 'start' },
      { from: 'researcher', to: 'writer', always: true },
      { from: 'writer', to: 'reviewer', always: true },
    ],
    entryNodeId: 'researcher',
    exitNodeIds: ['reviewer'],
  },
};

export async function POST(req: NextRequest) {
  const { task, graphId } = await req.json();
  const graph = GRAPHS[graphId] ?? GRAPHS['research-writer'];

  // 实例化 orchestrator（实际应用里放在 module 层缓存）
  const orchestrator = createOrchestrator(graph, graphId);

  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort());

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
      };

      try {
        for await (const event of orchestrator.run(task, abortController.signal)) {
          send(event.type, event);
        }
      } catch (error) {
        send('error', { error: (error as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

---

## 9. 多 Agent 常见陷阱

### 陷阱一：子 Agent 死循环引用

当 Agent 图中存在环路且 Supervisor 的决策有随机性时，可能出现 A → B → A → B 的无限循环。

**防护措施**：
- `maxRounds` 硬上限（当前实现为 `nodes.length × 3`）
- 记录 `history` 并检查重复模式
- 对每个节点加 `maxVisits` 限制

```typescript
// 在 orchestrator 的 run 循环中添加：
const visitCount = new Map<string, int>();
// 每次执行节点前检查：
const count = visitCount.get(decision.nextNodeId) ?? 0;
if (count >= 2) {
  // 此节点已执行 2 次，跳过
  continue;
}
visitCount.set(decision.nextNodeId, count + 1);
```

### 陷阱二：Supervisor 自己干活

Supervisor 的 LLM 上下文被决策逻辑占满后，如果让它同时执行子任务，决策质量会急剧下降。

**原则**：Supervisor 必须只决策不执行。所有执行操作都通过 Worker 的子 Agent 完成。

### 陷阱三：竞态条件

当两个 Agent（在 Swarm 模式）同时写入 shared state 的同一个字段时，后写的会覆盖先写的。

**解决方案**：
- 给每个 Agent 分配独立的输出 key（如 `state.shared[agentId] = output`）
- 使用 `accessMode: 'read-only'` 限制只读 Agent
- 在 Pipeline 模式下不存在此问题（串行执行）

### 陷阱四：上下文膨胀

每个子 Agent 看到的是 buildContextSummary(整个 shared)，如果累积了几轮、每轮输出几千字，上下文会爆。

**解决方案**：
- 在 AgentNode 增加 `relevantStateKeys: string[]`，只注入相关字段
- 对共享状态做摘要压缩（调 LLM 总结之前的输出）
- 使用 memory 系统的向量检索替代全量注入（memory 系统详见 reference 03）

---

## 10. RAG 检索增强生成概览

LLM 不知道你公司内部的 API 文档、产品需求、技术方案。你回答"我们系统的退款流程是什么"，它会用互联网通识回答——这是错的。

RAG 的完整做法不是"把文档塞进 prompt"（那会爆上下文窗口），而是**按需检索、精准引用**——像人类的"先翻书再回答"。

🔗 **工程逻辑**：RAG 不是简单的"搜到就返回"。它的失败模式有三种：找不到（召回率低）、找错了（精度低）、找到了但被后续生成步骤丢弃（生成不参考检索结果）。本 reference 的每一层都在解决其中一种失败模式：分块解决"找不到"，Embedding + 重排序解决"找错"，HyDE + 生成 prompt 设计解决"丢弃"。

```
┌─────────────────────── 摄入层 ───────────────────────┐
│  PDF / MD / HTML / DOCX                              │
│       ↓ 解析                                          │
│  纯文本 + 元数据（标题、层级、来源）                   │
│       ↓ 分块                                          │
│  [chunk1] [chunk2] [chunk3] ... [chunkN]             │
│       ↓ Embedding                                     │
│  ┌──────────────────────────────────────────┐         │
│  │         Vector Store (向量数据库)         │         │
│  │  [0.23, -0.87, 0.41, ...] → chunk_idx   │         │
│  └──────────────────────────────────────────┘         │
└─────────────────────── 检索层 ───────────────────────┘
       │
       ↓ 查询向量化 + 相似度搜索 + 重排序
┌──────────────────────────────────────────────┐
│  Query → Top-K 召回 → Reranker → Final Top-N │
└──────────────────────────────────────────────┘
       │
       ↓ 拼装 prompt + 发给 LLM
┌──────────────────────────────────────────────┐
│  System: "基于以下上下文回答..."              │
│  Context: [chunk7, chunk3, chunk12]           │
│  User: "退款流程是什么?"                      │
└──────────────────────────────────────────────┘
```

---

## 11. 文档摄入与解析

文档摄入是 RAG 的第一步，需要支持多种格式并提取结构化的文档信息。

```typescript
// packages/core/src/rag/ingestion.ts

import { promises as fs } from 'fs';

/** 解析后的文档 */
export interface ParsedDocument {
  id: string;
  sourceName: string;        // 原始文件名
  sourceType: 'pdf' | 'markdown' | 'html' | 'docx' | 'text';
  /** 文档结构信息（按章节组织的树） */
  structure: DocumentSection[];
  /** 完整纯文本（去除格式标记后的线性文本） */
  rawText: string;
  /** 文档元数据 */
  metadata: {
    createdAt: number;
    pageCount?: number;
    author?: string;
    wordCount: number;
  };
}

export interface DocumentSection {
  level: number;      // h1=1, h2=2, ...
  title: string;
  content: string;    // 该章节的完整文本
  charStart: number;  // 在 rawText 中的起始位置
  charEnd: number;
}

/** 文档解析器接口 */
export interface DocumentParser {
  supportedTypes: string[];
  parse(buffer: Buffer, filename: string): Promise<ParsedDocument>;
}

/** Markdown 解析器 */
export class MarkdownParser implements DocumentParser {
  supportedTypes = ['text/markdown', 'text/plain'];

  async parse(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const text = buffer.toString('utf-8');
    const structure = this.extractSections(text);

    return {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sourceName: filename,
      sourceType: 'markdown',
      structure,
      rawText: text,
      metadata: {
        createdAt: Date.now(),
        wordCount: text.length,
      },
    };
  }

  private extractSections(text: string): DocumentSection[] {
    const lines = text.split('\n');
    const sections: DocumentSection[] = [];
    let currentSection: DocumentSection | null = null;
    let charOffset = 0;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        if (currentSection) {
          sections.push(currentSection);
        }
        const level = headingMatch[1].length;
        currentSection = {
          level,
          title: headingMatch[2].trim(),
          content: '',
          charStart: charOffset + line.length + 1,
          charEnd: 0,
        };
      } else if (currentSection) {
        currentSection.content += line + '\n';
        currentSection.charEnd = charOffset + line.length;
      }
      charOffset += line.length + 1;
    }
    if (currentSection) sections.push(currentSection);
    return sections;
  }
}

/** PDF 解析器（基于 pdf-parse 轻量库） */
export class PDFParser implements DocumentParser {
  supportedTypes = ['application/pdf'];

  async parse(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    // 实际项目中用 pdf-parse 或 @anthropic-ai/pdf
    // import pdfParse from 'pdf-parse';
    // const pdfData = await pdfParse(buffer);

    // 此处省略具体解析，返回结构体
    const rawText = buffer.toString('utf-8'); // 占位

    return {
      id: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sourceName: filename,
      sourceType: 'pdf',
      structure: [{ level: 1, title: filename, content: rawText, charStart: 0, charEnd: rawText.length }],
      rawText,
      metadata: {
        createdAt: Date.now(),
        wordCount: rawText.length,
      },
    };
  }
}

/** 解析器工厂 */
export class ParserRegistry {
  private parsers: DocumentParser[] = [
    new MarkdownParser(),
    new PDFParser(),
  ];

  getParser(filename: string, mimeType?: string): DocumentParser {
    const ext = filename.split('.').pop()?.toLowerCase();
    for (const parser of this.parsers) {
      if (parser.supportedTypes.includes(mimeType ?? '') ||
          parser.supportedTypes.some(t => t.includes(ext ?? ''))) {
        return parser;
      }
    }
    throw new Error(`Unsupported file type: ${filename}`);
  }
}
```

🤖 **常见错误**：AI 经常直接用 `element.textContent` 或 `fs.readFileSync().toString()` 处理所有文件类型。解析 PDF 需要专门的库（pdf-parse、pdfjs-dist），解析 DOCX 需要 mammoth。纯 `.toString()` 拿到的是二进制噪声，不可能产出有意义的嵌入向量。

---

## 12. 分块策略

分块是 RAG 质量最关键的一步。分得太大 → 一个块里包含多个主题，检索精度下降；分得太小 → 上下文被切断，LLM 回答缺乏完整信息。

```typescript
// packages/core/src/rag/chunking.ts

import type { ParsedDocument, DocumentSection } from './ingestion';

export interface Chunk {
  id: string;
  documentId: string;
  content: string;
  /** 在原文中的位置 */
  charStart: number;
  charEnd: number;
  /** 所属标题路径，如 ["产品文档", "支付模块", "退款流程"] */
  headingPath: string[];
  metadata: {
    chunkIndex: number;
    sourceName: string;
  };
}

/** 三种分块策略 */

/**
 * 策略一：固定大小分块
 * 最简单，但会切断句子/段落，导致语义不完整
 */
export class FixedSizeChunker {
  constructor(
    private chunkSize = 500,     // 每块约 500 字符
    private overlap = 50        // 相邻块重叠 50 字符
  ) {}

  chunk(doc: ParsedDocument): Chunk[] {
    const chunks: Chunk[] = [];
    const text = doc.rawText;
    let offset = 0;
    let idx = 0;

    while (offset < text.length) {
      const end = Math.min(offset + this.chunkSize, text.length);
      chunks.push({
        id: `${doc.id}_c${idx}`,
        documentId: doc.id,
        content: text.slice(offset, end).trim(),
        charStart: offset,
        charEnd: end,
        headingPath: this.findHeadingsForRange(doc, offset, end),
        metadata: { chunkIndex: idx, sourceName: doc.sourceName },
      });
      offset += this.chunkSize - this.overlap;
      idx++;
    }
    return chunks;
  }

  private findHeadingsForRange(doc: ParsedDocument, start: number, end: number): string[] {
    return doc.structure
      .filter(s => s.charStart <= start && s.charEnd > start)
      .sort((a, b) => b.level - a.level)
      .slice(0, 3)
      .map(s => s.title);
  }
}

/**
 * 策略二：按标题层级分块（推荐默认策略）
 * 优点：每个块在一个逻辑章节内，语义完整
 * 缺点：章节差异很大时会产生极长或极短的块
 */
export class HeadingBasedChunker {
  constructor(
    private maxChunkSize = 800,
    private minChunkSize = 100
  ) {}

  chunk(doc: ParsedDocument): Chunk[] {
    const chunks: Chunk[] = [];
    let headingStack: DocumentSection[] = [];

    for (const section of doc.structure) {
      // 维护标题栈：遇到同级或更高级标题时回退
      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1].level >= section.level
      ) {
        headingStack.pop();
      }
      headingStack.push(section);

      // 如果章节内容太大，按段落进一步拆分
      if (section.content.length > this.maxChunkSize) {
        const subChunks = this.splitOversizedSection(section, doc, headingStack);
        chunks.push(...subChunks);
      } else if (section.content.trim().length >= this.minChunkSize) {
        chunks.push({
          id: `${doc.id}_${chunks.length}`,
          documentId: doc.id,
          content: section.content.trim(),
          charStart: section.charStart,
          charEnd: section.charEnd,
          headingPath: headingStack.map(s => s.title),
          metadata: {
            chunkIndex: chunks.length,
            sourceName: doc.sourceName,
          },
        });
      }
    }
    return chunks;
  }

  private splitOversizedSection(
    section: DocumentSection,
    doc: ParsedDocument,
    headingStack: DocumentSection[]
  ): Chunk[] {
    const paragraphs = section.content.split(/\n\n+/);
    const chunks: Chunk[] = [];
    let buffer = '';

    for (const para of paragraphs) {
      if (buffer.length + para.length > this.maxChunkSize && buffer.length > 0) {
        chunks.push({
          id: `${doc.id}_${chunks.length}`,
          documentId: doc.id,
          content: buffer.trim(),
          charStart: section.charStart,
          charEnd: section.charEnd,
          headingPath: headingStack.map(s => s.title),
          metadata: { chunkIndex: chunks.length, sourceName: doc.sourceName },
        });
        buffer = para;
      } else {
        buffer += '\n\n' + para;
      }
    }
    if (buffer.trim().length >= this.minChunkSize) {
      chunks.push({
        id: `${doc.id}_${chunks.length}`,
        documentId: doc.id,
        content: buffer.trim(),
        charStart: section.charStart,
        charEnd: section.charEnd,
        headingPath: headingStack.map(s => s.title),
        metadata: { chunkIndex: chunks.length, sourceName: doc.sourceName },
      });
    }
    return chunks;
  }
}

/**
 * 策略三：语义分块（Semantic Chunking）
 * 每段文本算 embedding，看相邻段之间的语义距离
 * 语义距离突降 → 此处断开
 *
 * 优点：最符合"语义边界"，粒度自然
 * 缺点：需要全量算 embedding，成本高
 */
export class SemanticChunker {
  constructor(
    private similarityThreshold = 0.7,  // 低于此值时断裂
    private minChunkSize = 150,
    private maxChunkSize = 1000
  ) {}

  async chunk(
    doc: ParsedDocument,
    embedFn: (text: string) => Promise<number[]>
  ): Promise<Chunk[]> {
    // 1. 按段落切分
    const paragraphs = doc.rawText.split(/\n\n+/).filter(p => p.trim().length > 10);
    if (paragraphs.length === 0) return [];

    // 2. 算每个段落的 embedding（批量处理以减少 API 调用）
    const embeddings: number[][] = [];
    const batchSize = 32;
    for (let i = 0; i < paragraphs.length; i += batchSize) {
      const batch = paragraphs.slice(i, i + batchSize);
      const batchEmbeds = await Promise.all(batch.map(p => embedFn(p)));
      embeddings.push(...batchEmbeds);
    }

    // 3. 计算相邻段落的相似度，在低相似度处断开
    const breakpoints: number[] = [];
    for (let i = 1; i < embeddings.length; i++) {
      const similarity = cosineSimilarity(embeddings[i - 1]!, embeddings[i]!);
      if (similarity < this.similarityThreshold) {
        breakpoints.push(i);
      }
    }

    // 4. 按断点组成 chunk
    const chunks: Chunk[] = [];
    let startIdx = 0;
    for (const bp of breakpoints.concat([paragraphs.length])) {
      const segmentParas = paragraphs.slice(startIdx, bp);
      const content = segmentParas.join('\n\n');

      if (content.length >= this.minChunkSize) {
        // 如果仍然太长，按固定大小再切
        if (content.length > this.maxChunkSize) {
          const subChunks = this.splitFixed(content, doc, chunks.length);
          chunks.push(...subChunks);
        } else {
          chunks.push({
            id: `${doc.id}_${chunks.length}`,
            documentId: doc.id,
            content,
            charStart: 0,
            charEnd: 0,
            headingPath: [],
            metadata: { chunkIndex: chunks.length, sourceName: doc.sourceName },
          });
        }
      }
      startIdx = bp;
    }

    return chunks;
  }

  private splitFixed(text: string, doc: ParsedDocument, startIndex: number): Chunk[] {
    const chunks: Chunk[] = [];
    const size = this.maxChunkSize;
    for (let i = 0; i < text.length; i += size) {
      chunks.push({
        id: `${doc.id}_${startIndex + chunks.length}`,
        documentId: doc.id,
        content: text.slice(i, i + size).trim(),
        charStart: 0,
        charEnd: 0,
        headingPath: [],
        metadata: { chunkIndex: startIndex + chunks.length, sourceName: doc.sourceName },
      });
    }
    return chunks;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

🔗 **工程逻辑**：三种分块策略的成本差异巨大。Heading-Based 只需要正则解析，零 API 成本。Semantic Chunking 每篇文档要算 N 个 embedding（按段落数算），一篇 5000 字的文档可能需要 20-30 次 API 调用。建议：初期用 Heading-Based（零额外成本、效果过得去），数据量大了再换 Semantic Chunking（精度更高但成本线性增长）。

**分块策略对比表：**

| 维度 | Fixed Size | Heading-Based | Semantic Chunking |
|------|-----------|---------------|-------------------|
| **成本** | 零 API | 零 API | N×嵌入 API |
| **语义完整性** | 低（切断句子） | 高（章节内完整） | 最高（自然边界） |
| **块大小均匀性** | 均匀 | 不均匀 | 较均匀 |
| **实现复杂度** | 低 | 中 | 高 |
| **推荐场景** | 无结构文本 | 有标题层级的文档 | 高质量要求场景 |
| **chunk 数量** | 固定 | 取决于标题数 | 取决于语义断点数 |

---

## 13. Embedding 与向量存储

向量存储是 RAG 的知识库后端，负责存储文档块及其 embedding 向量，并提供相似度搜索能力。

```typescript
// packages/core/src/rag/vector-store.ts

import type { Chunk } from './chunking';

export interface VectorEntry {
  id: string;
  vector: number[];
  chunk: Chunk;
  /** 元数据过滤字段 */
  metadata: {
    documentId: string;
    sourceName: string;
    headingPath: string[];
    createdAt: number;
  };
}

export interface SearchResult {
  chunk: Chunk;
  score: number;
  vector?: number[];
}

/** 向量存储抽象接口 */
export interface VectorStore {
  upsert(entries: VectorEntry[]): Promise<void>;
  search(query: VectorQuery): Promise<SearchResult[]>;
  delete(documentId: string): Promise<void>;
  getDocumentChunkCount(documentId: string): Promise<number>;
  listDocuments(): Promise<Array<{ id: string; name: string; chunkCount: number }>>;
}

export interface VectorQuery {
  vector: number[];
  topK: number;
  filter?: {
    documentId?: string;
    sourceType?: string;
  };
}

/** 基于内存的向量存储（MVP 用，生产换 pgvector / Milvus / Qdrant） */
export class InMemoryVectorStore implements VectorStore {
  private entries: VectorEntry[] = [];

  async upsert(entries: VectorEntry[]): Promise<void> {
    // 先删除同 documentId 的旧条目
    const newDocIds = new Set(entries.map(e => e.metadata.documentId));
    this.entries = this.entries.filter(e => !newDocIds.has(e.metadata.documentId));
    this.entries.push(...entries);
  }

  async search(query: VectorQuery): Promise<SearchResult[]> {
    let candidateEntries = this.entries;

    // 元数据过滤
    if (query.filter?.documentId) {
      candidateEntries = candidateEntries.filter(
        e => e.metadata.documentId === query.filter!.documentId
      );
    }

    // 暴力搜索余弦相似度
    const scored = candidateEntries.map(entry => ({
      chunk: entry.chunk,
      score: cosineSimilarity(query.vector, entry.vector),
      vector: entry.vector,
    }));

    // 按分数排序，返回 topK
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.topK);
  }

  async delete(documentId: string): Promise<void> {
    this.entries = this.entries.filter(e => e.metadata.documentId !== documentId);
  }

  async getDocumentChunkCount(documentId: string): Promise<number> {
    return this.entries.filter(e => e.metadata.documentId === documentId).length;
  }

  async listDocuments(): Promise<Array<{ id: string; name: string; chunkCount: number }>> {
    const docMap = new Map<string, { name: string; count: number }>();
    for (const entry of this.entries) {
      const existing = docMap.get(entry.metadata.documentId);
      if (existing) {
        existing.count++;
      } else {
        docMap.set(entry.metadata.documentId, {
          name: entry.metadata.sourceName,
          count: 1,
        });
      }
    }
    return Array.from(docMap.entries()).map(([id, val]) => ({
      id,
      name: val.name,
      chunkCount: val.count,
    }));
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

## 14. 检索增强生成引擎

核心检索引擎：把查询变成向量 → 检索 → 重排序 → 拼装 prompt。其中包含 HyDE (Hypothetical Document Embeddings) 增强检索技术。

```typescript
// packages/core/src/rag/retriever.ts

import type { LLMClient } from '../llm/types';
import type { VectorStore, SearchResult, VectorQuery } from './vector-store';
import type { Chunk } from './chunking';

/**
 * HyDE (Hypothetical Document Embeddings)
 * 核心思路：用户查询和文档的 embedding 风格不同（问题 vs 陈述句）
 * 用 LLM 先"编"一个假答案 → 对假答案做 embedding → 用这个向量去搜
 * 为什么有效：假答案的 embedding 分布更接近真实文档的 embedding 分布
 *
 * 来源：Gao et al., 2022 "Precise Zero-Shot Dense Retrieval without Relevance Labels"
 */
export class HyDERetriever {
  constructor(
    private llm: LLMClient,
    private vectorStore: VectorStore,
    private embedFn: (text: string) => Promise<number[]>
  ) {}

  async retrieve(query: string, topK: number = 5): Promise<SearchResult[]> {
    // 1. 生成假答案（hypothetical document）
    let hypotheticalDoc = '';
    for await (const chunk of this.llm.stream(
      [{
        role: 'user',
        content: `针对问题"${query}"，写一段可能是正确答案的摘要。只输出答案，不要其他内容。`,
      }],
      { maxTokens: 200 }
    )) {
      if (chunk.type === 'token') {
        hypotheticalDoc += (chunk.data as { content: string }).content;
      }
    }

    // 2. 对假答案做 embedding
    const queryVector = await this.embedFn(hypotheticalDoc);

    // 3. 用假答案的向量检索
    return this.vectorStore.search({
      vector: queryVector,
      topK: topK * 2,  // 多取一些，留给重排序筛
    });
  }
}

/**
 * Retriever 主类：组合 HyDE + 基础检索 + 重排序
 */
export class RAGRetriever {
  constructor(
    private vectorStore: VectorStore,
    private embedFn: (text: string) => Promise<number[]>,
    private hydeRetriever?: HyDERetriever,
    private rerankFn?: (query: string, results: SearchResult[]) => Promise<SearchResult[]>
  ) {}

  async retrieve(query: string, options: {
    topK?: number;
    useHyDE?: boolean;
    useRerank?: boolean;
    filter?: VectorQuery['filter'];
  } = {}): Promise<SearchResult[]> {
    const topK = options.topK ?? 5;

    // 第一轮检索
    let candidates: SearchResult[];

    if (options.useHyDE && this.hydeRetriever) {
      candidates = await this.hydeRetriever.retrieve(query, topK);
    } else {
      const queryVector = await this.embedFn(query);
      candidates = await this.vectorStore.search({
        vector: queryVector,
        topK: topK * 2,
        filter: options.filter,
      });
    }

    // 重排序
    if (options.useRerank && this.rerankFn) {
      candidates = await this.rerankFn(query, candidates);
    }

    return candidates.slice(0, topK);
  }

  /**
   * 把检索结果拼装成 prompt 上下文
   * 关键：每个 chunk 包含来源信息，LLM 可以引用
   */
  buildContext(results: SearchResult[]): string {
    if (results.length === 0) return '(未找到相关文档)';

    return results
      .map((r, idx) => {
        const source = r.chunk.metadata.sourceName;
        const headings = r.chunk.headingPath.join(' > ');
        return `[来源 ${idx + 1}: ${source} / ${headings}]\n${r.chunk.content}`;
      })
      .join('\n\n---\n\n');
  }
}
```

---

## 15. RAG 管道编排

把摄入 + 分块 + 嵌入 + 存储串起来，形成完整的 RAG 管道。

```typescript
// packages/core/src/rag/pipeline.ts

import type { ParsedDocument } from './ingestion';
import type { Chunk } from './chunking';
import { InMemoryVectorStore, type VectorStore, type VectorEntry } from './vector-store';
import { RAGRetriever } from './retriever';
import type { DocumentParser, ParserRegistry } from './ingestion';

export class RAGPipeline {
  private vectorStore: VectorStore;
  private parserRegistry: ParserRegistry;
  private embedFn: (text: string) => Promise<number[]>;
  private retriever: RAGRetriever;

  constructor(config: {
    vectorStore: VectorStore;
    parserRegistry: ParserRegistry;
    embedFn: (text: string) => Promise<number[]>;
  }) {
    this.vectorStore = config.vectorStore;
    this.parserRegistry = config.parserRegistry;
    this.embedFn = config.embedFn;
    this.retriever = new RAGRetriever(this.vectorStore, config.embedFn);
  }

  /** 摄入一篇文档：解析 → 分块 → 嵌入 → 存储 */
  async ingest(buffer: Buffer, filename: string): Promise<{ documentId: string; chunkCount: number }> {
    // 1. 解析
    const parser = this.parserRegistry.getParser(filename);
    const doc: ParsedDocument = await parser.parse(buffer, filename);

    // 2. 分块（默认用标题层级策略）
    const chunker = new HeadingBasedChunker(800, 100);
    const chunks: Chunk[] = chunker.chunk(doc);

    // 3. Embedding（批量，控制并发）
    const vectorEntries: VectorEntry[] = [];
    const batchSize = 16;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const vectors = await Promise.all(batch.map(c => this.embedFn(c.content)));

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        vectorEntries.push({
          id: chunk.id,
          vector: vectors[j]!,
          chunk,
          metadata: {
            documentId: doc.id,
            sourceName: doc.sourceName,
            headingPath: chunk.headingPath,
            createdAt: Date.now(),
          },
        });
      }
    }

    // 4. 存储
    await this.vectorStore.upsert(vectorEntries);

    return { documentId: doc.id, chunkCount: chunks.length };
  }

  /** 检索并生成增强 prompt */
  async searchAndAugment(query: string): Promise<{
    context: string;
    sources: Array<{ name: string; heading: string; score: number }>;
  }> {
    const results = await this.retriever.retrieve(query, { topK: 5 });
    const context = this.retriever.buildContext(results);
    const sources = results.map(r => ({
      name: r.chunk.metadata.sourceName,
      heading: r.chunk.headingPath.join(' > ') || '(根)',
      score: Math.round(r.score * 100) / 100,
    }));

    return { context, sources };
  }

  /** 删除文档 */
  async removeDocument(documentId: string): Promise<void> {
    await this.vectorStore.delete(documentId);
  }

  async getDocumentList() {
    return this.vectorStore.listDocuments();
  }
}
```

🤖 **常见错误**：AI 经常在 `ingest` 里忘记去重新旧版本的 chunk。如果用户上传一份"产品手册 v2"，旧版本 v1 的 chunk 仍然在向量库里。下次搜索时，v1 和 v2 的内容可能返回相同的 chunk，但 v1 的信息是过期的。必须在 `upsert` 之前先 `delete(documentId)` 清理旧数据。当前 `InMemoryVectorStore.upsert` 已在开头做了这个清理，但如果是外部向量数据库，需要确认是否也做了同样处理。

---

## 16. RAG 前端知识库管理

```typescript
// apps/web/src/components/rag/KnowledgeBase.tsx

import { useState, useCallback } from 'react';
import { useKnowledgeStore } from './knowledgeStore';

export function KnowledgeBase() {
  const { documents, uploadFile, deleteDoc, retrieveTest } = useKnowledgeStore();
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    for (const file of Array.from(files)) {
      const buffer = await file.arrayBuffer();
      const formData = new FormData();
      formData.append('file', file);

      await fetch('/api/rag/ingest', {
        method: 'POST',
        body: formData,
      });
    }
    // 刷新文档列表
    window.location.reload();
  }, []);

  const handleSearch = useCallback(async () => {
    if (!query.trim()) return;
    setIsSearching(true);

    try {
      const resp = await fetch('/api/rag/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, topK: 5 }),
      });
      const data = await resp.json();
      setSearchResults(data.results);
    } finally {
      setIsSearching(false);
    }
  }, [query]);

  return (
    <div className="knowledge-base p-4 space-y-6">
      {/* 上传区域 */}
      <div className="border-2 border-dashed border-border rounded-lg p-8 text-center">
        <input
          type="file"
          multiple
          accept=".md,.pdf,.docx,.txt"
          onChange={handleUpload}
          className="hidden"
          id="kb-upload"
        />
        <label htmlFor="kb-upload" className="cursor-pointer text-muted hover:text-accent">
          拖拽或点击上传文档（支持 PDF / Markdown / DOCX）
        </label>
      </div>

      {/* 文档列表 */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">已上传文档</h3>
        {documents.map(doc => (
          <div key={doc.id} className="flex items-center justify-between p-3 rounded-lg bg-surface">
            <div>
              <span className="text-sm font-medium">{doc.name}</span>
              <span className="ml-2 text-xs text-muted">{doc.chunkCount} 个分块</span>
            </div>
            <button
              onClick={() => deleteDoc(doc.id)}
              className="text-xs text-red-400 hover:text-red-300"
            >
              删除
            </button>
          </div>
        ))}
        {documents.length === 0 && (
          <p className="text-sm text-muted">尚未上传任何文档</p>
        )}
      </div>

      {/* 检索测试 */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">检索测试</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="输入查询测试检索效果..."
            className="flex-1 px-3 py-2 bg-surface border border-border rounded text-sm"
          />
          <button
            onClick={handleSearch}
            disabled={isSearching}
            className="px-4 py-2 bg-accent text-sm rounded disabled:opacity-50"
          >
            {isSearching ? '检索中...' : '搜索'}
          </button>
        </div>

        {/* 检索结果 */}
        {searchResults.length > 0 && (
          <div className="space-y-3 mt-4">
            {searchResults.map((result, idx) => (
              <div key={idx} className="p-3 bg-surface rounded-lg border border-border">
                <div className="flex justify-between text-xs text-muted mb-2">
                  <span>来源: {result.source}</span>
                  <span>相似度: {result.score}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{result.content.slice(0, 300)}...</p>
                {result.headingPath && (
                  <div className="mt-2 text-xs text-accent">
                    {result.headingPath.join(' > ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

---

## 17. RAG 后端 API

```typescript
// apps/web/src/app/api/rag/ingest/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { RAGPipeline } from '@agentcore/rag/pipeline';
import { getRAGPipeline } from '../rag-singleton';

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get('file') as File;

  if (!file) {
    return NextResponse.json({ error: 'file required' }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const pipeline = getRAGPipeline();

  try {
    const result = await pipeline.ingest(buffer, file.name);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}

// apps/web/src/app/api/rag/search/route.ts
export async function POST(req: NextRequest) {
  const { query, topK } = await req.json();

  if (!query) {
    return NextResponse.json({ error: 'query required' }, { status: 400 });
  }

  const pipeline = getRAGPipeline();
  const results = await pipeline.searchAndAugment(query);

  return NextResponse.json({
    results: results.context ? [{
      content: results.context,
      score: 0.99,
      source: results.sources.map(s => s.name).join(', '),
      headingPath: results.sources[0]?.heading?.split(' > '),
    }] : [],
    sources: results.sources,
  });
}
```

---

## 18. RAG 常见陷阱

### 陷阱一：跨版本污染

用户上传文档的新版本时，旧版本的 chunk 仍然在向量库中。检索时可能返回过期的内容。

**防护**：`upsert` 操作在插入新向量之前必须先 `delete(documentId)` 清理旧数据。当前 `InMemoryVectorStore.upsert` 已实现此逻辑。

### 陷阱二：embedding 模型不一致

摄入时用的 embedding 模型与检索时用的不一样 → 向量空间完全不同 → 检索结果随机。

**防护**：在系统配置中固定 embedding 模型，切换模型时全量重新摄入。

### 陷阱三：chunk 丢失上下文

分块后，某个 chunk 可能在语义上依赖上一个 chunk（比如"如上所述..."），但检索时只返回了这一个 chunk，LLM 看不懂。

**防护**：使用 overlap（相邻块重叠一部分），或在检索到 chunk 时同时返回前后相邻块（context expansion）。

### 陷阱四：文档格式解析失败

PDF 中的表格、图片、列布局等复杂格式，用简单库解析会产出乱码。

**防护**：对于复杂 PDF，使用专门的文档解析服务（如 Unstructured、Marker 等），或要求用户上传 Markdown 等格式化文本。

### 陷阱五：向量库规模膨胀

MVP 阶段用内存向量库没问题，但生产环境数据量大时需要迁移。

**防护**：通过 `VectorStore` 抽象接口解耦，生产环境切换为 pgvector、Milvus 或 Qdrant 等持久化向量数据库，代码只需替换实现类。

---

## 19. 最佳实践总结

### 多 Agent 协作

1. **Supervisor 只决策不执行** — 保持决策上下文的纯净
2. **maxRounds 硬限制** — 防止循环永不停止
3. **节点失败不终止编排** — Supervisor 决定下一步怎么补偿
4. **Pipeline 是默认选择** — 简单、确定性强，除非有明确理由用 Debate 或 Swarm
5. **前端实时可视化** — 展示节点高亮、执行日志和 handoff 消息流
6. **共享状态要精简** — 每个子 Agent 只看到与自己相关的字段

### RAG 检索增强

1. **Heading-Based 分块是性价比最高的选择** — 零 API 成本、按章节边界断开
2. **HyDE 显著提升检索精度** — 尤其是查询和文档风格差异大时
3. **每次 upsert 前清理旧数据** — 防止跨版本污染
4. **embedding 模型固定** — 切换模型需要全量重建索引
5. **来源信息不可省略** — 每个 chunk 必须带 sourceName + headingPath，让 LLM 可引用
6. **先用内存向量存储验证效果** — 再按规模迁移到 pgvector/Milvus/Qdrant

### 与 Agent 系统的集成

多 Agent 协作中的"研究员"角色可以直接接入 RAG 系统——不是用泛泛的搜索工具，而是基于私有知识库的高精度检索。研究员 Agent 的工具列表中可以加入 `rag_search` 工具，背后调用 `RAGPipeline.searchAndAugment`。这样研究员产出的内容就基于可靠的内部知识，而不是 LLM 的幻觉。

当 RAG 检索到内部文档后，如果 Agent 要对检索结果做出修改数据库等高风险操作，就需要进入 HITL 审批流程（详见 [06-hitl-reflection.md](./06-hitl-reflection.md)）。

---


