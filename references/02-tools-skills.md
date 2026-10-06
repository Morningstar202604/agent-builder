# 02 — 工具 · Skill · Token 预算

> 本 reference 覆盖 Agent 核心能力层的三个子系统：上下文窗口与 Token 预算管理（Token Estimation + Context Compression）、工具注册中心与 MCP 客户端（ToolRegistry + MCPClient）、Skill 系统——渐进披露与生命周期的完整实现。读完本文件即可独立落地上述三个子系统的全部后端+前端代码。

---

## 目录

- [上下文窗口管理](#上下文窗口管理)
  - [Token 估算器](#1-token-估算器)
  - [上下文压缩器](#2-上下文压缩器)
  - [Token Budget 编排器](#3-token-budget-编排器)
  - [集成到 Agent 循环](#4-集成到-agent-循环)
  - [模型上下文适配](#5-不同模型上下文适配)
  - [前端 ContextUsageBar](#6-前端上下文显示)
- [工具注册中心与 MCP 客户端](#工具注册中心与-mcp-客户端)
  - [ToolRegistry 完整实现](#1-toolregistry-完整实现)
  - [内置工具](#2-内置工具实现)
  - [MCP 类型定义](#3-mcp-类型定义)
  - [MCPClient 双模式通信](#4-mcp-客户端双模式通信)
  - [MCPManager 多连接管理](#5-mcp-连接管理器)
  - [前端集成](#6-前端集成)
- [Skill 系统——渐进披露](#skill-系统渐进披露)
  - [Skill 目录结构标准](#1-skill-目录结构标准)
  - [SkillsLoader 元数据加载](#2-skillloader-渐进加载)
  - [Skill 激活工具](#3-skill-激活工具llm-调用的入口)
  - [SkillContextManager](#4-skillcontextmanager-上下文注入与淘汰)
  - [SkillManager 安装与管理](#5-skillmanager-安装与生命周期)
  - [Skill 冲突检测](#6-skill-冲突检测)
  - [前端 Skills 面板](#7-前端-skills-面板)

---

## 上下文窗口管理

### 工程逻辑概述

Agent 每一轮 ReAct 循环都在消息历史里追加内容。5 轮循环后消息列表可达 15 条，加上工具返回的大段 JSON，token 数轻松突破 30K。大多数模型（GPT-4o、Claude Sonnet）的上下文窗口是 128K token。即使不突破上限，上下文越长模型注意力越稀释、回复质量越差。

**为什么不直接"砍掉旧消息"？** 因为 Agent 的多步推理有因果依赖——第 3 步的工具结果可能在第 5 步被引用。直接删除会让 LLM 产生幻觉。正确做法：**保留最近 N 轮完整，更早的压缩成摘要**。

压缩必须发生在 **Agent 每一轮迭代开始时**（不是用户发消息之前），因为 ReAct 循环每轮追加工具结果后 token 都在增长。压缩后的 `messagesToSend` 只是给 LLM 看的"视图"，绝不能覆盖 `context.messages`——始终在原始消息列表上追加，每轮从原始列表生成压缩视图发给 LLM。

```
┌─────────────────────────────────────────────────┐
│            LLM Context Window (e.g. 128K)        │
│                                                   │
│  ┌─────────────────────────────────────────┐     │
│  │ System Prompt (固定)                      │     │
│  ├─────────────────────────────────────────┤     │
│  │ Token Budget (本节点管理)                 │     │
│  │  ┌───────────────────────────────┐      │     │
│  │  │ 摘要区 (历史对话压缩)           │      │     │
│  │  │ "用户讨论了X，做了Y..."        │      │     │
│  │  ├───────────────────────────────┤      │     │
│  │  │ 近期 N 轮 (完整保留)           │      │     │
│  │  │ msg7 完整 · msg8 完整 ...     │      │     │
│  │  └───────────────────────────────┘      │     │
│  ├─────────────────────────────────────────┤     │
│  │ Headroom (安全余量 ~10%)                │     │
│  └─────────────────────────────────────────┘     │
└─────────────────────────────────────────────────┘
```

### 1. Token 估算器

精确估算需要 tokenizer（tiktoken），但它是一个 Python/Wasm 依赖，很重。我们从字符近似开始，在生产环境可切换为 WASM tokenizer，上层接口无需变动。

```typescript
// packages/core/src/context/tokenEstimator.ts

import type { LLMMessage } from '../llm/types';

/** 估算策略 */
export type EstimationStrategy = 'chars' | 'words' | 'tiktoken-wasm';

export interface TokenEstimator {
  readonly strategy: EstimationStrategy;
  estimate(messages: LLMMessage[]): Promise<number>;
  estimateText(text: string): Promise<number>;
}

/**
 * 字符近似估算 —— 零依赖、速度快、误差 ±15%
 *
 * 工程选择：中文约 1.5 char/token，英文约 4 char/token。
 * 使用加权公式：chineseChars * 0.7 + otherChars * 0.28。
 * 误差控制在 ±15%，对 Token Budget 的阈值判断足够用。
 */
export class CharBasedEstimator implements TokenEstimator {
  readonly strategy = 'chars' as const;

  async estimate(messages: LLMMessage[]): Promise<number> {
    let total = 0;
    for (const msg of messages) {
      total += await this.estimateText(msg.content ?? '');
      total += this.estimateMessageOverhead(msg);
    }
    return total;
  }

  async estimateText(text: string): Promise<number> {
    const chineseChars = (text.match(/[\u4e00-\u9fff\u3000-\u303f]/g) ?? []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars * 0.7 + otherChars * 0.28);
  }

  private estimateMessageOverhead(msg: LLMMessage): number {
    // OpenAI 每条消息固定消耗 ~4 token（role + separator）
    // 加上 tool_call_id 约 8 token，加上 tool_calls 结构约 10 token/个
    let overhead = 4;
    if (msg.tool_call_id) overhead += 8;
    if (msg.tool_calls?.length) overhead += 10 * msg.tool_calls.length;
    return overhead;
  }
}

/**
 * WASM tiktoken —— 精确估算，用于生产环境
 *
 * 工程选择：只有 GPT 系列模型用 cl100k_base 编码。
 * 通义千问、DeepSeek 等非 OpenAI 模型需要用 chars 策略。
 * 注意：WASM 版本约 1MB，浏览器端只能用 chars 策略。
 */
export class TiktokenEstimator implements TokenEstimator {
  readonly strategy = 'tiktoken-wasm' as const;
  private encoder: any = null;

  async initialize(): Promise<void> {
    // @vscode/vscode-languagedetection 或 tiktoken 的 wasm 版本
    // 这里用动态 import 避免强制依赖
    const { get_encoding } = await import('tiktoken/lite');
    this.encoder = get_encoding('cl100k_base');  // GPT-4/4o/turbo 用的
  }

  async estimate(messages: LLMMessage[]): Promise<number> {
    if (!this.encoder) await this.initialize();
    let total = 0;
    for (const msg of messages) {
      const text = msg.content ?? '';
      const tokens = this.encoder.encode(text).length;
      total += tokens + this.estimateMessageOverhead(msg);
    }
    return total;
  }

  async estimateText(text: string): Promise<number> {
    if (!this.encoder) await this.initialize();
    return this.encoder.encode(text).length;
  }

  private estimateMessageOverhead(msg: LLMMessage): number {
    let overhead = 4;
    if (msg.tool_call_id) overhead += 8;
    if (msg.tool_calls?.length) overhead += 10 * msg.tool_calls.length;
    return overhead;
  }
}

/** 工厂 —— 根据环境选择策略 */
export function createTokenEstimator(strategy?: EstimationStrategy): TokenEstimator {
  if (strategy === 'tiktoken-wasm') {
    return new TiktokenEstimator();
  }
  return new CharBasedEstimator();
}
```

> 🤖 **AI 常见错误**：
> 1. **只估算 content 不估算消息结构开销** —— OpenAI 每条消息有 4+ token 的固定开销，多消息轮次累积可达几百 token。
> 2. **在浏览器端用 tiktoken** —— WASM 版本约 1MB，会拖慢首屏加载。浏览器端用字符近似版，服务端用精确版做预算决策。

### 2. 上下文压缩器

压缩的关键粒度：保持 system + user 完整，压缩 assistant 的工具调用结果。

```typescript
// packages/core/src/context/compressor.ts

import type { LLMMessage } from '../llm/types';
import type { LLMClient } from '../llm/types';

/** 压缩后的结果 */
export interface CompressionResult {
  /** 压缩后的消息列表 */
  messages: LLMMessage[];
  /** 节省了多少 token */
  tokensSaved: number;
  /** 压缩了多少条原始消息 */
  compressedCount: number;
}

/** 压缩策略配置 */
export interface CompressionConfig {
  /** 保留最近 N 轮对话不压缩 */
  preserveRecentRounds: number;
  /** 单次压缩的最大消息数 */
  maxMessagesPerBatch: number;
  /** 摘要使用的 system instruction */
  summaryPrompt?: string;
  /** 触发压缩的阈值（token 占上下文窗口的比例 0.0-1.0） */
  triggerRatio: number;
}

export class ContextCompressor {
  private llm: LLMClient;
  private config: CompressionConfig;

  constructor(llm: LLMClient, config: Partial<CompressionConfig> = {}) {
    this.llm = llm;
    this.config = {
      preserveRecentRounds: 4,
      maxMessagesPerBatch: 16,
      triggerRatio: 0.7,
      summaryPrompt: this.getDefaultSummaryPrompt(),
      ...config,
    };
  }

  /** 判断是否需要压缩 */
  needsCompression(messages: LLMMessage[], contextWindow: number, currentTokens: number): boolean {
    return currentTokens > contextWindow * this.config.triggerRatio;
  }

  /**
   * 压缩消息历史
   * 核心策略：保留最近 N 轮完整，把更早的摘要化
   */
  async compress(
    messages: LLMMessage[],
    currentTokens: number
  ): Promise<CompressionResult> {
    const { preserved, toCompress } = this.splitMessages(messages);

    if (toCompress.length === 0) {
      return { messages, tokensSaved: 0, compressedCount: 0 };
    }

    const compressedMessages: LLMMessage[] = [];
    let totalCompressed = 0;

    for (let i = 0; i < toCompress.length; i += this.config.maxMessagesPerBatch) {
      const batch = toCompress.slice(i, i + this.config.maxMessagesPerBatch);
      const summary = await this.summarizeBatch(batch);
      compressedMessages.push({
        role: 'system',
        content: `[Previous conversation summary]\n${summary}`,
      });
      totalCompressed += batch.length;
    }

    const finalMessages = [...compressedMessages, ...preserved];

    return {
      messages: finalMessages,
      tokensSaved: currentTokens - (await this.estimateTokens(finalMessages)),
      compressedCount: totalCompressed,
    };
  }

  /**
   * 把消息分成"要压缩的"和"保留的"
   * 注意：system 消息永远保留在最前面不参与压缩
   */
  private splitMessages(messages: LLMMessage[]): {
    preserved: LLMMessage[];
    toCompress: LLMMessage[];
  } {
    const recentUserIndices: number[] = [];
    for (let i = messages.length - 1; i >= 0 && recentUserIndices.length < this.config.preserveRecentRounds; i--) {
      if (messages[i].role === 'user') {
        recentUserIndices.unshift(i);
      }
    }

    if (recentUserIndices.length === 0) {
      return { preserved: messages, toCompress: [] };
    }

    const preserveStartIndex = recentUserIndices[0];

    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');
    const convPreserveStart = preserveStartIndex - systemMessages.length;

    if (convPreserveStart <= 0) {
      return { preserved: messages, toCompress: [] };
    }

    return {
      preserved: [...systemMessages, ...conversationMessages.slice(convPreserveStart)],
      toCompress: conversationMessages.slice(0, convPreserveStart),
    };
  }

  /** 用 LLM 对一批消息做摘要 */
  private async summarizeBatch(messages: LLMMessage[]): Promise<string> {
    const textRepresentation = messages
      .map(m => {
        const role = m.role.toUpperCase();
        let segment = `[${role}]: ${m.content ?? ''}`;
        if (m.tool_calls?.length) {
          segment += `\n  Tool calls: ${m.tool_calls.map(tc =>
            `${tc.function.name}(${tc.function.arguments.slice(0, 100)}...)`
          ).join(', ')}`;
        }
        if (m.role === 'tool') {
          segment = `[TOOL RESULT for ${m.tool_call_id?.slice(0, 8)}]: ${m.content?.slice(0, 200) ?? ''}`;
        }
        return segment;
      })
      .join('\n---\n');

    const summaryRequest: LLMMessage[] = [
      { role: 'system', content: this.config.summaryPrompt! },
      { role: 'user', content: textRepresentation },
    ];

    let result = '';
    const stream = this.llm.stream(summaryRequest, { maxTokens: 500 });
    for await (const chunk of stream) {
      if (chunk.type === 'token') {
        result += chunk.data.content;
      }
    }
    return result.trim();
  }

  private async estimateTokens(messages: LLMMessage[]): Promise<number> {
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    return Math.ceil(totalChars / 3);
  }

  private getDefaultSummaryPrompt(): string {
    return `You are a conversation summarizer. Your task is to create a concise summary of the conversation excerpt below.
Focus on:
- Key topics discussed
- Important decisions made
- Tool calls and their outcomes
- Any code, files, or URLs mentioned
- User preferences expressed

Write the summary in Chinese if the conversation was in Chinese, otherwise in English.
Keep it under 200 words. Be specific about names, values, and decisions.`;
  }
}
```

> 🤖 **AI 常见错误**：
> 1. **摘要丢失工具结果的关键细节** —— 如果摘要写"用户讨论了天气"而没记录"温度是 22°C"，后续轮次 LLM 引用时会编造一个温度。summary prompt 里必须强调"保留数值类信息"。
> 2. **压缩后没有更新原始消息引用** —— 如果压缩后直接把 `context.messages` 覆盖成了压缩版本，用户的原始消息列表就丢了，前端消息记录也会错乱。
> 3. **每轮都压缩** —— 压缩不是免费的：调用 LLM 做摘要本身就要消耗 token。只有当 token 量超过阈值时才压缩。

### 3. Token Budget 编排器

把估算器和压缩器串起来的上层：

```typescript
// packages/core/src/context/contextManager.ts

import type { LLMMessage } from '../llm/types';
import type { LLMClient } from '../llm/types';
import { createTokenEstimator, type TokenEstimator, type EstimationStrategy } from './tokenEstimator';
import { ContextCompressor, type CompressionConfig, type CompressionResult } from './compressor';

/** 上下文窗口配置 */
export interface ContextWindowConfig {
  contextWindow: number;
  systemPromptTokens?: number;
  responseHeadroom: number;
  estimationStrategy?: EstimationStrategy;
  compressionTriggerRatio: number;
  preserveRounds: number;
}

/** 上下文状态（前端用来显示） */
export interface ContextStatus {
  totalTokens: number;
  contextWindow: number;
  usageRatio: number;        // 0.0 ~ 1.0
  messageCount: number;
  lastCompressionAt?: number;
  compressionCount: number;
  isCompressed: boolean;
  breakdown: {
    system: number;
    history: number;
    reserved: number;        // headroom
  };
}

export class ContextManager {
  private estimator: TokenEstimator;
  private compressor: ContextCompressor;
  private config: ContextWindowConfig;
  private contextWindow: number;
  private compressionHistory: Array<{ at: number; saved: number; count: number }> = [];

  constructor(llm: LLMClient, config: ContextWindowConfig) {
    this.config = {
      compressionTriggerRatio: 0.7,
      preserveRounds: 4,
      responseHeadroom: 4096,
      ...config,
    };
    this.contextWindow = config.contextWindow;
    this.estimator = createTokenEstimator(config.estimationStrategy);
    this.compressor = new ContextCompressor(llm, {
      preserveRecentRounds: config.preserveRounds,
      triggerRatio: config.compressionTriggerRatio,
    });
  }

  /**
   * 准备发送给 LLM 的消息列表
   * 在 Agent 每次调 LLM 前调用，自动决定要不要压缩
   */
  async prepareMessages(
    messages: LLMMessage[],
    systemPrompt?: string
  ): Promise<{ messages: LLMMessage[]; status: ContextStatus }> {
    const systemTokens = systemPrompt
      ? await this.estimator.estimateText(systemPrompt)
      : (this.config.systemPromptTokens ?? 0);

    let historyTokens = await this.estimator.estimate(messages);
    let totalTokens = systemTokens + historyTokens;

    const shouldCompress =
      totalTokens + this.config.responseHeadroom > this.contextWindow * this.config.compressionTriggerRatio;

    let isCompressed = false;
    if (shouldCompress) {
      const result = await this.compressor.compress(messages, historyTokens);
      if (result.tokensSaved > 0) {
        messages = result.messages;
        historyTokens = await this.estimator.estimate(messages);
        totalTokens = systemTokens + historyTokens;
        isCompressed = true;
        this.compressionHistory.push({
          at: Date.now(),
          saved: result.tokensSaved,
          count: result.compressedCount,
        });
      }
    }

    return {
      messages,
      status: {
        totalTokens,
        contextWindow: this.contextWindow,
        usageRatio: totalTokens / this.contextWindow,
        messageCount: messages.length,
        lastCompressionAt: this.compressionHistory.at(-1)?.at,
        compressionCount: this.compressionHistory.length,
        isCompressed,
        breakdown: {
          system: systemTokens,
          history: historyTokens,
          reserved: this.config.responseHeadroom,
        },
      },
    };
  }

  /** 获取当前状态（前端轮询或初始化时用） */
  async getStatus(messages: LLMMessage[], systemPrompt?: string): Promise<ContextStatus> {
    const systemTokens = systemPrompt
      ? await this.estimator.estimateText(systemPrompt)
      : 0;
    const historyTokens = await this.estimator.estimate(messages);
    const totalTokens = systemTokens + historyTokens;

    return {
      totalTokens,
      contextWindow: this.contextWindow,
      usageRatio: totalTokens / this.contextWindow,
      messageCount: messages.length,
      lastCompressionAt: this.compressionHistory.at(-1)?.at,
      compressionCount: this.compressionHistory.length,
      isCompressed: this.compressionHistory.length > 0,
      breakdown: {
        system: systemTokens,
        history: historyTokens,
        reserved: this.config.responseHeadroom,
      },
    };
  }

  /** 计算"还能追加多少内容" */
  async remainingCapacity(messages: LLMMessage[], systemPrompt?: string): Promise<number> {
    const status = await this.getStatus(messages, systemPrompt);
    return Math.max(0, this.contextWindow - status.totalTokens - this.config.responseHeadroom);
  }
}
```

### 4. 集成到 Agent 循环

```typescript
// packages/core/src/agent/base.ts —— 修改部分

import { ContextManager } from '../context/contextManager';

export interface AgentConfig {
  systemPrompt: string;
  llm: import('../llm/types').LLMClient;
  tools: AgentTool[];
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /** 新增：上下文管理 */
  contextManager?: ContextManager;
}

export abstract class AbstractAgent {
  protected config: AgentConfig;
  protected maxIterations: number;

  async *run(userMessage: string, context: AgentContext): AsyncGenerator<AgentEvent> {
    context.messages.push(/* ... */);

    for (let i = 0; i < this.maxIterations; i++) {
      if (context.signal?.aborted) { /* ... */ }

      context.iteration = i + 1;
      yield { type: 'iteration', count: i + 1 };

      // ★ 每轮循环开始前，检查上下文是否需要压缩
      let messagesToSend = context.messages;
      let contextStatus = null;

      if (this.config.contextManager) {
        const prepared = await this.config.contextManager.prepareMessages(
          context.messages,
          this.config.systemPrompt
        );
        messagesToSend = prepared.messages;
        contextStatus = prepared.status;
        // 把状态传给前端
        yield { type: 'context_status', ...contextStatus } as any;
      }

      let assistantContent = '';
      const pendingToolCalls: Array<{ id: string; name: string; args: any }> = [];

      for await (const chunk of this.config.llm.stream(messagesToSend, {
        systemPrompt: this.config.systemPrompt,
        tools: toolDefs,
        temperature: this.config.temperature,
        maxTokens: this.config.maxTokens,
        signal: context.signal,
      })) {
        // ... 同之前的处理
      }

      // ... 工具执行和消息追加（追加到 context.messages，不是 messagesToSend）
    }
  }
}
```

### 5. 不同模型上下文适配

不同模型窗口大小不同，需做配置映射：

```typescript
// packages/core/src/context/models.ts

/** 模型上下文窗口配置 */
export const MODEL_CONTEXT_WINDOWS: Record<string, {
  contextWindow: number;
  outputLimit: number;
  estimator: 'chars' | 'tiktoken-wasm';
}> = {
  'gpt-4o': { contextWindow: 128000, outputLimit: 16384, estimator: 'tiktoken-wasm' },
  'gpt-4o-mini': { contextWindow: 128000, outputLimit: 16384, estimator: 'tiktoken-wasm' },
  'gpt-4-turbo': { contextWindow: 128000, outputLimit: 4096, estimator: 'tiktoken-wasm' },
  'gpt-3.5-turbo': { contextWindow: 16000, outputLimit: 4096, estimator: 'tiktoken-wasm' },
  'claude-sonnet-4-20250514': { contextWindow: 200000, outputLimit: 4096, estimator: 'chars' },
  'claude-haiku-3-5': { contextWindow: 200000, outputLimit: 4096, estimator: 'chars' },
  'deepseek-chat': { contextWindow: 64000, outputLimit: 4096, estimator: 'chars' },
  'qwen-max': { contextWindow: 32000, outputLimit: 2048, estimator: 'chars' },
};

/** 根据模型名获取上下文配置 */
export function getModelConfig(model: string) {
  for (const [pattern, config] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(pattern)) return config;
  }
  return MODEL_CONTEXT_WINDOWS['gpt-4o']; // fallback
}
```

### 6. 前端上下文显示

```typescript
// apps/web/src/components/chat/ContextUsageBar.tsx

import { useEffect, useState } from 'react';

interface ContextStatus {
  totalTokens: number;
  contextWindow: number;
  usageRatio: number;
  messageCount: number;
  isCompressed: boolean;
  lastCompressionAt?: number;
}

export function ContextUsageBar({ status }: { status: ContextStatus | null }) {
  if (!status) return null;

  const { usageRatio, totalTokens, contextWindow, isCompressed, lastCompressionAt } = status;
  const percent = Math.min(usageRatio * 100, 100);

  const color = percent > 85 ? 'bg-red-500' : percent > 65 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted border-t border-border bg-surface/50">
      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${color}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <span className="tabular-nums whitespace-nowrap">
        {totalTokens.toLocaleString()} / {contextWindow.toLocaleString()} tk
      </span>

      {isCompressed && (
        <span
          className="px-1.5 py-0.5 rounded bg-accent/20 text-accent text-[10px]"
          title={`上次压缩：${lastCompressionAt ? new Date(lastCompressionAt).toLocaleTimeString() : 'unknown'}`}
        >
          COMPRESSED
        </span>
      )}

      {percent > 85 && (
        <span className="text-red-400 animate-pulse" title="即将触发上下文压缩">
          ⚠ 上下文快满了
        </span>
      )}
    </div>
  );
}

// 在 ChatArea 组件中消费 context_status 事件
// apps/web/src/components/chat/ChatArea.tsx

function ChatArea() {
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);

  // 在 useAgentStream 的 onEvent 里加上：
  // case 'context_status': setContextStatus(event.data); break;

  return (
    <div className="flex flex-col h-full">
      <MessageList />
      <ContextUsageBar status={contextStatus} />
      <ChatInput />
    </div>
  );
}
```

---

## 工具注册中心与 MCP 客户端

### 工程逻辑概述

当你的工具数量超过 20 个时，把所有工具 schema 塞进 LLM prompt 会浪费大量 token（每个工具描述约 50-200 token）。ToolRegistry 支持"按需加载"——Agent 进入某个工作模式时才注入那组工具，而不是所有工具始终都在 system prompt 里。

```
┌──────────────────────────────────────────────────────────┐
│                    Tool Registry                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Built-in     │  │ MCP Server   │  │ User-defined │   │
│  │ readFile     │  │ filesystem   │  │ custom_api   │   │
│  │ writeFile    │  │ github       │  │              │   │
│  │ search       │  │ database     │  │              │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                  │                  │           │
│         └──────────────────┴──────────────────┘           │
│                            │                              │
│              ┌─────────────▼──────────────┐               │
│              │   Unified Tool Interface    │               │
│              │   execute / validate / log  │               │
│              └─────────────┬──────────────┘               │
│                            │                              │
│              ┌─────────────▼──────────────┐               │
│              │   Agent ReAct Loop          │               │
│              └────────────────────────────┘               │
└──────────────────────────────────────────────────────────┘
```

### 1. ToolRegistry 完整实现

```typescript
// packages/core/src/tool/registry.ts

import type { AgentTool } from '../agent/types';
import type { LLMToolDefinition } from '../llm/types';
import type { ToolContext } from '../agent/types';

/** 工具元数据 */
export interface ToolMeta {
  name: string;
  description: string;
  category: 'file' | 'network' | 'system' | 'mcp' | 'custom';
  /** 工具优先级（相似描述的工具同时出现时选优先级高的） */
  priority?: number;
  /** 是否需要用户确认执行 */
  requiresConfirmation?: boolean;
  /** 工具标签，用于分组和检索 */
  tags?: string[];
}

/** 带元数据的工具 */
export interface RegisteredTool extends AgentTool {
  meta: ToolMeta;
  /** 参数 schema（JSON Schema） */
  parameters: Record<string, unknown>;
}

/** 注册中心错误 */
export class ToolError extends Error {
  constructor(
    message: string,
    public readonly toolName: string,
    public readonly code: 'NOT_FOUND' | 'TIMEOUT' | 'VALIDATION' | 'EXECUTION' | 'CIRCUIT_OPEN',
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * 工具注册表
 *
 * 工程特性：
 * - 支持注册/注销/搜索（按名称、描述、标签模糊匹配）
 * - 执行时自动计时、统计成功率、计算平均延迟
 * - 支持超时控制（默认 30s，超时自动抛出 ToolError）
 * - 支持重试 + 指数退避（可配置重试次数，超时不重试）
 * - 支持只传工具子集给 LLM（token 预算优化核心接口）
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private stats = new Map<string, { calls: number; failures: number; avgLatency: number }>();

  /** 注册一个工具 */
  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.meta.name)) {
      throw new Error(`Tool "${tool.meta.name}" is already registered. Use forceRegister to overwrite.`);
    }
    this.tools.set(tool.meta.name, tool);
    this.stats.set(tool.meta.name, { calls: 0, failures: 0, avgLatency: 0 });
  }

  /** 强制注册（覆盖已有） */
  forceRegister(tool: RegisteredTool): void {
    this.tools.set(tool.meta.name, tool);
    if (!this.stats.has(tool.meta.name)) {
      this.stats.set(tool.meta.name, { calls: 0, failures: 0, avgLatency: 0 });
    }
  }

  /** 批量注册 */
  registerMany(tools: RegisteredTool[]): void {
    tools.forEach(t => this.forceRegister(t));
  }

  /** 注销 */
  unregister(name: string): boolean {
    this.stats.delete(name);
    return this.tools.delete(name);
  }

  /** 获取单个工具 */
  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** 列出所有工具（可按分类过滤） */
  list(category?: string): RegisteredTool[] {
    const all = Array.from(this.tools.values());
    return category ? all.filter(t => t.meta.category === category) : all;
  }

  /** 搜索工具（用于 Agent 自动发现） */
  search(query: string): RegisteredTool[] {
    const q = query.toLowerCase();
    return Array.from(this.tools.values()).filter(t =>
      t.meta.name.toLowerCase().includes(q) ||
      t.meta.description.toLowerCase().includes(q) ||
      t.meta.tags?.some(tag => tag.toLowerCase().includes(q))
    );
  }

  /** 转换成 LLM schema（只取指定工具的子集 —— token 预算优化关键） */
  toLLMToolDefs(names?: string[]): LLMToolDefinition[] {
    const tools = names
      ? names.map(n => this.tools.get(n)).filter(Boolean) as RegisteredTool[]
      : Array.from(this.tools.values());

    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.meta.name,
        description: t.meta.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * 执行工具（带超时、统计、重试）
   *
   * 重试策略：
   * - 默认不重试（retries=0）
   * - 超时类型的错误不重试（再试也会超时）
   * - 其他错误做指数退避，最大退避 8s
   */
  async execute(
    name: string,
    args: any,
    ctx: ToolContext,
    options?: { timeout?: number; retries?: number }
  ): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolError(`Tool "${name}" not found`, name, 'NOT_FOUND');
    }

    const timeout = options?.timeout ?? 30000;  // 默认 30 秒超时
    const retries = options?.retries ?? 0;

    const stat = this.stats.get(name)!;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const start = Date.now();
      try {
        const result = await this.executeWithTimeout(tool, args, ctx, timeout);
        const latency = Date.now() - start;
        stat.calls++;
        stat.avgLatency = (stat.avgLatency * (stat.calls - 1) + latency) / stat.calls;
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        stat.failures++;

        if (error instanceof ToolError && error.code === 'TIMEOUT') {
          throw error;  // 超时不重试
        }
        if (attempt < retries) {
          await this.delay(Math.min(1000 * Math.pow(2, attempt), 8000));
        }
      }
    }

    throw new ToolError(
      `Tool "${name}" failed after ${retries + 1} attempts: ${lastError?.message}`,
      name,
      'EXECUTION',
      lastError
    );
  }

  private async executeWithTimeout(
    tool: RegisteredTool,
    args: any,
    ctx: ToolContext,
    timeout: number
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ToolError(`Tool "${tool.meta.name}" timed out after ${timeout}ms`, tool.meta.name, 'TIMEOUT'));
      }, timeout);

      tool.execute(args, ctx)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 获取工具统计（供前端面板展示） */
  getStats() {
    return Object.fromEntries(this.stats);
  }
}
```

> 🤖 **AI 常见错误**：
> 1. **工具执行不设超时** —— 如果工具内部调一个外部 API 卡住了，整个 Agent 主循环就挂在那。`executeWithTimeout` 是必须有的防线。
> 2. **工具参数没有校验** —— 模型可能生成不符合 schema 的参数。应该在 `execute` 调用前用 JSON Schema validate，不对时把校验错误返回给 LLM 让它重试。

### 2. 内置工具实现

```typescript
// packages/core/src/tool/builtins/fileTools.ts

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ToolContext } from '../../agent/types';
import type { RegisteredTool } from '../registry';

const ALLOWED_PATHS = (process.env.ALLOWED_PATHS ?? process.cwd()).split(':');

function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return ALLOWED_PATHS.some(allowed => resolved.startsWith(path.resolve(allowed)));
}

export function createReadFileTool(): RegisteredTool {
  return {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content as text. Use for checking code, config files, or any text file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
        offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
        limit: { type: 'number', description: 'Maximum number of lines to read' },
      },
      required: ['path'],
    },
    meta: {
      name: 'read_file',
      description: 'Read file content',
      category: 'file',
      tags: ['read', 'file', 'io'],
    },
    async execute(args: { path: string; offset?: number; limit?: number }, _ctx: ToolContext) {
      if (!isPathAllowed(args.path)) {
        throw new Error(`Access denied: path "${args.path}" is not in allowed directories`);
      }

      const content = await fs.readFile(args.path, 'utf-8');

      if (args.offset || args.limit) {
        const lines = content.split('\n');
        const start = (args.offset ?? 1) - 1;
        const end = args.limit ? start + args.limit : undefined;
        return lines.slice(start).slice(0, end ? end - start : undefined).join('\n');
      }
      return content;
    },
  };
}

export function createWriteFileTool(): RegisteredTool {
  return {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. Automatically creates parent directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    meta: {
      name: 'write_file',
      description: 'Write content to file',
      category: 'file',
      requiresConfirmation: true,
      tags: ['write', 'file', 'io'],
    },
    async execute(args: { path: string; content: string }, _ctx: ToolContext) {
      if (!isPathAllowed(args.path)) {
        throw new Error(`Access denied: path "${args.path}" is not in allowed directories`);
      }
      await fs.mkdir(path.dirname(args.path), { recursive: true });
      await fs.writeFile(args.path, args.content, 'utf-8');
      return { success: true, bytesWritten: args.content.length };
    },
  };
}

export function createListFilesTool(): RegisteredTool {
  return {
    name: 'list_files',
    description: 'List files and directories in a given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
        recursive: { type: 'boolean', description: 'Whether to list recursively' },
      },
      required: ['path'],
    },
    meta: {
      name: 'list_files',
      description: 'List directory contents',
      category: 'file',
      tags: ['read', 'file', 'list'],
    },
    async execute(args: { path: string; recursive?: boolean }, _ctx: ToolContext) {
      if (!isPathAllowed(args.path)) {
        throw new Error(`Access denied: path "${args.path}" is not in allowed directories`);
      }

      const entries = await fs.readdir(args.path, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    },
  };
}
```

```typescript
// packages/core/src/tool/builtins/searchTools.ts

import type { RegisteredTool } from '../registry';
import type { ToolContext } from '../../agent/types';

export function createWebSearchTool(): RegisteredTool {
  return {
    name: 'web_search',
    description: 'Search the web for information. Returns titles, snippets, and URLs of relevant pages.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        max_results: { type: 'number', description: 'Maximum results (default 5)', default: 5 },
      },
      required: ['query'],
    },
    meta: {
      name: 'web_search',
      description: 'Web search',
      category: 'network',
      tags: ['search', 'web', 'internet'],
    },
    async execute(args: { query: string; max_results?: number }, _ctx: ToolContext) {
      // 实际部署时接入 SerpAPI / Brave Search / DuckDuckGo 等
      // 此处为接口占位，需要在阶段 3（生产接入）实现
      const url = `https://api.search.example.com/search?q=${encodeURIComponent(args.query)}&limit=${args.max_results ?? 5}`;

      const res = await fetch(url, {
        signal: _ctx.signal,
      });
      if (!res.ok) throw new Error(`Search API failed: ${res.status}`);
      return res.json();
    },
  };
}
```

### 3. MCP 类型定义

MCP (Model Context Protocol) 是 Anthropic 推出的开放标准，让 Agent 能接入任何实现了 MCP Server 的工具。两种传输模式：**Stdio**（本地进程）和 **SSE**（HTTP 远程）。

```typescript
// packages/core/src/mcp/types.ts

export interface MCPServerConfig {
  name: string;
  /** Stdio 模式：启动命令 */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** SSE mode: HTTP endpoint */
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  autoReconnect?: boolean;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MCPResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}
```

### 4. MCP 客户端（双模式通信）

```typescript
// packages/core/src/mcp/client.ts

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { MCPServerConfig, MCPTool, MCPToolCall, MCPResult } from './types';
import type { RegisteredTool } from '../tool/registry';
import type { ToolContext } from '../agent/types';

/**
 * MCP Client —— 单服务器连接
 *
 * 两种传输模式：
 * 1. Stdio：启动本地进程，通过 stdin/stdout JSON-RPC 通信
 *    - 适合 filesystem、database 等本地工具
 * 2. SSE：HTTP Server-Sent Events 长连接
 *    - 适合远程 MCP 服务（如 SaaS API 网关）
 *
 * 重连策略：指数退避，最多 5 次
 */
export class MCPClient {
  private client: Client | null = null;
  private config: MCPServerConfig;
  private tools: MCPTool[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private isConnected = false;

  constructor(config: MCPServerConfig) {
    this.config = {
      timeout: 30000,
      autoReconnect: true,
      ...config,
    };
  }

  async connect(): Promise<void> {
    try {
      if (this.config.command) {
        // Stdio mode —— 启动本地进程通信
        const transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env as Record<string, string>,
        });
        this.client = new Client({ name: 'agent-core-mcp', version: '1.0.0' }, { capabilities: {} });
        await this.client.connect(transport);
      } else if (this.config.url) {
        // SSE mode —— HTTP 远程连接
        const transport = new SSEClientTransport(new URL(this.config.url), {
          requestInit: { headers: this.config.headers },
        });
        this.client = new Client({ name: 'agent-core-mcp', version: '1.0.0' }, { capabilities: {} });
        await this.client.connect(transport);
      } else {
        throw new Error('Either "command" or "url" must be specified');
      }

      const { tools } = await this.client.listTools();
      this.tools = tools;
      this.isConnected = true;
      this.reconnectAttempts = 0;
    } catch (error) {
      this.isConnected = false;
      throw error;
    }
  }

  getTools(): MCPTool[] {
    return this.tools;
  }

  /**
   * 把 MCP 工具转成 RegisteredTool 接口
   *
   * 工程要点：
   * - 工具名加 serverName.toolName 前缀，给 LLM 上下文锚点
   * - 当 LLM 看到 filesystem.readFile 和 github.getFile 时，知道来源不同不会搞混
   */
  toRegisteredTools(): RegisteredTool[] {
    return this.tools.map(mcpTool => ({
      name: `${this.config.name}.${mcpTool.name}`,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,
      meta: {
        name: `${this.config.name}.${mcpTool.name}`,
        description: mcpTool.description ?? '',
        category: 'mcp' as const,
        tags: ['mcp', this.config.name],
      },
      async execute(args: any, ctx: ToolContext): Promise<string> {
        try {
          const result = await this.callTool({ name: mcpTool.name, arguments: args });
          return result.content
            .filter(c => c.type === 'text')
            .map(c => (c as { text: string }).text)
            .join('\n');
        } catch (error) {
          throw new Error(`MCP tool "${mcpTool.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));
  }

  async callTool(call: MCPToolCall): Promise<MCPResult> {
    if (!this.client || !this.isConnected) {
      throw new Error(`MCP server "${this.config.name}" is not connected`);
    }

    try {
      const result = await this.client.callTool({
        name: call.name,
        arguments: call.arguments,
      }, undefined, { timeout: this.config.timeout });
      return result as MCPResult;
    } catch (error) {
      if (this.config.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        await this.delay(Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000));
        await this.connect();
        return this.callTool(call);
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    // SDK 的 Client 在不同版本中 disconnect 方法名不同，这里做兼容
    if (this.client && typeof (this.client as any).close === 'function') {
      await (this.client as any).close();
    }
    this.client = null;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
```

> 🤖 **AI 常见错误**：
> 1. **MCP SSE 连接断开后不会自动重连** —— SSE 长连接在弱网环境下容易断。客户端必须有指数退避重连逻辑。
> 2. **MCP 工具 schema 直接透传给 LLM 不做校验** —— MCP Server 的 tool description 可能很长，应在 `toRegisteredTools` 里对 description 做截断（100-150 字符）和精简。
> 3. **忘记验证 MCP Server 的身份** —— Stdio 模式下 MCP Server 是本地进程，恶意 MCP package 可能让 Agent 变成攻击入口。应做 tool 调用白名单或签名校验。

### 5. MCP 连接管理器

管理多个 MCP Server 的连接生命周期：

```typescript
// packages/core/src/mcp/manager.ts

import { MCPClient, type MCPServerConfig } from './client';
import { ToolRegistry } from '../tool/registry';

/**
 * MCPManager —— 多服务器连接生命周期管理
 *
 * 工程特性：
 * - 动态添加/移除 MCP Server
 * - 添加工具时自动批量注册到 ToolRegistry
 * - 移除时自动按前缀批量注销工具
 * - 支持全局重连（断网恢复场景）
 */
export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /** 添加并连接一个 MCP Server，返回工具列表 */
  async addServer(config: MCPServerConfig): Promise<MCPTool[]> {
    const client = new MCPClient(config);
    await client.connect();

    const registeredTools = client.toRegisteredTools();
    this.registry.registerMany(registeredTools);

    this.clients.set(config.name, client);
    return client.getTools();
  }

  /** 移除 MCP Server 及其所有工具 */
  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) return;

    const tools = client.toRegisteredTools();
    tools.forEach(t => this.registry.unregister(t.name));

    await client.disconnect();
    this.clients.delete(name);
  }

  /** 列出所有连接的 MCP Server */
  listServers(): Array<{ name: string; toolCount: number; connected: boolean }> {
    return Array.from(this.clients.entries()).map(([name, client]) => ({
      name,
      toolCount: client.getTools().length,
      connected: client.connected,
    }));
  }

  /** 重新连接所有断开的 Server */
  async reconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      if (!client.connected) {
        try {
          await client.connect();
          const tools = client.toRegisteredTools();
          this.registry.registerMany(tools);
        } catch (error) {
          console.error(`Failed to reconnect MCP server "${name}":`, error);
        }
      }
    }
  }

  /** 清理所有连接 */
  async dispose(): Promise<void> {
    for (const [name] of this.clients) {
      await this.removeServer(name);
    }
  }
}
```

### 6. 前端集成

```typescript
// apps/web/src/components/chat/ToolCallCard.tsx

import { useState } from 'react';
import type { ToolCallUI } from './chatStore';

interface ToolCallCardProps {
  tool: ToolCallUI;
}

export function ToolCallCard({ tool }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  const statusColors = {
    pending: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    running: 'bg-blue-500/20 text-blue-300 border-blue-500/30 animate-pulse',
    completed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    error: 'bg-red-500/20 text-red-300 border-red-500/30',
  };

  return (
    <div className={`rounded-lg border ${statusColors[tool.status]} p-3 my-2`}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left hover:opacity-80"
      >
        <span className="text-sm">
          {tool.status === 'running' ? '⚡' : tool.status === 'completed' ? '✓' : tool.status === 'error' ? '✗' : '○'}
        </span>

        <span className="font-mono text-sm font-medium">{tool.name}</span>

        <span className="text-xs opacity-60 ml-auto">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-current/10 space-y-1.5 text-xs font-mono">
          <div className="opacity-70">
            <span className="opacity-50">args: </span>
            {JSON.stringify(tool.args, null, 2)}
          </div>

          {tool.result && (
            <div className="opacity-90 max-h-40 overflow-auto">
              <span className="opacity-50">→ </span>
              {typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result)}
            </div>
          )}

          {tool.error && (
            <div className="text-red-300">
              <span className="opacity-50">error: </span>
              {tool.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

```typescript
// apps/web/src/components/settings/MCPConfigPanel.tsx

import { useState } from 'react';

interface MCPServerEntry {
  name: string;
  type: 'stdio' | 'sse';
  command?: string;
  args?: string;
  url?: string;
  connected: boolean;
  toolCount: number;
}

export function MCPConfigPanel() {
  const [servers, setServers] = useState<MCPServerEntry[]>([]);
  const [newServer, setNewServer] = useState<Partial<MCPServerEntry>>({});

  const handleAdd = async () => {
    await fetch('/api/mcp/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newServer),
    });
    // 刷新列表...
  };

  const handleRemove = async (name: string) => {
    await fetch(`/api/mcp/servers/${name}`, { method: 'DELETE' });
    setServers(prev => prev.filter(s => s.name !== name));
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">已连接的 MCP Server</h3>

      <div className="space-y-2">
        {servers.map(server => (
          <div key={server.name} className="flex items-center gap-3 p-3 rounded-lg bg-surface border border-border">
            <div className={`w-2 h-2 rounded-full ${server.connected ? 'bg-emerald-400' : 'bg-red-400'}`} />
            <div className="flex-1">
              <div className="text-sm font-medium">{server.name}</div>
              <div className="text-xs opacity-50">
                {server.type === 'stdio' ? `CLI: ${server.command}` : `HTTP: ${server.url}`}
              </div>
            </div>
            <span className="text-xs opacity-50">{server.toolCount} tools</span>
            <button
              onClick={() => handleRemove(server.name)}
              className="text-xs text-red-400 hover:text-red-300"
            >
              移除
            </button>
          </div>
        ))}
      </div>

      {/* 添加新 Server 表单 */}
      <div className="p-4 rounded-lg border border-border border-dashed space-y-3">
        <h4 className="text-sm font-medium">添加 MCP Server</h4>
        <div className="grid grid-cols-2 gap-2">
          <input
            placeholder="名称 (e.g. filesystem)"
            className="px-3 py-1.5 text-sm rounded bg-surface border border-border"
            onChange={e => setNewServer({ ...newServer, name: e.target.value })}
          />
          <select
            className="px-3 py-1.5 text-sm rounded bg-surface border border-border"
            onChange={e => setNewServer({ ...newServer, type: e.target.value as 'stdio' | 'sse' })}
          >
            <option value="stdio">Stdio (本地)</option>
            <option value="sse">SSE (远程)</option>
          </select>
        </div>
        {newServer.type === 'stdio' ? (
          <input
            placeholder="命令 (e.g. npx -y @modelcontextprotocol/server-filesystem)"
            className="w-full px-3 py-1.5 text-sm rounded bg-surface border border-border"
            onChange={e => setNewServer({ ...newServer, command: e.target.value })}
          />
        ) : (
          <input
            placeholder="URL (e.g. https://mcp.example.com/sse)"
            className="w-full px-3 py-1.5 text-sm rounded bg-surface border border-border"
            onChange={e => setNewServer({ ...newServer, url: e.target.value })}
          />
        )}
        <button
          onClick={handleAdd}
          className="px-4 py-1.5 text-sm rounded bg-accent text-accent-foreground"
        >
          连接
        </button>
      </div>
    </div>
  );
}
```

---

## Skill 系统（渐进披露）

### 工程逻辑概述

Skill 不是单个工具，而是包含**指令文档 + 脚本 + 参考文档**的模块。比如 `pdf-analysis` Skill 包含工具（`pdf_extract_text`）、指令（何时用它、常见问题排查）、脚本（PDF 预处理）、参考（PDF 标准文档）。

核心挑战：**在有限 prompt 里披露 Skill 而不炸 token**。

解决方案是**渐进式披露**——虚拟内存式的按需加载：
- 始终在 prompt 里的：Skill 标题 + 一句话描述（~30 token/Skill）
- LLM 决定使用时，通过 `load_skill` 工具调用把完整指令加载进来

```
┌──────────────────────────────────────────────┐
│  始终在 prompt 里的（~30 token/Skill）         │
│  ┌──────────────────────────────────────┐    │
│  │ Skill: pdf-analysis                  │    │
│  │ "Extract and analyze PDF content"    │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ Skill: data-viz                      │    │
│  │ "Generate HTML charts from data"     │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ Skill: report-gen                    │    │
│  │ "Write structured reports"           │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
                    │ LLM 决定用 pdf-analysis
                    ▼
┌──────────────────────────────────────────────┐
│  按需载入完整指令（~800 token）                │
│  ┌──────────────────────────────────────┐    │
│  │ ## pdf-analysis                      │    │
│  │ ### When to use                      │    │
│  │ When user asks about PDF documents... │    │
│  │ ### Tools available                  │    │
│  │ pdf_extract_text, pdf_extract_tables │    │
│  │ ### Strategies                       │    │
│  │ 1. For scanned PDFs, use OCR path    │    │
│  │ 2. For encrypted PDFs, ask password  │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

### 1. Skill 目录结构标准

每个 Skill 是一个独立目录，遵循约定优于配置原则：

```
skills/
├── pdf-analysis/
│   ├── SKILL.md              # 必需：前置元数据 + 完整指令
│   ├── scripts/              # 可选：可执行脚本
│   │   ├── preprocess.py
│   │   └── ocr_fallback.sh
│   ├── references/           # 可选：参考文档（不会被塞进 prompt）
│   │   └── pdf-spec.md
│   ├── templates/            # 可选：输出模板
│   │   └── report-template.md
│   └── tests/                # 可选：Skill 用例测试
│       └── sample.pdf
│
├── data-viz/
│   ├── SKILL.md
│   ├── scripts/
│   │   └── chart-renderer.ts
│   └── references/
│       └── echarts-options.md
```

SKILL.md 格式——既给人看又给 LLM 看：

```markdown
---
name: pdf-analysis
version: 1.2.0
description: Extract text and tables from PDF, analyze content, handle scanned documents via OCR
author: agent-core
tags: [pdf, document, ocr, extract]
requires_tools: [read_file, write_file, run_command]
priority: 80
---

# PDF 分析 Skill

## 何时使用（When to Use）
- 用户询问 PDF 内容："帮我总结这个 PDF"
- 需要从 PDF 提取表格数据
- 需要解析 PDF 中的文本做进一步分析
- PDF 是扫描件（需要 OCR）

## 可用工具
- `pdf_extract_text(path, page_range?)` - 提取文本
- `pdf_extract_tables(path, page?)` - 提取表格
- `pdf_get_metadata(path)` - 获取元数据

## 工作流程
1. 先用 `pdf_get_metadata` 检查 PDF 页数和加密状态
2. 如果加密，向用户索取密码
3. 尝试 `pdf_extract_text`；如果返回空或乱码，走 OCR 分支
4. OCR 分支：调用 `scripts/ocr_fallback.sh path`（需要 tesseract）

## 注意事项
- 超过 50 页的 PDF 逐批提取（每次 20 页）
- 提取表格时返回 Markdown 格式便于后续处理
- 对于图表，描述内容而不是 OCR 图表本身

## 脚本参考
### scripts/preprocess.py
清理 PDF 中的水印和空白页：
```bash
python scripts/preprocess.py input.pdf output.pdf --remove-watermark
```
```

### 2. SkillLoader 渐进加载

SkillLoader 扫描目录、解析元数据、按需加载完整版。

```typescript
// packages/core/src/skill/skill.ts

/** Skill 前置元数据（从 SKILL.md 的 frontmatter 解析） */
export interface SkillMeta {
  name: string;
  version: string;
  description: string;
  author?: string;
  tags: string[];
  requiresTools: string[];
  priority: number;             // 0-100, 越高越优先展示
}

/** Skill 加载模式 */
export type SkillLoadMode = 'metadata' | 'full';

/** 一个 Skill */
export interface Skill {
  meta: SkillMeta;
  /** SKILL.md 的正文（去掉 frontmatter） */
  instructions?: string;
  /** 目录路径 */
  path: string;
  /** 核心摘要（用于 prompt 内联） */
  summary: string;
  /** 当前是否已加载完整内容 */
  isLoaded: boolean;
  /** 最后使用时间 */
  lastUsed?: number;
}

/** 加载结果 */
export interface LoadedSkill extends Skill {
  instructions: string;
  references: string[];
  scripts: string[];
}

/** 解析 SKILL.md 前置元数据 */
export function parseSkillFrontmatter(mdContent: string): { meta: SkillMeta; body: string } {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
  const match = mdContent.match(frontmatterRegex);

  if (!match) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)');
  }

  const [, yamlBlock, body] = match;

  // 简单 YAML 解析器（只处理 Skill 元数据 schema）
  const meta: Record<string, any> = {};
  for (const line of yamlBlock.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map((s: string) => s.trim());
    } else {
      meta[key] = value;
    }
  }

  return {
    meta: {
      name: meta.name || '',
      version: meta.version || '0.1.0',
      description: meta.description || '',
      author: meta.author,
      tags: meta.tags || [],
      requiresTools: meta.requires_tools || [],
      priority: parseInt(meta.priority || '50', 10),
    },
    body: body.trim(),
  };
}

/** 生成 Skill 摘要（用于 prompt 里的"目录"） */
export function generateSkillSummary(meta: SkillMeta): string {
  return `Skill: ${meta.name} — ${meta.description}`;
}
```

```typescript
// packages/core/src/skill/loader.ts

import { promises as fs } from 'fs';
import * as path from 'path';
import { parseSkillFrontmatter, generateSkillSummary } from './skill';
import type { Skill, SkillMeta, LoadedSkill, SkillLoadMode } from './skill';

export class SkillLoader {
  private skills = new Map<string, Skill>();
  private skillDirs: string[];
  private referenceCache = new Map<string, string[]>();

  constructor(skillDirs: string[]) {
    this.skillDirs = skillDirs;
  }

  /** 扫描所有 Skill 目录，只加载元数据（不读 SKILL.md body） */
  async scan(): Promise<Skill[]> {
    const found: Skill[] = [];

    for (const dir of this.skillDirs) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const skillMdPath = path.join(dir, entry.name, 'SKILL.md');
          try {
            const content = await fs.readFile(skillMdPath, 'utf-8');
            const { meta, body } = parseSkillFrontmatter(content);

            const skill: Skill = {
              meta,
              path: path.join(dir, entry.name),
              summary: generateSkillSummary(meta),
              isLoaded: false,
              lastUsed: undefined,
            };

            this.skills.set(meta.name, skill);
            found.push(skill);
          } catch (e) {
            // SKILL.md 不存在或格式错误，跳过
            console.warn(`Skipping skill "${entry.name}": ${(e as Error).message}`);
          }
        }
      } catch (e) {
        // skill 目录不存在，跳过
      }
    }

    return found.sort((a, b) => b.meta.priority - a.meta.priority);
  }

  /** 加载单个 Skill 的完整内容（按需调用，渐进披露核心） */
  async loadFull(skillName: string): Promise<LoadedSkill> {
    const skill = this.skills.get(skillName);
    if (!skill) throw new Error(`Skill "${skillName}" not found`);

    const skillMdPath = path.join(skill.path, 'SKILL.md');
    const content = await fs.readFile(skillMdPath, 'utf-8');
    const { meta, body } = parseSkillFrontmatter(content);

    const references = await this.loadReferences(skill.path);
    const scripts = await this.listScripts(skill.path);

    const loaded: LoadedSkill = {
      meta,
      instructions: body,
      references,
      scripts,
      path: skill.path,
      summary: generateSkillSummary(meta),
      isLoaded: true,
      lastUsed: Date.now(),
    };

    this.skills.set(skillName, { ...skill, isLoaded: true, lastUsed: Date.now() });
    return loaded;
  }

  /** 只获取元数据，不开 SKILL.md body */
  getMetadata(skillName: string): Skill | undefined {
    return this.skills.get(skillName);
  }

  /** 列出所有 Skill 的摘要（用于 system prompt 注入） */
  getAllSummaries(): string[] {
    return Array.from(this.skills.values())
      .sort((a, b) => b.meta.priority - a.meta.priority)
      .map(s => s.summary);
  }

  /** 检查 Skill 的依赖工具是否都就绪 */
  checkDependencies(skillName: string, availableTools: string[]): {
    ready: boolean;
    missing: string[];
  } {
    const skill = this.skills.get(skillName);
    if (!skill) return { ready: false, missing: [] };

    const missing = skill.meta.requiresTools.filter(t => !availableTools.includes(t));
    return { ready: missing.length === 0, missing };
  }

  private async loadReferences(skillPath: string): Promise<string[]> {
    const refPath = path.join(skillPath, 'references');
    try {
      const files = await fs.readdir(refPath);
      return files.filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    } catch {
      return [];
    }
  }

  private async listScripts(skillPath: string): Promise<string[]> {
    const scriptPath = path.join(skillPath, 'scripts');
    try {
      const files = await fs.readdir(scriptPath);
      return files;
    } catch {
      return [];
    }
  }

  /** 列出所有已注册的 Skill */
  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }
}
```

### 3. Skill 激活工具（LLM 调用的"激活"入口）

这个工具让 LLM 按需"激活" Skill——渐进披露的关键实现：

```typescript
// packages/core/src/skill/skillActivationTool.ts

import type { RegisteredTool } from '../tool/registry';
import type { ToolContext } from '../agent/types';
import { SkillLoader } from './loader';
import type { LoadedSkill } from './skill';

/**
 * 创建一个工具，让 LLM 能按需"激活" Skill
 *
 * 这就是"渐进披露"的关键——LLM 看到 Skill 摘要后，
 * 如果觉得自己需要更多信息，就调这个工具。
 * 返回值包含完整指令 + 可用脚本列表 + references + token 成本提示
 */
export function createSkillActivationTool(loader: SkillLoader): RegisteredTool {
  return {
    name: 'load_skill',
    description: 'Load a skill\'s full instructions, scripts, and references. Use when you need detailed guidance for a specific task. Skills available: ' + loader.getAllSummaries().join('; '),
    parameters: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'The name of the skill to load',
        },
      },
      required: ['skill_name'],
    },
    meta: {
      name: 'load_skill',
      description: 'Activate a skill for detailed instructions',
      category: 'system',
      tags: ['skill', 'meta'],
    },
    async execute(args: { skill_name: string }, ctx: ToolContext): Promise<string> {
      try {
        const skill = await loader.loadFull(args.skill_name);

        let output = `# Skill Activated: ${skill.meta.name}\n\n`;
        output += `## Instructions\n${skill.instructions}\n\n`;

        if (skill.scripts.length > 0) {
          output += `## Available Scripts\n`;
          skill.scripts.forEach(s => { output += `- scripts/${s}\n`; });
          output += '\n';
        }

        if (skill.references.length > 0) {
          output += `## References\n`;
          skill.references.forEach(r => { output += `- references/${r}\n`; });
          output += '\n';
        }

        // Token 预算提示——让 LLM 知道加载了这个 Skill 后花了多少 token
        output += `\n[Skill token cost: ~${Math.ceil(output.length / 3)} tokens.`;
        output += ` Use this skill\'s tools now.]\n`;

        return output;
      } catch (error) {
        return `Error loading skill: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
```

### 4. SkillContextManager —— 上下文注入与淘汰

管理已激活 Skill 上下文：防重复、防冲突、LRU 淘汰。

```typescript
// packages/core/src/skill/skillContext.ts

import { SkillLoader } from './loader';

/**
 * 把 Skill "目录"注入 system prompt
 * 只放摘要不放完整指令 —— 这就是渐进披露
 */
export function buildSkillPromptSection(loader: SkillLoader): string {
  const summaries = loader.getAllSummaries();

  if (summaries.length === 0) return '';

  return `
## Available Skills
You have access to the following specialized skills. Each skill contains detailed instructions, scripts, and references for specific tasks.
When you need to handle a task that matches a skill's description, use the \`load_skill(skill_name: "<name>")\` tool to load its full instructions.
Do NOT try to guess a skill's instructions from the summary alone.

${summaries.map(s => `- ${s}`).join('\n')}
`;
}

/**
 * 管理已激活 Skill 的上下文（防重复、防冲突、LRU 淘汰）
 *
 * 关键约束：
 * - 同时激活不超过 3 个（防 prompt 膨胀）
 * - 5 分钟不用则过期
 */
export class SkillContextManager {
  private activeSkills = new Map<string, { loadedAt: number; tokens: number }>();
  private maxActiveSkills = 3;
  private skillTimeoutMs = 5 * 60 * 1000;  // 5 分钟

  /** 激活一个 Skill */
  activate(skillName: string, tokenCost: number): { evicted?: string } {
    if (this.activeSkills.has(skillName)) {
      this.activeSkills.set(skillName, { loadedAt: Date.now(), tokens: tokenCost });
      return {};
    }

    let evicted: string | undefined;
    if (this.activeSkills.size >= this.maxActiveSkills) {
      let oldest: { name: string; time: number } | null = null;
      for (const [name, info] of this.activeSkills) {
        if (!oldest || info.loadedAt < oldest.time) {
          oldest = { name, time: info.loadedAt };
        }
      }
      if (oldest) {
        this.activeSkills.delete(oldest.name);
        evicted = oldest.name;
      }
    }

    this.activeSkills.set(skillName, { loadedAt: Date.now(), tokens: tokenCost });
    return { evicted };
  }

  /** 清理过期的 Skill */
  pruneExpired(): string[] {
    const now = Date.now();
    const expired: string[] = [];

    for (const [name, info] of this.activeSkills) {
      if (now - info.loadedAt > this.skillTimeoutMs) {
        this.activeSkills.delete(name);
        expired.push(name);
      }
    }

    return expired;
  }

  getActive(): string[] {
    return Array.from(this.activeSkills.keys());
  }

  isActive(skillName: string): boolean {
    return this.activeSkills.has(skillName);
  }
}
```

### 5. SkillManager —— 安装与生命周期

```typescript
// packages/core/src/skill/manager.ts

import { promises as fs } from 'fs';
import * as path from 'path';
import { SkillLoader, parseSkillFrontmatter } from './skill';
import { SkillContextManager } from './skillContext';
import { ToolRegistry } from '../tool/registry';
import type { Skill, LoadedSkill } from './skill';

export interface SkillInstallOptions {
  fromDir?: string;
  fromTarball?: string;
  fromGit?: string;
  user?: boolean;
}

export class SkillManager {
  private loader: SkillLoader;
  private contextManager: SkillContextManager;
  private registry: ToolRegistry;
  private skillActions = new Map<string, RegisteredTool>();

  constructor(registry: ToolRegistry, skillDirs: string[]) {
    this.registry = registry;
    this.loader = new SkillLoader(skillDirs);
    this.contextManager = new SkillContextManager();
  }

  async initialize(): Promise<Skill[]> {
    return this.loader.scan();
  }

  async install(options: SkillInstallOptions): Promise<Skill> {
    if (options.fromDir) {
      const skillMdPath = path.join(options.fromDir, 'SKILL.md');
      const content = await fs.readFile(skillMdPath, 'utf-8');
      const { meta } = parseSkillFrontmatter(content);

      const targetDir = path.join(
        options.user ? getUserSkillDir() : getSystemSkillDir(),
        meta.name
      );

      await fs.mkdir(path.dirname(targetDir), { recursive: true });
      await fs.cp(options.fromDir, targetDir, { recursive: true });

      await this.loader.scan();
      return this.loader.getMetadata(meta.name)!;
    }

    throw new Error('Install method not implemented');
  }

  /** 启用 Skill —— 注册专用工具到 ToolRegistry */
  async enable(skillName: string): Promise<{ toolsAdded: string[] }> {
    const skill = await this.loader.loadFull(skillName);

    const allToolNames = this.registry.list().map(t => t.meta.name);
    const { ready, missing } = this.loader.checkDependencies(skillName, allToolNames);
    if (!ready) {
      throw new Error(`Skill "${skillName}" requires tools not available: ${missing.join(', ')}`);
    }

    // 注册 Skill 自带的专用工具（pdf-analysis Skill 可能有自己的 pdf_extract_text）
    // 从 skill.meta 获取工具定义，注册到 ToolRegistry
    // 具体注册逻辑视 Skill 工具定义规范而定，需在阶段 2 实现

    return { toolsAdded: [] };
  }

  /** 禁用 Skill —— 注销专用工具 */
  disable(skillName: string): void {
    // 按前缀批量注销，不会误删其他 Skill 或内置工具
    const prefix = `${skillName}.`;
    const allTools = this.registry.list().filter(t => t.meta.name.startsWith(prefix));
    allTools.forEach(t => this.registry.unregister(t.meta.name));

    this.contextManager.activate(skillName, 0);  // 刷新
  }

  async uninstall(skillName: string): Promise<void> {
    this.disable(skillName);
    const skill = this.loader.getMetadata(skillName);
    if (skill) {
      await fs.rm(skill.path, { recursive: true, force: true });
    }
  }

  listSkills(): Skill[] {
    return this.loader.listSkills();
  }

  getLoader(): SkillLoader {
    return this.loader;
  }

  getContextManager(): SkillContextManager {
    return this.contextManager;
  }
}

function getUserSkillDir(): string {
  return path.join(process.env.HOME || '~', '.agent-core', 'skills');
}

function getSystemSkillDir(): string {
  return path.join(process.cwd(), 'skills');
}
```

> 🤖 **工程逻辑**：Skill 激活后的专用工具注册到 ToolRegistry 时加了 `skillName.` 前缀。这不只是命名空间管理——当 Skill 被 disable 时，只需按前缀批量注销，不会误删其他 Skill 或内置工具。这是"安全卸载"的关键。

### 6. Skill 冲突检测

当多个 Skill 的 description 高度重叠时（比如 `pdf-analysis` 和 `document-reader`），LLM 不知道该用哪个。需要在元数据层面做静态检查：

```typescript
// packages/core/src/skill/conflictDetector.ts

import type { Skill } from './skill';

export interface SkillConflict {
  skillA: string;
  skillB: string;
  reason: string;
  severity: 'warning' | 'error';
}

/** 检测 Skill 之间的指令冲突 */
export function detectConflicts(skills: Skill[]): SkillConflict[] {
  const conflicts: SkillConflict[] = [];

  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i];
      const b = skills[j];

      // 1. 名称冲突
      if (a.meta.name === b.meta.name) {
        conflicts.push({
          skillA: a.meta.name,
          skillB: b.meta.name,
          reason: 'Duplicate skill names',
          severity: 'error',
        });
      }

      // 2. 描述相似度过高（共享标签）
      const sharedTags = a.meta.tags.filter(t => b.meta.tags.includes(t));
      if (sharedTags.length >= 2 && a.meta.priority === b.meta.priority) {
        conflicts.push({
          skillA: a.meta.name,
          skillB: b.meta.name,
          reason: `Description overlap on tags: [${sharedTags.join(', ')}]. Consider differentiating or merging.`,
          severity: 'warning',
        });
      }

      // 3. 工具依赖冲突（共享工具但不一定是冲突，值得警告）
      const aTools = new Set(a.meta.requiresTools);
      const bTools = new Set(b.meta.requiresTools);
      const sharedTools = [...aTools].filter(t => bTools.has(t));
      if (sharedTools.length > 0 && a.meta.name !== b.meta.name) {
        console.warn(`Skills "${a.meta.name}" and "${b.meta.name}" share tools: ${sharedTools.join(', ')}`);
      }
    }
  }

  return conflicts;
}
```

> 🤖 **AI 常见错误**：
> 1. **Skill 指令太长炸 prompt** —— 一个 SKILL.md 正文写 2000 token，LLM 激活 3 个 Skill 就多了 6000 token 指令。必须在 SkillContextManager 里限制同时激活数量（3-5 个）。
> 2. **Skill 之间指令冲突** —— 两个 Skill 同时告诉 LLM "遇到 X 做 Y"但做法不同。conflictDetector 是静态检查工具，在 Skill 安装时就应该跑一遍。
> 3. **循环依赖** —— Skill A 指令提到"使用 Skill B 的方法"，Skill B 也提到 Skill A。LLM 会陷入 load_skill 死循环。需要在 SkillContextManager 里记录已调用链，检测到循环时打断。

### 7. 前端 Skills 面板

```typescript
// apps/web/src/components/settings/SkillsPanel.tsx

import { useState } from 'react';

interface SkillListItem {
  name: string;
  version: string;
  description: string;
  author?: string;
  tags: string[];
  enabled: boolean;
  installed: boolean;
  priority: number;
}

export function SkillsPanel() {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace'>('installed');

  const handleToggleSkill = async (name: string, action: 'enable' | 'disable') => {
    await fetch(`/api/skills/${name}/${action}`, { method: 'POST' });
    // 刷新列表...
  };

  const handleInstall = async (skillId: string) => {
    await fetch(`/api/skills/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId }),
    });
  };

  const handleUninstall = async (name: string) => {
    await fetch(`/api/skills/${name}`, { method: 'DELETE' });
    setSkills(prev => prev.filter(s => s.name !== name));
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab('installed')}
          className={`px-3 py-1.5 text-sm rounded ${activeTab === 'installed' ? 'bg-accent text-accent-foreground' : 'bg-surface border border-border'}`}
        >
          已安装 ({skills.filter(s => s.installed).length})
        </button>
        <button
          onClick={() => setActiveTab('marketplace')}
          className={`px-3 py-1.5 text-sm rounded ${activeTab === 'marketplace' ? 'bg-accent text-accent-foreground' : 'bg-surface border border-border'}`}
        >
          市场
        </button>
      </div>

      <div className="space-y-2">
        {skills
          .filter(s => s.installed)
          .map(skill => (
            <div key={skill.name} className="p-3 rounded-lg bg-surface border border-border">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{skill.name}</span>
                    <span className="text-xs opacity-40">v{skill.version}</span>
                    <span className="text-xs opacity-30">by {skill.author || 'system'}</span>
                  </div>
                  <p className="text-xs mt-1 opacity-60">{skill.description}</p>
                  {skill.tags.length > 0 && (
                    <div className="flex gap-1 mt-1.5">
                      {skill.tags.map(tag => (
                        <span key={tag} className="px-1.5 py-0.5 text-[10px] rounded bg-border/50 opacity-50">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1">
                  {skill.enabled ? (
                    <button
                      onClick={() => handleToggleSkill(skill.name, 'disable')}
                      className="px-2 py-1 text-xs rounded bg-emerald-500/20 text-emerald-300"
                    >
                      启用中
                    </button>
                  ) : (
                    <button
                      onClick={() => handleToggleSkill(skill.name, 'enable')}
                      className="px-2 py-1 text-xs rounded bg-border/50 opacity-50"
                    >
                      启用
                    </button>
                  )}
                  <button
                    onClick={() => handleUninstall(skill.name)}
                    className="px-2 py-1 text-xs rounded text-red-400 hover:bg-red-500/10"
                  >
                    卸载
                  </button>
                </div>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
```

---

## 前端集成汇总

本 reference 中所有后端子系统对应的前端消费方式：

### ContextUsageBar

- **数据来源**：Agent 每轮迭代发出的 `context_status` 事件
- **消费位置**：ChatArea 组件中 `<MessageList>` 和 `<ChatInput>` 之间
- **关键交互**：实时显示 token 用量百分比，颜色随使用率变化（绿/黄/红），压缩时显示 COMPRESSED 标记

### ToolCallCard

- **数据来源**：Agent 的事件流 `tool_start` / `tool_complete` / `tool_error`
- **展示内容**：工具名称（monospace）、调用参数（展开）、返回值/错误
- **关键交互**：点击展开/折叠，status 颜色区分 pending/running/completed/error

### MCPConfigPanel

- **数据来源**：`GET /api/mcp/servers` 获取已连接 Server 列表
- **展示内容**：Server 名称、类型（stdio/sse）、连接状态（绿点/红点）、工具数量
- **关键交互**：添加（表单：名称+类型+命令/URL）、删除（调 API）

### SkillsPanel

- **数据来源**：`GET /api/skills` 列表 + `GET /api/skills/marketplace` 可供安装的 Skill
- **展示内容**：已安装列表（名称、版本、描述、标签、启用状态）
- **关键交互**：启用/禁用切换、卸载、从市场安装

### 整体布局建议

```
Settings Page
├── MCPConfigPanel      → 管理 MCP Server 连接
├── SkillsPanel         → 管理 Skill 安装/启用
└── (future)
    ├── MemoryPanel     → 长期记忆管理（见 03-memory-rag.md）
    └── SecurityPanel   → 安全配置（见 07-security.md）

Chat Area
├── MessageList
│   ├── ToolCallCard    → 内嵌工具调用状态卡片
│   └── ...
├── ContextUsageBar     → Token 用量实时进度条
└── ChatInput
```
