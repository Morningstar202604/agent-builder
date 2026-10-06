# 18 — 框架集成与对比 · LangGraph · CrewAI · AutoGen · CAMEL · MetaGPT

> 目标：五个主流 Agent 框架各有长短。不要"为了用框架而用框架"，而是根据场景选择最合适的，并以本项目 AbstractAgent 为核心实现"本项目为主、框架为辅"的混用架构。

---

## 目录

- [1. 框架全景对比 Matrix](#1-框架全景对比-matrix)
- [2. LangGraph 集成指南](#2-langgraph-集成指南)
- [3. CrewAI 集成指南](#3-crewai-集成指南)
- [4. AutoGen 集成指南](#4-autogen-集成指南)
- [5. 实战混用策略](#5-实战混用策略)
- [6. 切换成本评估矩阵](#6-切换成本评估矩阵)
- [7. 前端：Framework 适配器面板](#7-前端framework-适配器面板)
- [8. 避坑汇总](#8-避坑汇总)

---

## 1. 框架全景对比 Matrix

### 1.1 五框架 × 六维度评测

| 维度 | LangGraph | CrewAI | AutoGen | CAMEL | MetaGPT |
|------|-----------|--------|---------|-------|---------|
| **架构哲学** | 图编排——一切皆节点+边，状态机驱动 | 角色协作——Crew/Agent/Task 三件套 | 对话代理——ConversableAgent 消息传递 | 角色扮演——两 Agent 对话涌现智能 | 流水线——SOP 驱动多角色串行 |
| **状态管理** | 显式 StateGraph，类型安全，可持久化 checkpoint | 隐式状态，由框架内部管理，不可细粒度干预 | 基于消息列表，无结构化状态 | 对话历史即状态，无外部存储 | 显式 Message Pool，按 SOP 流转 |
| **调试体验** | LangSmith trace 可视化极强，每节点耗时/输入输出可查 | 日志丰富但无可视化工具，需自己做 trace | verbose 模式输出极多，无结构化 UI | 对话日志可读性好，但无结构化调试 | 中间产物文件化，可手动追溯 |
| **社区** | 最大、最活跃，LangChain 生态直接赋能 | 快速增长，企业用户多，但底层控制力弱 | 微软背书，学术圈流行，生产案例偏少 | 学术导向，社区小但专注 | 中文社区强，国际偏弱 |
| **文档质量** | 示例多但有版本碎片化问题（0.2 vs 0.3 API 不兼容） | 上手快，深度不足，高级用法需读源码 | 文档分散在论文和代码间，新手门槛高 | 文档薄，论文比文档清楚 | 中文文档好，英文文档滞后 |
| **适用场景** | 复杂工作流、状态机、需要持久化/恢复的 Agent | 快速原型、角色化团队协作 | 代码生成验证、多 Agent 对话实验 | 对话模拟、数据生成、研究 | 软件工程 SOP 自动化 |

### 1.2 选型决策树

```
你的需求是什么？
├── 需要持久化/断点恢复 → LangGraph
├── 快速搭建角色化多 Agent 原型 → CrewAI
├── 代码生成+验证循环（测试驱动） → AutoGen
├── 对话数据生成/角色扮演研究 → CAMEL
├── 软件工程流程自动化（需求→代码→测试） → MetaGPT
└── 以上都包含，且需要统一架构 → 本项目 AbstractAgent 为主 + 框架桥接
```

### 1.3 核心抽象映射

| 本项目 | LangGraph | CrewAI | AutoGen | CAMEL | MetaGPT |
|--------|-----------|--------|---------|-------|---------|
| AbstractAgent | Graph Node | Agent | ConversableAgent | RolePlaying | Role |
| ToolRegistry | Node 内工具调用 | Task.tools | function_map | 工具作为 Role 能力 | Action |
| MemoryManager | Checkpoint / Store | Memory (short/long) | chat_messages_history | chat_history | MessagePool |
| AgentTool | Tool Node | Tool | FunctionTool | 工具描述 | Action |
| AgentEvent | Stream Event | 无直接对应 | 消息事件 | 消息事件 | Message |

---

## 2. LangGraph 集成指南

### 2.1 核心思路：把 AbstractAgent 包装成 LangGraph Node

你不应该因为上了 LangGraph 就重写所有 Agent 逻辑。正确做法是把 `AbstractAgent` 作为 LangGraph 图中的一个"超级节点"，让 LangGraph 负责编排、持久化和恢复，让 AbstractAgent 负责推理、工具调用和记忆管理。

🔗 **工程逻辑**：LangGraph 的核心价值是"checkpoint"——每个节点执行后可以持久化状态，断线恢复时从断点续跑。把这个能力叠加到你的 AbstractAgent 上，就实现了第 21 章（fault-recovery.md）要做的状态快照——而且是复用成熟生态，不是自己造轮子。

### 2.2 桥接实现

```typescript
// packages/core/src/frameworks/langgraph-bridge.ts

import { StateGraph, END, START, Annotation, CheckpointSaver } from '@langchain/langgraph';
import z from 'zod';
import { AbstractAgent } from '../agent/abstract-agent';
import { MemoryManager } from '../memory/memory-manager';

/**
 * LangGraph 状态定义。
 * messages 字段与 LangChain Message 格式兼容，
 * 这让 LangSmith 的 trace 展示直接可用。
 */
const AgentState = Annotation.Root({
  messages: Annotation<Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  currentInput: Annotation<string>({ default: () => '' }),
  toolResults: Annotation<Array<{ tool: string; result: string }>>({
    default: () => [],
    reducer: (left, right) => left.concat(right),
  }),
  metadata: Annotation<Record<string, unknown>>({
    default: () => ({}),
    reducer: (left, right) => ({ ...left, ...right }),
  }),
});

type AgentStateType = typeof AgentState.State;

/**
 * 将 AbstractAgent 包装为 LangGraph 节点。
 *
 * 这个桥接的关键约定：
 * 1. AbstractAgent 的工具调用不会直接修改外部状态
 * 2. 每次调用返回 LangGraph 兼容的状态更新
 * 3. 抽象层泄漏时（如 LangGraph 的 Send API），提供 fallback
 */
export function createAgentNode(
  agent: AbstractAgent,
  options: {
    name?: string;
    maxToolCalls?: number;
  } = {},
) {
  const { name = 'agent_node', maxToolCalls = 10 } = options;

  return async function agentNode(
    state: AgentStateType,
    config?: { configurable?: { thread_id?: string } },
  ): Promise<Partial<AgentStateType>> {
    const userMessage = state.currentInput;
    if (!userMessage && state.messages.length === 0) {
      return {}; // 空输入不处理
    }

    const inputs = userMessage || state.messages[state.messages.length - 1]?.content || '';

    // 调用 AbstractAgent，收集所有 Assitant 产物
    const assistantContent: string[] = [];
    const toolResults: Array<{ tool: string; result: string }> = [];
    let callCount = 0;

    const generator = agent.run(inputs, {
      // 复用 LangGraph 的 thread_id 作为 session_id
      sessionId: config?.configurable?.thread_id,
    });

    for await (const event of generator) {
      if (event.type === 'assistant_message') {
        assistantContent.push(event.content);
      } else if (event.type === 'tool_result') {
        toolResults.push({ tool: event.toolName, result: event.result });
        callCount++;
        if (callCount >= maxToolCalls) {
          assistantContent.push('\n[达到工具调用上限，中断执行]');
          break;
        }
      }
    }

    return {
      messages: [
        { role: 'assistant', content: assistantContent.join('') },
      ],
      toolResults,
    };
  };
}

/**
 * 构建完整的 Agent 图。
 *
 * 这是一个最简单的单节点图。实际场景下可扩展为：
 * START → router → [research_node, coding_node, ...] → END
 * 每个节点内部都是独立的 AbstractAgent 实例。
 */
export function buildAgentGraph(
  agent: AbstractAgent,
  checkpointer?: CheckpointSaver,
) {
  const graph = new StateGraph(AgentState)
    .addNode('main_agent', createAgentNode(agent))
    .addEdge(START, 'main_agent')
    .addEdge('main_agent', END);

  // checkpointer 即为 LangGraph 的持久化引擎
  // 传入后，每个节点执行结束自动做 checkpoint
  return graph.compile({ checkpointer });
}

/**
 * 辅助函数：以流式方式运行图。
 * 返回 AsyncGenerator，供 SSE API 消费。
 */
export async function* streamAgentGraph(
  graph: ReturnType<typeof buildAgentGraph>,
  input: string,
  threadId: string,
): AsyncGenerator<{ type: string; data: unknown }> {
  const stream = graph.stream(
    { currentInput: input },
    { configurable: { thread_id: threadId } },
  );

  for await (const chunk of stream) {
    // LangGraph 的 chunk 格式是 { nodeName: state } 的 map
    for (const [nodeName, nodeState] of Object.entries(chunk)) {
      yield {
        type: 'node_update',
        data: { node: nodeName, state: nodeState },
      };
    }
  }
}
```

### 2.3 与 LangGraph Checkpoint 配合

```typescript
// packages/core/src/frameworks/langgraph-checkpoint.ts

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createPool } from '@vercel/postgres';

/**
 * LangGraph 的 Checkpoint 持久化到 Postgres。
 * 这取代了你自己手写的状态快照（见 fault-recovery.md Chapter 1），
 * 因为 LangGraph 做了更完善的实现——包括状态版本控制、分支恢复。
 */
export async function createPostgresCheckpointer(connectionString: string) {
  const pool = createPool({ connectionString });

  const checkpointer = new PostgresSaver(pool);

  // checkpointer.setup() 创建 checkpoint 相关的表
  // 幂等操作——重复调用不会报错
  await checkpointer.setup();

  return checkpointer;
}
```

### 2.4 路由节点设计

```typescript
// packages/core/src/frameworks/langgraph-router.ts

/**
 * LangGraph 路由：根据用户输入选择执行哪个专家 Agent。
 *
 * 这是"本项目为主、框架为辅"的核心——
 * 用 LangGraph 的 router 决定走哪条路径，
 * 路径上的每个节点是本项目的 AbstractAgent。
 */

export function createRouterNode(
  routes: Array<{
    name: string;
    description: string;
    keywords: string[];
  }>,
) {
  return async function routerNode(state: { currentInput: string }) {
    const input = state.currentInput.toLowerCase();

    for (const route of routes) {
      if (route.keywords.some((kw) => input.includes(kw))) {
        return { selectedRoute: route.name };
      }
    }

    return { selectedRoute: 'general' };
  };
}
```

🤖 **AI 常见错误**：
1. **把整个 AbstractAgent 重写成 LangChain 的 AgentExecutor**：桥梁工程应该是"包装"不是"替换"。你已经花了几百行构建了 MemoryManager、ToolRegistry、Skills system——这些不该因为换框架而丢。
2. **忘记 LangGraph 的 reducer 语义**：`Annotation` 的 `reducer` 决定了多次节点的更新如何累加。默认的 "replace" 语义会让前一个节点的消息被覆盖，必须用 `concat` 或自定义 reducer。

---

## 3. CrewAI 集成指南

### 3.1 核心思路：Crew/Agent/Task 映射

CrewAI 的三件套适合"并行分工"场景——让多个 Agent 同时处理一个任务的不同方面。但 CrewAI 缺乏对 Memory 和 Tool 的精细控制，所以正确用法是把 CrewAI 当作"协调层"，每个 Agent 内部调本项目的 `AbstractAgent`。

🔗 **工程逻辑**：CrewAI 的 `Process.parallel` 可以在一个 Crew 内部并行执行多个 Agent——这在做"多角度分析"时很有用（如同时进行安全审计、性能审计、代码风格审计）。但 CrewAI 的记忆系统远不如你已有的 MemoryManager，所以 Agent 的记忆管理应走你自己的体系。

### 3.2 桥接实现

```typescript
// packages/core/src/frameworks/crewai-bridge.ts

import { Crew, Agent as CrewAgent, Task } from 'crewai';
import { AbstractAgent } from '../agent/abstract-agent';
import { ToolRegistry } from '../tools/tool-registry';
import { MemoryManager } from '../memory/memory-manager';

/**
 * 将本项目的工具转换为 CrewAI Agent 可消费的 tool。
 *
 * CrewAI 的工具定义是一个带有 description + func 的对象。
 * 我们用代理模式把调用转发到本项目的 ToolRegistry。
 */
function convertToolsToCrewAI(toolRegistry: ToolRegistry, toolNames: string[]) {
  return toolNames.map((name) => {
    const meta = toolRegistry.getMeta(name);
    return {
      name,
      description: meta?.description ?? `Execute ${name}`,
      func: async (input: string) => {
        const result = await toolRegistry.call(name, JSON.parse(input));
        return JSON.stringify(result);
      },
    };
  });
}

/**
 * 构建 CrewAI 的 Agent 配置——但不实际创建 CrewAI 的 Agent 对象，
 * 而是返回配置，让你在编排时有完全控制权。
 */
export function buildCrewAgentConfig(
  abstractAgent: AbstractAgent,
  toolRegistry: ToolRegistry,
  options: {
    role: string;
    goal: string;
    backstory: string;
    tools: string[];
    allowDelegation?: boolean;
  },
) {
  return {
    role: options.role,
    goal: options.goal,
    backstory: options.backstory,
    tools: convertToolsToCrewAI(toolRegistry, options.tools),
    // CrewAI Agent 的 llm 工厂——我们用闭包调 AbstractAgent
    llm: undefined as unknown, // 占位，实际通过 custom 执行器注入
    allow_delegation: options.allowDelegation ?? false,
    // 自定义执行器：绕过 CrewAI 的 LLM 调用，直接走 AbstractAgent
    executeTask: async (taskDescription: string) => {
      const results: string[] = [];
      const generator = abstractAgent.run(taskDescription);
      for await (const event of generator) {
        if (event.type === 'assistant_message') {
          results.push(event.content);
        }
      }
      return results.join('\n');
    },
  };
}

/**
 * 推荐模式：CrewAI 仅用于任务分配，执行走 AbstractAgent。
 *
 * 创建 Crew 时用 delegate=false，在我们自己的编排层里完成工具调用。
 * 这是"本项目为主"的核心体现。
 */
export function createResearchCrew(config: {
  researcher: AbstractAgent;
  writer: AbstractAgent;
  reviewer: AbstractAgent;
  toolRegistry: ToolRegistry;
  memory: MemoryManager;
}): { run: (topic: string) => AsyncGenerator<string> } {
  // CrewAI 的 Agent 定义仅作为任务模板
  const researcherConfig = buildCrewAgentConfig(config.researcher, config.toolRegistry, {
    role: 'Senior Research Analyst',
    goal: 'Conduct thorough research and fact-finding on the given topic',
    backstory: 'You are an experienced research analyst with expertise in finding accurate information.',
    tools: ['web_search', 'web_fetch', 'read_file'],
  });

  const writerConfig = buildCrewAgentConfig(config.writer, config.toolRegistry, {
    role: 'Technical Writer',
    goal: 'Synthesize research findings into clear, structured documents',
    backstory: 'You are a technical writer who transforms complex research into accessible content.',
    tools: ['write_file', 'edit_file'],
  });

  return {
    async *run(topic: string) {
      yield `Starting research crew for: ${topic}`;

      // Phase 1: Research（并行执行信息收集）
      const researchTask = `Research the following topic and provide key findings, sources, and analysis.\n\nTopic: ${topic}`;
      const researchResult = await researcherConfig.executeTask(researchTask);
      yield `Research complete. Findings: ${researchResult.slice(0, 200)}...`;

      // Phase 2: Writing（依赖 Research 结果）
      const writingTask = `Based on the following research, write a comprehensive summary.\n\nResearch:\n${researchResult}`;
      const writeResult = await writerConfig.executeTask(writingTask);
      yield `Draft complete.`;

      yield writeResult;
    },
  };
}
```

### 3.3 Process 模式选择

```
你的场景用哪种 Process？
├── 线性流程（A → B → C）→ Process.sequential
│   适用于：Research → Write → Review 这种依赖关系
├── 层级流程（Manager 分配 → 员工执行）→ Process.hierarchical
│   适用于：动态任务分配，但 Manager Agent 的决策质量依赖于 LLM 推理
└── 并行执行（A + B + C 同时 → 汇总）
    ⚠️ CrewAI 目前不原生支持，需要自己实现（见 createResearchCrew 示例）
```

---

## 4. AutoGen 集成指南

### 4.1 核心思路：ConversableAgent 包装 + 条件终止

AutoGen 的特点是"对话终止条件"——Agent 在对话中自主判断是否完成。这适合"代码生成+测试"闭环：生成 Agent 写代码，测试 Agent 跑测试，失败了自动重来。

🔗 **工程逻辑**：AutoGen 不适合的场景是"用户参与的交互对话"——它是为"两个机器之间自动化协作"设计的。如果你做的是面向用户的聊天 Agent，AutoGen 的工具调用触发机制（需要另一个 Agent 或用户 proxy 发消息）会让你多写很多桥接代码。正确的做法是仅在本项目的"代码生成"类 skill 内部使用 AutoGen 作为子引擎。

### 4.2 桥接实现

```typescript
// packages/core/src/frameworks/autogen-bridge.ts

import { ConversableAgent, AgentRuntime } from 'autogen-agentchat';
import { AbstractAgent } from '../agent/abstract-agent';
import { ToolRegistry } from '../tools/tool-registry';
import { ChatCompletionClient } from './autogen-openai-client';

/**
 * 将本项目的 AbstractClient 作为 AutoGen 的 LLM backend。
 *
 * AutoGen 内部需要调用 `client.create(messages)` 和 `client.stream(messages)`。
 * 我们把调用转发到本项目的 LLMClient（已有的 OpenAI/Anthropic 抽象层）。
 */
export function wrapLLMForAutoGen(llmClient: {
  create: (params: { messages: Array<{ role: string; content: string }> }) => Promise<{ choices: [{ message: { content: string } }] }>;
  stream: (params: { messages: Array<{ role: string; content: string }> }) => AsyncGenerator<{ choices: [{ delta: { content: string } }] }>;
}) {
  return {
    async create(params: { messages: Array<{ role: string; content: string }>; tools?: unknown[] }) {
      // AutoGen 会在 tools 里传 function calling 参数，我们需要转换回本项目的工具格式
      const result = await llmClient.create(params);
      return {
        content: result.choices[0].message.content,
        // AutoGen 期望 tool_calls 字段——直接从本项目 LLM 响应中透传
        tool_calls: [],
      };
    },

    async *stream(params: { messages: Array<{ role: string; content: string }> }) {
      for await (const chunk of llmClient.stream(params)) {
        yield { delta: { content: chunk.choices[0].delta.content || '' } };
      }
    },

    model: 'agentcore-llm',
    pricing: { prompt_price_per_1m: 0, completion_price_per_1m: 0 },
  };
}

/**
 * 创建代码审查双人组（AutoGen 最经典的 use case）。
 *
 * 使用条件终止而非无限对话，防止死循环。
 */
export function createCodeReviewPair(
  llmClient: ReturnType<typeof wrapLLMForAutoGen>,
  toolRegistry: ToolRegistry,
) {
  const coder = new ConversableAgent('coder', {
    system_message: `You are a Python expert. Write code to solve the problem.
      When the code is correct and all tests pass, reply with "TERMINATE".`,
    llm_config: { config_list: [{ model: 'agentcore-llm', ...llmClient }] },
    is_termination_msg: (msg) => msg.content?.includes('TERMINATE') ?? false,
  });

  const tester = new ConversableAgent('tester', {
    system_message: `You run tests on the provided code. If tests fail, send back
      the error with instructions to fix. Never say TERMINATE.`,
    llm_config: { config_list: [{ model: 'agentcore-llm', ...llmClient }] },
    code_execution_config: { use_docker: false, timeout: 30 },
  });

  return { coder, tester };
}
```

### 4.3 何时该用 / 不该用 AutoGen

```
✅ 适合用 AutoGen：
├── 代码生成+测试闭环（Coders + Tester + Verifier 三角闭环）
├── 多 Agent 辩论/验证（生成一个答案，再让另一个挑战）
├── 自动科研实验（设计实验→跑实验→分析结果→迭代）
└── 已有 AutoGen 经验 + 团队熟悉它的模式

❌ 不适合用 AutoGen：
├── 面向用户的聊天 Agent（AutoGen 不擅长单 Agent 持续对话）
├── 需要精细控制 MemoryManager 的场景（AutoGen 的记忆很粗粒度）
├── 需要调用复杂 MCP 工具链的任务（AutoGen 的工具注册很原始）
└── 前端 SSE 流式 AutoGen 没有原生支持，需要自己做 EventSource 桥接
```

### 4.4 群聊模式性能问题

AutoGen 的 `GroupChat` 模式在 4+ 个 Agent 时性能急剧下降：
- 每轮需要所有 Agent 选择下一个发话者（用 LLM 决定，每次都是 API 调用）
- 默认无并发——N 个 Agent 的对话是 O(N^2) 消息复杂度
- 30 分钟对话可能产生上百次 LLM 调用，token 消耗巨大

**解法**：对 4+ Agent 群聊，不用 AutoGen GroupChat，改用本项目的 Supervisor 模式（已在 05-multi-agent.md 中有实现），只在关键校验环节引入 AutoGen 的双 Agent 审查对。

---

## 5. 实战混用策略

### 5.1 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    本项目（AgentCore）                         │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ MemoryManager│  │ ToolRegistry  │  │ Skills System    │    │
│  └──────┬──────┘  └──────┬───────┘  └────────┬─────────┘    │
│         │                │                    │              │
│         └────────────────┼────────────────────┘              │
│                          │                                   │
│                   ┌──────┴──────┐                            │
│                   │ AbstractAgent│                            │
│                   └──────┬──────┘                            │
│                          │                                   │
│         ┌────────────────┼────────────────┐                  │
│         ▼                ▼                ▼                  │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐         │
│  │LangGraph    │  │  CrewAI       │  │ AutoGen      │         │
│  │StateGraph   │  │  Crew         │  │ GroupChat    │         │
│  │(持久化/恢复) │  │  (任务分配)   │  │ (代码审查)   │         │
│  └─────────────┘  └──────────────┘  └─────────────┘         │
│                                                              │
│         每个框架节点内都是一个 AbstractAgent 实例              │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 具体编排示例

```typescript
// packages/core/src/frameworks/orchestrator.ts

import { buildAgentGraph, streamAgentGraph } from './langgraph-bridge';
import { createResearchCrew } from './crewai-bridge';
import { createCodeReviewPair } from './autogen-bridge';
import { AbstractAgent } from '../agent/abstract-agent';
import { ToolRegistry } from '../tools/tool-registry';
import { MemoryManager } from '../memory/memory-manager';

/**
 * 实战调度器：根据任务类型选择编排框架。
 *
 * 核心原则：本项目提供 Memory、Tool、Skills 基础设施，
 * 框架只负责"编排基础设施之上的任务流程"。
 */
export class HybridOrchestrator {
  private langGraphInstance;
  private agents: Map<string, AbstractAgent>;

  constructor(
    private toolRegistry: ToolRegistry,
    private memory: MemoryManager,
    options: { checkpointer?: unknown } = {},
  ) {
    this.agents = new Map();

    // 默认通用 Agent（不绑 LangGraph，直接 SSE 服务用户）
    this.agents.set('general', new AbstractAgent({
      llmClient: /* 项目已有 LLM 工厂 */,
      toolRegistry,
      memoryManager: memory,
    }));

    // LangGraph 绑定的 Agent（用于需要 checkpoint 的复杂工作流）
    const researchAgent = new AbstractAgent({
      llmClient: /* LLM 工厂 */,
      toolRegistry,
      memoryManager: memory,
    });
    this.agents.set('researcher', researchAgent);

    if (options.checkpointer) {
      this.langGraphInstance = buildAgentGraph(researchAgent, options.checkpointer as any);
    }
  }

  /**
   * 路由用户请求到合适的执行路径。
   */
  async *handle(input: string, sessionId: string): AsyncGenerator<{ type: string; data: unknown }> {
    // 1. 简单对话 → 直接用 AbstractAgent（不引入框架开销）
    // 2. "research X" → LangGraph 编排（支持 checkpoint 恢复）
    // 3. "review code X" → AutoGen 双人审查
    // 4. "write report about X" → CrewAI 协调

    const intent = await this.classifyIntent(input);

    switch (intent) {
      case 'research': {
        if (!this.langGraphInstance) {
          throw new Error('LangGraph checkpointer not configured');
        }
        yield* streamAgentGraph(this.langGraphInstance, input, sessionId);
        break;
      }

      case 'code_review': {
        yield { type: 'agent_event', data: { content: 'Starting code review...' } };
        const pair = createCodeReviewPair(wrapLLMForAutoGen(/* llmClient */), this.toolRegistry);
        // AutoGen 执行逻辑...
        yield { type: 'agent_event', data: { content: 'Code review complete' } };
        break;
      }

      case 'writing': {
        const crew = createResearchCrew({
          researcher: this.agents.get('general')!,
          writer: this.agents.get('general')!,
          reviewer: this.agents.get('general')!,
          toolRegistry: this.toolRegistry,
          memory: this.memory,
        });
        for await (const chunk of crew.run(input)) {
          yield { type: 'agent_event', data: { content: chunk } };
        }
        break;
      }

      default: {
        // 默认走 AbstractAgent 直接对话——零框架开销
        const agent = this.agents.get('general')!;
        for await (const event of agent.run(input, { sessionId })) {
          yield event;
        }
      }
    }
  }

  private async classifyIntent(input: string): Promise<string> {
    const lower = input.toLowerCase();
    if (lower.startsWith('research') || lower.startsWith('analyze')) return 'research';
    if (lower.includes('code review') || lower.includes('review pr')) return 'code_review';
    if (lower.startsWith('write report') || lower.startsWith('draft')) return 'writing';
    return 'general';
  }
}
```

### 5.3 混用关键约束

1. **持久化格式统一**：LangGraph 用了 checkpoint，本项目自己也有状态快照。混用时只选一种——推荐用 LangGraph 的 checkpoint 处理"复杂工作流"，本项目的 auto-save 处理"普通对话"。不要两套同时跑。

2. **工具调用链路追踪**：混用后 tool call 的 trace 横跨多个框架。工具调用的日志必须在 ToolRegistry 层统一注入，不能依赖各框架自己的 trace —— 否则你看到的 trace 会断成几截。

3. **Token 预算分摊**：多框架混用时，一个对话可能经过 2-3 个 LLM 调用链。AbstractAgent 的 token budget（128K）要按路由阶段分摊：research 40%，writing 30%，review 20%，buffer 10%。

---

## 6. 切换成本评估矩阵

| 从 → 到 | 代码改动量 | 性能影响 | 维护收益 | 风险 |
|---------|-----------|---------|---------|------|
| 纯手写 → LangGraph | 中等（~500 行桥接） | +5-15% 延迟（图层开销） | +持久化, +LangSmith trace, +生态插件 | API 版本不兼容（0.2 → 0.3 大改动） |
| 纯手写 → CrewAI | 少（~300 行包装） | +10-20% 延迟（CrewAI 中间的编排层） | +快速原型, +角色模板 | 底层控制力弱，生产场景缩手缩脚 |
| 纯手写 → AutoGen | 中等（~400 行） | +15-30% 延迟（多 Agent 多轮通信） | +代码生成闭环, +测试驱动开发 | 面向用户对话场景不匹配 |
| 纯手写 → 混用 | 大（~1200 行编排层） | +20-40% 延迟（多框架序列调用） | +各取所长 | 调试复杂度翻倍，trace 断裂风险 |
| LangGraph → 纯手写 | 回归工作量大 | -10% 延迟（去掉了图层） | 完全控制，无版本依赖 | 失去 checkpoint 恢复能力 |

🔗 **工程逻辑**："混用"不是一次性全上。正确演进路径是：
1. Stage 1：本项目 AbstractAgent 搞定 90% 场景
2. Stage 2：引入 LangGraph 仅为了 checkpoint（解决 fault-recovery）
3. Stage 3：对特定任务引入 CrewAI 协调
4. Stage 4：仅在代码审查场景引入 AutoGen 双人组

每一步收益明确、风险可控。一步到位的"混用"会变成维护地狱。

---

## 7. 前端：Framework 适配器面板

🔗 **工程逻辑**：让用户看到当前使用的框架有几个价值：（1）设置合理期待——知道是 LangGraph 还是直接回复，回复延迟预期不同；（2）调试时快速定位问题出在哪个框架层级；（3）在"研究模式"和"普通模式"间切换。

```tsx
// apps/web/src/components/framework/framework-panel.tsx

'use client';

import { useState, useEffect } from 'react';

interface FrameworkAdapter {
  id: string;
  name: string;
  status: 'active' | 'available' | 'disabled';
  icon: string;
  description: string;
  switchCost: 'low' | 'medium' | 'high';
}

const FRAMEWORKS: FrameworkAdapter[] = [
  {
    id: 'native',
    name: 'Native Agent',
    status: 'active',
    icon: '⚡',
    description: '直接通过 AbstractAgent 响应，零框架开销',
    switchCost: 'low',
  },
  {
    id: 'langgraph',
    name: 'LangGraph',
    status: 'available',
    icon: '🔀',
    description: '图编排 + 持久化 checkpoint，适合复杂工作流',
    switchCost: 'medium',
  },
  {
    id: 'crewai',
    name: 'CrewAI',
    status: 'available',
    icon: '👥',
    description: '角色化团队协调，适合研究报告生成',
    switchCost: 'medium',
  },
  {
    id: 'autogen',
    name: 'AutoGen',
    status: 'disabled',
    icon: '🤖',
    description: '双 Agent 代码审查，仅支持代码类任务',
    switchCost: 'high',
  },
];

export function FrameworkPanel() {
  const [active, setActive] = useState('native');
  const [showDetail, setShowDetail] = useState<string | null>(null);

  const switchCostColors = {
    low: 'text-green-400',
    medium: 'text-yellow-400',
    high: 'text-red-400',
  };

  return (
    <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-text font-medium text-sm">框架适配器</h3>

      <div className="space-y-1">
        {FRAMEWORKS.map((fw) => (
          <div
            key={fw.id}
            className={`flex items-center justify-between px-3 py-2 rounded-md transition-colors
              ${fw.status === 'active' ? 'bg-primary/10 border border-primary/30' : 'hover:bg-surface/60'}
              ${fw.status === 'disabled' ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
            `}
            onClick={() => {
              if (fw.status !== 'disabled') {
                setActive(fw.id);
                setShowDetail(showDetail === fw.id ? null : fw.id);
              }
            }}
          >
            <div className="flex items-center gap-2">
              <span className="text-base">{fw.icon}</span>
              <div>
                <div className="text-sm text-text font-medium">{fw.name}</div>
                <div className="text-xs text-muted">{fw.description}</div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {fw.status === 'active' && (
                <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded">
                  运行中
                </span>
              )}
              <span className={`text-xs ${switchCostColors[fw.switchCost]}`}>
                切换成本: {fw.switchCost === 'low' ? '低' : fw.switchCost === 'medium' ? '中' : '高'}
              </span>
              <div className={`w-2 h-2 rounded-full ${
                fw.status === 'active' ? 'bg-green-400' :
                fw.status === 'available' ? 'bg-blue-400' : 'bg-gray-400'
              }`} />
            </div>
          </div>
        ))}
      </div>

      {/* 切换提示 */}
      {showDetail && showDetail !== active && (
        <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-md text-xs text-yellow-300">
          ⚠️ 切换到 {FRAMEWORKS.find(f => f.id === showDetail)?.name} 后：
          <ul className="list-disc ml-4 mt-1 space-y-0.5">
            <li>当前会话将被 checkpoint 后重新创建</li>
            <li>工具调用链路将通过新框架编排</li>
            <li>预计额外增加 5-15% 延迟</li>
          </ul>
        </div>
      )}
    </div>
  );
}
```

---

## 8. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| LangGraph 0.2 → 0.3 升级后代码全炸 | API 重构：`GraphState` → `StateGraph`，`addNode()` 参数格式变了 | 锁定版本 `"@langchain/langgraph": "0.2.45"` 在 package.json 里，等 0.3 稳定后再迁移 |
| 混用框架导致 trace 断裂 | 每个框架有自己的 trace 体系（LangSmith/CrewAI log/AutoGen verbose），互不连通 | 在 ToolRegistry 层统一注入 trace ID，跨框架透传 |
| 框架抽象泄漏——LangGraph 图状态泄漏到 Agent 内部 | 强依赖 Annotation.Root 的 State 类型定义 | 把 LangGraph 状态作为参数传入 AbstractAgent.run()，不要让它成为模块级全局变量 |
| CrewAI Agent 调用 AbstractAgent 时出现两个 Memory 系统 | CrewAI 有自己的 Memory（short/long/external）和 AbstractAgent 的 MemoryManager | 在 CrewAI Agent 里设置 `memory=False`，让记忆完全走 AbstractAgent |
| AutoGen 的 code_execution_config 依赖 Docker，和本项目的 sandbox 冲突 | 两边都想拉起 Docker 容器 | 在 AutoGen 里设 `use_docker: false`，代码执行走本项目的 ToolRegistry 已有的 `execute_code` 工具 |
| 前端显示 LangGraph trace 但用户不需要看到图编排放大镜 | 把内部调试信息暴露到生产 UI | trace 信息只在`/admin/dev-tools` 页面展示，普通用户只能看到"framework: LangGraph"标识 |
| 每个框架都拉了不同版本的 LangChain | LangGraph 和 CrewAI 都依赖 LangChain 但版本要求不同 | 用 `pnpm.overrides` 统一 LangChain 版本，或直接避免同时安装 |
| 框架升级导致工具格式不兼容 | LangGraph 工具定义是 `ToolNode`，AutoGen 是 `function_map`，CrewAI 是自定义 Tool 类 | 桥接层做格式转换，不要在各处散落格式处理逻辑 |

---

## 9. AI 避坑追加（AST 可检）

> 🤖 **AI 常见错误**：
>
> 3. **混用框架时 token 预算未分摊** — 当一个对话路由经过 LangGraph（research 阶段）和手写 AbstractAgent（general 阶段）时，两边的 `system prompt` 各自占 token，总 token 超出 context window 后 LLM 静默截断 system prompt 的工具描述层。**检查方式**：`AbstractAgent.run()` 必须在每次 LLM 调用前断言 `estimateTokens(systemPrompt) + estimateTokens(messages) < model.maxContext * 0.8`；混用模式下每个框架的 token 配额由 `TokenBudgetAllocator` 显式分配，禁止各框架自行估算。

*本节点属于 Layer 4 生态集成层。核心原则：本项目（AgentCore）是主体，框架是工具。不要为了"用上某个框架"而用，只有在框架解决的问题确实是你的痛点时才引入。混用的代价是调试复杂度指数级增长，所以演进路径应该是逐步叠加、而非一步到位。框架版本兼容性必须在锁定文件（package.json）里做好管控。*
