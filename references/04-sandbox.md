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

| 平台 | 官方 SDK | 隔离模型 | 冷启动 | 语言支持 | 生产案例 |
|------|----------|----------|--------|----------|----------|
| **E2B** | `@e2b/code-interpreter`（TypeScript / Python） | Firecracker microVM（KVM 微型虚拟化，AWS Lambda 同源） | 约 100-300ms 创建独立 microVM | Python / Node / Bash 官方 Code Interpreter 模板；任意语言可自建镜像 | 大量 AI agent 项目与 agent 框架的默认沙箱；模板由官方持续维护 |
| **Daytona** | `@daytona/sdk`（TypeScript / Python / Go） | 容器 + 轻量 VM，可自托管到你的云账号（VPC） | 官方基准约 90ms 创建环境 | 30+ 预置环境（Python / Node / Go / Rust / Java 等） | 企业合规场景：代码必须留在客户云账号内 |
| **Modal** | `modal`（Python） | Serverless 容器 + 安全边界；Sandboxes 提供可交互执行环境 | 秒级冷启动，热实例可复用 | Python 优先，任意 shell 命令可执行 | 重型 Python / GPU 批处理、数据管线、模型推理 |
| **Firecracker microVM** | 不直接提供 SDK（是组件） | 微型虚拟化，每 VM 内存开销约 5MB，基于 KVM | AWS Lambda 实测量级约 125ms | 任意 guest OS（Linux） | AWS Lambda / Fargate 底层；E2B 构建于其上 |

> **读表方法**：隔离模型决定安全边界强度——microVM 是硬件辅助虚拟化，逃逸面远小于共享内核容器；冷启动决定“每次执行新建沙箱”的体验成本；语言支持决定模板能否覆盖你的 `ALLOWED_LANGUAGES`。Firecracker 本身是**组件不是产品**：直接调用它等于自研沙箱平台，违反本层铁律。

### 为什么底层是 Firecracker microVM

E2B 与 AWS Lambda 共用 Firecracker——一个用 Rust 编写的微型虚拟化（microVM）管理器。每个沙箱是一个独立 VM，拥有自己的内核，与宿主机和其他沙箱之间是硬件辅助隔离：

- **逃逸面小**：microVM 只模拟必要设备，攻击面比通用 QEMU VM 更小；共享内核容器（Docker 默认）一旦内核漏洞被利用，隔离即失效。
- **开销低**：每 VM 内存开销约 5MB，“每次执行新建一个沙箱”在经济上可行——这是平台敢把 `create → run → destroy` 作为默认生命周期模型的原因。
- **生产验证充分**：Firecracker 支撑 AWS Lambda / Fargate 多年，是云厂商级验证；E2B 在其上包装出 AI 代码沙箱的易用 API。

**对你的工程含义**：不要重复实现 microVM 管理——那是平台的工作。你要做的是选对模板、设对超时、用对生命周期，三件事都是声明式配置。

### 选型决策树

- 全托管 + 官方维护的 AI 代码模板 → **E2B**（本层主示例）
- 合规要求代码留在自己云账号 / 需要自托管 → **Daytona**
- 重型 Python / GPU 批处理，沙箱只是其中一步 → **Modal**
- 想自己管理 Firecracker / KVM → 违反铁律，不做

🔗 **工程逻辑**：三个平台的调用形状完全一致——**create → write → run → destroy**。选型只看部署偏好：全托管选 E2B，自托管选 Daytona，GPU 批处理选 Modal。下面以 E2B 为主示例，换平台只换 SDK 调用，业务代码不变。

**成本提醒**：沙箱按“创建实例 + 运行时长”计费，每次执行新建会放大费用——用 `p-limit` 控制并发（见下文），并为单次执行设 `timeoutMs` 上限；同一模板热启动可以复用，但**复用与安全冲突时选安全**（每次新建）。
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

### 完整生命周期：创建 → 上传 → 执行 → 下载 → 销毁

`runCodeInSandbox` 是最小闭环。真实产品还需要**文件上传下载**（用户给的 CSV、生成的图表）、**目录操作**与**生命周期兜底**。下面是一个覆盖完整生命周期的示例：

