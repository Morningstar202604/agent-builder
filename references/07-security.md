# 07 — 安全纵深 · Prompt 注入防御 · 工具风险分级 · Guardrails

> **Layer 3：安全纵深** — Agent 直接暴露在不可信输入面前。本 reference 用成熟 Guardrails 方案替代手写注入检测/工具分级/事件日志；业务规则（哪些模式算注入、工具分级表）保留为 `[CUSTOM]` 配置。
>
> **⚠️ 不要重造以下东西：**
> - Prompt 注入检测引擎 → **OpenAI Agents SDK Guardrails**（`input_guardrail` / `output_guardrail` + `tripwire_triggered`）或 **LLM Guard**（独立检测服务），不要手写正则库/检测器
> - 工具风险分级引擎 → **AI SDK `tool()` + 配置表**（`[CUSTOM]` 业务分级表），不要手写注册表引擎
> - Guardrails 管道 → **OpenAI Agents SDK**（guardrail + tripwire）或 **LLM Guard HTTP API**，不要手写检查管道
> - 沙箱与逃逸检测 → **E2B / Daytona**（reference 04 已实现），本层不重复实现
> - 多租户隔离 → **Postgres RLS**（SQL 配置，reference 19 已给出），不要手写租户过滤逻辑
> - 安全事件日志 → **Langfuse trace**（安全事件作为观测数据），不要手写日志器
>
> 本层唯一允许手写的 `[CUSTOM]`：**注入模式业务库**（哪些模式算注入，交给 LLM Guard 的检测器配置）、**工具风险分级表**（工具名 → 等级/是否需要审批）、**安全中心 UI**。

## 目录

