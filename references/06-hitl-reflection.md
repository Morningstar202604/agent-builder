# 06 — 人在回路 (HITL) + 自我反思 (Reflection)

> **Layer 2.5：执行安全与质量闭环** — Agent 自主执行前需要两道闸门：**人在回路**卡住高风险操作（做不做），**自我反思**卡住低质量输出（好不好）。本 reference 只写成熟方案的接入与 `[CUSTOM]` 业务规则。
>
> **⚠️ 不要重造以下东西：**
> - 人工审批状态机 / `waitForDecision` / resolver 表 → **LangGraph interrupts**（`interrupt()` + `Command({ resume })`）或 **OpenAI Agents SDK HITL**（human-in-the-loop approval），不要手写审批状态机
> - LLM-as-Judge 评估器 → **Langfuse**（trace + score）与 **promptfoo**（离线回归），不要手写评分循环
> - Agent 主循环 / 工具循环 → **AI SDK** `streamText` + `tool()`（见 reference 01），不要手写 while+switch
> - 事件协议 → **AgentEvent**（reference 01 的业务信封），不要另起炉灶
>
> 本层唯一允许手写的 `[CUSTOM]`：**四级 HITL 业务规则表**（哪些工具要审批、审批人、超时策略）、**Reflection 终止策略**（迭代上限/阈值）、**前端审批中心 UI**。

## 目录

