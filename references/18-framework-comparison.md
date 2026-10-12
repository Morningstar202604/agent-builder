# 18 — 框架集成与对比 · LangGraph · CrewAI · AutoGen · CAMEL · MetaGPT

> 目标：五个主流 Agent 框架各有长短。不要"为了用框架而用框架"，而是根据场景选择最合适的。本文件是**选型文档**，不是实现文档——框架的成熟用法直接用官方 API，不写桥接层。

> **⚠️ 本层铁律：框架是工具，不是要改造的对象。**
> - 选 LangGraph → 直接用官方 `createReactAgent` / `StateGraph`，不把自家 Agent 包装成节点
> - 选 CrewAI / AutoGen / CAMEL / MetaGPT → 直接用官方 Python API，不写 TypeScript 桥接
> - 本项目的主体是 01 的 `streamText` + `tools`，框架只解决"多 Agent 编排 / 持久化 / 角色协作"这类具体痛点
>
> 本文件**无手写实现**，只保留对比矩阵、官方用法示例与选型约束。

---

## 目录

- [1. 框架全景对比 Matrix](#1-框架全景对比-matrix)
- [2. LangGraph](#2-langgraph)
- [3. CrewAI](#3-crewai)
- [4. AutoGen](#4-autogen)
- [5. CAMEL](#5-camel)
- [6. MetaGPT](#6-metagpt)
- [7. 实战混用策略](#7-实战混用策略)
- [8. 切换成本评估矩阵](#8-切换成本评估矩阵)
- [9. 避坑汇总](#9-避坑汇总)
- [10. 本层验收清单](#10-本层验收清单)

---

## 1. 框架全景对比 Matrix

### 1.1 五框架 × 六维度评测

| 维度 | LangGraph | CrewAI | AutoGen | CAMEL | MetaGPT |
|------|-----------|--------|---------|-------|---------|
| **架构哲学** | 图编排——节点+边，状态机驱动 | 角色协作——Crew/Agent/Task 三件套 | 对话代理——ConversableAgent 消息传递 | 角色扮演——Agent 对话涌现智能 | 流水线——SOP 驱动多角色串行 |
| **状态管理** | 显式 StateGraph，类型安全，可持久化 checkpoint | 隐式状态，框架内部管理 | 基于消息列表，无结构化状态 | 对话历史即状态 | 显式 Message Pool，按 SOP 流转 |
| **调试体验** | LangSmith trace 可视化强 | 日志丰富但无可视化工具 | verbose 模式输出多 | 对话日志可读性好 | 中间产物文件化 |
| **社区** | 最大、最活跃，LangChain 生态 | 增长快，企业用户多 | 微软背书，学术圈流行 | 学术导向，社区小但专注 | 中文社区强 |
| **文档质量** | 示例多但有版本碎片化 | 上手快，深度不足 | 文档分散在论文与代码间 | 文档薄 | 中文文档好，英文滞后 |
| **适用场景** | 复杂工作流、持久化/恢复 | 快速原型、角色化团队协作 | 代码生成验证、多 Agent 实验 | 对话模拟、数据生成、研究 | 软件工程 SOP 自动化 |

### 1.2 选型决策树

```
你的需求是什么？
├── 需要持久化/断点恢复 → LangGraph
├── 快速搭建角色化多 Agent 原型 → CrewAI
├── 代码生成+验证循环（测试驱动） → AutoGen
├── 对话数据生成/角色扮演研究 → CAMEL
├── 软件工程流程自动化（需求→代码→测试） → MetaGPT
└── 以上都包含，且需要统一架构 → 本项目 streamText + tools 为主，框架按需引入
```

### 1.3 核心抽象映射

| 本项目（01） | LangGraph | CrewAI | AutoGen | CAMEL | MetaGPT |
|--------|-----------|--------|---------|-------|---------|
| `streamText` Agent | `createReactAgent` / Graph Node | Agent | ConversableAgent | ChatAgent | Role |
| `tool()` | LangChain Tool | Task.tools | function_map | 工具作为 Agent 能力 | Action |
| SessionStore / Memory | Checkpoint / Store | Memory (short/long) | chat_messages_history | 对话历史 | MessagePool |
| AgentEvent | Stream Event | 无直接对应 | 消息事件 | 消息事件 | Message |

---

## 2. LangGraph

**成熟用法**：直接使用官方 `createReactAgent` 构建 ReAct Agent，或 `StateGraph` + `Annotation` 自定义编排。不要把自家 Agent 逻辑"包装成图节点"——框架的价值是 checkpoint 与循环控制，推理仍由模型完成。

```typescript
// 官方 LangGraph 用法：createReactAgent 一行构建 ReAct Agent
import { createReactAgent } from '@langchain/langgraph/prebuilt';
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
});
```

🔗 **工程逻辑**：LangGraph 的核心价值是 **checkpoint**——每个节点执行后持久化状态，断线恢复时从断点续跑，这正是 21（fault-recovery）需要的。用官方 API 获得这个能力，不要自己实现状态机。

🤖 **AI 常见错误**：把整个自研 Agent 重写成 LangChain 的 `AgentExecutor`。正确的做法是保持 01 的 `streamText` 作为单 Agent 推理主体，只在"确实需要图编排 + 持久化"的多步骤工作流里引入 `createReactAgent`。

---

## 3. CrewAI

**成熟用法**：CrewAI 是 Python 优先的框架，用官方 `crewai` 包直接定义 Agent/Task/Crew。TS 项目不需要桥接——把 CrewAI 作为独立服务（或直接用 Python 子进程）运行，通过 HTTP 收结果即可，桥接层只有"传配置、收结果"两件事。

```python
# CrewAI 官方用法（Python）：Crew + Agent + Task
from crewai import Agent, Crew, Process, Task

researcher = Agent(
    role="资深研究员",
    goal="多角度收集信息并交叉验证",
    backstory="你擅长事实核查。",
    tools=[],  # 官方工具见 crewai-tools 文档
)

task = Task(
    description="调研主题并输出带来源的关键发现",
    expected_output="要点列表",
    agent=researcher,
)

crew = Crew(agents=[researcher], tasks=[task], process=Process.sequential)
result = crew.kickoff(inputs={"topic": "AI agents 在 2026 年的实践"})
```

🔗 **工程逻辑**：CrewAI 的记忆系统粒度较粗，如果项目已经依赖 03（Memory & RAG）的 `MemoryManager`，就在 CrewAI Agent 上设置 `memory=False`，记忆统一走自己的体系，避免双记忆冲突。

🤖 **AI 常见错误**：在 TypeScript 里手写一个 CrewAI 桥接类（转发任务、解析 NDJSON）。桥接类会随着 CrewAI 版本变化频繁返工。正确做法是让 Python 服务直接暴露一个简单的 HTTP 端点，TS 只做 fetch + 透传。

---

## 4. AutoGen

**成熟用法**：AutoGen 的核心是 `ConversableAgent` 之间的对话与条件终止，适合"代码生成 + 测试"闭环。官方 Python 包直接使用：

```python
# AutoGen 官方用法（Python）：ConversableAgent + 终止条件
from autogen import ConversableAgent

coder = ConversableAgent(
    name="coder",
    system_message="你是 Python 专家。测试通过后回复 TERMINATE。",
    llm_config={"config_list": [{"model": "gpt-4o"}]},
    is_termination_msg=lambda msg: "TERMINATE" in (msg.get("content") or ""),
    human_input_mode="NEVER",
)
```

🔗 **工程逻辑**：AutoGen 不适合面向用户的聊天 Agent——它是为"两个机器之间自动化协作"设计的。只在本项目的"代码生成"类 skill 内部使用 AutoGen 作为子引擎，用户对话仍走 01 的 `useChat`。

🤖 **AI 常见错误**：用 AutoGen 的 `GroupChat` 做 4+ Agent 群聊。每轮所有 Agent 都要用 LLM 选下一个发言者，消息复杂度 O(N²)，token 消耗巨大。4+ Agent 场景改用本项目 05 的 Supervisor 模式，只在关键校验环节引入 AutoGen 双 Agent 对。

---

## 5. CAMEL

**成熟用法**：CAMEL 以角色扮演对话研究闻名，官方 `camel` Python 包直接使用：

```python
# CAMEL 官方用法（Python）：ChatAgent
from camel.agents import ChatAgent

agent = ChatAgent(system_message="你是一个有帮助的助手。")
response = agent.step("解释什么是多模态 Agent")
print(response.msg.content)
```

**适用场景**：对话数据生成、角色扮演研究、多 Agent 行为分析。TS 项目如果只是调用，同样用 HTTP 访问 Python 服务，不写桥接。

---

## 6. MetaGPT

**成熟用法**：MetaGPT 把"软件公司"流水线（需求 → 设计 → 编码 → 测试）封装成高层 API，官方 Python 包直接使用：

```python
# MetaGPT 官方用法（Python）：高层 SOP 流水线
from metagpt.software_company import generate_repo

generate_repo(idea="构建一个 CLI 待办事项工具", investment=2.0)
```

**适用场景**：软件工程流程自动化。注意 MetaGPT 的 API 在不同版本间变化较大，**锁定版本**再使用（见避坑汇总）。

---

## 7. 实战混用策略

### 7.1 架构原则

本项目（AgentCore）是主体，框架是工具。混用不是"把所有框架缝在一起"，而是**按痛点逐个引入**：

1. **Stage 1**：01 的 `streamText` + `tools` 搞定 90% 场景。
2. **Stage 2**：需要持久化 / 断点恢复时，引入 LangGraph `createReactAgent` + checkpointer。
3. **Stage 3**：需要角色化团队协作时，引入 CrewAI（独立 Python 服务）。
4. **Stage 4**：仅在"代码生成 + 测试"闭环中引入 AutoGen 双 Agent 对。

每一步收益明确、风险可控。一步到位的"混用"会变成维护地狱。

### 7.2 混用关键约束

1. **持久化格式统一**：LangGraph 用 checkpoint，本项目也有状态快照。混用时只选一种——推荐用 LangGraph 的 checkpoint 处理"复杂工作流"，本项目的 auto-save 处理"普通对话"。不要两套同时跑。
2. **可观测性统一**：混用后 tool call 的 trace 横跨多个框架。用 Langfuse（08）统一注入 `trace_id`，不依赖各框架自己的 trace——否则 trace 会断成几截。
3. **Token 预算分摊**：多框架混用时，一个对话可能经过 2-3 条 LLM 调用链。按路由阶段分摊预算：research 40%，writing 30%，review 20%，buffer 10%。

---

## 8. 切换成本评估矩阵

| 从 → 到 | 代码改动量 | 性能影响 | 维护收益 | 风险 |
|---------|-----------|---------|---------|------|
| 纯手写 → LangGraph | 中等（迁移 `streamText` 到 `createReactAgent`） | +5-15% 延迟（图层开销） | +持久化, +LangSmith trace, +生态插件 | API 版本不兼容（0.2 → 0.3 大改动） |
| 纯手写 → CrewAI | 少（独立 Python 服务） | +10-20% 延迟（跨语言 HTTP） | +快速原型, +角色模板 | 底层控制力弱，生产场景缩手缩脚 |
| 纯手写 → AutoGen | 中等（Python 子引擎） | +15-30% 延迟（多 Agent 多轮通信） | +代码生成闭环 | 面向用户对话场景不匹配 |
| 纯手写 → 混用 | 大（编排层） | +20-40% 延迟（多框架序列调用） | +各取所长 | 调试复杂度翻倍，trace 断裂风险 |
| LangGraph → 纯手写 | 回归工作量大 | -10% 延迟（去掉了图层） | 完全控制，无版本依赖 | 失去 checkpoint 恢复能力 |

---

## 9. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| LangGraph 0.2 → 0.3 升级后代码全炸 | API 重构：`GraphState` → `StateGraph`，`addNode()` 参数格式变了 | 锁定版本 `"@langchain/langgraph": "0.2.45"` 在 package.json，等 0.3 稳定后再迁移 |
| 混用框架导致 trace 断裂 | 每个框架有自己的 trace 体系（LangSmith/CrewAI log/AutoGen verbose），互不连通 | 在 ToolRegistry / Langfuse 层统一注入 trace ID，跨框架透传 |
| CrewAI Agent 出现两个 Memory 系统 | CrewAI 有自己的 Memory（short/long/external），本项目也有 `MemoryManager` | 在 CrewAI Agent 里设置 `memory=False`，记忆完全走本项目 |
| AutoGen 的 code_execution_config 依赖 Docker，和沙箱冲突 | 两边都想拉起 Docker 容器 | 在 AutoGen 里设 `use_docker: false`，代码执行走本项目已有的 `execute_code` 工具 |
| 每个框架都拉了不同版本的 LangChain | LangGraph 和 CrewAI 都依赖 LangChain 但版本要求不同 | 用 `pnpm.overrides` 统一 LangChain 版本，或避免同时安装 |
| 框架升级导致工具格式不兼容 | LangGraph 工具是 ToolNode，AutoGen 是 function_map，CrewAI 是自定义 Tool 类 | 用官方转换工具（`convertToLangChainTools` / crewai-tools），不散落格式处理逻辑 |

---

## 10. 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **选型确认**：在项目 README 或 ADR 中记录本层选型结论——哪个场景用哪个框架、为什么；没有引入的框架注明"暂不需要"。
- [ ] **官方 API 示例**：`createReactAgent` 示例、CrewAI / AutoGen / CAMEL / MetaGPT 的 Python 示例分别在对应运行时中可运行，产出符合文档描述。
- [ ] **类型检查**：如引入 LangGraph TS 包，运行 `pnpm typecheck`，确认 `createReactAgent` 相关代码全部通过；`references/` 下无自定义 LLM 类型与手写桥接层残留。
- [ ] **版本锁定**：检查 `package.json` 中 `@langchain/langgraph` 锁在 `0.2.45`；`pnpm why @langchain/langgraph` 确认无两个主版本并存；`pnpm.overrides` 已统一 LangChain 版本。
- [ ] **可观测性**：混用 LangGraph 与自研 Agent 时，Langfuse 中同一会话的 `trace_id` 字段在所有框架日志中一致。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 标记与本层验收清单。

---

> **与后续节点的衔接**：本文件是纯选型文档——确定框架后，LangGraph 的接入由 05（Multi-Agent）与 21（Fault Recovery）落地，CrewAI/AutoGen 的服务化部署由 09（Deploy）处理，统一观测由 08（Eval & Observability）提供。所有示例中的 `llm` 类型仍遵循 00 契约；多框架场景不引入自定义 LLM 抽象，避免破坏跨层类型一致性。