- [1. 安全总论](#1-安全总论)
- [2. 输入侧：OpenAI Agents SDK Guardrails + LLM Guard](#2-输入侧openai-agents-sdk-guardrails--llm-guard)
- [3. 工具风险分级 [CUSTOM]](#3-工具风险分级-custom)
- [4. 输出侧：Prompt 泄漏防护](#4-输出侧prompt-泄漏防护)
- [5. 沙箱逃逸检测（复用 reference 04）](#5-沙箱逃逸检测复用-reference-04)
- [6. 多租户隔离：Postgres RLS（复用 reference 19）](#6-多租户隔离postgres-rls复用-reference-19)
- [7. 安全观测：Langfuse](#7-安全观测langfuse)
- [8. 全节点串联](#8-全节点串联)
- [9. 避坑汇总](#9-避坑汇总)
- [10. 本层验收清单](#10-本层验收清单)

---

## 1. 安全总论

Agent 安全不是"加个鉴权就完事"。你需要纵深防御——单一防线被突破后还有下一层。本层四道防线：

1. **输入侧注入检测**：用户消息/文档进 LLM 前先过 guardrail（OpenAI Agents SDK / LLM Guard）。
2. **工具风险分级**：LLM 决定调工具时，按 `[CUSTOM]` 分级表拦截高风险操作。
3. **沙箱与逃逸检测**：代码执行放进 E2B/Daytona 沙箱，由沙箱运行时兜底（reference 04）。
4. **多租户隔离与观测**：数据按租户隔离（Postgres RLS），所有安全事件进 Langfuse。

🔗 **工程逻辑**：为什么不用一条大正则覆盖所有注入模式？因为注入手法每月新增，一个 800 字符的正则要么过度误判（把正常聊天标记为注入），要么漏判小变体。成熟方案（LLM Guard）用多层检测器（正则 + 编码归一化 + 分类模型 + Presidio），由专业团队持续维护——你只需要配置业务规则，不重造引擎。

---

## 2. 输入侧：OpenAI Agents SDK Guardrails + LLM Guard

**OpenAI Agents SDK** 提供 `input_guardrail`：返回 `GuardrailFunctionOutput`，当 `tripwire_triggered = true` 时，`Runner.run` 立即终止并返回 `GuardrailTripwireTriggered`，不再继续 Agent 循环。**LLM Guard** 是可独立部署的检测服务（HTTP API），提供扫描器/检测器组合。

**TypeScript 侧接入**：在 AI SDK 的 `tool()` 执行前调用 LLM Guard HTTP API，检测结果作为 `tool_error` 或拦截结果返回给模型——这是胶水层，不是引擎：

```typescript
// server/src/security/injection-guard.ts —— 注入检测胶水层（调用 LLM Guard HTTP API，不自研引擎）
import { tool } from 'ai';
import { z } from 'zod';
import { getToolRisk } from '@agentcore/core/security/tool-risk-config';

export interface GuardResult {
  tripwire: string;
  isInjection: boolean;
}

export async function runInjectionGuard(input: string): Promise<GuardResult> {
  const endpoint = process.env.LLM_GUARD_URL ?? 'http://localhost:8000/analyze';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: input }),
  });
  const data: { detected: boolean; tripwire?: string } = await response.json();
  return {
    tripwire: data.tripwire ?? 'injection_detected',
    isInjection: data.detected,
  };
}

export const guardedExecuteCode = tool({
  description: '在沙箱中执行代码（高风险，需 guardrail 校验）',
  parameters: z.object({ command: z.string() }),
  execute: async ({ command }) => {
    const rule = getToolRisk('execute_code');
    if (rule.requiresApproval) {
      const guard = await runInjectionGuard(command);
      if (guard.isInjection) {
        return { error: `已拦截：${guard.tripwire}` };
      }
    }
    return { status: 'ok' };
  },
});
```

**Python 侧（OpenAI Agents SDK 原生）**：如果安全服务独立部署在 Python 侧，直接用 `@input_guardrail`：

```python
# server/src/security/guardrails.py —— OpenAI Agents SDK input guardrail（Python 侧参考）
from agents import Agent, RunContextWrapper, TResponseInputItem, input_guardrail, GuardrailFunctionOutput
from pydantic import BaseModel

class InjectionOutput(BaseModel):
    is_injection: bool
    tripwire: str

async def detect_injection(text: str) -> bool:
    # 调用 LLM Guard 的 /analyze，不要在这里手写正则引擎
    return False

@input_guardrail
async def injection_guardrail(
    context: RunContextWrapper,
    agent: Agent,
    input: str | list[TResponseInputItem],
) -> GuardrailFunctionOutput:
    detected = await detect_injection(str(input))
    return GuardrailFunctionOutput(
        output_info=InjectionOutput(is_injection=detected, tripwire="injection_detected"),
        tripwire_triggered=detected,
    )
```

🤖 **常见错误**：注入检测正则被大小写/零宽字符绕过。手写引擎的 pattern 经常忘记 `i` flag、漏掉全角同形字、Cyrillic 同形字和零宽字符。用 LLM Guard 的 `normalize` 扫描器（Unicode 归一化） + 分类模型，覆盖这些变体；`[CUSTOM]` 注入模式库只作为补充规则。

---

## 3. 工具风险分级 [CUSTOM]

工具风险分级表是**业务规则**，不是框架能力。为什么不能指望 LLM 自己判断风险等级？因为 LLM 会把你说的任何工具调用都判断为"安全"——它的设计倾向是服从指令。风险分类必须是人工注册的硬编码表。**未知工具默认 CRITICAL**——宁可误杀也不放行。

```typescript
// packages/core/src/security/tool-risk-config.ts —— 工具分级表 [CUSTOM]
export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ToolRiskEntry {
  toolPattern: string;
  level: ToolRiskLevel;
  requiresApproval: boolean;
  maxArgs?: string[];
}

export const TOOL_RISK_REGISTRY: ToolRiskEntry[] = [
  { toolPattern: 'web_search', level: 'low', requiresApproval: false },
  { toolPattern: 'file_read', level: 'low', requiresApproval: false },
  { toolPattern: 'file_write', level: 'medium', requiresApproval: true },
  { toolPattern: 'send_email', level: 'medium', requiresApproval: true },
  { toolPattern: 'delete_records', level: 'high', requiresApproval: true },
  { toolPattern: 'execute_code', level: 'critical', requiresApproval: true, maxArgs: ['command'] },
];

export function getToolRisk(toolName: string): ToolRiskEntry {
  const matched = TOOL_RISK_REGISTRY.find((entry) => entry.toolPattern === toolName);
  if (matched) return matched;
  return { toolPattern: '*', level: 'critical', requiresApproval: true };
}
```

🤖 **常见错误**：新工具上线没登记风险 → 开发忘记维护注册表 → 未知工具走默认分支。默认分支必须是 `critical`（拦截 + 告警），而不是 `low` 放行。

---

## 4. 输出侧：Prompt 泄漏防护

输出侧主要防两类泄漏：**模型把 system prompt / 私有数据原样吐给用户**、**模型把用户隐私拼进工具参数**。OpenAI Agents SDK 的 `output_guardrail` 在 Agent 返回最终输出前检查，`tripwire_triggered` 时输出被终止并替换为安全响应：

```python
# server/src/security/output_guardrails.py —— 输出侧 Prompt 泄漏防护（OpenAI Agents SDK）
from agents import Agent, output_guardrail, GuardrailFunctionOutput, RunContextWrapper
from pydantic import BaseModel

class LeakOutput(BaseModel):
    contains_secret: bool
    matched_pattern: str

async def detect_secret_in_output(text: str) -> bool:
    # 用 Presidio / LLM Guard 的出力扫描器，不要手写正则
    return False

@output_guardrail
async def prompt_leak_guardrail(
    context: RunContextWrapper,
    agent: Agent,
    output: str,
) -> GuardrailFunctionOutput:
    leaked = await detect_secret_in_output(output)
    return GuardrailFunctionOutput(
        output_info=LeakOutput(contains_secret=leaked, matched_pattern="secret"),
        tripwire_triggered=leaked,
    )
```

**TypeScript 侧**：AI SDK 的 `streamText` 输出在返回给用户前经过同一道检查（在 `finish` 回调或 `toDataStreamResponse` 前调用 `runInjectionGuard` 的 `output` 变体）。检测到泄漏时，用 Langfuse 记录安全事件（见第 7 节）并把输出替换为"内容已被安全策略拦截"。

---

## 5. 沙箱逃逸检测（复用 reference 04）

代码执行必须放进沙箱（**E2B / Daytona**），沙箱逃逸检测由沙箱运行时负责（reference 04 已实现 seccomp/AppArmor、网络隔离 `--network none`、文件系统白名单）。**本层不重复实现**，只做两件事：把沙箱报警转成安全事件、把 escape 迹象上报观测。

```typescript
// server/src/security/sandbox-escape.ts —— 沙箱逃逸检测由 reference 04 的沙箱运行时负责，本层只上报
import { recordSecurityEvent } from './observability';

export async function handleSandboxAlert(
  sessionId: string,
  detail: Record<string, unknown>
): Promise<void> {
  await recordSecurityEvent(sessionId, 'sandbox_escape', detail);
}
```

---

## 6. 多租户隔离：Postgres RLS（复用 reference 19）

多租户隔离不要手写 `WHERE tenant_id = ?` 的过滤逻辑——每一处手写都是一处漏写风险。用 **Postgres Row Level Security**：在数据库层强制每行都属于当前租户，应用层即使漏了过滤条件也读不到他人数据。完整迁移脚本见 reference 19，本层只给安全事件表的等价配置：

```sql
-- migrations/007_security_rls.sql —— 多租户安全事件隔离（Postgres RLS 配置，非手写逻辑）
ALTER TABLE security_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_security_events ON security_events
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE ROLE agentcore_admin BYPASSRLS;
```

🤖 **常见错误**：只 `ENABLE ROW LEVEL SECURITY` 但忘了建 `POLICY`——表变成"对所有行不可见"，普通查询全空，排查半天。启用 RLS 后必须立刻创建 `USING` 策略并验证 `current_setting` 在连接建立时已设置（否则查询报错）。

---

## 7. 安全观测：Langfuse

安全事件是**观测数据**，不是业务日志。用 Langfuse trace 记录，替代手写 `SecurityEventLogger`/`console.warn`——事件有了 trace_id、session_id，可关联到具体 Agent 运行，可回放、可告警：

```typescript
// server/src/security/observability.ts —— 安全事件作为观测数据（Langfuse trace，替代手写日志器）
import { Langfuse } from 'langfuse';

export type SecurityEventType = 'injection_blocked' | 'tool_rejected' | 'sandbox_escape' | 'path_traversal';

const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
  secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
});

export async function recordSecurityEvent(
  sessionId: string,
  type: SecurityEventType,
  detail: Record<string, unknown>
): Promise<void> {
  const trace = langfuse.trace({
    name: 'security_event',
    sessionId,
    input: { type },
    metadata: detail,
  });
  trace.update({ output: detail });
  await langfuse.flushAsync();
}
```

🤖 **常见错误**：安全事件散落在 `console.warn` 里，没有关联 trace_id。排障时无法回答"这次注入发生在哪一轮对话、哪一次工具调用"。安全事件必须与 Agent 运行 trace 关联（`sessionId` + `trace_id`），这是 Langfuse 而不是 `console` 的职责。

---

## 8. 全节点串联

```
用户消息 POST /api/chat
    │
    ▼
input_guardrail（tripwire_triggered=false 才继续）   ← Step 2: 注入检测
    │ (通过)
    ▼
Agent.run(safeContent)
    │
    │  ┌─ LLM decides to call: execute_code ─┐
    │  ▼                                       │
    │  getToolRisk('execute_code')   ← Step 3: [CUSTOM] 分级表，critical 拦截
    │  │ (需审批)                              │
    │  ▼                                       │
    │  E2B/Daytona 沙箱执行          ← Step 5: 沙箱运行时（reference 04）
    │  │ (escape alert)                     │
    │  └─ handleSandboxAlert()      ← Step 5: 上报安全事件
    │                                          │
    ▼                                          ▼
返回结果 ── output_guardrail（泄漏检测）   ← Step 4
    │
    ▼
recordSecurityEvent() → Langfuse trace     ← Step 7
```

---

## 9. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| 正则防御被大小写绕过 | 忘记加 `i` flag | 用 LLM Guard 的 normalize 扫描器，业务规则只做补充 |
| 零宽字符绕过正则 | 匹配前没做 Unicode 归一化 | 用 LLM Guard 的 `normalize` 检测器，不用手写字符替换 |
| 分隔符固定字符串被跳出 | 用户输入包含你的分隔符 | 用 UUID 做随机 boundary |
| 只检查写不检查读 | 路径遍历在读取时也发生 | 文件读写都交给沙箱工作区白名单（reference 04） |
| 新工具上线没登记风险 | 开发者忘记维护注册表 | 未知工具默认 CRITICAL，宁可误杀不放过 |
| 沙箱默认有网络 | Docker 默认 `--network bridge` | 沙箱容器必须 `--network none`（reference 04） |
| 只启用 RLS 没建 POLICY | 忽略 RLS 策略 | 建 `USING` 策略 + 验证 `current_setting` |
| 直接拼 system prompt | 用户输入和 system prompt 之间没隔离 | 用 guardrail 包裹用户输入 |
| eval / Function 动态执行用户输入 | 信任 LLM 输出的安全性 | 代码执行一律进沙箱，不直接跑在宿主机 |
| 安全事件没有 trace_id | 用手写日志器 | 事件进 Langfuse，关联 sessionId + traceId |

---

## 10. 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/security/**`、`server/src/security/**`、`apps/web/src/components/security/**` 全部 0 错误。
- [ ] **注入检测**：运行基准测试，10 种已知注入手法（大小写绕过、零宽字符、全角同形字、Cyrillic 同形字）检测率 > 95%，正常用户消息误判率 < 1%；`tripwire_triggered=true` 时 Agent 运行立即终止并返回 `GuardrailTripwireTriggered`。
- [ ] **工具分级**：`getToolRisk('execute_code')` 返回 `critical` 且 `requiresApproval=true`；未注册工具返回 `critical`（默认拦截）而非放行。
- [ ] **RLS 隔离**：以非 `BYPASSRLS` 角色查询 `security_events`，只能看到 `current_setting('app.current_tenant_id')` 对应租户的行；篡改 `tenant_id` 查询参数读不到他人数据。
- [ ] **观测**：触发一次注入拦截，Langfuse 出现 `security_event` trace，且 `sessionId` 与 Agent 运行一致；安全事件不再出现在 `console`。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 标记与本节验收清单。

---

> **与后续节点的衔接**：本层复用 reference 01 的 `AgentEvent` 信封与 `createModel`（`LanguageModel`）；沙箱细节见 reference 04；多 Agent 编排的跨 Agent 安全传递见 reference 05；Guardrails 体系全景与 tracing 见 reference 22；多租户完整迁移与备份见 reference 19；评估与安全事件的统一观测语义见 reference 08。
