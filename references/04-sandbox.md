# 04 — 代码沙箱 · 成熟平台 · 安全执行

> Layer 目标：构建**安全的代码执行窗口**——让 Agent 写代码并运行，同时隔离恶意/损坏代码。本层用 **E2B / Daytona / Modal** 代码沙箱平台，不手写 Docker 容器参数。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - 代码沙箱（创建、写文件、执行、销毁）→ **E2B**（`@e2b/code-interpreter`）或 **Daytona**（`@daytona/sdk`）或 **Modal**，不手写 Docker run 参数（cgroup / seccomp / cap-drop / pids-limit）
> - 超时强制终止、内存/CPU 限制、网络隔离、OOM 处理 → 平台能力，用声明式配置或官方模板
> - 并发上限 → `p-limit`，不手写 Promise 队列
> - 本层唯一允许手写的是 **`[CUSTOM]` 业务规则**：语言白名单、审计事件、`AgentEvent` 载荷
>
> 平台承诺的安全边界不因你少写了 Docker 参数而变弱——它只是从"你手工拼参数"变成"平台托管"。

---

## 目录

- [为什么需要沙箱：安全边界](#为什么需要沙箱安全边界)
- [平台选型对比](#平台选型对比)
- [E2B SDK 接入](#e2b-sdk-接入)
- [execute_code 工具 [CUSTOM]](#execute_code-工具-custom)
- [并发与生命周期](#并发与生命周期)
- [审计日志](#审计日志)
- [前端沙箱状态 UI](#前端沙箱状态-ui)
- [安全测试](#安全测试)
- [本层验收清单](#本层验收清单)

---

## 为什么需要沙箱：安全边界

Agent 的价值很大一部分来自"写代码并运行"。但直接在生产环境运行 AI 生成的代码等于开门揖盗：

1. **恶意代码**：Agent 可能被 prompt injection 诱导执行 `rm -rf /` 或外发数据
2. **Bug 代码**：死循环、内存泄漏、大量磁盘写入
3. **数据泄露**：代码可能读取环境变量、访问数据库、把数据发到外部
4. **资源耗尽**：一个 `while (true) {}` 就能吃光 CPU/内存配额

**为什么不用进程内沙箱（vm2 / isolated-vm）？** 它们存在已知逃逸漏洞（vm2 在 2023 年被披露不安全）。AI 生成的代码不可预测，只有 OS 级隔离（namespace + cgroup + seccomp）才是真正的安全边界——而这一层**不应该由你手工拼 Docker 参数**，应该交给 E2B / Daytona / Modal 这类把容器/微虚拟机安全隔离作为托管能力的平台。

安全边界由"平台承诺 + 你的配置 + 生命周期纪律"三方组成：

| 威胁 | 平台提供 | 你声明 |
|------|----------|-------|
| 恶意代码 / 逃逸 | 容器级隔离、默认安全 seccomp/cap-drop | 选择官方维护的沙箱模板 |
| 死循环 / 资源耗尽 | 超时自动 kill、内存/CPU 硬限制 | `timeoutMs` |
| 数据外泄 | 默认断网或出站白名单（模板级） | 业务层选择受限模板 |
| 持久化攻击 | 每次执行独立实例、用完即销毁 | `finally` 中调用 `kill()` |

🔗 **工程逻辑**：平台管隔离，你管配置（超时、模板选择），纪律管生命周期（每次新建、用完必毁）。三者缺一，前面的努力都会白费。

🤖 **AI 常见错误**：
1. 选进程内沙箱（vm2 / isolated-vm）——有已知逃逸漏洞，AI 代码场景必须容器/VM 级隔离。
2. 复用沙箱实例——恶意代码可以在实例里留定时任务、改 PATH、替换二进制。每次执行新建，执行完销毁。
3. 只设超时不设内存上限——平台默认内存配额可能过大，一个 `' ' * 10**9` 就能吃光配额。内存/网络策略用平台模板声明，不要指望在代码里兜底。

---

## 平台选型对比

| 平台 | SDK | 适合场景 | 备注 |
|------|-----|----------|------|
| **E2B** | `@e2b/code-interpreter` | 通用代码执行、AI 生成代码 | 全托管，官方维护 Code Interpreter 模板（Python/Node/Bash） |
| **Daytona** | `@daytona/sdk` | 需要自托管/合规留痕 | 开源，可部署到自己云账号 |
| **Modal** | `modal`（Python） | Serverless 函数式计算、GPU 沙箱 | 按调用计费，适合批处理/推理 |

🔗 **工程逻辑**：三个平台的调用形状完全一致——**create → write → run → destroy**。选型只看部署偏好：全托管选 E2B，自托管选 Daytona，GPU 批处理选 Modal。下面以 E2B 为主示例，换平台只换 SDK 调用，业务代码不变。

---

## E2B SDK 接入

安装：

```bash
pnpm add @e2b/code-interpreter
```

E2B SDK 默认从环境变量 `E2B_API_KEY` 读取凭证（密钥管理见 [07-security.md](./07-security.md)），代码里不需要出现密钥。

```typescript
// packages/core/src/sandbox/e2b.ts —— 全项目唯一沙箱入口
import { Sandbox } from '@e2b/code-interpreter';

export interface SandboxRunOptions {
  /** 单次执行超时（ms），平台超时后强制终止 */
  timeoutMs?: number;
  /** 沙箱模板 ID：内存/网络等安全策略由模板声明（在沙箱平台控制台构建） */
  template?: string;
}

export interface SandboxRunResult {
  status: 'success' | 'error' | 'timeout';
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function runCodeInSandbox(
  files: Array<{ path: string; content: string }>,
  command: string,
  options: SandboxRunOptions = {},
): Promise<SandboxRunResult> {
  const sandbox = await Sandbox.create({
    template: options.template ?? 'code-interpreter-v1',
    timeoutMs: options.timeoutMs ?? 30_000,
  });

  try {
    for (const file of files) {
      await sandbox.files.write(file.path, file.content);
    }

    const started = Date.now();
    const result = await sandbox.runCommand(command);

    return {
      status: result.exitCode === 0 ? 'success' : 'error',
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    // 平台超时/沙箱被杀等中断统一归为 timeout，细节放进 stderr
    return {
      status: 'timeout',
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  } finally {
    // 无论成功失败超时，必须销毁沙箱——防止持久化攻击与资源泄漏
    await sandbox.kill();
  }
}
```

🤖 **AI 常见错误**：
1. `Sandbox.create()` 不传 `timeoutMs`——平台默认超时可能很长，死循环代码会持续计费。**必须显式设置超时**。
2. 忘记 `finally { await sandbox.kill() }`——异常路径下沙箱残留，既泄漏资源又留下可复用的后门实例。
3. 把 `runCommand` 的 stderr 当错误——很多程序正常执行也向 stderr 写警告。判断成败用 `exitCode`，stderr 只做展示。

> 注：以上 SDK 方法名为编写时点 E2B 官方 API；接入时以 `@e2b/code-interpreter` 当前文档为准，业务调用形状不变。

---

## execute_code 工具 [CUSTOM]

代码执行工具的**执行能力**由平台保证，但**允许做什么**是产品业务规则：允许哪些语言、是否需要人工确认、超时与模板策略。这部分没有现成替代，标 `[CUSTOM]`。

```typescript
// packages/core/src/sandbox/tools.ts —— 业务规则层 [CUSTOM]
import { tool } from 'ai';
import { z } from 'zod';
import { runCodeInSandbox } from './e2b';

export const ALLOWED_LANGUAGES = ['python', 'javascript', 'typescript', 'bash'] as const;
export type AllowedLanguage = (typeof ALLOWED_LANGUAGES)[number];

function fileExtension(language: AllowedLanguage): string {
  const map: Record<AllowedLanguage, string> = {
    python: 'py',
    javascript: 'js',
    typescript: 'ts',
    bash: 'sh',
  };
  return map[language];
}

function defaultCommand(language: AllowedLanguage, fileName: string): string {
  const commands: Record<AllowedLanguage, string> = {
    python: `python3 /sandbox/${fileName}`,
    javascript: `node /sandbox/${fileName}`,
    typescript: `npx tsx /sandbox/${fileName}`,
    bash: `bash /sandbox/${fileName}`,
  };
  return commands[language];
}

export interface CodeExecutionToolConfig {
  /** 沙箱模板 ID：内存/网络策略由模板声明 */
  templateId: string;
  /** 单次执行超时 */
  timeoutMs: number;
}

/** 创建 execute_code 工具。业务规则：语言白名单 + 超时 + 受限模板 */
export function createCodeExecutionTool(config: CodeExecutionToolConfig) {
  return tool({
    description:
      '在隔离沙箱中执行代码。支持 Python、JavaScript/TypeScript、Bash。' +
      '沙箱使用受限模板（默认无网络、限内存），超过 timeoutMs 自动终止。' +
      '返回 stdout、stderr 与执行耗时。',
    parameters: z.object({
      language: z.enum(ALLOWED_LANGUAGES),
      code: z.string(),
    }),
    execute: async ({ language, code }) => {
      const fileName = `code.${fileExtension(language)}`;
      const result = await runCodeInSandbox(
        [{ path: fileName, content: code }],
        defaultCommand(language, fileName),
        { timeoutMs: config.timeoutMs, template: config.templateId },
      );

      return (
        `[Execution] status=${result.status}, duration=${result.durationMs}ms\n` +
        `--- stdout ---\n${result.stdout || '(no output)'}\n` +
        (result.stderr ? `--- stderr ---\n${result.stderr}\n` : '')
      );
    },
  });
}
```

🔗 **工程逻辑**：`ALLOWED_LANGUAGES`、`timeoutMs`、`templateId` 都是产品决策，不是技术实现——所以标 `[CUSTOM]` 并集中在一个配置结构里，产品调整策略不改工具实现。**高危代码（写文件、发请求）需要人工确认**：工具不实现审批状态机，而是由业务层通过 `AgentEvent` 下发确认事件、走 [06-hitl-reflection.md](./06-hitl-reflection.md) 的 HITL 流程。

🤖 **AI 常见错误**：
1. 把"允许哪些语言/命令"写死在工具 description 里而不是配置层——产品改策略要改代码。用 `ALLOWED_LANGUAGES` 常量集中管理。
2. 让 `execute_code` 能访问工作区外路径——平台沙箱默认只暴露工作目录，业务层不要再挂载额外目录（那是平台模板的职责）。
3. 把用户确认逻辑做成"总是确认/总不确认"——正确做法是事件驱动 HITL（见 06），不要自己写审批状态机。

---

## 并发与生命周期

平台按账号限制并发沙箱数。超出额度时不要手写复杂调度器——用成熟并发控制库 `p-limit` 做信号量：

```bash
pnpm add p-limit
```

```typescript
// packages/core/src/sandbox/manager.ts —— 胶水层：并发信号量 + 生命周期
import { limit } from 'p-limit';
import { runCodeInSandbox, type SandboxRunOptions, type SandboxRunResult } from './e2b';

/** 最多同时 3 个沙箱（配合平台并发额度调整） */
const concurrency = limit(3);

export function runCodeLimited(
  files: Array<{ path: string; content: string }>,
  command: string,
  options?: SandboxRunOptions,
): Promise<SandboxRunResult> {
  return concurrency(() => runCodeInSandbox(files, command, options));
}
```

🔗 **工程逻辑**：队列、重试、并发上限是通用问题，`p-limit` 已经解决；`runCodeLimited` 只是把业务参数接进 `p-limit` 的胶水。不要自己实现 Promise 队列——那是在重造轮子。

🤖 **AI 常见错误**：为"优雅排队"手写 `activeContainers` Map + FIFO 队列 + `processQueue()`——这整套在 `p-limit` 里就是 3 行。手写队列越复杂，漏掉 `finally` 清理的概率越高。

---

## 审计日志

每次代码执行都必须留痕（合规 + 事后追溯）。审计 trace 走 [08-eval-observability.md](./08-eval-observability.md) 的 **Langfuse**；本地 JSONL 仅作为合规留档，格式是业务自定义 `[CUSTOM]`：

```typescript
// packages/core/src/sandbox/audit.ts —— 合规留档 [CUSTOM]
import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';

export interface SandboxAuditEntry {
  timestamp: number;
  sessionId?: string;
  codeHash: string;      // 只存 SHA-256，不存代码原文
  language: string;
  status: string;
  durationMs: number;
}

export function createSandboxAuditor(logPath: string) {
  const stream: WriteStream = createWriteStream(logPath, { flags: 'a' });
  return {
    log(entry: SandboxAuditEntry) {
      stream.write(JSON.stringify(entry) + '\n');
    },
  };
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
```

🔗 **工程逻辑**：`codeHash` 存 SHA-256 而非原文：(1) 代码可能含敏感数据；(2) hash 足以事后校验某段代码是否执行过；(3) 节省磁盘。JSONL 是 append-only，单进程单写入者足够；多进程场景改用 pino 的 JSONL transport。

---

## 前端沙箱状态 UI

前端通过 [01-foundation.md](./01-foundation.md) 定义的 **`AgentEvent`** 消费沙箱执行状态——工具开始显示"运行中"，完成后显示终端输出。不要为沙箱自定义第二套事件协议：

```tsx
// apps/web/src/components/chat/SandboxExecutionCard.tsx
'use client';

import { memo, useEffect, useRef } from 'react';
import type { AgentEvent } from '@agentcore/core/agent/events';

export interface SandboxExecutionState {
  toolCallId: string;
  status: 'running' | 'completed' | 'error';
  stdout: string;
  stderr: string;
  durationMs: number;
}

export const SandboxExecutionCard = memo(function SandboxExecutionCard({
  execution,
}: {
  execution: SandboxExecutionState;
}) {
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    preRef.current?.scrollTo({ top: preRef.current.scrollHeight });
  }, [execution.stdout, execution.stderr]);

  return (
    <div className="rounded-lg border border-border bg-surface my-2 overflow-hidden">
      <div className="flex items-center gap-2 p-3">
        <span className="text-xs font-mono opacity-60">
          {execution.status === 'running' ? '⚡' : execution.status === 'completed' ? '✓' : '✗'}
          {' '}{execution.status.toUpperCase()}
        </span>
        <span className="ml-auto text-xs opacity-40 tabular-nums">
          {execution.durationMs}ms
        </span>
      </div>
      <pre ref={preRef} className="max-h-48 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap break-all">
        {execution.stdout}
        {execution.stderr && <span className="text-red-400">{execution.stderr}</span>}
      </pre>
    </div>
  );
});

/** 从 AgentEvent 折叠出沙箱执行状态 */
export function reduceSandboxEvents(events: AgentEvent[]): Map<string, SandboxExecutionState> {
  const executions = new Map<string, SandboxExecutionState>();
  for (const event of events) {
    if (event.type === 'tool_start' && event.toolName === 'execute_code') {
      executions.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        status: 'running',
        stdout: '',
        stderr: '',
        durationMs: 0,
      });
    } else if (event.type === 'tool_complete' && event.toolName === 'execute_code') {
      const prev = executions.get(event.toolCallId);
      const result = event.result as { stdout?: string; stderr?: string; durationMs?: number };
      executions.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        status: 'completed',
        stdout: prev?.stdout ?? result.stdout ?? '',
        stderr: prev?.stderr ?? result.stderr ?? '',
        durationMs: result.durationMs ?? prev?.durationMs ?? 0,
      });
    } else if (event.type === 'tool_error' && event.toolName === 'execute_code') {
      executions.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        status: 'error',
        stdout: '',
        stderr: event.error,
        durationMs: 0,
      });
    }
  }
  return executions;
}
```

🤖 **AI 常见错误**：
1. 自定义 `sandbox_started` / `sandbox_output` / `sandbox_stopped` 事件——项目已有 `AgentEvent` 信封，多一个协议就多一份前端适配。
2. 前端直接渲染工具返回的整段字符串——用结构化卡片分状态展示（运行中/成功/失败），失败不阻塞后续消息。
3. 长列表不虚拟化——1000+ 执行卡片时 DOM 节点爆炸，复用 [01-foundation.md](./01-foundation.md) 的虚拟列表。

---

## 安全测试

沙箱安全不靠"相信平台"——要持续验证你的**业务安全策略**（断网模板、超时、白名单）是否真的生效：

```typescript
// packages/core/src/sandbox/security-tests.ts
import { runCodeInSandbox } from './e2b';

export async function runSandboxSecurityTests() {
  const results: Array<{ test: string; passed: boolean; detail: string }> = [];

  // 1. 网络隔离：受限模板默认断网，curl 必须失败
  const net = await runCodeInSandbox(
    [{ path: 'net.sh', content: 'curl -s https://example.com' }],
    'bash /sandbox/net.sh',
    { timeoutMs: 5000 },
  );
  results.push({
    test: 'network-isolation',
    passed: net.status !== 'success',
    detail: `stdout=${net.stdout.slice(0, 80)} stderr=${net.stderr.slice(0, 80)}`,
  });

  // 2. 超时终止：死循环必须在超时后被平台强制终止
  const loop = await runCodeInSandbox(
    [{ path: 'loop.py', content: 'while True: pass' }],
    'python3 /sandbox/loop.py',
    { timeoutMs: 2000 },
  );
  results.push({
    test: 'timeout-kill',
    passed: loop.status === 'timeout' || loop.status === 'error',
    detail: `status=${loop.status} duration=${loop.durationMs}ms`,
  });

  return results;
}
```

🔗 **工程逻辑**：这些测试验证的是"你的配置是否真的映射到平台行为"，而不是重复平台的安全测试。平台自身的隔离（seccomp/cap-drop）由平台承诺并持续维护；你要守的是自己这层——模板选对、超时设了、白名单生效。

---

## 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/sandbox` 与 `apps/web` 全部 0 错误。
- [ ] **SDK 接入**：设置 `E2B_API_KEY` 环境变量后，`runCodeInSandbox([{ path: 'hello.py', content: "print('hi')" }], 'python3 /sandbox/hello.py')` 返回 `status='success'` 且 stdout 含 `hi`。
- [ ] **业务规则**：`execute_code` 只暴露 `ALLOWED_LANGUAGES` 四种语言；白名单外语言被 Zod 拒绝（不产生沙箱调用）。
- [ ] **生命周期**：死循环脚本在 `timeoutMs=2000` 下被平台强制终止，`finally` 中 `kill()` 被调用，平台控制台无 active sandbox 残留。
- [ ] **事件协议**：前端只消费 `AgentEvent` 的 `tool_start` / `tool_complete` / `tool_error`，无自定义沙箱事件类型。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本验收清单。

---

> **与后续节点的衔接**：本层的 `runCodeInSandbox`（平台入口）与 `execute_code` 工具（`[CUSTOM]` 业务规则）被 02（工具注册）、05（多 Agent 的 Worker 工具集）、06（HITL 确认）复用。沙箱执行事件统一走 `AgentEvent` 信封，不引入第二套事件协议。