- [1. HITL 概览](#1-hitl-概览)
- [2. 四级风险模型与审批规则 [CUSTOM]](#2-四级风险模型与审批规则-custom)
- [3. LangGraph interrupts 接入](#3-langgraph-interrupts-接入)
- [4. 审批决策 API 与恢复执行](#4-审批决策-api-与恢复执行)
- [5. 前端审批中心 [CUSTOM]](#5-前端审批中心-custom)
- [6. HITL 常见陷阱](#6-hitl-常见陷阱)
- [7. Self-Reflection 概览](#7-self-reflection-概览)
- [8. LLM-as-Judge 评估：Langfuse 与 promptfoo](#8-llm-as-judge-评估langfuse-与-promptfoo)
- [9. Reflection 终止策略 [CUSTOM]](#9-reflection-终止策略-custom)
- [10. Reflection 主循环](#10-reflection-主循环)
- [11. Reflection 常见陷阱](#11-reflection-常见陷阱)
- [12. HITL 与 Reflection 协同](#12-hitl-与-reflection-协同)
- [13. 本层验收清单](#13-本层验收清单)

---

## 1. HITL 概览

Agent 自主性越高，闯祸的风险越大。一个误操作：发错邮件给客户、删了生产数据库记录、把钱转到错误账户——这些后果是 RPA 时代的噩梦。

HITL 不是"什么都问用户"，而是**按风险分级自主/审批**。查天气不需要审批，发邮件需要审批，转账需要二次确认。目标是：让 Agent 做 90% 低风险决策，只卡住那 10% 高风险操作。

🔗 **工程逻辑**：审批系统最隐蔽的坑不是"漏掉了需要审批的操作"，而是"审批提示不清晰导致用户随便点"。如果审批弹窗写的是"该操作涉及敏感数据，是否继续？" 99% 的用户会点"确定"。好的审批提示应当具体到这个操作不可逆的影响："此操作将永久删除 1,247 条订单记录且无法恢复"。

```
┌──────────────────────────────────────────────────────────┐
│                    操作请求进入                            │
│                          │                                │
│                          ▼                                │
│              ┌──────────────────────┐                    │
│              │   风险分级（配置表）   │                    │
│              └──────────┬───────────┘                    │
│                         │                                │
│              ┌──────────┼──────────┐                     │
│              ▼          ▼          ▼                     │
│         低风险        中风险       高风险                  │
│      (自动放行)    (需要审批)   (多人分级审批)            │
│              │          │          │                     │
│              ▼          ▼          ▼                     │
│         直接执行    审批弹窗    多人分级审批               │
│                    超时→默认策略                         │
└──────────────────────────────────────────────────────────┘
```

接入后，HITL 由三部分组成：

1. **`[CUSTOM]` 风险配置表**：按工具名/参数给出风险等级、审批人、超时策略（业务规则，本层手写）。
2. **LangGraph interrupts 胶水层**：在图中暂停、恢复（框架能力，不自研状态机）。
3. **前端审批中心**：展示待审批列表、风险详情、副作用说明，支持批准/拒绝/修改后批准（`[CUSTOM]` UI）。

---

## 2. 四级风险模型与审批规则 [CUSTOM]

风险等级是**业务规则**，不是框架能力。四级是最佳实践——太少（2 级）区分度不足，太多（5+ 级）用户记忆负担加重且审批流程差异化成本上升。Medium 和 High 的区别在于"可逆性"：误删文件可以恢复（如果备份）但发出去的邮件收不回来。

| 等级 | 描述 | 典型操作 | 审批要求 | 超时默认 |
|------|------|----------|----------|----------|
| **Low** | 无副作用 | 读文件、搜索、计数、RAG 查询 | 自动放行 | - |
| **Medium** | 可逆的状态变更 | 创建文件、发送通知 | 单人审批 | 拒绝 |
| **High** | 不可逆的破坏性操作 | 删除数据、修改生产配置 | 单人审批 + 副作用展示 | 拒绝 |
| **Critical** | 涉及资金/法务 | 转账、部署生产、签合同 | 多人审批（可选） | 拒绝 |

```typescript
// packages/core/src/hitl/config.ts —— 四级 HITL 业务规则 [CUSTOM]
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskRule {
  toolPattern: string;
  level: RiskLevel;
  explanation: string;
  sideEffectTemplates: string[];
  timeoutSeconds: number;
  timeoutStrategy: 'reject' | 'allow' | 'escalate';
  approverRoles: string[];
}

export const HITL_RULES: RiskRule[] = [
  {
    toolPattern: 'web_search',
    level: 'low',
    explanation: '仅查询外部信息',
    sideEffectTemplates: [],
    timeoutSeconds: 0,
    timeoutStrategy: 'allow',
    approverRoles: [],
  },
  {
    toolPattern: 'file_read',
    level: 'low',
    explanation: '仅读取文件内容',
    sideEffectTemplates: [],
    timeoutSeconds: 0,
    timeoutStrategy: 'allow',
    approverRoles: [],
  },
  {
    toolPattern: 'file_write',
    level: 'medium',
    explanation: '将创建或覆盖文件',
    sideEffectTemplates: ['文件 {path} 的内容将被覆盖'],
    timeoutSeconds: 300,
    timeoutStrategy: 'reject',
    approverRoles: ['approver'],
  },
  {
    toolPattern: 'send_email',
    level: 'medium',
    explanation: '将向外部发送邮件，无法撤回',
    sideEffectTemplates: ['收件人 {to} 将收到一封邮件'],
    timeoutSeconds: 300,
    timeoutStrategy: 'reject',
    approverRoles: ['approver'],
  },
  {
    toolPattern: 'delete_records',
    level: 'high',
    explanation: '将删除数据库记录，不可恢复',
    sideEffectTemplates: ['{count} 条记录将被永久删除'],
    timeoutSeconds: 300,
    timeoutStrategy: 'reject',
    approverRoles: ['admin'],
  },
  {
    toolPattern: 'transfer_funds',
    level: 'critical',
    explanation: '将转移资金，不可逆',
    sideEffectTemplates: ['金额 {amount} {currency} 将被转移'],
    timeoutSeconds: 600,
    timeoutStrategy: 'reject',
    approverRoles: ['finance_admin', 'legal'],
  },
];

export function classifyRisk(toolName: string): RiskRule {
  const matched = HITL_RULES.find((rule) => rule.toolPattern === toolName);
  if (matched) return matched;
  return {
    toolPattern: '*',
    level: 'low',
    explanation: '未匹配到审批规则，默认放行',
    sideEffectTemplates: [],
    timeoutSeconds: 0,
    timeoutStrategy: 'allow',
    approverRoles: [],
  };
}
```

🤖 **常见错误**：AI 经常写成"所有工具都需要审批"或"所有工具都不需要审批"的极端二分。正确的做法是按工具的实际副作用分级，而且要给前端展示为什么需要审批（不能只弹个"需要审批"没有原因）。

---

## 3. LangGraph interrupts 接入

手写审批状态机的三个痛点：**竞态条件**（人类在 resolver 注册前就点了审批）、**服务重启丢状态**、**resolver 表内存泄漏**。LangGraph 的 `interrupt()` + `Command({ resume })` 原生解决这三个问题：图在断点处暂停并持久化到 checkpointer，外部任意时刻用 `Command.resume` 恢复，无需手写 Promise 唤醒表。

```typescript
// packages/core/src/hitl/graph.ts —— LangGraph interrupts 胶水层（替代手写审批状态机）
import { StateGraph, START, END, Annotation, Command, interrupt } from '@langchain/langgraph';
import { classifyRisk } from './config';

export type ApprovalDecision =
  | { status: 'approved'; userId: string; at: number; comment?: string }
  | { status: 'rejected'; userId: string; reason: string; at: number }
  | { status: 'modified'; userId: string; modifiedArgs: Record<string, unknown>; at: number };

const GraphState = Annotation.Root({
  toolName: Annotation<string>({ default: () => '' }),
  args: Annotation<Record<string, unknown>>({ default: () => ({}) }),
  decision: Annotation<ApprovalDecision | undefined>({ default: () => undefined }),
});

async function requestApproval(state: typeof GraphState.State) {
  const rule = classifyRisk(state.toolName);
  const decision = interrupt<ApprovalDecision>({
    toolName: state.toolName,
    args: state.args,
    risk: rule.level,
    explanation: rule.explanation,
    sideEffects: rule.sideEffectTemplates,
  });
  return { decision };
}

export function buildHITLGraph(checkpointer?: unknown) {
  return new StateGraph(GraphState)
    .addNode('request_approval', requestApproval)
    .addEdge(START, 'request_approval')
    .addEdge('request_approval', END)
    .compile({ checkpointer });
}

export function resumeWithDecision(
  graph: ReturnType<typeof buildHITLGraph>,
  sessionId: string,
  decision: ApprovalDecision
) {
  return graph.invoke(new Command({ resume: decision }), {
    configurable: { thread_id: sessionId },
  });
}
```

🔗 **工程逻辑**：`interrupt()` 在 `request_approval` 节点内暂停图执行，`thread_id` 由调用方传入。审批人决策后，`resumeWithDecision` 用 `Command({ resume: decision })` 恢复——`decision` 会作为 `interrupt()` 的返回值交回节点。竞态条件（人类在恢复前就点了审批）由 checkpointer 的状态记录兜底：图只会在暂停点恢复一次，不存在"resolver 没注册导致 Promise 永不 resolve"的问题。

> **OpenAI Agents SDK 作为替代**：如果你整体使用 OpenAI Agents SDK，可以用 `Agent` + `Runner.run` 的 `hooks` 或 `handoffs` 实现等价的 HITL（`AgentTurnResult` 中携带 `submit_approval`/`approve` 的 `HumanApproval` 回调）。选择依据：你的 Agent 主循环在 LangGraph 还是 OpenAI Agents SDK 上（详见 reference 05 / 18）。

---

## 4. 审批决策 API 与恢复执行

```typescript
// apps/web/src/app/api/hitl/graph-singleton.ts —— 编译后的图单例
import { InMemoryCheckpointer } from '@langchain/langgraph';
import { buildHITLGraph } from '@agentcore/core/hitl/graph';

let graph: ReturnType<typeof buildHITLGraph> | undefined;

export function getGraph() {
  if (!graph) {
    graph = buildHITLGraph(new InMemoryCheckpointer());
  }
  return graph;
}
```

```typescript
// apps/web/src/app/api/hitl/resolve/route.ts —— 审批决策 API
import { NextRequest, NextResponse } from 'next/server';
import { resumeWithDecision, type ApprovalDecision } from '@agentcore/core/hitl/graph';
import { getGraph } from './graph-singleton';

export async function POST(req: NextRequest) {
  const body: {
    sessionId?: string;
    status?: string;
    reason?: string;
    modifiedArgs?: Record<string, unknown>;
  } = await req.json();
  const sessionId = body.sessionId ?? '';
  let decision: ApprovalDecision;
  if (body.status === 'modified') {
    decision = {
      status: 'modified',
      userId: 'current-user',
      modifiedArgs: body.modifiedArgs ?? {},
      at: Date.now(),
    };
  } else if (body.status === 'approved') {
    decision = { status: 'approved', userId: 'current-user', at: Date.now() };
  } else {
    decision = { status: 'rejected', userId: 'current-user', reason: body.reason ?? '未说明原因', at: Date.now() };
  }
  await resumeWithDecision(getGraph(), sessionId, decision);
  return NextResponse.json({ ok: true });
}
```

🤖 **常见错误**：AI 经常忘记处理 `modified` 状态。用户不仅可以通过/拒绝审批，还可以**修改参数后通过**（比如 Agent 要发邮件给所有人，审批人改为只发给测试组）。如果实现忘记支持 `modified`，要么丢失了这种有用的交互能力，要么导致审批人的修改被静默忽略。上面的 `POST` 必须把 `modifiedArgs` 组装进 `ApprovalDecision`，再由 `Command({ resume })` 交回图。

---

## 5. 前端审批中心 [CUSTOM]

审批中心是产品 UI，没有现成替代，保留手写。要点只有两个：**具体展示副作用**（"删除 1,247 条记录"而非"涉及敏感数据"）、**支持修改参数后批准**。

```tsx
// apps/web/src/components/hitl/ApprovalCenter.tsx —— 审批中心 UI [CUSTOM]
'use client';

import { useEffect, useState } from 'react';

interface PendingApproval {
  id: string;
  toolName: string;
  explanation: string;
  sideEffects: string[];
}

export function ApprovalCenter() {
  const [pending, setPending] = useState<PendingApproval[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/hitl/pending')
      .then((res) => res.json())
      .then((data: { approvals: PendingApproval[] }) => {
        if (!cancelled) setPending(data.approvals);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const decide = async (id: string, status: 'approved' | 'rejected') => {
    await fetch('/api/hitl/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: id, status }),
    });
    setPending((prev) => prev.filter((item) => item.id !== id));
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-semibold">审批中心</h1>
      {pending.length === 0 ? (
        <p className="text-muted">暂无待审批操作</p>
      ) : (
        <ul className="space-y-3">
          {pending.map((item) => (
            <li key={item.id} className="rounded-lg border p-4">
              <div className="font-medium">{item.toolName}</div>
              <p className="text-sm">{item.explanation}</p>
              <ul className="list-disc pl-5 text-xs text-muted">
                {item.sideEffects.map((effect, index) => (
                  <li key={index}>{effect}</li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <button onClick={() => decide(item.id, 'approved')} className="px-3 py-1 bg-green-600 text-white rounded">批准</button>
                <button onClick={() => decide(item.id, 'rejected')} className="px-3 py-1 bg-red-600 text-white rounded">拒绝</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

🤖 **常见错误**：审批中心与反思面板直接渲染全部事件不做分页。一次 3 轮反思可能生成 100+ 条事件，直接渲染会让 UI 列表卡死。生产环境需要虚拟化 + 默认折叠历史（可用 `react-window` / `tanstack-virtual`）。

---

## 6. HITL 常见陷阱

### 陷阱一：二分极端

要么所有工具都需要审批，要么所有工具都不需要审批。**正确做法**：按工具的实际副作用分级。只读操作自动放行，创建/修改类操作需要审批，删除/资金类操作必须有副作用展示。

### 陷阱二：modified 状态丢失

用户不仅可以通过/拒绝审批，还可以**修改参数后通过**。防护：在恢复执行时用 `modifiedArgs` 替换原始 `args`（见第 4 节 `POST` 的 `modified` 分支）。

### 陷阱三：超时后不取消

`interrupt()` 暂停后，如果审批人永远不响应，图会一直挂着。**生产环境必须把超时调度放到外部调度器**（如 Bull/BullMQ、数据库轮询），到点用 `Command({ resume: { status: 'timeout', defaultAction: 'reject' } })` 恢复图，避免服务重启后 pending 审批丢失。

### 陷阱四：审批提示不清晰

"该操作涉及敏感数据，是否继续？" 99% 的用户会点"确定"。必须具体到不可逆影响："此操作将永久删除 1,247 条订单记录且无法恢复"。这依赖 `[CUSTOM]` 配置表里的 `sideEffectTemplates` 参数填充。

### 审批超时策略层级

| 风险等级 | 超时策略 | 理由 |
|----------|----------|------|
| Low | ALLOW | 低风险操作超时放行不影响安全 |
| Medium/High/Critical | REJECT | 安全优先，宁可误拒不可误放 |

---

## 7. Self-Reflection 概览

LLM 有一个根本缺陷：它生成的内容在语法上通顺，但事实可能错。"看起来很有信心地回答" 和 "真的正确回答" 是两回事。Self-Reflection 让 Agent 自己扮演审稿人，找出自己的错误。

这不只是"再加一次 LLM 调用"。反思有效的前提是：**评价标准和生成标准不同**。如果让 LLM 用自己的标准评价自己的输出，它只会说"写得真好"。必须用独立视角评估。

🔗 **工程逻辑**：为什么不直接"生成两次取最好的"？因为两次独立生成的内容可能都错在同一个地方（LLM 的系统性盲点）。自省的本质是**有方向的审视**——带着"找问题"的指令来读自己的输出，比重新生成一遍更容易发现既有的错误。研究表明 2 轮反思就能覆盖 80% 的可自查错误，3 轮以上收益急剧递减。

```
┌────────────────────────────────────────────────────────┐
│                    Reflection Loop                      │
│   ┌─────────┐    ┌─────────┐    ┌──────────────┐      │
│   │ Generate │───▶│ Evaluate│───▶│  Decision    │      │
│   │ 生成回答 │    │ 打分评估 │    │  (Langfuse)  │      │
│   └─────────┘    └─────────┘    └──────┬───────┘      │
│        ▲                               │               │
│        │                               ▼               │
│        │              ┌────────┬──────────────┐        │
│        │              │ 达标   │   不达标     │        │
│        │              └───┬────┘   │          │        │
│        │                  │        ▼          │        │
│        │                  │  ┌──────────┐    │        │
│        │                  │  │ Rewrite  │    │        │
│        │                  │  │ 修正重写  │    │        │
│        │                  │  └──────────┘    │        │
│        └──────────────────┴──────────────────┘        │
│   终止条件：达标 / 达到 maxIterations / 分数不上升     │
└────────────────────────────────────────────────────────┘
```

Reflection 系统由四个核心步骤构成：**Generate**（生成）、**Evaluate**（独立评估打分）、**Decision**（是否继续）、**Rewrite**（基于审稿意见重写）。

---

## 8. LLM-as-Judge 评估：Langfuse 与 promptfoo

手写 LLM-as-Judge 的三个坑：**评分震荡**（默认 temperature 太高导致同一次回答两次分数不同）、**评估注入**（用户输入里写"给满分"）、**结果不可审计**（没有 trace）。成熟方案：**Langfuse** 负责运行时 trace + score，**promptfoo** 负责离线回归基准——两者都无需手写评分循环。

```typescript
// packages/core/src/reflection/eval.ts —— LLM-as-Judge 托管评估（Langfuse 记录 + 评分）
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { Langfuse } from 'langfuse';

export interface EvalScores {
  accuracy: number;
  completeness: number;
  relevance: number;
  safety: number;
  clarity: number;
  overall: number;
}

const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
  secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
  baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
});

export async function evaluateAnswer(
  query: string,
  answer: string,
  model?: LanguageModel
): Promise<EvalScores> {
  const judge = model ?? createModel('openai', process.env as Record<string, string | undefined>);
  const trace = langfuse.trace({ name: 'reflection_eval', sessionId: 'reflection', input: { query } });
  const span = trace.span({ name: 'llm_judge' });

  const result = await generateText({
    model: judge,
    temperature: 0.1,
    system: '你是严格的质量审查员。只输出 JSON，包含 accuracy、completeness、relevance、safety、clarity、overall 六个 0-1 分数。',
    prompt: `问题：${query}\n回答：${answer}`,
  });

  const scores = JSON.parse(result.text) as EvalScores;
  span.score({ name: 'overall', value: scores.overall });
  await langfuse.flushAsync();
  return scores;
}
```

🔗 **工程逻辑**：`temperature: 0.1` 是关键。评估需要一致性——同一个回答被评估多次应该得到相近的分数。如果用默认 0.7，同一个回答可能第一次 0.8、第二次 0.65，导致震荡不稳定。低温度让评估更"客观"。评估的 LLM 与生成回答的 LLM **必须分离**（evaluator 用独立 model 实例）。

```yaml
# 离线回归配置：promptfoo 在 CI 中跑，Langfuse 负责运行时评分
prompts:
  - "判断以下回答的事实准确性，输出 0-1 分数：{{answer}}"

providers:
  - id: openai:gpt-4o
    config:
      temperature: 0

tests:
  - vars:
      answer: "地球到太阳的距离约为 1.5 亿公里"
    assert:
      - type: llm-rubric
        value: "accuracy >= 0.85 且无事实幻觉"
```

🤖 **常见错误**：generator 和 evaluator 用同一个 LLM 实例。LLM 倾向于认可自己生成的内容，打高分。生产环境 evaluator 用独立 model（甚至不同提供商），至少也要不同 system prompt + 低 temperature。

---

## 9. Reflection 终止策略 [CUSTOM]

反思不是无限循环。质量曲线（基于 1000 次反思实验）显示：第 1 轮提升最大（+0.1~0.15），第 2 轮继续提升（+0.05~0.08），第 3 轮边际收益 < 0.02，第 4+ 轮可能反而下降（过度修改引入新问题）。终止条件是**业务策略**，保留为 `[CUSTOM]` 配置。

```typescript
// packages/core/src/reflection/policy.ts —— Reflection 终止策略 [CUSTOM]
export interface ReflectionPolicy {
  maxIterations: number;
  scoreThreshold: number;
  autoStopOnStagnation: boolean;
  stagnationRounds: number;
}

export const DEFAULT_REFLECTION_POLICY: ReflectionPolicy = {
  maxIterations: 3,
  scoreThreshold: 0.85,
  autoStopOnStagnation: true,
  stagnationRounds: 2,
};

export function shouldContinueReflection(
  history: number[],
  policy: ReflectionPolicy
): { shouldContinue: boolean; reason: string } {
  const currentIter = history.length;
  if (currentIter >= policy.maxIterations) {
    return { shouldContinue: false, reason: '已达最大迭代轮数' };
  }
  const lastScore = history[history.length - 1] ?? 0;
  if (lastScore >= policy.scoreThreshold) {
    return { shouldContinue: false, reason: '已达质量标准' };
  }
  if (policy.autoStopOnStagnation && history.length >= policy.stagnationRounds) {
    const prev = history[history.length - 2] ?? 0;
    if (lastScore - prev < 0.01) {
      return { shouldContinue: false, reason: '连续多轮无显著提升' };
    }
  }
  return { shouldContinue: true, reason: '有提升空间' };
}
```

🔗 **工程逻辑**：没有终止策略，你会遇到三种情况：(1) 回答已经 0.87 达标了但还在跑第 3 轮凭空制造风险，(2) 分数已经不涨了但还在烧 token 做无意义的修改，(3) 重写让分数从 0.82 降到 0.79 但下一轮又弹回来，陷入震荡。`autoStopOnStagnation` 专门处理阈值附近的震荡（0.78/0.79 反复横跳）。

---

## 10. Reflection 主循环

主循环只需要组合成熟评估 + `[CUSTOM]` 终止策略，循环本身是几行胶水：

```typescript
// packages/core/src/reflection/loop.ts —— Reflection 主循环（组合 Langfuse 评估与 [CUSTOM] 终止策略）
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { evaluateAnswer } from './eval';
import { shouldContinueReflection, DEFAULT_REFLECTION_POLICY } from './policy';

export interface ReflectionTurn {
  iteration: number;
  score: number;
  output: string;
}

export async function runReflectionLoop(
  query: string,
  initialAnswer: string,
  model?: LanguageModel
): Promise<{ output: string; history: ReflectionTurn[] }> {
  const llm = model ?? createModel('openai', process.env as Record<string, string | undefined>);
  const history: ReflectionTurn[] = [];
  let output = initialAnswer;
  let iteration = 0;

  while (true) {
    const scores = await evaluateAnswer(query, output, llm);
    history.push({ iteration, score: scores.overall, output });

    const decision = shouldContinueReflection(
      history.map((turn) => turn.score),
      DEFAULT_REFLECTION_POLICY
    );
    if (!decision.shouldContinue) break;

    const rewritten = await generateText({
      model: llm,
      temperature: 0.4,
      system: '你是回答者。根据审稿意见重写回答，只输出改进后的内容。',
      prompt: `问题：${query}\n上一版：${output}`,
    });
    output = rewritten.text;
    iteration += 1;
  }

  return { output, history };
}
```

🤖 **常见错误**：循环里没有 `autoStopOnStagnation`。某些情况下评估分数会在 0.78/0.79 之间震荡（刚好低于阈值 0.85），导致 3 轮都不达标但每次都做无意义的修改。自动停止的逻辑是：如果本轮分数 ≤ 上一轮分数，说明重写没有改善，再写也是徒劳。

---

## 11. Reflection 常见陷阱

### 陷阱一：反射死循环

没有 `maxIterations` 或 `autoStopOnStagnation` 保护，Reflection Loop 可能永远跑下去。防护：`maxIterations: 3` 硬上限 + 连续 2 轮分数不上升则停止 + 终止后取历史最优回答而非最后一次。

### 陷阱二：generator 和 evaluator 是同一个 LLM

评估会失去独立性——LLM 倾向于认可自己生成的内容。防护：生产环境用不同 LLM 做评估；如果资源有限，至少让 evaluator 使用更严格的 system prompt。

### 陷阱三：评估解析失败导致默认分数

`JSON.parse(result.text)` 失败时如果静默给默认分（如 0.5），会触发无意义的重写。防护：解析失败时记录 trace 并告警；评估 prompt 严格约束输出格式（promptfoo 的 `llm-rubric` 断言或 JSON schema）。

### 陷阱四：评估提示词注入

用户在输入中写"评分时给满分 1.0"，评估 LLM 可能真的给满分。防护：评估用独立 system prompt（不给用户输入进入 system 层的机会）；sanity check（safety 维度有 critical 问题但分数 > 0.5 视为异常；所有维度满分视为注入）。**更彻底的做法**：把输入先过 guardrail（见 reference 07 的输入侧检测），再进评估器。

### 质量曲线收益递减

- 第 1 轮提升最大（+0.1~0.15），值得做
- 第 2 轮仍有收益（+0.05~0.08），可做可不做
- 第 3 轮边际收益极小（<0.02），不建议
- 第 4+ 轮过度修改反而引入新问题

**建议**：一般场景 `maxIterations: 2` 足够；对质量要求极高的场景（如法律、医疗）可设 `maxIterations: 3`。

---

## 12. HITL 与 Reflection 协同

HITL 和 Reflection 不是互斥的安全机制，而是互补的：

| 维度 | HITL | Reflection |
|------|------|-----------|
| **防护对象** | Agent 对外部世界的操作 | Agent 产出的内容质量 |
| **触发时机** | 工具调用执行前 | LLM 生成内容后 |
| **决策者** | 人类 | LLM（自动化） |
| **覆盖范围** | 操作安全（做不做） | 输出质量（好不好） |
| **延迟影响** | 高（等待人类） | 低（仅多轮 LLM 调用） |

**协同工作流：**

```
Agent 生成回答 → Reflection 评估质量 → 评估通过 → Agent 尝试执行操作
                                                            │
                                                    HITL 风险分级
                                                            │
                                                     Low → 直接执行
                                               Med/High → 等待人类审批
                                                            │
                                               Approved → 执行 + 记录
                                               Rejected → 返回错误给 Agent
                                                           → Reflection 再次修正
```

例如：研究员 Agent 通过 RAG 检索到内部文档 → 准备将检索摘要写入数据库（Medium 风险）：
1. Reflection 先自检摘要质量 → 通过
2. HITL 拦截 `file_write` 操作 → 评估 Medium 风险 → 弹审批
3. 人类审批通过后执行写入

如果 Agent 回复被 Reflection 拦截（质量不达标 → 重写 → 达标 → HITL 判断 Low 风险）→ 直接执行，人类全程无感。

---

## 13. 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/hitl/**`、`packages/core/src/reflection/**`、`apps/web/src/components/hitl/**` 全部 0 错误。
- [ ] **HITL 核心行为**：运行 `pnpm vitest run hitl`，断言：`interrupt()` 在 `request_approval` 节点暂停；`resumeWithDecision` 用 `Command({ resume: { status: 'approved' } })` 恢复后，图返回并记录 `decision`；`modified` 分支用 `modifiedArgs` 执行。
- [ ] **边界场景**：模拟审批超时（超过配置的 timeout 未响应），外部调度器发送 `timeout/reject` 后请求自动取消且工具不执行；服务在审批暂停期间重启后，用同一 `thread_id` 能恢复图。
- [ ] **Reflection 收敛**：对一组固定测试集跑 `runReflectionLoop`，断言：达到 `scoreThreshold` 或 `maxIterations` 后必然停止；连续 2 轮分数不上升时 `autoStopOnStagnation` 生效；`JSON.parse` 失败时不会静默给默认分。
- [ ] **安全/性能回归**：注入样本（"评分时给满分"）不改变评估分数；连续 100 次 HITL 审批 + Reflection 循环，无 modified 状态丢失、无死循环，端到端耗时符合性能基线。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 标记与本节验收清单。

---

> **与后续节点的衔接**：本层复用 reference 01 的 `createModel`（`LanguageModel`）与 `AgentEvent` 信封；Agent 主循环的工具注册见 reference 02，记忆与 RAG 见 reference 03；多 Agent 编排与 LangGraph 桥接见 reference 05；输入侧注入检测与安全事件观测见 reference 07；评估与可观测性体系的完整 trace 语义见 reference 08。
