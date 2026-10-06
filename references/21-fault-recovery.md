# 21 — 容错与恢复 · Agent 可靠性工程

> 目标：Agent 在一次 30 分钟对话中途崩溃时，用户不应承受"一切重来"的代价。本章从状态快照、断线重连、幂等设计、降级模型、超时处理五个角度构建完整的容错体系。

---

## 目录

- [1. Agent 状态快照](#1-agent-状态快照)
- [2. 断线重连恢复流程](#2-断线重连恢复流程)
- [3. 工具调用幂等性设计](#3-工具调用幂等性设计)
- [4. 降级模型切换](#4-降级模型切换)
- [5. 超时与取消优雅处理](#5-超时与取消优雅处理)
- [6. 错误分类与自动恢复策略](#6-错误分类与自动恢复策略)
- [7. 前端：Recovery UI](#7-前端recovery-ui)
- [8. 避坑汇总](#8-避坑汇总)

---

## 1. Agent 状态快照

### 1.1 为什么需要快照

Agent 在一次长对话中：
- 已调用了 5 个工具，产生 8 个中间文件
- MemoryManager 已写入了 3 条 summary
- LLM 已消耗了 45K tokens 在这个会话上
- 此时 SSE 连接断了 / 进程崩溃 / 网络闪断

用户重新连接时，如果一切从零开始：5 个工具调用白做了，45K tokens 白花了，3 条 summary 丢了（如果还没持久化的话）。

**快照的最小状态集**：
```
- message_history（对话消息列表）
- current_tool_call_in_progress（正在进行的工具调用）
- memory_snapshots（MemoryManager 中待持久化的 summary）
- token_usage（已消耗的 token 累计）
- metadata（session_id, user_intent, partial_plan）
```

### 1.2 Redis vs Postgres 存储方案对比

| 维度 | Redis | Postgres |
|------|-------|---------|
| 读写性能 | 亚毫秒级 | 毫秒级 |
| 持久化 | RDB/AOF，可配 | WAL，天然持久化 |
| 状态查询 | 只能 key-value，无法复杂查询 | 可 SQL 分析快照 |
| 存储成本 | 内存昂贵 | 磁盘便宜 |
| 过期策略 | 天然 TTL | 需要手动 clean up |
| 推荐场景 | 高频快照、实时断线恢复 | 会话审计、长周期持久化 |

🔗 **工程逻辑**：用 Redis 做"实时状态快照"（每次工具调用后写入，TTL 24h），用 Postgres 做"持久化归档"（每次会话结束时落库，长期存储）。这是 Hot-Warm 双层存储架构——Redis 快但贵（只放活跃状态），Postgres 慢但便宜（放历史记录）。

### 1.3 快照实现

```typescript
// packages/core/src/fault/snapshot.ts

import { redis } from '@/lib/redis';
import { createHash } from 'crypto';

/**
 * Agent 快照。
 *
 * 这不是全量内存 dump——"全量"会包含不可序列化的对象（stream handle,
 * AbortController），导致 crash。只序列化"重建会话所需的最小信息集"。
 */
export interface AgentSnapshot {
  version: 1;                  // snapshot 格式版本号，未来升级用
  sessionId: string;
  tenantId: string;
  createdAt: number;           // snapshot 的创建时间（不是会话创建时间）

  /** 对话消息序列（从系统消息到最后一条 assistant 消息） */
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    toolCallId?: string;
    toolName?: string;
    timestamp: number;
  }>;

  /** 正在进行的工具调用（如果有的话） */
  pendingToolCall: {
    toolName: string;
    args: unknown;
    callId: string;
    startedAt: number;
  } | null;

  /** 上下文状态 */
  context: {
    tokenBudgetUsed: number;          // 已用 token 数
    toolCallCount: number;            // 已完成的工具调用次数
    activeSkillIds: string[];         // 当前加载的 Skill ID
    memoryKeys: string[];             // MemoryManager 中已存储的 key 列表
    currentIntent: string | null;     // 当前识别的 intent
    partialPlan: string | null;       // Agent 的分步计划（如果有的话）
  };

  /** SSE 流式状态——用于恢复时补发 */
  stream: {
    lastEventId: string;            // 最后发给客户端的 event_id
    lastEventSeq: number;           // 最后 event 的序列号
    totalChunksSent: number;        // 已发送 chunks 总数
  };
}

/**
 * 快照管理器。
 *
 * 职责：
 * 1. 在关键节点持久化快照（每次工具调用后、每 N 条消息后）
 * 2. 按需恢复快照（断线重连、进程重启）
 * 3. 清理过期快照（TTL 24h，或会话结束后归档到 Postgres）
 */
export class SnapshotManager {
  private readonly TTL = 24 * 60 * 60; // 24 小时
  private readonly KEY_PREFIX = 'snapshot:';
  private readonly ARCHIVE_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 天归档

  /**
   * 创建快照。
   *
   * 性能考虑：这个操作不能阻塞 Agent 主循环。
   * 所以用 Redis pipeline 批量写入，< 5ms 完成。
   */
  async save(snapshot: AgentSnapshot): Promise<void> {
    const key = this.getKey(snapshot.sessionId);
    const serialized = this.serialize(snapshot);

    // Pipeline：同时写入快照和索引
    const pipeline = redis.pipeline();
    pipeline.set(key, serialized, 'EX', this.TTL);

    // 维护"活跃会话"索引（按 tenant 分组）
    const indexKey = `snapshots:active:${snapshot.tenantId}`;
    pipeline.sadd(indexKey, snapshot.sessionId);
    pipeline.expire(indexKey, this.TTL);

    await pipeline.exec();
  }

  /**
   * 恢复快照。
   *
   * 如果快照已过期（TTL 返回 null），回退到 Postgres 归档。
   */
  async restore(sessionId: string): Promise<AgentSnapshot | null> {
    const key = this.getKey(sessionId);

    // 第一尝试：Redis
    const cached = await redis.get(key);
    if (cached) {
      return this.deserialize(cached);
    }

    // 第二尝试：Postgres 归档
    const archived = await this.restoreFromArchive(sessionId);
    if (archived) {
      // 重新缓存到 Redis（如果会话还在活跃期）
      await this.save(archived);
      return archived;
    }

    return null; // 快照不可用，必须重头来
  }

  /**
   * 安全的序列化。
   *
   * 关键：过滤所有不可序列化的字段。
   * 包括 stream handles, AbortController, closure references 等。
   * 序列化失败时降级——只保留基本信息，丢弃上下文状态。
   */
  private serialize(snapshot: AgentSnapshot): string {
    try {
      return JSON.stringify(snapshot, (key, value) => {
        // 过滤已知危险字段
        if (key === 'abortController' || key === 'stream' || key === 'socket') {
          return undefined;
        }
        return value;
      });
    } catch (e) {
      // 序列化失败——降级：只保存 messages 和基础信息
      console.error(`Snapshot serialization failed for ${snapshot.sessionId}`, e);
      const minimal: Partial<AgentSnapshot> = {
        version: snapshot.version,
        sessionId: snapshot.sessionId,
        tenantId: snapshot.tenantId,
        createdAt: Date.now(),
        messages: snapshot.messages.slice(-10), // 只保留最近 10 条
        pendingToolCall: null,
        context: {
          tokenBudgetUsed: 0,
          toolCallCount: context?.toolCallCount ?? 0,
          activeSkillIds: [],
          memoryKeys: [],
          currentIntent: null,
          partialPlan: null,
        },
        stream: { lastEventId: '', lastEventSeq: 0, totalChunksSent: 0 },
      };
      return JSON.stringify(minimal);
    }
  }

  private deserialize(raw: string): AgentSnapshot {
    const parsed = JSON.parse(raw);

    // 版本检查：如果格式版本不兼容，触发迁移或丢弃
    if (parsed.version !== 1) {
      throw new Error(`Snapshot version mismatch: expected 1, got ${parsed.version}`);
    }

    return parsed as AgentSnapshot;
  }

  private async restoreFromArchive(sessionId: string): Promise<AgentSnapshot | null> {
    // 从 Postgres 的 snapshots_archive 表读取
    const row = await db.query(
      'SELECT data FROM snapshots_archive WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
      [sessionId],
    );
    return row?.[0]?.data ?? null;
  }

  private getKey(sessionId: string): string {
    return `${this.KEY_PREFIX}${sessionId}`;
  }
}
```

### 1.4 集成到 AbstractAgent

```typescript
// packages/core/src/fault/agent-snapshot-integration.ts

import { SnapshotManager, AgentSnapshot } from './snapshot';

/**
 * 在 AbstractAgent 主循环中集成快照逻辑。
 *
 * 快照时机：
 * 1. 每次工具调用完成后 —— 这是最重要的快照点
 * 2. 每 5 条消息—— 防止工具调用之间丢失
 * 3. 工具调用开始前 —— 用于幂等性恢复（如果重启可以从上次工具调用继续）
 *
 * 不在每次 LLM 推理 token 后做快照——那太频繁了，Redis I/O 会拖慢流。
 */
export abstract class AbstractAgent {
  // ... 已有代码

  private snapshotManager = new SnapshotManager();
  private snapshotCounter = 0;

  /**
   * 在 run() 主循环中调用——每次工具调用完成后。
   */
  protected async takeSnapshot(): Promise<void> {
    const snapshot = this.buildSnapshot();
    // 异步写入 Redis，不阻塞下一步工具调用
    this.snapshotManager.save(snapshot).catch((e) => {
      // 快照失败不能阻断 Agent 执行——只记录警告
      console.warn('[Snapshot] Save failed:', e.message);
    });
  }

  private buildSnapshot(): AgentSnapshot {
    return {
      version: 1,
      sessionId: this.sessionId,
      tenantId: this.tenantId,
      createdAt: Date.now(),
      messages: this.messageHistory.map((m) => ({
        role: m.role,
        content: m.content || '',
        toolCallId: (m as any).toolCallId,
        toolName: (m as any).toolName,
        timestamp: Date.now(),
      })),
      pendingToolCall: this.currentToolCall
        ? {
            toolName: this.currentToolCall.name,
            args: this.currentToolCall.args,
            callId: this.currentToolCall.id,
            startedAt: this.currentToolCall.startedAt,
          }
        : null,
      context: {
        tokenBudgetUsed: this.tokenUsage.total,
        toolCallCount: this.toolCallHistory.length,
        activeSkillIds: Array.from(this.loadedSkills.keys()),
        memoryKeys: this.memoryManager.getKeys(),
        currentIntent: this.detectedIntent,
        partialPlan: this.activePlan?.description ?? null,
      },
      stream: {
        lastEventId: this.lastSentEventId,
        lastEventSeq: this.eventSequence,
        totalChunksSent: this.totalChunksSent,
      },
    };
  }

  /**
   * 从快照恢复。在 AbstractAgent 的静态 factory 方法里调用。
   */
  static async fromSnapshot(
    sessionId: string,
    manager: SnapshotManager,
  ): Promise<{ agent: AbstractAgent; snapshot: AgentSnapshot } | null> {
    const snapshot = await manager.restore(sessionId);
    if (!snapshot) return null;

    // 重建 Agent 实例
    const agent = new (this as any)({
      sessionId: snapshot.sessionId,
      // ... 从 snapshot 恢复的参数
    });

    // 恢复消息历史
    agent.messageHistory = snapshot.messages;

    // 恢复 token 预算
    agent.tokenUsage.total = snapshot.context.tokenBudgetUsed;

    // 恢复 intent 和 plan
    agent.detectedIntent = snapshot.context.currentIntent;
    if (snapshot.context.partialPlan) {
      agent.activePlan = { description: snapshot.context.partialPlan };
    }

    return { agent, snapshot };
  }
}
```

---

## 2. 断线重连恢复流程

### 2.1 完整断线恢复时序

```
Client                               Server                              Redis
  │                                     │                                   │
  │──── SSE Connect ────────────────────▶│                                   │
  │                                     │── Agent.run() ───────────────────▶│
  │◀──── event: message_chunk ─────────│                                   │
  │◀──── event: tool_call_start ───────│                                   │
  │                                     │── tool executes...               │
  │◀──── event: tool_call_result ──────│                                   │
  │                                     │── snapshot.save() ──────────────▶│ key: snapshot:session_123
  │── Network drops ✗                   │                                   │
  │                                     │── Agent continues (server side)  │
  │                                     │── takes more snapshots ─────────▶│
  │                                     │                                   │
  │──── SSE Reconnect ─────────────────▶│                                   │
  │──── Last-Event-Id: evt_42 ─────────│                                   │
  │                                     │── restore snapshot ◀────────────│
  │                                     │── calculate missing events       │
  │◀──── event: recovery_start ────────│                                   │
  │◀──── event: tool_call_result ──────│ (补发 evt_43, evt_44)             │
  │◀──── event: message_chunk ─────────│ (从断点继续)                      │
```

### 2.2 服务端实现

```typescript
// packages/core/src/fault/sse-recovery.ts

import { SnapshotManager } from './snapshot';
import { redis } from '@/lib/redis';

/**
 * SSE 恢复管理器。
 *
 * 核心逻辑：
 * 1. 客户端重连时带上 lastEventId
 * 2. 服务比较 lastEventId 与快照中的 stream state
 * 3. 如果 lastEventId < 快照 seq，补发缺失的事件
 * 4. 如果 Agent 已经结束（snapshot 有 final result），直接返回最终结果
 * 5. 如果 Agent 还在运行，重新订阅当前 stream
 */
export class SSERecoveryManager {
  constructor(private snapshotManager: SnapshotManager) {}

  /**
   * 处理客户端重连请求。
   *
   * @param sessionId 会话 ID
   * @param lastEventId 客户端最后收到的事件 ID（从 Last-Event-Id header 获取）
   */
  async handleReconnect(
    sessionId: string,
    lastEventId: string | null,
  ): Promise<{
    status: 'caught_up' | 'needs_replay' | 'agent_finished' | 'session_not_found';
    eventsToReplay?: AgentEvent[];
    finalResult?: string;
  }> {
    // 1. 恢复快照
    const snapshot = await this.snapshotManager.restore(sessionId);
    if (!snapshot) {
      return { status: 'session_not_found' };
    }

    // 2. 检查 Agent 是否已结束
    if (this.isAgentFinished(snapshot)) {
      const finalResult = await this.getFinalResult(sessionId);
      return { status: 'agent_finished', finalResult };
    }

    // 3. 客户端没有 lastEventId 或 lastEventId 早于快照记录的 seq
    if (!lastEventId || this.shouldReplay(lastEventId, snapshot)) {
      const events = await this.getMissedEvents(sessionId, lastEventId, snapshot);
      return { status: 'needs_replay', eventsToReplay: events };
    }

    // 4. 客户端已经 catch up——当前无事件要补发
    return { status: 'caught_up' };
  }

  private shouldReplay(lastEventId: string, snapshot: AgentSnapshot): boolean {
    // 从 event ID 中提取序列号
    // event ID 格式: "{sessionId}_{seq}" 如 "sess_123_42"
    const lastSeq = this.extractSeq(lastEventId);
    return lastSeq < snapshot.stream.lastEventSeq;
  }

  private extractSeq(eventId: string): number {
    const parts = eventId.split('_');
    return Number(parts[parts.length - 1] ?? 0);
  }

  /**
   * 获取客户端错过的事件。
   *
   * 从 Redis Stream 消费——所有 Agent 事件被写入 Redis Stream，
   * 保留最近 24 小时。客户端的 lastEventId 作为读起点。
   */
  private async getMissedEvents(
    sessionId: string,
    afterEventId: string | null,
    _snapshot: AgentSnapshot,
  ): Promise<AgentEvent[]> {
    const streamKey = `events:${sessionId}`;
    const after = afterEventId ?? '0-0'; // 从头读

    const entries = await redis.xrange(streamKey, after, '+', 'COUNT', 500);

    return entries.map((entry) => ({
      id: entry.id,
      type: entry.data.type,
      data: JSON.parse(entry.data.payload),
    }));
  }

  private isAgentFinished(snapshot: AgentSnapshot): boolean {
    // 检查最后一条消息是否是完整的 assistant 回复
    const lastMessage = snapshot.messages[snapshot.messages.length - 1];
    return lastMessage?.role === 'assistant' && !snapshot.pendingToolCall;
  }
}
```

### 2.3 Redis Stream 事件存储

```typescript
// packages/core/src/fault/event-store.ts

import { redis } from '@/lib/redis';

/**
 * Agent 事件存储 —— 基于 Redis Stream。
 *
 * 为什么用 Redis Stream：
 * - 天然支持 range read（XRANGE after_id TO last_id）
 * - 天然支持 consumer group 用于广播到多个 WebSocket 客户端
 * - 支持 MAXLEN 自动 truncate 老数据
 *
 * 每个会话有一个 stream key：events:{sessionId}
 * 事件存在 stream 里的 XADD 记录中。
 */
export class EventStore {
  private readonly MAX_EVENTS_PER_SESSION = 1000;
  private readonly TTL = 24 * 60 * 60; // 24 小时

  /**
   * 追加一个事件到 stream。
   *
   * 由 SSE 发送端在发射事件前调用——确保事件落盘后再发。
   */
  async append(sessionId: string, event: { type: string; data: unknown }): Promise<string> {
    const key = `events:${sessionId}`;

    const id = await redis.xadd(
      key,
      'MAXLEN', '~', this.MAX_EVENTS_PER_SESSION, // ~ 表示 approximate trim，性能更好
      '*',  // 自动生成 ID
      'type', event.type,
      'payload', JSON.stringify(event.data),
    );

    // 刷新 TTL
    await redis.expire(key, this.TTL);

    return id; // 返回 event id 给 SSE 层用
  }

  /**
   * 读取 after 之后的所有事件。
   */
  async readAfter(sessionId: string, after: string, count = 500): Promise<Array<{
    id: string;
    type: string;
    data: unknown;
  }>> {
    const key = `events:${sessionId}`;
    const entries = await redis.xrange(key, after, '+', 'COUNT', count);

    return entries.map((e) => ({
      id: e.id,
      type: e.data.type,
      data: JSON.parse(e.data.payload as string),
    }));
  }
}
```

---

## 3. 工具调用幂等性设计

### 3.1 为什么幂等性如此重要

断线恢复后，工具可能被重试：
- 工具调用 A 正在执行，连接断了。恢复时恢复引擎会"重试 A"。
- 如果 A 是 "追加一行到文件"，那么重试后文件多了一行。
- 如果 A 是 "发送邮件"，那么用户收到了两封邮件。

**幂等性** : 同一操作执行 N 次，结果和执行 1 次一样。

### 3.2 文件写入幂等：tmp + rename

```typescript
// packages/core/src/fault/idempotent-fs.ts

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

/**
 * 安全的文件写入——保证幂等性。
 *
 * 经典模式：
 * 1. 写内容到临时文件（同目录的 .tmp.{hash}）
 * 2. fsync 确保落盘
 * 3. rename 为最终文件（原子操作）
 *
 * 如果过程中崩溃：
 * - 临时文件残留 → 下次启动时清理
 * - 重试写同一内容 → hash 相同，临时文件相同，rename 幂等
 * - 重试写不同内容 → hash 不同，临时文件不同，最终文件被正确覆盖
 */
export async function safeWriteFile(
  filePath: string,
  content: string,
): Promise<{ written: boolean; recovered: boolean }> {
  const tempPath = `${filePath}.tmp.${createHash('md5').update(content).digest('hex').slice(0, 8)}`;
  const dir = dirname(filePath);

  // 确保目录存在
  await fs.mkdir(dir, { recursive: true });

  // 如果最终文件已经包含我们要写的内容——幂等命中，直接返回
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (existing === content) {
      return { written: false, recovered: true };
    }
  } catch {
    // 文件不存在，正常继续
  }

  // 写临时文件
  await fs.writeFile(tempPath, content, 'utf-8');

  // fsync 确保落盘（防止 rename 后内容在 page cache 里）
  const fd = await fs.open(tempPath, 'r');
  await fd.sync();
  await fd.close();

  // 原子 rename
  await fs.rename(tempPath, filePath);

  return { written: true, recovered: false };
}
```

### 3.3 删除幂等：trash 模式

```typescript
// packages/core/src/fault/trash-delete.ts

import { promises as fs } from 'fs';
import { join, basename } from 'path';

/**
 * 安全删除 —— trash 模式而非直接 unlink。
 *
 * 为什么：FileNotFoundError 时直接恢复会认为"已删除成功"，
 * 但实际上可能在 trash 目录里还在。用户期望的是"恢复到原位置"。
 *
 * 策略：
 * 1. 移动文件到 ~/.agentcore/trash/{timestamp}_{filename}
 * 2. 记录 deletion_record（原路径 → trash 路径的映射）
 * 3. 恢复时找到 trash 文件并移回
 * 4. 7 天后 trash 文件自动清理
 */
const TRASH_DIR = process.env.TRASH_DIR ?? `${process.env.HOME}/.agentcore/trash`;

export async function trashDelete(filePath: string): Promise<{ success: boolean; trashPath?: string }> {
  try {
    const timestamp = Date.now();
    const trashName = `${timestamp}_${basename(filePath)}`;
    const trashPath = join(TRASH_DIR, trashName);

    await fs.mkdir(TRASH_DIR, { recursive: true });

    // 移动（而非复制+删除）—— 同一文件系统是原子操作
    await fs.rename(filePath, trashPath);

    // 记录 deletion_record 到 JSON 文件
    const recordPath = join(TRASH_DIR, 'deletion_records.json');
    let records: Array<{ original: string; trash: string; deletedAt: number }> = [];
    try {
      records = JSON.parse(await fs.readFile(recordPath, 'utf-8'));
    } catch {
      records = [];
    }
    records.push({ original: filePath, trash: trashPath, deletedAt: timestamp });
    await fs.writeFile(recordPath, JSON.stringify(records, null, 2));

    return { success: true, trashPath };
  } catch (e) {
    return { success: false };
  }
}

export async function restoreFromTrash(originalPath: string): Promise<boolean> {
  const recordPath = join(TRASH_DIR, 'deletion_records.json');
  const records = JSON.parse(await fs.readFile(recordPath, 'utf-8'));

  const record = records.find((r: any) => r.original === originalPath);
  if (!record) return false;

  // 确保原目录存在
  await fs.mkdir(dirname(originalPath), { recursive: true });
  await fs.rename(record.trash, originalPath);

  return true;
}
```

### 3.4 API 调用幂等性

```typescript
// packages/core/src/fault/idempotent-api.ts

import { createHash } from 'crypto';
import { redis } from '@/lib/redis';

/**
 * 带幂等键的 API 调用。
 *
 * 模式：
 * 1. 根据 (toolName + args) 生成 idempotencyKey
 * 2. Redis SET NX（key 不存在才设置，TTL 24h）
 * 3. 如果 SET 成功 → 执行 API 调用 → 缓存结果
 * 4. 如果 SET 失败 → 说明之前调过 → 返回缓存的结果
 *
 * 这保证了"网络超时后重试时不会重复调用远程 API"。
 */
export async function withIdempotency<T>(
  toolName: string,
  args: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `idempotency:${toolName}:${createHash('md5').update(JSON.stringify(args)).digest('hex')}`;

  // SET NX（原子性：检查+设置一步完成）
  const acquired = await redis.set(key, 'pending', 'NX', 'EX', 24 * 60 * 60);

  if (acquired !== 'OK') {
    // 之前调过 —— 等一下然后读缓存
    // 这是因为当前可能正处于"正在执行"的状态（值为 'pending'）
    const result = await waitForResult(key);
    if (result !== null) return result as T;

    // 执行没成功（上次崩溃了），重试
    // 重新 SET——可能会失败但没关系，走 fallthrough
  }

  try {
    const result = await fn();
    await redis.setex(key, 24 * 60 * 60, JSON.stringify({ status: 'done', result }));
    return result;
  } catch (e) {
    // 失败时删除缓存 —— 下次重试允许重新执行
    await redis.del(key);
    throw e;
  }
}

async function waitForResult(key: string, timeoutMs = 5000): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await redis.get(key);
    if (raw && raw !== 'pending') {
      const parsed = JSON.parse(raw);
      if (parsed.status === 'done') return parsed.result;
      if (parsed.status === 'error') throw new Error(parsed.error);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null; // 超时
}
```

---

## 4. 降级模型切换

### 4.1 触发条件

```
主模型（如 GPT-4o）返回错误
     │
     ├── 429 Too Many Requests（配额超限） → 立刻降级到备用模型
     ├── 500 Internal Server Error → 等待 1s 后重试，2 次失败后降级
     ├── 503 Service Unavailable → 立刻降级
     ├── timeout（> 30s 无响应） → 立刻降级
     └── 其他错误 → 重试 1 次，失败后降级
```

### 4.2 实现

```typescript
// packages/core/src/fault/model-fallback.ts

import { LLMClient, LLMStreamChunk, LLMMessage } from '../llm/types';

interface ModelTier {
  name: string;
  client: LLMClient;
  priority: number;  // 越小越优先
  maxRetries: number;
}

/**
 * 多模型级联调用——fallback 模式。
 *
 * 不在初始化时选一个模型绑死，而是在每次 LLM 调用时尝试优先级最高的，
 * 失败时自动切换到下一个。
 */
export class FailoverLLMClient implements LLMClient {
  private tiers: ModelTier[];
  private currentTierIndex = 0;
  private retryCount = 0;

  constructor(tiers: ModelTier[]) {
    this.tiers = [...tiers].sort((a, b) => a.priority - b.priority);
  }

  /**
   * 尝试调用，失败自动 fallback。
   *
   * 降级触发后：
   * 1. 从 SSE 发一个"model_switched"事件通知前端（用户看到 toast）
   * 2. 在当前会话内锁定降级模型——不再尝试重切回主模型
   * 3. 记录降级日志（用于之后购买更多 quota）
   */
  async create(params: {
    messages: LLMMessage[];
    onSwitch?: (from: string, to: string) => void;
  }): Promise<{ content: string }> {
    for (let i = this.currentTierIndex; i < this.tiers.length; i++) {
      const tier = this.tiers[i];

      if (i > this.currentTierIndex && params.onSwitch) {
        params.onSwitch(this.tiers[this.currentTierIndex].name, tier.name);
      }

      try {
        const result = await tier.client.create({
          messages: params.messages,
        });

        // 成功——如果之前降级过，先不急着切回去（避免抖动）
        // 下一次 create 调用时再尝试主模型
        if (i > 0) {
          this.scheduleRecovery();
        }

        return result;
      } catch (e) {
        console.warn(`[Failover] ${tier.name} failed:`, (e as Error).message);
        this.currentTierIndex = i + 1;
      }
    }

    throw new Error('All LLM models failed — primary and all fallback models unavailable');
  }

  /**
   * 流式调用版本，支持在 stream 中途失败时切换模型继续。
   *
   * 实现策略：收集已发的 chunk，在新模型上 append 剩余内容。
   */
  async *stream(params: {
    messages: LLMMessage[];
    onSwitch?: (from: string, to: string) => void;
  }): AsyncGenerator<LLMStreamChunk> {
    for (let i = this.currentTierIndex; i < this.tiers.length; i++) {
      const tier = this.tiers[i];

      try {
        const generator = tier.client.stream({ messages: params.messages });
        let yielded = false;

        for await (const chunk of generator) {
          yielded = true;
          yield chunk;
        }

        if (i > 0) this.scheduleRecovery();
        return;
      } catch (e) {
        if (yielded) {
          // 已经发了一些 chunk 但 stream 中途停了——发 continuation 标记
          yield {
            type: 'continuation',
            content: '',
            metadata: { switchedFrom: tier.name, switchedTo: this.tiers[i + 1]?.name },
          };
        }

        console.warn(`[Failover Stream] ${tier.name} failed mid-stream:`, (e as Error).message);
        this.currentTierIndex = i + 1;
      }
    }

    throw new Error('All LLM models failed in streaming mode');
  }

  /**
   * 延迟恢复——下一分钟开始时尝试切回主模型。
   *
   * 不立即切回是因为：如果 quota 被耗光，切回去也还是 429。
   * 等一分钟让配额恢复（大多数 API 配额是每分钟/每小时周期）。
   */
  private scheduleRecovery(): void {
    setTimeout(() => {
      this.currentTierIndex = 0;
      console.log('[Failover] Attempting to recover to primary model');
    }, 60_000);
  }

  get currentModelName(): string {
    return this.tiers[this.currentTierIndex]?.name ?? 'unknown';
  }
}
```

### 4.3 使用配置

```typescript
// packages/core/src/fault/model-fallback-config.ts

/**
 * 推荐降级链：
 *
 * Tier 1: GPT-4o（最聪明，但贵，quota 有限）
 * Tier 2: Claude 3.5 Sonnet（也很聪明，与 GPT-4o 互补——它擅长代码，GPT-4o 擅长推理）
 * Tier 3: GPT-4o-mini（快且便宜，quota 充裕，降级后用户几乎无感）
 * Tier 4: Claude 3 Haiku（最便宜，用于保底）
 *
 * 关键原则：降级链里至少有一个模型是"对方互补"的。
 * 如果全部用 OpenAI 系（GPT-4 + GPT-3.5），一次 OpenAI 全线故障就会被全打挂。
 */
export const DEFAULT_FALLBACK_CHAIN: ModelTier[] = [
  {
    name: 'gpt-4o',
    client: new OpenAIClient({ model: 'gpt-4o' }),
    priority: 0,
    maxRetries: 2,
  },
  {
    name: 'claude-3-5-sonnet',
    client: new AnthropicClient({ model: 'claude-3-5-sonnet-20241022' }),
    priority: 1,
    maxRetries: 1,
  },
  {
    name: 'gpt-4o-mini',
    client: new OpenAIClient({ model: 'gpt-4o-mini' }),
    priority: 2,
    maxRetries: 1,
  },
  {
    name: 'claude-3-haiku',
    client: new AnthropicClient({ model: 'claude-3-haiku-20240307' }),
    priority: 3,
    maxRetries: 0,
  },
];
```

---

## 5. 超时与取消优雅处理

### 5.1 三级超时策略

```
Level 1: 单工具调用超时（30s）
         一个工具调用超过 30s → 超时，返回 error 结果，Agent 走重试策略
         不会终止整个对话

Level 2: Agent 单轮超时（10 分钟）
         一个 run() 调用超过 10 分钟 → 强制终止，保存 partial result
         返回已生成的回复给前端，不丢弃已经完成的部分

Level 3: 会话总超时（60 分钟）
         整个会话超过 60 分钟 → 强制归档
         提示用户 "会话已超时，请新建会话继续"
         所有状态快照归档到 Postgres
```

### 5.2 实现

```typescript
// packages/core/src/fault/timeout-handler.ts

import { setTimeout as delay } from 'timers/promises';

/**
 * Agent 超时控制器。
 *
 * 三层级超时，每级不同处理逻辑。
 * 关键设计：超时不只是"终止"，而是优雅收尾。
 */
export class TimeoutController {
  private toolTimeout: NodeJS.Timeout | null = null;
  private roundTimeout: NodeJS.Timeout | null = null;
  private sessionTimeout: NodeJS.Timeout | null = null;

  private aborted = false;
  private partialResult = '';

  constructor(
    private config: {
      toolTimeoutMs: number;
      roundTimeoutMs: number;
      sessionTimeoutMs: number;
    },
    private callbacks: {
      onToolTimeout: (toolName: string, callId: string) => void;
      onRoundTimeout: (partialResult: string) => void;
      onSessionTimeout: () => void;
    },
  ) {}

  startSession(): void {
    this.sessionTimeout = setTimeout(() => {
      this.aborted = true;
      this.callbacks.onSessionTimeout();
    }, this.config.sessionTimeoutMs);
  }

  startRound(abortController: AbortController): void {
    this.roundTimeout = setTimeout(() => {
      abortController.abort('round_timeout');
    }, this.config.roundTimeoutMs);
  }

  startToolWatch(toolName: string, callId: string): void {
    this.toolTimeout = setTimeout(() => {
      this.callbacks.onToolTimeout(toolName, callId);
    }, this.config.toolTimeoutMs);
  }

  cancelToolWatch(): void {
    if (this.toolTimeout) {
      clearTimeout(this.toolTimeout);
      this.toolTimeout = null;
    }
  }

  cancelRound(): void {
    if (this.roundTimeout) {
      clearTimeout(this.roundTimeout);
      this.roundTimeout = null;
    }
  }

  /** 累积 partial result（供超时后返回） */
  appendPartial(content: string): void {
    this.partialResult += content;
  }

  getPartialResult(): string {
    return this.partialResult;
  }

  destroy(): void {
    this.cancelToolWatch();
    this.cancelRound();
    if (this.sessionTimeout) clearTimeout(this.sessionTimeout);
  }
}
```

---

## 6. 错误分类与自动恢复策略

### 6.1 错误分类

```typescript
// packages/core/src/fault/error-classifier.ts

export type ErrorCategory =
  | 'retryable_rate_limit'      // 429 — 重试 + backoff
  | 'retryable_server_error'    // 5xx — 重试 + fallback
  | 'retryable_network'         // ECONNRESET / ETIMEDOUT — 重试 + reconnect
  | 'non_retryable_auth'        // 401 — 标记用户需要重新授权
  | 'non_retryable_quota'       // 403 quota 耗尽 — 通知用户升级
  | 'non_retryable_invalid_input' // 400 — 返回给用户修正输入
  | 'non_retryable_tool_error'   // 工具内部错误 — 提示用户
  | 'fatal';                    // 不可恢复 — 终止会话

interface RecoveryAction {
  category: ErrorCategory;
  retry: boolean;
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  switchModel: boolean;
  notifyUser: boolean;
  userMessage?: string;
}

export function classifyError(error: unknown): RecoveryAction {
  const message = (error as Error).message ?? '';
  const status = (error as any).status ?? (error as any).statusCode ?? 0;

  // Rate limit
  if (status === 429 || message.includes('rate limit')) {
    return {
      category: 'retryable_rate_limit',
      retry: true,
      maxRetries: 5,
      backoffMs: 1000,
      backoffMultiplier: 2,
      switchModel: true,
      notifyUser: false,
    };
  }

  // Server error
  if (status >= 500) {
    return {
      category: 'retryable_server_error',
      retry: true,
      maxRetries: 3,
      backoffMs: 2000,
      backoffMultiplier: 2,
      switchModel: true,
      notifyUser: false,
    };
  }

  // Network
  if (message.includes('ECONNRESET') || message.includes('ETIMEDOUT') || message.includes('network')) {
    return {
      category: 'retryable_network',
      retry: true,
      maxRetries: 3,
      backoffMs: 1000,
      backoffMultiplier: 1.5,
      switchModel: false,
      notifyUser: false,
    };
  }

  // Auth error
  if (status === 401) {
    return {
      category: 'non_retryable_auth',
      retry: false,
      maxRetries: 0,
      backoffMs: 0,
      backoffMultiplier: 1,
      switchModel: false,
      notifyUser: true,
      userMessage: 'API 密钥已过期，请重新配置',
    };
  }

  // Quota exceeded
  if (status === 403) {
    return {
      category: 'non_retryable_quota',
      retry: false,
      maxRetries: 0,
      backoffMs: 0,
      backoffMultiplier: 1,
      switchModel: false,
      notifyUser: true,
      userMessage: '配额已用尽，请升级套餐或等待配额刷新',
    };
  }

  // 默认：不重试
  return {
    category: 'non_retryable_tool_error',
    retry: false,
    maxRetries: 0,
    backoffMs: 0,
    backoffMultiplier: 1,
    switchModel: false,
    notifyUser: true,
    userMessage: `工具调用出错: ${message.slice(0, 100)}`,
  };
}
```

### 6.2 指数退避 retry 循环

```typescript
// packages/core/src/fault/retry-loop.ts

/**
 * 带指数退避的通用 retry 封装。
 *
 * 退避时间表：
 * 第 1 次重试: 等待 1s
 * 第 2 次重试: 等待 2s
 * 第 3 次重试: 等待 4s
 * 第 4 次重试: 等待 8s
 * 第 5 次重试: 等待 16s（最大上限）
 *
 * 每次等待都加了 jitter（0-25% 随机退避），防止多个客户端同时重试导致的
 * "惊群效应"（thundering herd）。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number;
    baseDelayMs: number;
    multiplier: number;
    maxDelayMs?: number;
    onRetry?: (attempt: number, error: unknown) => void;
  },
): Promise<T> {
  const { maxRetries, baseDelayMs, multiplier, maxDelayMs = 16000 } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;

      if (attempt >= maxRetries) break;

      const action = classifyError(e);
      if (!action.retry) throw e; // 不可恢复错误，立刻抛出

      // 计算退避时间 + jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(multiplier, attempt),
        maxDelayMs,
      );
      const jitter = delay * 0.25 * Math.random(); // 25% jitter
      const totalDelay = Math.floor(delay + jitter);

      options.onRetry?.(attempt + 1, e);
      await new Promise((r) => setTimeout(r, totalDelay));
    }
  }

  throw lastError;
}
```

---

## 7. 前端：Recovery UI

🔗 **工程逻辑**：Recovery UI 的核心目标有两个：
1. 让用户知道"发生了什么"——不要让用户看着无响应的页面发呆
2. 让用户有控制权——手动 resume vs 重新开始的选择

### 7.1 断线提示组件

```tsx
// apps/web/src/components/recovery/recovery-status.tsx

'use client';

import { useState, useEffect, useCallback } from 'react';

interface RecoveryState {
  status: 'connected' | 'reconnecting' | 'recovered' | 'failed';
  attempt: number;
  maxAttempts: number;
  lastError?: string;
  modelSwitched?: { from: string; to: string };
  progress: number; // 0-100，Agent 完成的进度（基于消息数量）
}

export function RecoveryOverlay({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<RecoveryState>({
    status: 'connected',
    attempt: 0,
    maxAttempts: 5,
    progress: 0,
  });

  const handleSSEDisconnect = useCallback(() => {
    setState((prev) => ({
      ...prev,
      status: 'reconnecting',
      attempt: prev.attempt + 1,
    }));
  }, []);

  const handleSSEMessage = useCallback((event: { type: string; data: any }) => {
    switch (event.type) {
      case 'recovery_start':
        setState((prev) => ({ ...prev, status: 'reconnecting' }));
        break;
      case 'recovery_complete':
        setState((prev) => ({ ...prev, status: 'recovered', attempt: 0 }));
        // 3 秒后自动隐藏
        setTimeout(() => {
          setState((prev) => ({ ...prev, status: 'connected' }));
        }, 3000);
        break;
      case 'model_switched':
        setState((prev) => ({
          ...prev,
          modelSwitched: {
            from: event.data.from,
            to: event.data.to,
          },
        }));
        break;
      case 'progress':
        setState((prev) => ({
          ...prev,
          progress: event.data.percent,
        }));
        break;
    }
  }, []);

  // 根据状态渲染不同 UI
  if (state.status === 'connected' && !state.modelSwitched) {
    return null; // 一切都好——不显示任何东西
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-50">
      {/* 断线提示条 */}
      {state.status === 'reconnecting' && (
        <div className="bg-yellow-500/90 text-black px-4 py-2 text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 bg-yellow-800 rounded-full animate-pulse" />
            连接断开，正在重连...（第 {state.attempt}/{state.maxAttempts} 次）
          </span>
          {state.progress > 0 && (
            <span className="text-yellow-800 text-xs">
              Agent 执行进度: {state.progress}%
            </span>
          )}
        </div>
      )}

      {/* 恢复成功提示 */}
      {state.status === 'recovered' && (
        <div className="bg-green-500/90 text-black px-4 py-2 text-sm text-center">
          ✓ 已恢复连接，所有消息已同步
        </div>
      )}

      {/* 模型降级通知 */}
      {state.modelSwitched && (
        <div className="bg-blue-500/20 border-b border-blue-500/30 text-blue-300 px-4 py-2 text-sm flex items-center justify-between">
          <span>
            模型已从 <strong>{state.modelSwitched.from}</strong> 切换到 <strong>{state.modelSwitched.to}</strong>
            {state.modelSwitched.to.includes('mini') || state.modelSwitched.to.includes('haiku')
              ? '（降级模型，回复质量可能略有下降）'
              : ''}
          </span>
          <button
            onClick={() => setState((prev) => ({ ...prev, modelSwitched: undefined }))}
            className="text-blue-400 hover:text-blue-300"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
```

### 7.2 Agent 进度条

```tsx
// apps/web/src/components/recovery/agent-progress.tsx

'use client';

import { useState, useEffect } from 'react';

interface AgentProgressData {
  toolCallCount: number;
  completedTools: string[];
  currentTool: string | null;
  estimatedTokensUsed: number;
  estimatedTotalTokens: number;
}

export function AgentProgress({ sessionId }: { sessionId: string }) {
  const [progress, setProgress] = useState<AgentProgressData | null>(null);

  useEffect(() => {
    // 接收 Agent 实时进度（从 SSE stream 中解析 tool_call_start/tool_call_result 事件）
    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress_update') {
          setProgress(data.payload as AgentProgressData);
        }
      } catch {
        // 不是 JSON，跳过
      }
    };

    // 这里应该监听 EventSource 的消息，简化版:
    window.addEventListener('agent-progress', handler as EventListener);
    return () => window.removeEventListener('agent-progress', handler as EventListener);
  }, [sessionId]);

  if (!progress || !progress.currentTool) return null;

  const tokenProgress = Math.min(
    (progress.estimatedTokensUsed / progress.estimatedTotalTokens) * 100,
    95, // 永远不到 100%，直到 Agent 说完成
  );

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
      {/* 进度条 */}
      <div>
        <div className="flex justify-between text-xs text-muted mb-1">
          <span>处理中</span>
          <span>~{Math.round(tokenProgress)}%</span>
        </div>
        <div className="h-1.5 bg-surface/60 rounded-full overflow-hidden">
          <div
            className="h-full bg-primary/80 rounded-full transition-all duration-300"
            style={{ width: `${tokenProgress}%` }}
          />
        </div>
      </div>

      {/* 当前工具 */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted">当前:</span>
        <span className="text-text font-mono bg-surface/60 px-1.5 py-0.5 rounded">
          {progress.currentTool}
        </span>
      </div>

      {/* 已完成工具列表 */}
      {progress.completedTools.length > 0 && (
        <div className="text-xs text-muted">
          ✓ 已完成: {progress.completedTools.slice(-3).join(', ')}
          {progress.completedTools.length > 3 && ` (+${progress.completedTools.length - 3})`}
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
| 状态快照序列化时 crash | 快照包含了不可序列化的对象（AbortController, stream handle, socket） | 序列化前显式过滤已知危险字段；try-catch 包裹 + 降级模式（只保留 messages 基本信息） |
| 重连时 lastEventId 遗漏导致恢复到错误断点 | 客户端没正确存储/发送 Last-Event-Id header；或者服务端 event id 格式不一致 | 用标准化 event id 格式 `{sessionId}_{seq}`；服务端做 lastEventId 存在性检查 |
| 工具调用重试导致同一操作执行多次（重复发送邮件、重复写文件） | 没有给工具调用加幂等保护 | 文件写用 tmp+rename；删除用 trash；API 调用加 idempotency key |
| 降级模型后用户完全无感知，但回复质量下降严重 | 切换到低端模型时没有通知用户 | SSE 发 `model_switched` 事件，前端显示 toast 提示 |
| 快照写入 Redis 但 TTL 还没到进程就崩了，恢复时拿到不完整的快照 | 工具调用执行到一半时崩溃——snapshot 里的 pendingToolCall 状态不准确 | pendingToolCall 开始前先快照，完成后立刻再快照——把"中间状态"窗口缩到最小 |
| Agent 超时时只返回 error 而没有返回已生成的内容 | 超时直接 throw，丢失了 partial result | 三层超时回调 wrap partial result；超时时发给前端"以下为不完整回复" |
| Redis stream 被 MAXLEN trim 后重连无法补发旧事件 | 如果客户端离线时间太长（> 24h），stream 可能已被 archive 但客户端不知道 | event TTL 之前检查是否超出 archive 边界；超出的话告诉用户"无法恢复到之前的对话" |
| transform 后的 JSON 字段和模型原始输出不一致导致前端解析失败 | Agent 处理模型输出时做了格式转换（如把 `\n` 替换为 `<br>`），但前端期望原始 markdown | transformation 要在 snapshot 中标记（`transformed: true`），前端根据标记选择渲染逻辑 |
| Failover 后切回的频率太高（每分钟都在尝试切回主模型，429 又降） | recovery delay 太短，quota 还没恢复 | 增加 recovery 间隔（从 60s 到 300s）；同时记录"连续失败次数"，超 N 次后暂停自动恢复 |
| 会话结束时 snapshot 没归档到 Postgres，用户第二天想"回到昨天的对话"没数据 | snapshot 在 Redis TTL 过期后自动删除 | 会话结束时（Agent 完成或会话超时）主动把 snapshot 写入 Postgres archive 表 |

---

## 9. AI 避坑追加（AST 可检）

> 🤖 **AI 常见错误**：
>
> 1. **快照序列化包含不可序列化字段** — 状态快照中引用了 `AbortController`、`Socket` 或 `ReadableStream` 对象，`JSON.stringify` 直接返回 `{}` 或抛 `TypeError`。**检查方式**：所有进入 snapshot 的对象必须通过 `serializeState()` 函数，该函数递归过滤非 JSON-safe 类型；快照写入前用 `structuredClone()` 测试兼容性。
>
> 2. **SSE 重连后 last-event-id 不连续** — 客户端断线重连时带上了旧的 `Last-Event-Id`，但 Redis stream 已被 `MAXLEN` 裁剪，服务端找不到该事件 ID，导致静默跳过所有历史消息。**ESLint 规则**：所有 SSE 重连逻辑必须检查 `resumed` 响应字段——如果服务端返回 `resumed: false`，客户端必须丢弃旧 event buffer 并执行全量恢复。
>
> 3. **模型降级后 token 预算未重算** — 从 GPT-4o 降级到 GPT-3.5-turbo 时，最大 context 从 128K 降到 16K，但 ContextManager 仍在按 128K 构建 prompt，导致第一条 API 报 `context_length_exceeded`。**检查方式**：ModelFallbackProvider 在切换模型时必须同步触发 `ContextManager.resizeBudget(newMaxTokens)`；所有 `buildContext()` 调用必须断言 `estimatedTokens <= model.maxContextTokens * 0.9`。

---

*本节点属于 Layer 4 可靠性工程层。容错的终极目标是"用户不应该感知到底层出了问题"——连接断了模型回复没断、工具超时了还有降级的、状态崩溃了能从断点恢复。实现时有一个核心原则：**容错优先级高于性能**——宁可 snapshot 写入多花 5ms 导致流慢一点，也不能崩溃后丢了半小时的对话。演进路径：先做 Redis 快照+断线重连（解决 80% 的容器），再加幂等性设计（解决工具层），最后做降级模型+优雅超时（解决 LLM API 层）。*