```typescript
// packages/core/src/sandbox/e2b-lifecycle.ts —— 完整生命周期示例
import { Sandbox, type Sandbox as E2BSandbox } from '@e2b/code-interpreter';

export interface SandboxFile {
  path: string;
  content: Uint8Array;
}

export interface SandboxSession {
  sandboxId: string;
  close(): Promise<void>;
}

/** 创建沙箱：模板 + 超时 + 环境变量一次声明 */
export async function createSandboxSession(
  template: string,
  timeoutMs: number,
  envs: Record<string, string>,
): Promise<SandboxSession> {
  const sandbox = await Sandbox.create({
    template,
    timeoutMs,
    envs,
  });
  return {
    sandboxId: sandbox.sandboxId,
    close: () => sandbox.kill(),
  };
}

/** 批量上传文件到沙箱工作区 */
export async function uploadFiles(
  sandbox: E2BSandbox,
  files: SandboxFile[],
  workdir = '/sandbox',
): Promise<void> {
  await sandbox.files.mkdir(workdir); // 目录不存在时创建
  for (const file of files) {
    await sandbox.files.write(`${workdir}/${file.path}`, file.content);
  }
}

/** 执行命令并返回结构化结果 */
export async function runWithFiles(
  sandbox: E2BSandbox,
  command: string,
  files: SandboxFile[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await uploadFiles(sandbox, files);
  const result = await sandbox.runCommand(command);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/** 下载沙箱内文件（例如执行结果 CSV / 生成的图片） */
export async function downloadFile(
  sandbox: E2BSandbox,
  path: string,
): Promise<Uint8Array> {
  return sandbox.files.read(path);
}
```

🔗 **工程逻辑**：`sandbox.files.write` / `sandbox.files.read` 是平台的文件 API，业务层只做路径拼接与批量循环。**生命周期纪律**：`createSandboxSession` 返回的 `close()` 必须被调用方放进 `finally`；框架层可以用 `p-limit` 包一层（见下文），但“用完必毁”仍然是调用方的责任。

**Code Interpreter 的高级入口**：如果只是“跑一段 Python 并拿输出”，`notebook.execCell(code)` 比 `runCommand('python3 ...')` 更省事——它直接返回单元格输出（stdout / 图表 / 错误），不必自己拼命令。但 `execCell` 是 Python 笔记本语义，Bash / Node 场景仍用 `runCommand`：

```typescript
// packages/core/src/sandbox/e2b-exec-cell.ts —— 可选：Notebook 语义
import { Sandbox } from '@e2b/code-interpreter';

export async function execPythonCell(code: string, timeoutMs: number): Promise<string> {
  const sandbox = await Sandbox.create({ template: 'code-interpreter-v1', timeoutMs });
  try {
    const cell = await sandbox.notebook.execCell(code);
    return cell.text ?? '';
  } finally {
    await sandbox.kill();
  }
}
```

🤖 **AI 常见错误**：
1. 用 `runCommand('python3 script.py')` 代替 `notebook.execCell`——两者都行，但 `execCell` 自带 stdout/图表解析，返回结构更贴近 Agent 需要。选定一种后不要混用。
2. 上传文件时假定工作目录存在——先 `sandbox.files.mkdir(workdir)`（幂等），再逐文件写入。
3. 下载路径写错——`files.read` 的路径是**沙箱内绝对路径**，不是相对路径；先 `files.list(workdir)` 确认路径再下载。


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

## 沙箱安全边界详解

平台的隔离承诺是“地基”，你的**配置与运维纪律**决定边界是否真的成立。本节把边界拆成三层：网络策略、超时终止、审计留痕——每一层都有平台能力与你的声明式配置。

### 网络策略：默认断网，按需开白名单

AI 生成的代码**默认不应访问公网**。数据外泄（prompt injection 把环境变量发到攻击者服务器）是沙箱场景最高频事故。网络策略在模板层声明，而不是在代码里拦截：

