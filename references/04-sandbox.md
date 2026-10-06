# 04 — 代码沙箱 · Docker 隔离 · 安全执行

> 本 reference 覆盖 Docker 容器级代码沙箱的完整实现——安全边界（cgroup/seccomp/cap-drop）、资源限制（memory/cpu/pids）、execute_code 工具接入、并发调度+队列、审计日志系统、以及前端终端输出卡片。读完本文件即可独立落地安全的 Agent 代码执行环境。

---

## 目录

- [安全设计总览](#安全设计总览)
- [类型定义](#类型定义)
  - [沙箱配置与结果类型](#沙箱配置与结果类型)
- [Docker 沙箱核心实现](#docker-沙箱核心实现)
  - [DockerSandbox 类](#docker-沙箱类)
  - [Dockerfile 构建](#dockerfile-构建)
  - [安全约束层详解](#安全约束层详解)
- [并发调度与连接池](#并发调度与连接池)
  - [SandboxManager 实现](#sandboxmanager-实现)
- [Agent 工具接入](#agent-工具接入)
  - [execute_code 工具](#execute_code-工具)
  - [create_visualization 工具](#create_visualization-工具streamlitgrddio)
  - [可视化沙箱专属镜像](#可视化沙箱专属镜像)
- [安全审计日志](#安全审计日志)
- [前端沙箱状态 UI](#前端沙箱状态-ui)
  - [SandboxExecutionCard 终端卡片](#sandboxexecutioncard-终端卡片)
  - [useSandboxExecution Hook](#usesandboxexecution-hook)

---

## 安全设计总览

Agent 的价值很大一部分来自"写代码并运行"。但直接在生产环境运行 AI 生成的代码等于开门揖盗：

1. **恶意代码**：Agent 可能被 prompt injection 诱导执行 `rm -rf /`
2. **Bug 代码**：死循环、内存泄漏、大量磁盘写入
3. **数据泄露**：代码可能尝试访问数据库、读取环境变量、外发数据
4. **资源耗尽**：一个 `while(true){}` 就能吃光 CPU

**工程选择**：不用 `vm2` 或 `isolated-vm`。它们都是进程内沙箱，存在已知的逃逸漏洞（vm2 在 2023 年被彻底披露不安全）。对于 AI 生成的代码——你永远不知道它会写什么——只有操作系统级别的隔离（namespace + cgroup + seccomp）才是真正的安全边界。

```
┌──────────────────────────────────────────────────────────┐
│                    Host (Host OS)                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Docker Container (per execution)                    │  │
│  │                                                      │  │
│  │  ┌──────────┐  资源限制:                             │  │
│  │  │ User     │  ─ memory: 512MB (cgroup)            │  │
│  │  │ Code     │  ─ cpu: 0.5 core (cgroup)             │  │
│  │  │ Runner   │  ─ disk: 1GB (overlay fs)             │  │
│  │  │          │  ─ network: 无 / 白名单                │  │
│  │  │          │  ─ pids: 50 max (cgroup pids.max)     │  │
│  │  │          │  ─ no-new-privileges                  │  │
│  │  └──────────┘  ─ seccomp: 默认 profile              │  │
│  │       │           ─ AppArmor/SELinux                │  │
│  │       ▼                                              │  │
│  │  /sandbox/  —— 代码只能在这里写                       │  │
│  │  (read-only: /usr, /lib, /bin)                       │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  每次执行: 创建容器 → 运行 → 收集结果 → 销毁               │
│  绝不复用容器（防止状态残留和持久化攻击）                     │
└──────────────────────────────────────────────────────────┘
```

> 🤖 **AI 常见错误**：
> 1. **忘记 `--cap-drop ALL`** —— 默认 Docker 容器有一些 Linux capabilities（如 `NET_RAW`），攻击者可以构造原始网络包绕过网络隔离。必须显式丢弃所有 capability。
> 2. **`--memory-swap` 不设等于 `--memory`** —— 如果 swap 限制大于内存限制，容器可以溢出到 swap，相当于没有内存限制。
> 3. **容器复用** —— 有些人为了性能复用容器（docker start 而不是 docker run）。这在 Agent 场景里是灾难——恶意代码可以在容器里留下定时任务、修改 PATH、替换可执行文件。每次必须新建。

### 类型定义

#### 沙箱配置与结果类型

```typescript
// packages/core/src/sandbox/types.ts

export type SandboxTimeout = number;  // ms
export type MemoryLimit = string;     // e.g. "512m"
export type CpuLimit = number;        // e.g. 0.5 = 50% 单核

export interface SandboxConfig {
  /** 执行超时 */
  timeoutMs: number;
  /** 内存限制 */
  memoryLimit: MemoryLimit;
  /** CPU 限制 */
  cpuLimit: CpuLimit;
  /** 是否允许网络 */
  network: 'none' | 'whitelist';
  /** 网络白名单域名 */
  networkWhitelist?: string[];
  /** 工作目录 */
  workdir: string;
  /** 只读挂载 */
  readOnlyMounts?: Array<{ host: string; container: string }>;
  /** 可写临时目录大小 */
  tmpfsSize?: string;
}

export interface SandboxFile {
  path: string;
  content: string;
}

export interface SandboxExecutionResult {
  id: string;
  status: 'success' | 'timeout' | 'oom' | 'security_violation' | 'error';
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  memoryPeak?: number;
  error?: string;
}

export interface SandboxEvent {
  type: 'created' | 'started' | 'output' | 'stopped' | 'error' | 'security_violation';
  data?: any;
  timestamp: number;
}

export interface Sandbox {
  id: string;
  /** 写入文件到容器 */
  writeFiles(files: SandboxFile[]): Promise<void>;
  /** 执行命令行命令 */
  execute(command: string): AsyncGenerator<SandboxEvent>;
  /** 执行完（或超时）后销毁 */
  destroy(): Promise<void>;
}
```

---

## Docker 沙箱核心实现

### Docker 沙箱类

```typescript
// packages/core/src/sandbox/docker.ts

import { v4 as uuid } from 'uuid';
import { spawn, exec } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  SandboxConfig, SandboxFile, SandboxEvent, SandboxExecutionResult
} from './types';

const DOCKER_IMAGE = 'agent-sandbox:latest';

/**
 * Docker 容器沙箱实现
 *
 * 安全设计原则：
 * 1. 每次执行创建新容器，用完即弃（--rm + destroy）
 * 2. 多层防御：cgroup 资源限制 + seccomp 系统调用过滤 + capability 丢弃 + 只读文件系统
 * 3. 网络默认禁用（--network none）
 * 4. 实时 stdout/stderr 流式输出（不缓存整个输出）
 * 5. 超时自动 kill（docker kill）
 * 6. 强制非 root 用户运行
 */
export class DockerSandbox {
  readonly id: string;
  private config: SandboxConfig;
  private tmpDir: string;
  private containerName: string;
  private isDestroyed = false;
  private isRunning = false;
  private startTime = 0;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.id = uuid().slice(0, 8);
    this.containerName = `sandbox-${this.id}`;
    this.config = {
      timeoutMs: 30000,
      memoryLimit: '512m',
      cpuLimit: 0.5,
      network: 'none',
      workdir: '/sandbox',
      tmpfsSize: '256m',
      ...config,
    };
    this.tmpDir = '';
  }

  /** 初始化：创建临时目录、构建镜像（如果需要） */
  async initialize(): Promise<void> {
    this.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `sandbox-${this.id}-`));
    await this.ensureImage();
  }

  /** 写入文件到容器工作目录 */
  async writeFiles(files: SandboxFile[]): Promise<void> {
    if (this.isDestroyed) throw new Error('Sandbox already destroyed');

    for (const file of files) {
      const filePath = path.join(this.tmpDir, file.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, file.content, 'utf-8');
    }
  }

  /**
   * 执行命令——返回事件流
   */
  async *execute(command: string): AsyncGenerator<SandboxEvent> {
    if (this.isDestroyed) throw new Error('Sandbox already destroyed');
    if (this.isRunning) throw new Error('Sandbox already running');

    this.isRunning = true;
    this.startTime = Date.now();

    yield { type: 'created', data: { sandboxId: this.id }, timestamp: Date.now() };

    const dockerArgs = this.buildDockerArgs(command);

    yield { type: 'started', data: { command }, timestamp: Date.now() };

    const dockerProcess = spawn('docker', dockerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      spawn('docker', ['kill', this.containerName]);
    }, this.config.timeoutMs);

    dockerProcess.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      // 注意：流式输出到前端需要通过事件系统传递
    });

    dockerProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const securityCheck = setInterval(() => {
      if (this.detectSecurityViolation(stderr)) {
        killed = true;
        spawn('docker', ['kill', this.containerName]);
      }
    }, 1000);

    const exitCode = await new Promise<number>((resolve) => {
      dockerProcess.on('close', (code) => {
        clearTimeout(timeoutTimer);
        clearInterval(securityCheck);
        resolve(code ?? 1);
      });
    });

    const duration = Date.now() - this.startTime;
    this.isRunning = false;

    if (killed) {
      yield {
        type: 'security_violation',
        data: { reason: 'Dangerous operation detected' },
        timestamp: Date.now(),
      };
    } else if (timedOut) {
      yield {
        type: 'stopped',
        data: { reason: 'timeout', durationMs: duration },
        timestamp: Date.now(),
      };
    } else {
      yield {
        type: 'stopped',
        data: { exitCode, durationMs: duration, stdout, stderr },
        timestamp: Date.now(),
      };
    }
  }

  /** 销毁容器和临时文件 */
  async destroy(): Promise<void> {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    try {
      await execAsync(`docker rm -f ${this.containerName}`);
    } catch {
      // 容器可能已经被清理了
    }

    try {
      await fs.rm(this.tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  /**
   * 构建 docker run 参数
   * 每一层都在堵住一种攻击路径
   */
  private buildDockerArgs(command: string): string[] {
    const args = [
      'run',
      '--rm',                              // 容器退出后自动删除
      '--name', this.containerName,

      // ═══ 资源限制 (cgroup) ═══
      '--memory', this.config.memoryLimit,          // 内存硬上限
      '--memory-swap', this.config.memoryLimit,     // swap = memory，禁止 swap 溢出
      '--cpus', this.config.cpuLimit.toString(),    // CPU 限制
      '--pids-limit', '50',                         // 最多 50 个进程（防 fork bomb）

      // ═══ 安全约束 ═══
      '--security-opt', 'no-new-privileges:true',   // 禁止提权（防止 setuid 攻击）
      '--security-opt', 'seccomp=default',          // seccomp 系统调用过滤
      '--cap-drop', 'ALL',                          // 丢弃所有 Linux capabilities
      '--read-only',                                // 根文件系统只读

      // ═══ 网络隔离 ═══
      ...(this.config.network === 'none'
        ? ['--network', 'none']                     // 完全断网
        : this.config.network === 'whitelist'
          ? ['--network', 'bridge', ...this.enforceWhitelist()]
          : ['--network', 'bridge']),

      // ═══ 文件系统 ═══
      '--tmpfs', `/tmp:size=${this.config.tmpfsSize || '256m'},exec`,  // 临时可写空间
      '-v', `${this.tmpDir}:/sandbox:rw`,           // 工作目录挂载（唯一可写区域）
      '-w', this.config.workdir,                     // 设置工作目录

      // ═══ 运行时配置 ═══
      '--stop-timeout', '5',                         // 5 秒优雅关闭窗口（超时后直接 kill）
      '--log-driver', 'none',                        // 禁止 Docker 日志（我们自行收集）

      DOCKER_IMAGE,
      'sh', '-c', command,
    ];

    return args;
  }

  /**
   * 网络白名单 enforcement —— 修复「whitelist 形同虚设」
   * Docker bridge 允许所有出站流量，iptables 是实际执行层。
   * 每条 iptables 规则：默认 DROP 出站 → 仅允许白名单目标
   */
  private enforceWhitelist(): string[] {
    if (!this.config.networkWhitelist?.length) return [];
    // 执行脚本在容器内运行（通过 entrypoint 注入的 setup-iptables.sh）
    // 这里返回告诉外层去附加 --env WHITELIST_HOSTS
    return ['--env', `WHITELIST_HOSTS=${this.config.networkWhitelist.join(',')}`];
  }

  private detectSecurityViolation(stderr: string): boolean {
    const dangerousSignals = [
      'Operation not permitted',  // 尝试越权操作
      'Connection refused',        // 可能尝试外联
      'cannot create',             // 只读文件系统写入尝试
      'apt-get install',           // 尝试安装系统软件包
      'pip install',               // 尝试安装依赖（应预装在镜像中）
      'curl',                      // 尝试外发数据
      'wget',                      // 尝试外发数据
      'nc ',                       // netcat 网络工具
    ];
    return dangerousSignals.some(signal => stderr.includes(signal));
  }

  /** 确保沙箱镜像存在 */
  private async ensureImage(): Promise<void> {
    try {
      await execAsync(`docker image inspect ${DOCKER_IMAGE}`);
    } catch {
      console.warn(`Sandbox image ${DOCKER_IMAGE} not found. Building...`);
      await this.buildImage();
    }
  }

  private async buildImage(): Promise<void> {
    const dockerfile = `
FROM node:20-slim

# 安装常用运行时
RUN apt-get update && apt-get install -y --no-install-recommends \\
    python3 python3-pip \\
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash sandbox
USER sandbox

WORKDIR /sandbox
`;
    const dfPath = path.join(os.tmpdir(), `sandbox-dockerfile-${this.id}`);
    await fs.writeFile(dfPath, dockerfile);
    await execAsync(`docker build -t ${DOCKER_IMAGE} -f ${dfPath} ${path.dirname(dfPath)}`);
    await fs.rm(dfPath, { force: true });
  }
}

/** 工具函数：Promise 化 exec */
function execAsync(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error && !stderr.includes('No such container')) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}
```

### Dockerfile 构建

```dockerfile
# docker/sandbox-base/Dockerfile
# 代码执行通用沙箱

FROM node:20-slim

# 安装常用运行时（Node.js 已是基础层）
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# 创建非 root 用户
# 安全要求：容器内进程必须以非 root 运行
RUN useradd -m -s /bin/bash sandbox
USER sandbox

WORKDIR /sandbox
```

### 安全约束层详解

| 层级 | Docker 参数 | 防御的攻击 | 逃逸后果 |
|------|-------------|-----------|---------|
| 资源限制 | `--memory`, `--cpus`, `--pids-limit` | fork bomb, OOM, CPU 耗尽 | 宿主机资源耗尽 |
| Capability 丢弃 | `--cap-drop ALL` | 利用 NET_RAW/SYS_ADMIN 等 capability 做越权 | 容器逃逸、网络攻击 |
| Seccomp 过滤 | `--seccomp=default` | 调用危险系统调用（如 `ptrace`, `kexec_load`） | 容器逃逸、提权 |
| 只读文件系统 | `--read-only` | 篡改系统文件、植入后门 | 持久化攻击 |
| 禁止提权 | `--no-new-privileges` | 通过 setuid 提升权限 | 提权到 root |
| 网络隔离 | `--network none` | 数据外泄、挖矿、端口扫描 | 网络攻击 |
| 容器不复用 | `--rm` + 每次新建 | 修改 PATH/定时任务/二进制替换 | 持久化攻击 |

> 🤖 **AI 常见错误**：
> 1. 忘记 `--cap-drop ALL` —— 默认 Docker 容器有一些 Linux capabilities 可被利用构造原始网络包绕过网络隔离。
> 2. `--memory-swap` 不设成等于 `--memory` —— 容器可以溢出到 swap，相当于没有内存限制。
> 3. 容器复用 —— `docker start` 复用容器虽然快，但恶意代码可以在容器里留下持久化后门。

---

## 并发调度与连接池

### SandboxManager 实现

当多个用户同时让 Agent 执行代码，或者单个 Agent 连续快速触发多个工具调用时，需要有并发控制。`SandboxManager` 负责管理并发数上限和执行队列：

```typescript
// packages/core/src/sandbox/manager.ts

import { DockerSandbox } from './docker';
import type { SandboxConfig, SandboxEvent, SandboxExecutionResult } from './types';
import { v4 as uuid } from 'uuid';

/**
 * 沙箱管理器 —— 并发调度 + 队列
 *
 * 工程特性：
 * - 同时最多 N 个容器运行（默认 3，防止 Docker 资源被占满）
 * - 超出并发上限时进入 FIFO 队列
 * - 提供 kill 接口（用户终止执行）
 * - 进程退出时清理所有容器
 *
 * 队列设计选择：
 * - 不用优先级队列——所有代码执行同等重要
 * - 用 Promise resolve 回调而非直接返回——允许异步排队
 */
export class SandboxManager {
  private activeContainers = new Map<string, DockerSandbox>();
  private maxConcurrent: number;
  private queue: Array<{
    resolve: (value: SandboxExecutionResult) => void;
    reject: (reason: Error) => void;
    task: () => Promise<SandboxExecutionResult>;
  }> = [];

  constructor(options?: { maxConcurrent?: number }) {
    this.maxConcurrent = options?.maxConcurrent ?? 3;
  }

  /**
   * 执行代码——入口函数
   * Agent 工具（execute_code）调用这个方法
   */
  async run(
    files: Array<{ path: string; content: string }>,
    command: string,
    config?: Partial<SandboxConfig>
  ): Promise<SandboxExecutionResult> {
    // 达上限则排队
    if (this.activeContainers.size >= this.maxConcurrent) {
      return new Promise((resolve, reject) => {
        this.queue.push({
          resolve,
          reject,
          task: () => this.runInternal(files, command, config),
        });
      });
    }

    return this.runInternal(files, command, config);
  }

  private async runInternal(
    files: Array<{ path: string; content: string }>,
    command: string,
    config?: Partial<SandboxConfig>
  ): Promise<SandboxExecutionResult> {
    const executionId = uuid().slice(0, 12);
    const sandbox = new DockerSandbox(config);

    await sandbox.initialize();
    this.activeContainers.set(executionId, sandbox);

    let stdout = '';
    let stderr = '';
    let status: SandboxExecutionResult['status'] = 'success';
    let startTime = Date.now();

    try {
      await sandbox.writeFiles(files);

      for await (const event of sandbox.execute(command)) {
        switch (event.type) {
          case 'output':
            stdout += event.data.text ?? '';
            break;
          case 'stopped':
            if (event.data.reason === 'timeout') {
              status = 'timeout';
            } else if (event.data.exitCode !== 0) {
              status = 'error';
              stderr = event.data.stderr;
            } else {
              stdout = event.data.stdout ?? stdout;
            }
            break;
          case 'security_violation':
            status = 'security_violation';
            break;
        }
      }
    } catch (error) {
      status = 'error';
      stderr = error instanceof Error ? error.message : String(error);
    } finally {
      await sandbox.destroy();
      this.activeContainers.delete(executionId);
      this.processQueue();
    }

    return {
      id: executionId,
      status,
      exitCode: status === 'success' ? 0 : 1,
      stdout,
      stderr,
      durationMs: Date.now() - startTime,
      error: status !== 'success' ? stderr : undefined,
    };
  }

  /** 强制结束一个正在执行的沙箱 */
  async kill(executionId: string): Promise<void> {
    const sandbox = this.activeContainers.get(executionId);
    if (sandbox) {
      await sandbox.destroy();
      this.activeContainers.delete(executionId);
      this.processQueue();
    }
  }

  /** 当前活跃的容器数量 */
  get activeCount(): number {
    return this.activeContainers.size;
  }

  /** 队列推进 */
  private processQueue(): void {
    if (this.queue.length === 0) return;
    if (this.activeContainers.size >= this.maxConcurrent) return;

    const next = this.queue.shift();
    if (next) {
      next.task().then(next.resolve).catch(next.reject);
    }
  }

  /** 销毁所有容器（进程退出时调用） */
  async dispose(): Promise<void> {
    for (const [id] of this.activeContainers) {
      await this.kill(id);
    }
  }
}
```

---

## Agent 工具接入

### execute_code 工具

这是 Agent"写代码并运行"的核心工具。LLM 通过它让 Agent 执行在沙箱里：

```typescript
// packages/core/src/sandbox/tools.ts

import type { RegisteredTool } from '../tool/registry';
import type { ToolContext } from '../agent/types';
import type { SandboxManager } from './manager';

/**
 * 创建代码执行工具
 *
 * 接入 Agent 循环方式：
 * 1. 在 Agent 初始化时 new SandboxManager()
 * 2. createCodeExecutionTool(manager) 生成 RegisteredTool
 * 3. toolRegistry.register(tool) 注册
 * 4. LLM 看到 execute_code 工具定义后，自行决定何时调用
 *
 * 安全注意事项：
 * - 需要用户确认（requiresConfirmation: true）
 * - 默认 30s 超时
 * - 不能访问网络（除 create_visualization 工具外）
 */
export function createCodeExecutionTool(manager: SandboxManager): RegisteredTool {
  return {
    name: 'execute_code',
    description: 'Execute code in an isolated Docker sandbox. Supports Python, JavaScript/TypeScript (Node.js), and Bash. Code runs with limited memory (512MB), CPU (0.5 core), and no network access. Returns stdout, stderr, and execution time.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'javascript', 'typescript', 'bash'],
          description: 'Programming language to execute',
        },
        code: {
          type: 'string',
          description: 'The code to execute',
        },
        command: {
          type: 'string',
          description: 'Optional: custom command (default: python3 /sandbox/code.py or node /sandbox/code.js)',
        },
      },
      required: ['language', 'code'],
    },
    meta: {
      name: 'execute_code',
      description: 'Execute code in sandbox',
      category: 'system',
      requiresConfirmation: true,
      tags: ['code', 'execute', 'sandbox'],
    },
    async execute(args: {
      language: string;
      code: string;
      command?: string;
    }, ctx: ToolContext): Promise<string> {
      const fileName = `code.${getFileExtension(args.language)}`;
      const defaultCommand = getDefaultCommand(args.language, fileName);

      const result = await manager.run(
        [{ path: fileName, content: args.code }],
        args.command ?? defaultCommand,
        { timeoutMs: 30000 }
      );

      let output = `[Execution ${result.id}] Status: ${result.status}, Duration: ${result.durationMs}ms\n`;

      if (result.status === 'success') {
        output += `--- stdout ---\n${result.stdout || '(no output)'}\n`;
        if (result.stderr) {
          output += `--- stderr ---\n${result.stderr}\n`;
        }
      } else if (result.status === 'timeout') {
        output += `Error: Execution timed out after 30 seconds\n`;
      } else if (result.status === 'security_violation') {
        output += `Error: Security violation detected. Code attempted dangerous operations.\n`;
      } else {
        output += `Error: ${result.error || result.status}\n`;
      }

      return output;
    },
  };
}

/** create_visualization 工具 —— Streamlit/Gradio 可视化沙箱 */
export function createVisualizationTool(manager: SandboxManager): RegisteredTool {
  return {
    name: 'create_visualization',
    description: 'Create an interactive data visualization app using Streamlit or Gradio. Returns a preview URL and app info.',
    parameters: {
      type: 'object',
      properties: {
        framework: {
          type: 'string',
          enum: ['streamlit', 'gradio'],
          description: 'Framework to use',
        },
        code: {
          type: 'string',
          description: 'The app code',
        },
        port: {
          type: 'number',
          description: 'Port to run on (default 8501 for Streamlit, 7860 for Gradio)',
        },
      },
      required: ['framework', 'code'],
    },
    meta: {
      name: 'create_visualization',
      description: 'Create interactive visualization app',
      category: 'system',
      tags: ['visualization', 'streamlit', 'gradio', 'data'],
    },
    async execute(args: {
      framework: 'streamlit' | 'gradio';
      code: string;
      port?: number;
    }, ctx: ToolContext): Promise<string> {
      const port = args.port ?? (args.framework === 'streamlit' ? 8501 : 7860);
      const fileName = `app.py`;

      const command = args.framework === 'streamlit'
        ? `streamlit run /sandbox/app.py --server.port ${port} --server.headless true --server.enableCORS false &`
        : `python3 /sandbox/app.py &`;

      const result = await manager.run(
        [{ path: fileName, content: args.code }],
        command,
        {
          timeoutMs: 60000,
          memoryLimit: '1g',
          network: 'whitelist',
        }
      );

      if (result.status !== 'success') {
        return `Failed to start visualization: ${result.error || result.stderr}`;
      }

      return `Visualization started successfully.
Framework: ${args.framework}
Port: ${port}
Preview URL: http://localhost:${port}
Execution ID: ${result.id}

To stop: call kill_sandbox(executionId: "${result.id}")`;
    },
  };
}

function getFileExtension(language: string): string {
  const map: Record<string, string> = {
    python: 'py',
    javascript: 'js',
    typescript: 'ts',
    bash: 'sh',
  };
  return map[language] || 'txt';
}

function getDefaultCommand(language: string, fileName: string): string {
  const commands: Record<string, string> = {
    python: `python3 /sandbox/${fileName}`,
    javascript: `node /sandbox/${fileName}`,
    typescript: `npx tsx /sandbox/${fileName}`,
    bash: `bash /sandbox/${fileName}`,
  };
  return commands[language] || `sh /sandbox/${fileName}`;
}
```

### 可视化沙箱专属镜像

**工程逻辑**：Streamlit/Gradio 沙箱用单独的 Docker 镜像（包含所有数据可视化依赖）。为什么不用同一个代码执行镜像？因为一个完整的数据科学环境（pandas + numpy + plotly）有 300+ MB 依赖。每个代码执行都重新安装太慢了，而且大部分代码执行不需要这些库。分离镜像让代码执行沙箱保持轻量（~200MB），可视化沙箱只在需要时加载（~1GB）。

```dockerfile
# docker/sandbox-streamlit/Dockerfile
# Streamlit 可视化专用沙箱

FROM python:3.11-slim

RUN pip install --no-cache-dir \
    streamlit==1.38.0 \
    gradio==4.44.0 \
    pandas==2.2.0 \
    plotly==5.24.0 \
    matplotlib==3.9.0 \
    numpy==1.26.0

RUN useradd -m -s /bin/bash sandbox
USER sandbox

WORKDIR /sandbox
```

---

## 安全审计日志

审计日志必须是 append-only 的 JSONL 格式。安全事件发生后——比如发现用户在利用 Agent 挖矿——你能从日志里追溯所有执行过的代码、时间链、关联 session。这是合规和事后分析的必备基础设施。

```typescript
// packages/core/src/sandbox/audit.ts

import { appendFile } from 'fs/promises';
import * as path from 'path';
import type { SandboxExecutionResult } from './types';

export interface AuditLogEntry {
  timestamp: number;
  sandboxId: string;
  userId?: string;
  sessionId?: string;
  codeHash: string;              // 代码内容的 SHA-256（不存原文，保护隐私）
  language: string;
  result: SandboxExecutionResult['status'];
  durationMs: number;
  flags: string[];               // 安全标记：network_access, large_output 等
}

/**
 * 沙箱安全审计
 *
 * 设计原则：
 * 1. 写入必须 append-only（不会被篡改或回滚）
 * 2. 不存代码原文（存 hash 就够了，追溯时可校验）
 * 3. 写入失败不阻塞执行（但需要告警）
 * 4. 定期轮转日志文件（防止磁盘满）
 */
export class SandboxAuditor {
  private logPath: string;

  constructor(logPath?: string) {
    this.logPath = logPath || path.join(process.cwd(), 'logs', 'sandbox-audit.jsonl');
  }

  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await appendFile(this.logPath, JSON.stringify(entry) + '\n');
    } catch (error) {
      // 审计日志写入失败不应该阻塞执行，但需要告警
      console.error('Failed to write sandbox audit log:', error);
    }
  }

  /**
   * 检测异常模式：短时间内大量执行、频繁失败
   *
   * 安全场景：
   * - 1 分钟内同一用户执行了 20+ 次 → 可能是 prompt injection 攻击
   * - 连续 5 次执行都是 security_violation → 有人在试探安全边界
   */
  async checkAnomaly(params: {
    userId: string;
    windowMs: number;
    maxExecutions: number;
  }): Promise<{ anomaly: boolean; reason?: string }> {
    // [阶段 3 实现] 从日志文件分析，统计窗口内执行次数
    // 当前为接口占位
    return { anomaly: false };
  }
}
```

> 🤖 **工程逻辑**：审计日志的 `codeHash` 字段存 SHA-256 而非原文。原因：(1) 用户可能执行含敏感数据（API Key、密码）的代码；(2) hash 足以在事后验证某段代码是否被执行过；(3) 节省磁盘空间。

---

## 前端沙箱状态 UI

### SandboxExecutionCard 终端卡片

```typescript
// apps/web/src/components/chat/SandboxExecutionCard.tsx

import { useState, useEffect, useRef } from 'react';

interface ExecutionState {
  id: string;
  status: 'starting' | 'running' | 'completed' | 'error' | 'timeout';
  language: string;
  command: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  memoryUsage?: number;
}

/**
 * 沙箱执行终端卡片
 *
 * 工程特性：
 * - 自动滚动到底部（流式输出时保持最新可见）
 * - 颜色区分 status：starting=蓝, running=黄(脉冲动画), completed=绿, error/timeout=红
 * - 内存用量显示进度条（当有 memoryUsage 数据时）
 * - 支持展开/折叠
 */
export function SandboxExecutionCard({ execution }: { execution: ExecutionState }) {
  const [expanded, setExpanded] = useState(true);
  const terminalRef = useRef<HTMLPreElement>(null);

  // 自动滚动到底部
  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [execution.stdout, execution.stderr]);

  const statusColors = {
    starting: 'bg-blue-500/20 text-blue-300',
    running: 'bg-amber-500/20 text-amber-300 animate-pulse',
    completed: 'bg-emerald-500/20 text-emerald-300',
    error: 'bg-red-500/20 text-red-300',
    timeout: 'bg-red-500/20 text-red-300',
  };

  return (
    <div className="rounded-lg border border-border bg-surface my-2 overflow-hidden">
      {/* 头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 p-3 text-left hover:bg-white/5 transition-colors`}
      >
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[execution.status]}`}>
          {execution.status === 'running' ? '⚡' : execution.status === 'completed' ? '✓' : '✗'}
          {' '}{execution.status.toUpperCase()}
        </span>
        <span className="text-xs font-mono opacity-60">{execution.language}</span>
        <span className="text-xs font-mono opacity-40 ml-1 truncate max-w-[200px]">
          {execution.command}
        </span>
        <span className="ml-auto text-xs opacity-40 tabular-nums">
          {execution.durationMs}ms
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {/* 终端输出 */}
          <div className="max-h-48 overflow-auto">
            <pre
              ref={terminalRef}
              className="p-3 text-xs font-mono whitespace-pre-wrap break-all"
            >
              {execution.stdout}
              {execution.stderr && (
                <span className="text-red-400">{execution.stderr}</span>
              )}
            </pre>
          </div>

          {/* 资源使用条 */}
          {execution.memoryUsage && (
            <div className="flex items-center gap-2 px-3 py-2 border-t border-border bg-black/20">
              <div className="flex-1 h-1 bg-border rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-500"
                  style={{ width: `${Math.min((execution.memoryUsage / 512) * 100, 100)}%` }}
                />
              </div>
              <span className="text-[10px] opacity-40 tabular-nums">
                {execution.memoryUsage}MB / 512MB
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

### useSandboxExecution Hook

```typescript
// apps/web/src/components/chat/useSandboxExecution.ts

import { useState, useCallback, useRef } from 'react';

/**
 * Hook：管理沙箱执行状态
 *
 * 与 Agent 事件流的交互方式：
 * - case 'tool_start' + tool=execute_code → 创建新的 ExecutionState
 * - case 'tool_output' → 更新 stdout
 * - case 'tool_complete' → 更新 status = completed/error/timeout
 *
 * 工程注意：
 * - 用 Map 而非 Array 来引用执行，保证 O(1) 查找
 * - 每次更新创建新 Map 引用（不可变更新），触发 React re-render
 */
export function useSandboxExecution() {
  const [executions, setExecutions] = useState<Map<string, ExecutionState>>(new Map());

  const handleSandboxEvent = useCallback((toolCallId: string, event: any) => {
    setExecutions(prev => {
      const next = new Map(prev);
      const existing = next.get(toolCallId) || {
        id: toolCallId,
        status: 'starting' as const,
        language: '',
        command: '',
        stdout: '',
        stderr: '',
        durationMs: 0,
      };

      switch (event.type) {
        case 'sandbox_started':
          next.set(toolCallId, {
            ...existing,
            status: 'running',
            language: event.data.language,
            command: event.data.command,
          });
          break;
        case 'sandbox_output':
          next.set(toolCallId, {
            ...existing,
            stdout: existing.stdout + event.data.text,
          });
          break;
        case 'sandbox_stopped':
          next.set(toolCallId, {
            ...existing,
            status: event.data.reason === 'timeout' ? 'timeout' : 'completed',
            durationMs: event.data.durationMs,
            memoryUsage: event.data.memoryPeakMB,
          });
          break;
        case 'sandbox_security_violation':
          next.set(toolCallId, {
            ...existing,
            status: 'error',
          });
          break;
      }

      return next;
    });
  }, []);

  /** 获取所有执行列表（用于 UI 渲染） */
  const executionList = Array.from(executions.values());

  return { executions: executionList, handleSandboxEvent };
}
```

---

## 前端集成汇总

本 reference 对应的前端消费方式：

### SandboxExecutionCard

- **数据来源**：Agent 工具调用事件流中对 `execute_code` / `create_visualization` 工具的回调
- **展示内容**：终端输出（monospace font）、执行状态 badge、语言标识、命令、耗时、内存用量
- **关键交互**：
  - 点击展开/折叠详细输出
  - 流式输出时自动滚动到底部
  - 内存用量进度条
  - running 状态显示脉冲动画

### 整体布局建议

```
Chat Area
├── MessageList
│   ├── SandboxExecutionCard   → 内嵌代码执行终端
│   ├── ToolCallCard           → 其他工具调用 (见 02-tools-skills.md)
│   └── ...
├── ContextUsageBar            → Token 用量 (见 02-tools-skills.md)
└── ChatInput

Settings Page (可选扩展)
├── SandboxPanel               → 沙箱配置：超时/内存/CPU/网络白名单
└── AuditLogPanel              → 安全审计日志查看器
```

---

## 深入话题：多语言运行时完整支持

沙箱需要支持 Python、JavaScript/TypeScript、Bash 三种语言。每种语言有不同的包管理需求和运行时特点：

| 语言 | 运行时 | 包管理 | 安装策略 |
|------|--------|--------|---------|
| Python 3 | 预装在镜像中 | pip | 预装常用包（见 Dockerfile），运行时不允许 `pip install` |
| Node.js 20 | 基础镜像 | npm | `npx tsx` 支持 TypeScript 运行时编译 |
| Bash | sh 内置 | apt | 运行时完全禁止安装 |

```dockerfile
# docker/sandbox-base/Dockerfile（完整多运行时版本）
FROM node:20-slim

# ═══ Python + 常用数据科学库 ═══
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    python3-numpy \
    python3-pandas \
    && rm -rf /var/lib/apt/lists/*

# ═══ Node.js 全局工具 ═══
RUN npm install -g tsx@4.7.0

# ═══ 安全：非 root 用户 ═══
RUN useradd -m -s /bin/bash sandbox
USER sandbox

WORKDIR /sandbox
```

> 🤖 **工程逻辑**：所有依赖必须在**镜像构建时**安装，不能在代码执行时安装。原因：(1) 容器内无网络，装不了；(2) 如果可以装，恶意代码可以装任意包做恶意行为。正确的策略是：预装常用依赖，如果用户的代码需要额外包，应该在开发/配置阶段把包加入 Dockerfile 重新构建镜像。

---

## 深入话题：Streamlit 可视化完整工作流

Streamlit/Gradio 沙箱与普通代码执行的关键区别：

1. **长运行进程**：不是运行完就退出，而是起一个后台服务
2. **需要网络**：浏览器需要访问容器的 HTTP 端口
3. **更多内存**：数据可视化库（matplotlib、plotly）内存开销大

```typescript
// packages/core/src/sandbox/visualizationManager.ts

import type { SandboxManager } from './manager';
import { v4 as uuid } from 'uuid';

interface VisualizationSession {
  id: string;
  framework: 'streamlit' | 'gradio';
  port: number;
  executionId: string;
  status: 'starting' | 'running' | 'error' | 'stopped';
  previewUrl: string;
  startedAt: number;
}

/**
 * 可视化会话管理
 *
 * 工程选择：
 * - 每个可视化起独立容器（不复用），用完 kill
 * - 端口动态分配（避免冲突），默认范围 18500-18600
 * - 容器以 & 后台运行（保持进程不退出）
 * - 设置 60 分钟自动过期（防资源泄漏）
 */
export class VisualizationManager {
  private sessions = new Map<string, VisualizationSession>();
  private sandboxManager: SandboxManager;
  private nextPort = 18500;
  private maxPort = 18600;

  constructor(sandboxManager: SandboxManager) {
    this.sandboxManager = sandboxManager;
  }

  /** 创建新的可视化应用 */
  async create(params: {
    framework: 'streamlit' | 'gradio';
    code: string;
    timeoutMs?: number;
  }): Promise<VisualizationSession> {
    const id = uuid().slice(0, 8);
    const port = this.allocatePort();
    const fileName = 'app.py';

    const command = params.framework === 'streamlit'
      ? `streamlit run /sandbox/${fileName} --server.port ${port} --server.headless true --server.enableCORS false --server.enableXsrfProtection false &`
      : `python3 /sandbox/${fileName} &`;

    const executionId = `viz-${id}`;

    // 启动容器
    const result = await this.sandboxManager.run(
      [{ path: fileName, content: params.code }],
      command,
      {
        timeoutMs: params.timeoutMs ?? 60 * 60 * 1000,  // 默认 1 小时
        memoryLimit: '1g',
        network: 'whitelist',
        networkWhitelist: ['localhost'],
      }
    );

    const session: VisualizationSession = {
      id,
      framework: params.framework,
      port,
      executionId: result.id,
      status: result.status === 'success' ? 'running' : 'error',
      previewUrl: `http://localhost:${port}`,
      startedAt: Date.now(),
    };

    this.sessions.set(id, session);
    return session;
  }

  /** 终止可视化会话 */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await this.sandboxManager.kill(session.executionId);
    session.status = 'stopped';
    this.sessions.delete(sessionId);
  }

  /** 列出所有活跃的可视化会话 */
  list(): VisualizationSession[] {
    return Array.from(this.sessions.values());
  }

  private allocatePort(): number {
    const port = this.nextPort;
    this.nextPort = this.nextPort >= this.maxPort ? 18500 : this.nextPort + 2;
    return port;
  }
}
```

---

## 深入话题：沙箱初始化与 Agent 接入完整示例

```typescript
// packages/core/src/sandbox/index.ts —— 沙箱模块导出

export * from './types';
export * from './docker';
export * from './manager';
export * from './tools';
export * from './audit';
export * from './visualizationManager';
```

```typescript
// 完整的 Agent + 沙箱初始化示例

import { ToolRegistry } from './tool/registry';
import { SandboxManager } from './sandbox/manager';
import { SandboxAuditor } from './sandbox/audit';
import {
  createCodeExecutionTool,
  createVisualizationTool,
} from './sandbox/tools';
import { VisualizationManager } from './sandbox/visualizationManager';

export function setupAgentWithSandbox(agentConfig: any) {
  // 1. 初始化沙箱管理器
  const sandboxManager = new SandboxManager({
    maxConcurrent: 3,  // 同时最多 3 个容器
  });

  // 2. 安全审计
  const auditor = new SandboxAuditor('./logs/sandbox-audit.jsonl');

  // 3. 初始化可视化管理器
  const vizManager = new VisualizationManager(sandboxManager);

  // 4. 创建工具并注册
  const registry = new ToolRegistry();
  registry.register(createCodeExecutionTool(sandboxManager));
  registry.register(createVisualizationTool(sandboxManager));

  return {
    sandboxManager,
    vizManager,
    auditor,
    registry,
  };
}
```

---

## 深入话题：沙箱安全性测试

沙箱安全不是"相信 Docker 就够了"——需要持续测试安全边界的有效性：

```typescript
// packages/core/src/sandbox/security-tests.ts

import { SandboxManager } from './manager';

/**
 * 沙箱安全测试套件
 *
 * 这些测试验证沙箱的各种安全隔离是否正常起作用。
 * 应在以下时机运行：
 * - CI/CD pipeline 里每次镜像构建后
 * - 部署前的验收测试
 * - 定期安全审计（每周/每月）
 */
export async function runSecurityTests(manager: SandboxManager) {
  const results: Array<{ test: string; passed: boolean; detail?: string }> = [];

  // 测试 1：文件系统只读
  const test1 = await manager.run(
    [{ path: 'test.sh', content: 'echo "hello" > /usr/local/bin/test_file' }],
    'bash /sandbox/test.sh',
    { network: 'none' }
  );
  results.push({
    test: '文件系统只读',
    passed: test1.status === 'error' || test1.stderr.includes('Read-only'),
    detail: `status=${test1.status}, stderr="${test1.stderr.slice(0, 100)}"`,
  });

  // 测试 2：网络隔离
  const test2 = await manager.run(
    [{ path: 'nettest.sh', content: 'curl -s https://httpbin.org/ip' }],
    'bash /sandbox/nettest.sh',
    { network: 'none' }
  );
  results.push({
    test: '网络隔离',
    passed: test2.status === 'error',
    detail: `status=${test2.status}`,
  });

  // 测试 3：超时终止
  const test3 = await manager.run(
    [{ path: 'loop.py', content: 'while True: pass' }],
    'python3 /sandbox/loop.py',
    { timeoutMs: 2000 }
  );
  results.push({
    test: '超时终止',
    passed: test3.status === 'timeout',
    detail: `status=${test3.status}, duration=${test3.durationMs}ms`,
  });

  // 测试 4：内存限制（分配超过 512MB 应被 kill）
  const test4 = await manager.run(
    [{ path: 'oom.py', content: 'x = " " * (600 * 1024 * 1024)' }],
    'python3 /sandbox/oom.py',
    { memoryLimit: '512m' }
  );
  results.push({
    test: '内存限制',
    passed: test4.status === 'error' || test4.status === 'timeout',
    detail: `status=${test4.status}`,
  });

  return results;
}
```

---

## 构建与部署命令

```bash
# 构建通用代码执行沙箱镜像
docker build -t agent-sandbox:latest -f docker/sandbox-base/Dockerfile docker/sandbox-base/

# 构建 Streamlit 可视化沙箱镜像（分离以减小代码执行沙箱体积）
docker build -t agent-sandbox-streamlit:latest -f docker/sandbox-streamlit/Dockerfile docker/sandbox-streamlit/

# 运行安全测试
npx vitest run packages/core/src/sandbox/security-tests.ts

# 查看审计日志
tail -f logs/sandbox-audit.jsonl | jq .
```

---

## 特别说明：沙箱配置参考

默认配置适用大多数场景，不同场景的调整建议：

| 场景 | timeoutMs | memoryLimit | cpuLimit | network |
|------|-----------|-------------|----------|---------|
| 简单 Python 脚本 | 30s | 256m | 0.25 | none |
| 数据分析（pandas） | 60s | 1g | 1.0 | none |
| 机器学习推理 | 120s | 2g | 2.0 | none |
| Streamlit 可视化 | 1h | 1g | 1.0 | whitelist |
| 网络爬虫（受控） | 60s | 512m | 0.5 | whitelist |
| Bash 系统操作 | 30s | 128m | 0.1 | none |

---

## CI/CD 集成

沙箱镜像的构建和测试应纳入 CI/CD pipeline：

```yaml
# .github/workflows/sandbox.yml
name: Sandbox Security

on:
  push:
    paths:
      - 'docker/sandbox-*/**'
      - 'packages/core/src/sandbox/**'

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build sandbox images
        run: |
          docker build -t agent-sandbox:test -f docker/sandbox-base/Dockerfile docker/sandbox-base/
          docker build -t agent-sandbox-streamlit:test -f docker/sandbox-streamlit/Dockerfile docker/sandbox-streamlit/

      - name: Run security tests
        run: |
          npx vitest run packages/core/src/sandbox/security-tests.ts

      - name: Check for known CVE
        run: |
          docker scout cves agent-sandbox:test
          docker scout cves agent-sandbox-streamlit:test
```

---

## 故障排查指南

| 问题 | 原因 | 排查方法 |
|------|------|---------|
| 代码执行超时 | 无限循环/网络请求卡住 | 查看 stderr 是否有卡住迹象，适当提高 timeout |
| exit code 137 (SIGKILL) | 内存超限制被 OOM Kill | 增加 memoryLimit |
| 容器启动失败 | Docker 镜像不存在或 Docker daemon 不可用 | `docker images` 检查镜像是否存在 |
| 网络白名单不生效 | Docker 网络模式配置错误 | 确认 network='whitelist' 而非 'none' |
| 容器残留 | destroy() 未被正确调用 | 检查 finally 块，确保 sandbox.destroy() 总会被调用 |
| 审计日志未写入 | 目录不存在或权限问题 | 确保 logs/ 目录存在且进程有写权限 |
| 端口冲突 | 多个可视化会话端口重复 | 检查 VisualizationManager 的端口分配逻辑 |
| 中文输出乱码 | 容器内缺少 locale | 在 Dockerfile 中安装 locales 并设置 LANG=zh_CN.UTF-8 |

---

## 附录：Docker 安全配置速查

```
docker run
  --rm                                    # 自动清理容器
  --name sandbox-{id}                     # 唯一命名
  --memory 512m                           # 内存硬上限
  --memory-swap 512m                      # swap = memory，禁止 swap 溢出
  --cpus 0.5                              # CPU 限制（0.5 = 50% 单核）
  --pids-limit 50                         # 最多 50 进程（防 fork bomb）
  --security-opt no-new-privileges:true   # 禁止提权
  --security-opt seccomp=default          # 系统调用过滤
  --cap-drop ALL                          # 丢弃所有 capabilities
  --read-only                             # 根文件系统只读
  --network none                          # 完全断网
  --tmpfs /tmp:size=256m,exec             # 临时可写空间
  -v /host/path:/sandbox:rw               # 工作目录挂载
  -w /sandbox                             # 设置工作目录
  --stop-timeout 5                        # 5 秒优雅关闭窗口
  --log-driver none                       # 禁止 Docker 日志
  agent-sandbox:latest
  sh -c "command"
```

---

## 总结

本 reference 覆盖了 Docker 容器级代码沙箱的完整实现体系：

1. **安全边界** —— 七层防御（cgroup/seccomp/cap-drop/只读文件系统/网络隔离/禁止提权/容器不复用）
2. **核心实现** —— DockerSandbox 类（初始化、文件写入、事件流执行、销毁）
3. **并发调度** —— SandboxManager（队列、上限控制、强制终止）
4. **工具接入** —— execute_code / create_visualization 两个 Agent 工具
5. **长运行服务** —— VisualizationManager（Streamlit/Gradio 会话管理）
6. **审计合规** —— SandboxAuditor（append-only JSONL 日志 + 异常检测框架）
7. **安全测试** —— 自动化安全边界验证套件
8. **前端 UI** —— SandboxExecutionCard + useSandboxExecution Hook
9. **构建部署** —— Docker 镜像构建命令 + CI/CD 集成
10. **故障排查** —— 常见问题快速定位表

## 实现阶段指引

本 reference 中标注了 `[阶段 X 实现]` 的占位代码，各阶段的优先级如下：

| 阶段 | 内容 | 对应用户故事 | 依赖 |
|------|------|------------|------|
| 阶段 1（MVP） | Docker 运行、基础 execute_code 工具、简单前端卡片 | 用户让 Agent 执行 Python 脚本 | Docker 环境 |
| 阶段 2（增强） | 安全测试套件、安全审计日志、retry 逻辑增强 | Agent 生成的多次代码执行被正确记录 | 阶段 1 完成 |
| 阶段 3（生产） | Qdrant 集成、异常检测、CI/CD 自动构建扫描、Rerank | 生产部署，需要安全审计和自动化运维 | 阶段 1+2 完成 |

> 🤖 **重要提醒**：在阶段 1 MVP 中，InMemoryVectorStore 可以让记忆/RAG 功能先跑起来，但生产环境必须切换到 Qdrant 等真正的向量数据库——内存版进程退出后数据全部丢失，且搜索是 O(N) 暴力扫描，性能不可接受。