| 策略档位 | 行为 | 适用场景 | 配置位置 |
|----------|------|----------|----------|
| `no-network` | 沙箱内所有出站连接被平台阻断 | 默认档；大多数数据分析/脚本执行 | 沙箱平台模板配置（E2B 控制台 / Daytona environment） |
| `allowlist` | 只允许显式白名单域名/IP 出站 | 需要拉取公开数据集、pip install 白名单源 | 模板 egress 规则 |
| `full-egress` | 允许全部出站 | 可信代码 / 受控网络环境 | 模板 egress 规则（默认不推荐） |

**工程实践**：
1. 默认模板用 `no-network`；需要联网的任务单独建 `allowlist` 模板，并把白名单写进模板描述，让 Agent 知道自己能访问什么。
2. `pip install` 走公司内部镜像（allowlist 内的私有源），不开放公网 PyPI。
3. 网络策略是**模板属性**，不是工具参数——`execute_code` 工具只选模板 ID，不传网络开关，避免业务层绕过安全策略。

### 超时终止：平台强制 kill，业务层设上限

超时是“死循环 / 恶意自旋”的唯一兜底。平台在沙箱级超时到达后强制终止整个 microVM，业务层还要设置**单次命令超时**：

| 超时层级 | 设置方式 | 作用 |
|----------|----------|------|
| 沙箱级 | `Sandbox.create({ timeoutMs })` | 整个沙箱生命周期的硬上限，到达即销毁 |
| 命令级 | `sandbox.runCommand(cmd, { timeoutMs })` | 单条命令超时，超时后命令被杀，沙箱仍可复用（不推荐复用） |
| 调用方级 | `Promise.race` + 业务超时 | 网络抖动兜底，返回 `timeout` 状态给 Agent |

**工程实践**：三个层级都要设。平台级超时防止计费失控；命令级超时让“一条命令卡死”不会拖垮整次执行；调用方级超时让 Agent 尽快拿到 `status='timeout'` 并转向下一步。超时后**不要复用沙箱**——命令被杀可能留下脏状态，直接 `kill()` 新建。

### 审计留痕：不可抵赖的执行记录

审计是安全边界的最后一环——出了问题要能回答“哪段代码、什么时候、谁触发的、执行了什么”。审计实现见 [审计日志](#审计日志)，这里强调三条纪律：

1. **只存 hash 不存原文**：代码可能含敏感数据，审计文件只保留 SHA-256；需要原文时从任务系统补录。
2. **关联 trace**：每次执行绑定 `sessionId` 与 Langfuse `traceId`，让“用户会话 → 工具调用 → 沙箱执行”可追溯（见 [08-eval-observability.md](./08-eval-observability.md)）。
3. **保留周期与销毁**：JSONL 按天滚动，合规要求确定保留周期（如 90 天），过期由日志系统统一清理，不手工删。

> 与 [07-security.md](./07-security.md) 的分工：07 管“模型输入输出”的注入与护栏；本节管“代码执行”的隔离边界。两者互补，缺一不可。

🤖 **AI 常见错误**：
1. 为了“功能能跑”给所有沙箱开 `full-egress`——网络白名单是唯一能挡住“代码外发环境变量”的层，默认必须断网。
2. 只设命令级超时不设沙箱级超时——平台按沙箱存活计费，沙箱级超时是费用上限。
3. 审计日志记录完整代码原文——审计文件本身会成为新的敏感数据源；只存 hash。

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

### 动态并发：跟随账号配额

平台账号有并发沙箱上限（免费层通常 3-5 个，付费层更高）。把配额写进配置，并发数跟着配额走：

```typescript
// packages/core/src/sandbox/quota.ts —— 配额配置与读取 [CUSTOM]
import { limit } from 'p-limit';

export interface SandboxQuotaConfig {
  /** 平台账号允许的最大并发沙箱数 */
  maxConcurrent: number;
  /** 单账号预留的缓冲（避免触发平台限流） */
  safetyMargin: number;
}

/** 根据配额计算本地并发上限：配额 - 缓冲，最小为 1 */
export function resolveConcurrency(config: SandboxQuotaConfig): number {
  return Math.max(1, config.maxConcurrent - config.safetyMargin);
}

/** 创建跟随配额变化的并发信号量 */
export function createSandboxLimiter(config: SandboxQuotaConfig) {
  const active = limit(resolveConcurrency(config));
  return {
    run: active,
    /** 配额调整后返回新的上限（配合管理后台热更新） */
    resize(next: SandboxQuotaConfig) {
      // p-limit 的实例并发数在创建时固定；这里返回新实例由调用方替换
      return createSandboxLimiter(next);
    },
  };
}
```

### 失败重试：p-limit 之外加退避

`p-limit` 只控制并发，不负责重试。沙箱创建可能因平台限流（429）或瞬时网络问题失败——重试是通用问题，但**不要与队列逻辑混在一起**：

```typescript
// packages/core/src/sandbox/retry.ts —— 胶水层：指数退避重试
import { setTimeout as sleep } from 'node:timers/promises';

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}
```

🔗 **工程逻辑**：`withRetry` 是纯胶水——指数退避是成熟模式，不需要引库；它只负责“重试”，队列交给 `p-limit`，两者通过 `runCodeLimited` 组合：

```typescript
// packages/core/src/sandbox/manager.ts —— 组合：并发信号量 + 重试 + 生命周期
import { limit } from 'p-limit';
import { withRetry } from './retry';
import { runCodeInSandbox, type SandboxRunOptions, type SandboxRunResult } from './e2b';

const concurrency = limit(3);

export function runCodeLimited(
  files: Array<{ path: string; content: string }>,
  command: string,
  options?: SandboxRunOptions,
): Promise<SandboxRunResult> {
  return concurrency(() =>
    withRetry(() => runCodeInSandbox(files, command, options), { retries: 2 }),
  );
}
```

### 配额监控与告警

接近配额上限时，与其让任务排队等到超时，不如提前降级：

1. **本地计数**：`p-limit` 的 `activeCount` / `pendingCount` 暴露当前负载，工具执行前检查：`activeCount + pendingCount >= maxConcurrent - margin` 时返回“沙箱繁忙，请稍后重试”。
2. **平台侧核对**：定时调用平台 API 列出活跃沙箱，与本地计数对账——发现泄漏（`kill()` 失败）立即告警。
3. **告警通道**：走 [08-eval-observability.md](./08-eval-observability.md) 的 Langfuse 指标或云监控，不自己实现告警系统。

### 生命周期检查表（每次执行）

- [ ] 创建：`Sandbox.create({ template, timeoutMs, envs })` 显式传超时与模板
- [ ] 上传：`files.mkdir` + `files.write`，路径统一在 `/sandbox` 下
- [ ] 执行：`runCommand` / `notebook.execCell`，记录 `exitCode`
- [ ] 下载：需要结果文件时 `files.read`，不需要则跳过
- [ ] 销毁：`finally` 中 `await sandbox.kill()`，并捕获 `kill` 自身异常（销毁失败也要记审计）

🤖 **AI 常见错误**：
1. 把重试写进队列逻辑——`p-limit` 的 `concurrency(fn)` 里塞 `while` 重试循环，失败时队列被占用，后续任务全部卡死。重试与队列解耦。
2. `kill()` 失败不处理——网络抖动时销毁调用也会失败，漏掉的沙箱持续计费并占用配额；`finally` 里 `await sandbox.kill().catch(() => undefined)` 并记审计。
3. 并发数写死为 3 而平台配额已提升——配额是运行时配置，不是魔法数字。


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

### 审计事件字段

`SandboxAuditEntry` 在真实产品里至少还要包含以下字段，用于事后回答“谁在什么时候执行了什么”：

```typescript
// packages/core/src/sandbox/audit-types.ts —— 审计事件字段扩展 [CUSTOM]
export interface SandboxAuditEntryV2 {
  timestamp: number;
  traceId?: string;       // Langfuse trace，关联模型调用链
  sessionId?: string;     // 用户会话
  userId?: string;        // 触发执行的用户
  toolCallId?: string;    // 工具调用 ID，关联 AgentEvent
  codeHash: string;       // 只存 SHA-256，不存代码原文
  language: string;
  templateId: string;     // 使用的沙箱模板（含网络策略）
  networkPolicy: 'no-network' | 'allowlist' | 'full-egress';
  status: 'success' | 'error' | 'timeout';
  durationMs: number;
  files: string[];        // 上传到沙箱的文件路径清单
}
```

### 审计接入工具执行

审计器在 `execute_code` 工具的执行路径里被调用，而不是在平台回调里——业务层才知道“用户是谁、属于哪个会话”：

```typescript
// packages/core/src/sandbox/audit-integration.ts —— 审计接入 [CUSTOM]
import { createSandboxAuditor, hashCode } from './audit';
import type { SandboxAuditEntryV2 } from './audit-types';

const auditor = createSandboxAuditor('logs/sandbox-audit.jsonl');

export async function recordExecution(input: {
  traceId?: string;
  sessionId?: string;
  userId?: string;
  toolCallId?: string;
  code: string;
  language: string;
  templateId: string;
  networkPolicy: SandboxAuditEntryV2['networkPolicy'];
  status: SandboxAuditEntryV2['status'];
  durationMs: number;
  files: string[];
}): Promise<void> {
  const entry: SandboxAuditEntryV2 = {
    timestamp: Date.now(),
    traceId: input.traceId,
    sessionId: input.sessionId,
    userId: input.userId,
    toolCallId: input.toolCallId,
    codeHash: hashCode(input.code),
    language: input.language,
    templateId: input.templateId,
    networkPolicy: input.networkPolicy,
    status: input.status,
    durationMs: input.durationMs,
    files: input.files,
  };
  auditor.log(entry);
}
```

### 审计运维纪律

1. **按天滚动**：`logs/sandbox-audit-YYYY-MM-DD.jsonl`，日志系统统一采集，不长期驻留业务机器。
2. **保留周期**：合规要求确定（如 90 天），过期由日志系统清理——不要在业务代码里实现“过期删除”。
3. **只读留档**：审计文件权限只写不删（append-only），定期校验 hash 链防止被篡改。
4. **多进程安全**：单进程用 `createWriteStream` 足够；多实例部署时改用 pino 的 JSONL transport 或直接写入日志采集器，避免两个进程写同一个文件句柄。

🤖 **AI 常见错误**：把审计器放在平台回调/Webhook 里——平台不知道你的用户体系，审计会丢失 `userId` / `sessionId` 上下文。审计必须在业务层工具执行路径里记录。


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

### 扩充安全测试矩阵

上线前至少覆盖以下用例（新增用例追加到 `runSandboxSecurityTests` 的 `results`）：

```typescript
// packages/core/src/sandbox/security-tests-extra.ts —— 补充安全用例
import { runCodeInSandbox } from './e2b';

export async function runExtraSandboxSecurityTests() {
  const results: Array<{ test: string; passed: boolean; detail: string }> = [];

  // 3. 内存上限：平台必须拦截超配额分配（OOM kill 或分配失败）
  const mem = await runCodeInSandbox(
    [{ path: 'mem.py', content: "data = ' ' * (1024 ** 3 * 4)" }],
    'python3 /sandbox/mem.py',
    { timeoutMs: 10_000 },
  );
  results.push({
    test: 'memory-limit',
    passed: mem.status !== 'success',
    detail: `status=${mem.status} stderr=${mem.stderr.slice(0, 80)}`,
  });

  // 4. 文件隔离：沙箱内看不到宿主机文件系统
  const fsTest = await runCodeInSandbox(
    [{ path: 'fs.sh', content: 'ls /etc/passwd /host_etc 2>&1 || true' }],
    'bash /sandbox/fs.sh',
    { timeoutMs: 5000 },
  );
  results.push({
    test: 'filesystem-isolation',
    passed: !fsTest.stdout.includes('root:x:'),
    detail: `stdout=${fsTest.stdout.slice(0, 80)}`,
  });

  // 5. 环境变量隔离：宿主机密钥不能出现在沙箱环境变量里
  const envTest = await runCodeInSandbox(
    [{ path: 'env.sh', content: 'env | sort' }],
    'bash /sandbox/env.sh',
    { timeoutMs: 5000 },
  );
  results.push({
    test: 'env-isolation',
    passed: !/[Ss]ECRET|[Tt]OKEN/.test(envTest.stdout),
    detail: `stdout=${envTest.stdout.slice(0, 120)}`,
  });

  return results;
}
```

### 回归节奏

1. **每次模板变更**：修改网络策略 / 内存配额后，立即重跑全部安全用例。
2. **每日定时**：CI 定时任务（cron）跑一次，捕获平台侧策略漂移（平台更新模板默认值）。
3. **发布门禁**：`execute_code` 相关改动合并前必须通过安全用例——把 `runSandboxSecurityTests` 接进 [08-eval-observability.md](./08-eval-observability.md) 的 eval 门禁。

🤖 **AI 常见错误**：把安全测试写成一次性脚本跑完就删。安全边界是持续承诺——平台更新、模板修改、配额调整都会让旧结论失效，测试必须进 CI 定时回归。


---

## 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：仓库根目录运行 `pnpm typecheck`，`packages/core/src/sandbox` 与 `apps/web` 全部 0 错误。
- [ ] **SDK 接入**：设置 `E2B_API_KEY` 环境变量后，`runCodeInSandbox([{ path: 'hello.py', content: "print('hi')" }], 'python3 /sandbox/hello.py')` 返回 `status='success'` 且 stdout 含 `hi`。
- [ ] **业务规则**：`execute_code` 只暴露 `ALLOWED_LANGUAGES` 四种语言；白名单外语言被 Zod 拒绝（不产生沙箱调用）。
- [ ] **生命周期**：死循环脚本在 `timeoutMs=2000` 下被平台强制终止，`finally` 中 `kill()` 被调用，平台控制台无 active sandbox 残留。
- [ ] **事件协议**：前端只消费 `AgentEvent` 的 `tool_start` / `tool_complete` / `tool_error`，无自定义沙箱事件类型。
- [ ] **平台对比**：能说清 E2B / Daytona / Modal / Firecracker 的隔离模型与冷启动差异，并给出本项目的选型理由。
- [ ] **完整生命周期**：`createSandboxSession` + `uploadFiles` + `runWithFiles` + `downloadFile` 全链路可用；沙箱销毁后平台控制台无 active 实例。
- [ ] **网络策略**：`no-network` 模板下 `curl https://example.com` 失败；`allowlist` 模板下白名单域名可达、非白名单被阻断。
- [ ] **并发配额**：并发上限 = 平台配额 - 安全缓冲；超出时返回“沙箱繁忙”而非无限排队；`withRetry` 不阻塞队列。
> **与后续节点的衔接**：本层的 `runCodeInSandbox`（平台入口）与 `execute_code` 工具（`[CUSTOM]` 业务规则）被 02（工具注册）、05（多 Agent 的 Worker 工具集）、06（HITL 确认）复用。沙箱执行事件统一走 `AgentEvent` 信封，不引入第二套事件协议。安全边界与 [07-security.md](./07-security.md) 的护栏互补；审计与配额指标接入 [08-eval-observability.md](./08-eval-observability.md)；沙箱超时/重试可作为 [21-fault-recovery.md](./21-fault-recovery.md) 的故障注入点；[23-artifacts-computer-use.md](./23-artifacts-computer-use.md) 的 artifact 渲染可消费沙箱生成的图表文件。
- [ ] **安全回归**：`runSandboxSecurityTests` + `runExtraSandboxSecurityTests` 全部用例通过，且已接入 CI 定时任务。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本验收清单。

---

> **与后续节点的衔接**：本层的 `runCodeInSandbox`（平台入口）与 `execute_code` 工具（`[CUSTOM]` 业务规则）被 02（工具注册）、05（多 Agent 的 Worker 工具集）、06（HITL 确认）复用。沙箱执行事件统一走 `AgentEvent` 信封，不引入第二套事件协议。
