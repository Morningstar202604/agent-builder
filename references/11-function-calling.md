# 11 — Function Calling 统一抽象层 · Provider 适配 · 容错与审计

> Layer 2 进阶模块：模型对 function calling 的实现差异大（OpenAI JSON Mode、Anthropic tool_use、Gemini FunctionDeclaration），直接写会写出一堆 if-else。本节点实现请求/响应全链路归一化、多 Provider 格式转换、重试循环、并行调度、审计日志，以及前端 Tool Call Tracer 时间线视图。

---

## 目录

- [11.1 Agent 工具调用标准化架构](#111-agent-工具调用标准化架构)
- [11.2 多 Provider 工具调用适配](#112-多-provider-工具调用适配)
  - [OpenAI 格式适配](#openai-格式适配)
  - [Anthropic 格式适配](#anthropic-格式适配)
  - [Gemini 格式适配](#gemini-格式适配)
  - [Provider Adapter 统一接口](#provider-adapter-统一接口)
- [11.3 Tool Call Retry & Error Recovery](#113-tool-call-retry--error-recovery)
  - [参数校验失败重试](#参数校验失败重试)
  - [工具不存在处理](#工具不存在处理)
  - [JSON 截断修复](#json-截断修复)
  - [最大重试循环](#最大重试循环)
- [11.4 Parallel Tool Calls](#114-parallel-tool-calls)
  - [Promise.allSettled 实现](#promisesettled-实现)
  - [部分失败处理](#部分失败处理)
  - [并发限制](#并发限制)
- [11.5 工具调用审计日志](#115-工具调用审计日志)
- [11.6 AI 避坑](#116-ai-避坑)
- [11.7 前端：Tool Call Tracer](#117-前端tool-call-tracer)
  - [时间线视图](#时间线视图)
  - [耗时瀑布图](#耗时瀑布图)
- [11.8 本节点验收](#118-本节点验收)

---

## 11.1 Agent 工具调用标准化架构

工具调用全链路的归一化：不管底层是什么 Provider，Agent ReAct 循环只看到统一的 `ToolCallRequest → ToolCallResult` 流程。

```
┌──────────────────────────────────────────────────────────────┐
│                  Agent ReAct Loop                              │
│                        │                                      │
│            ┌───────────▼───────────┐                          │
│            │  ToolCallOrchestrator  │ ← 本节实现               │
│            │  ─────────────────    │                          │
│            │  normalizeRequest()   │ 为不同 Provider 生成请求  │
│            │  parseResponse()      │ 从不同响应提取统一结果     │
│            │  handleRetry()        │ 错误自动恢复               │
│            │  dispatchParallel()   │ 并行调度                   │
│            └───────────┬───────────┘                          │
│                        │                                      │
│         ┌──────────────┼──────────────┐                       │
│         ▼              ▼              ▼                       │
│   OpenAI Adapter  Anthropic Adapter  Gemini Adapter           │
│   (tool_call_delta)  (input_json_delta) (FunctionCall)        │
│         │              │              │                       │
│         └──────────────┼──────────────┘                       │
│                        ▼                                      │
│              Provider API 实际调用                              │
└──────────────────────────────────────────────────────────────┘
```

🔗 **工程逻辑**：为什么不在每个 LLMClient 实现里直接处理工具调用？因为 Provider A 和 Provider B 的工具调用格式转换逻辑是**独立的正交维度**——和流式解析、错误处理、retry 逻辑混在一起后，任何一方的格式变化都会影响另一方。把工具调用抽成独立的 Orchestrator 层，Provider 只需要关心"怎么把工具定义转成 API 格式"，retry 和并行调度则是通用的。

---

## 11.2 多 Provider 工具调用适配

### Provider Adapter 统一接口

```typescript
// packages/core/src/agent/tool-call-adapter.ts

import type { LLMToolDefinition } from '../llm/types';
import type { ToolContext } from './types';

/** 归一化的工具调用请求（发给 LLM 之前） */
export interface NormalizedToolRequest {
  tools: any[];                  // Provider-specific 格式
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  parallelToolCalls?: boolean;   // 是否允许并行调用
}

/** 归一化的工具调用结果（从 LLM 响应解析后） */
export interface NormalizedToolCall {
  id: string;                    // 回调 ID（必须与 LLM 返回的 ID 一致）
  name: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'executing' | 'completed' | 'error';
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface NormalizedToolResult {
  /** 本轮所有工具调用结果（有序） */
  calls: NormalizedToolCall[];
  /** 是否需要继续循环（有工具调用 = true） */
  shouldContinue: boolean;
  /** token usage 信息 */
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ToolCallAdapter {
  readonly provider: string;

  /**
   * 将统一的 LLMToolDefinition 列表转为 Provider-specific 格式
   */
  buildToolDefinitions(tools: LLMToolDefinition[]): any[];

  /**
   * 从原始 LLM 响应事件中提取工具调用
   *
   * 所有 Provider 最终都要产出 NormalizedToolCall[]，
   * 但路径不同：
   * - OpenAI: 流式 tool_call_delta 累积 → 聚合
   * - Anthropic: 非流式完整 tool_use block → 直接解析
   * - Gemini: FunctionCall event → 直接解析
   */
  parseToolCalls(rawResponse: any): NormalizedToolCall[];

  /**
   * 将工具执行结果编码为 Provider-specific 的消息格式
   *
   * 这决定了工具结果如何"回喂"给 LLM 做下一轮推理。
   * 不同 Provider 的 tool result 格式差异很大：
   * - OpenAI: { role: 'tool', tool_call_id, content }
   * - Anthropic: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
   * - Gemini: { functionResponse: { id, name, response: { result } } }
   */
  encodeToolResults(calls: NormalizedToolCall[]): any[];
}
```

### OpenAI 格式适配

```typescript
// packages/core/src/agent/adapters/openai-adapter.ts

import type { LLMToolDefinition, LLMToolCall } from '../../llm/types';
import type { ToolCallAdapter, NormalizedToolCall } from '../tool-call-adapter';

export class OpenAIAdapter implements ToolCallAdapter {
  readonly provider = 'openai-compatible';

  buildToolDefinitions(tools: LLMToolDefinition[]): any[] {
    return tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
  }

  /**
   * 解析 OpenAI 的 tool_calls 字段
   *
   * OpenAI 的 tool_calls 已经是完整结构（不是 delta），
   * 只有流式场景才需要 delta 累积。这里处理的是 stream 完成后的
   * 最终 tool_calls 数组。
   */
  parseToolCalls(rawResponse: { tool_calls?: LLMToolCall[] }): NormalizedToolCall[] {
    if (!rawResponse.tool_calls) return [];
    return rawResponse.tool_calls.map(tc => {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = { _raw: tc.function.arguments, _parseError: true };
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: args,
        status: 'pending' as const,
      };
    });
  }

  encodeToolResults(calls: NormalizedToolCall[]): any[] {
    return calls.map(tc => ({
      role: 'tool' as const,
      tool_call_id: tc.id,
      content: typeof tc.result === 'string'
        ? tc.result
        : JSON.stringify(tc.result ?? { error: tc.error }),
    }));
  }
}
```

### Anthropic 格式适配

```typescript
// packages/core/src/agent/adapters/anthropic-adapter.ts

import type { LLMToolDefinition } from '../../llm/types';
import type { ToolCallAdapter, NormalizedToolCall } from '../tool-call-adapter';

export class AnthropicAdapter implements ToolCallAdapter {
  readonly provider = 'anthropic';

  buildToolDefinitions(tools: LLMToolDefinition[]): any[] {
    return tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as any,  // Anthropic 用 input_schema 而非 parameters
    }));
  }

  /**
   * 解析 Anthropic 的 content blocks
   *
   * Anthropic 的响应中，-tool_use 类型的 content block 就是工具调用。
   * 注意：Anthropic 的 tool_use block 里的 input 字段已经是解析好的对象，
   * 不需要 JSON.parse。
   */
  parseToolCalls(rawResponse: { content?: Array<{ type: string; id?: string; name?: string; input?: any }> }): NormalizedToolCall[] {
    if (!rawResponse.content) return [];
    return rawResponse.content
      .filter(block => block.type === 'tool_use')
      .map(block => ({
        id: block.id ?? '',
        name: block.name ?? '',
        arguments: block.input ?? {},
        status: 'pending' as const,
      }));
  }

  encodeToolResults(calls: NormalizedToolCall[]): any[] {
    // Anthropic 要求工具结果放在 user role 里
    return [{
      role: 'user' as const,
      content: calls.map(tc => ({
        type: 'tool_result' as const,
        tool_use_id: tc.id,
        content: typeof tc.result === 'string'
          ? tc.result
          : JSON.stringify(tc.result ?? { error: tc.error }),
        is_error: tc.status === 'error',
      })),
    }];
  }
}
```

### Gemini 格式适配

```typescript
// packages/core/src/agent/adapters/gemini-adapter.ts

import type { LLMToolDefinition } from '../../llm/types';
import type { ToolCallAdapter, NormalizedToolCall } from '../tool-call-adapter';

export class GeminiAdapter implements ToolCallAdapter {
  readonly provider = 'gemini';

  buildToolDefinitions(tools: LLMToolDefinition[]): any[] {
    // Gemini 用 function_declarations 包装
    return [{
      function_declarations: tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as any,
      })),
    }];
  }

  /**
   * 解析 Gemini 的 functionCalls
   *
   * Gemini 的响应格式：
   * { candidates: [{ content: { parts: [{ functionCall: { name, args, id } }] } }] }
   * Gemini 的 args 字段已经是对象（Google Protocol Buffer 转换），不需要 JSON.parse。
   */
  parseToolCalls(rawResponse: {
    candidates?: Array<{ content?: { parts?: Array<{ functionCall?: { name: string; args: any; id?: string } }> } }>
  }): NormalizedToolCall[] {
    const calls: NormalizedToolCall[] = [];
    for (const candidate of rawResponse.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall) {
          calls.push({
            id: part.functionCall.id ?? `gemini_tc_${Date.now()}_${calls.length}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args ?? {},
            status: 'pending',
          });
        }
      }
    }
    return calls;
  }

  encodeToolResults(calls: NormalizedToolCall[]): any[] {
    return [{
      functionResponse: calls.map(tc => ({
        id: tc.id,
        name: tc.name,
        response: {
          result: tc.result ?? { error: tc.error },
        },
      })),
    }];
  }
}
```

### Adapter 工厂

```typescript
// packages/core/src/agent/adapters/factory.ts

import type { ToolCallAdapter } from '../tool-call-adapter';
import { OpenAIAdapter } from './openai-adapter';
import { AnthropicAdapter } from './anthropic-adapter';
import { GeminiAdapter } from './gemini-adapter';

export function createToolCallAdapter(provider: string): ToolCallAdapter {
  switch (provider) {
    case 'openai-compatible':
      return new OpenAIAdapter();
    case 'anthropic':
      return new AnthropicAdapter();
    case 'gemini':
      return new GeminiAdapter();
    default:
      // [MOCK] 默认走 OpenAI 兼容格式（大多数国产模型兼容 OpenAI API）
      return new OpenAIAdapter();
  }
}
```

---

## 11.3 Tool Call Retry & Error Recovery

### 三种典型错误场景

| 错误类型 | 表现 | 能否重试 |
|---------|------|---------|
| 参数校验失败 | 模型生成的参数不符合 JSON Schema | 能（把校验错误返回给 LLM 让它重新生成） |
| JSON 截断 | 流式输出中途 finish_reason=length | 能（提示 LLM 继续或重新输出） |
| 工具不存在 | 模型调用了未注册的工具名 | 不能（返回 not found 让 LLM 选别的工具） |
| 工具执行超时 | 工具内部卡死 | 不能重试同一参数（可能副作用已产生） |

```typescript
// packages/core/src/agent/tool-call-retry.ts

import type { NormalizedToolCall } from './tool-call-adapter';
import type { LLMToolDefinition } from '../llm/types';

/** 重试策略配置 */
export interface RetryConfig {
  /** 最大总重试轮数（不是单次工具重试，是"工具调用→错误→让 LLM 重新生成"的循环次数） */
  maxRetryRounds: number;
  /** 是否允许 JSON 截断修复（拼接不完整的 JSON） */
  enableJsonRepair: boolean;
  /** 参数校验失败时的错误消息模板 */
  validationErrorTemplate: string;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetryRounds: 3,
  enableJsonRepair: true,
  validationErrorTemplate: '参数验证失败：{detail}。请根据工具定义的 JSON Schema 修正参数。',
};

/** 工具调用错误分类 */
export type ToolCallError =
  | { type: 'VALIDATION'; toolName: string; detail: string }
  | { type: 'JSON_PARSE'; toolName: string; rawInput: string; detail: string }
  | { type: 'TOOL_NOT_FOUND'; toolName: string }
  | { type: 'TOOL_TIMEOUT'; toolName: string; timeoutMs: number }
  | { type: 'TOOL_EXECUTION'; toolName: string; detail: string };

/**
 * 工具调用重试引擎
 *
 * 核心逻辑：不是说"工具失败就重试工具"，而是
 * "工具失败了→把错误信息编码成 tool result 消息→让 LLM 在下一轮自己修正"。
 * 这才是 function calling 的正确用法——利用 LLM 的语言理解能力修正自己的错误。
 *
 * 工程注意：
 * - 最多 maxRetryRounds 轮（防死循环）
 * - 超时类错误不重试（副作用可能已发生）
 * - 每轮重试都完整记录到审计日志
 */
export class ToolCallRetryEngine {
  constructor(private config: RetryConfig = DEFAULT_RETRY_CONFIG) {}

  /**
   * 分类错误并决定是否需要重试循环
   *
   * @returns { retryable: true, errorResult: ... }  → 需要重试（返回错误给 LLM 让它改）
   * @returns { retryable: false, errorResult: ... } → 不可重试（直接返回错误）
   */
  handleError(error: ToolCallError, attemptNumber: number): {
    retryable: boolean;
    errorResult: { tool_call_id: string; content: string };
  } {
    const canRetry = attemptNumber < this.config.maxRetryRounds;

    switch (error.type) {
      case 'VALIDATION': {
        // 参数校验失败 → 让 LLM 修正参数的绝佳机会
        const content = this.config.validationErrorTemplate.replace('{detail}', error.detail);
        return {
          retryable: canRetry,
          errorResult: { tool_call_id: '', content },
        };
      }

      case 'JSON_PARSE': {
        // JSON 截断或格式错误 → 提示 LLM 工具调用格式出错
        if (this.config.enableJsonRepair && canRetry) {
          const repaired = this.attemptJsonRepair(error.rawInput);
          if (repaired) {
            // 修复成功不需要重试，直接返回修复后的参数
            return {
              retryable: false,  // 已修复，不需要再让 LLM 重来
              errorResult: {
                tool_call_id: '',
                content: JSON.stringify({ _repaired: true, _repairedArguments: repaired }),
              },
            };
          }
        }
        return {
          retryable: canRetry,
          errorResult: {
            tool_call_id: '',
            content: `工具 "${error.toolName}" 的参数 JSON 解析失败：${error.detail}。请确保输出合法 JSON。`,
          },
        };
      }

      case 'TOOL_NOT_FOUND':
        // 工具不存在 → LLM 幻觉了一个工具名，不可重试（重试还会幻觉同一个）
        return {
          retryable: false,
          errorResult: {
            tool_call_id: '',
            content: `工具 "${error.toolName}" 不存在。请从可用工具列表中选择。`,
          },
        };

      case 'TOOL_TIMEOUT':
        // 超时不可重试（副作用可能已发生）
        return {
          retryable: false,
          errorResult: {
            tool_call_id: '',
            content: `工具 "${error.toolName}" 执行超时（${error.timeoutMs}ms）。请简化输入或分批处理。`,
          },
        };

      case 'TOOL_EXECUTION':
        // 执行出错 → 可能是指令不合法，可重试
        return {
          retryable: canRetry,
          errorResult: {
            tool_call_id: '',
            content: `工具 "${error.toolName}" 执行出错：${error.detail}。`,
          },
        };
    }
  }

  /**
   * 尝试修复截断的 JSON
   *
   * 场景：模型输出的 JSON 字符串在 args 中间被截断
   * 策略：补全括号和引号（简易版，生产环境可用 jsonrepair 库）
   */
  private attemptJsonRepair(raw: string): Record<string, unknown> | null {
    if (!raw || raw.trim().length === 0) return null;

    // 策略 1：补全未闭合的括号和引号
    let repaired = raw.trim();
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    const openBrackets = (repaired.match(/\[/g) || []).length;
    const closeBrackets = (repaired.match(/\]/g) || []).length;

    // 去掉末尾逗号
    if (repaired.endsWith(',')) {
      repaired = repaired.slice(0, -1);
    }
    // 补全引号
    const quotes = (repaired.match(/"/g) || []).length;
    if (quotes % 2 !== 0) {
      repaired += '"';
    }
    // 补全方括号
    for (let i = 0; i < openBrackets - closeBrackets; i++) {
      repaired += ']';
    }
    // 补全花括号
    for (let i = 0; i < openBraces - closeBraces; i++) {
      repaired += '}';
    }

    try {
      return JSON.parse(repaired);
    } catch {
      return null;  // 修复失败，交给 LLM 重试
    }
  }
}
```

---

## 11.4 Parallel Tool Calls

### 为什么需要并行调度？

当一轮 ReAct 循环中 LLM 返回 3 个无依赖关系的工具调用（比如同时搜索天气、读取文件、查数据库），串行执行浪费时间。并行执行可以把总耗时从 T1+T2+T3 降低到 max(T1, T2, T3)。

🔗 **工程逻辑**：并行工具调用有前提——工具之间没有数据依赖。如果工具 B 的输入是工具 A 的输出，必须串行。LLM 有时会"自作主张"把有依赖的工具放在同一轮并行调用里——这时要么检测到依赖自动降级为串行，要么全部执行然后让 LLM 由处理乱序结果。当前实现选择后者（信任 LLM + maxRounds 兜底）。

### Promise.allSettled 实现

```typescript
// packages/core/src/agent/parallel-dispatcher.ts

import type { NormalizedToolCall } from './tool-call-adapter';
import type { ToolContext } from './types';
import type { ToolRegistry } from '../tool/registry';

export interface ParallelDispatchOptions {
  /** 最大并发数（防止一次调 10 个工具把下游打挂） */
  maxConcurrency: number;
  /** 是否允许部分失败（true = 失败的返回 error result） */
  allowPartialFailure: boolean;
  /** 整体超时（ms） */
  overallTimeout: number;
}

export const DEFAULT_PARALLEL_OPTIONS: ParallelDispatchOptions = {
  maxConcurrency: 5,
  allowPartialFailure: true,
  overallTimeout: 60000,
};

export interface DispatchResult {
  calls: NormalizedToolCall[];
  /** 是否有部分调用失败 */
  hasPartialFailure: boolean;
  /** 总耗时（从第一个工具开始到所有工具结束） */
  totalDurationMs: number;
}

export class ParallelToolDispatcher {
  constructor(private toolRegistry: ToolRegistry) {}

  /**
   * 并行执行多个工具调用
   *
   * 实现：使用 Promise.allSettled 而非 Promise.all。
   * Promise.all 在任一 reject 时直接抛错，导致其他成功的结果丢失。
   * Promise.allSettled 保证所有结果都能拿到。
   *
   * 并发控制：使用滑动窗口，超过 maxConcurrency 的工具排队等待。
   */
  async dispatch(
    calls: NormalizedToolCall[],
    ctx: ToolContext,
    options?: Partial<ParallelDispatchOptions>
  ): Promise<DispatchResult> {
    const opts = { ...DEFAULT_PARALLEL_OPTIONS, ...options };
    const start = Date.now();

    // 为每个调用更新状态为 executing
    for (const call of calls) {
      call.status = 'executing';
    }

    // 并发执行（带滑动窗口）
    const results = await this.runWithConcurrency(calls, ctx, opts.maxConcurrency, opts.overallTimeout);

    // 更新每个 call 的最终状态
    const finalCalls: NormalizedToolCall[] = [];
    let hasPartialFailure = false;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const call = calls[i];

      if (result.status === 'fulfilled') {
        call.status = 'completed';
        call.result = result.value;
      } else {
        call.status = 'error';
        call.error = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        hasPartialFailure = true;

        if (!opts.allowPartialFailure) {
          // 不允许部分失败 → 立即中断，把剩余调用都标为 skipped
          for (let j = i + 1; j < calls.length; j++) {
            calls[j].status = 'error';
            calls[j].error = 'Skipped due to earlier failure';
          }
          break;
        }
      }

      call.durationMs = Date.now() - start;
      finalCalls.push(call);
    }

    return {
      calls: finalCalls,
      hasPartialFailure,
      totalDurationMs: Date.now() - start,
    };
  }

  /**
   * 并发控制核心：滑动窗口
   *
   * 无论 calls 有多少个，同时只跑 maxConcurrency 个。
   * 和一个一个挨着执行不一样的地方在于：执行快的工具先完成后，
   * 排队中的工具立刻补位，不需要等最慢的那个先执行完。
   */
  private async runWithConcurrency(
    calls: NormalizedToolCall[],
    ctx: ToolContext,
    maxConcurrency: number,
    timeout: number
  ): Promise<PromiseSettledResult<unknown>[]> {
    const results: PromiseSettledResult<unknown>[] = new Array(calls.length);
    let nextIndex = 0;

    async function worker(this: ParallelToolDispatcher): Promise<void> {
      while (nextIndex < calls.length) {
        const i = nextIndex++;
        const call = calls[i];

        try {
          const result = await this.toolRegistry.execute(
            call.name,
            call.arguments,
            ctx,
            { timeout }
          );
          results[i] = { status: 'fulfilled', value: result };
        } catch (error) {
          results[i] = { status: 'rejected', reason: error };
        }
      }
    }

    const workerCount = Math.min(maxConcurrency, calls.length);
    const workers = Array.from({ length: workerCount }, () => worker.call(this));
    await Promise.all(workers);

    return results;
  }
}
```

### 部分失败的处理策略

```typescript
// packages/core/src/agent/parallel-dispatcher.ts（续）

/**
 * 对部分失败的工具结果，生成给 LLM 的反馈消息
 *
 * 成功和失败的调用返回同一个消息列表（保持顺序），
 * 但失败的调用在内容里标注 error 字段。
 * LLM 看到 error 后会选择重试或换一个工具。
 */
export function buildToolResultMessages(
  calls: NormalizedToolCall[],
  encodeAs: 'openai' | 'anthropic',
): any[] {
  return calls.map(tc => {
    const isError = tc.status === 'error';

    if (encodeAs === 'openai') {
      return {
        role: 'tool' as const,
        tool_call_id: tc.id,
        content: isError
          ? JSON.stringify({ error: tc.error, toolName: tc.name })
          : typeof tc.result === 'string'
            ? tc.result
            : JSON.stringify(tc.result),
      };
    } else {
      // Anthropic format
      return {
        role: 'user' as const,
        content: [{
          type: 'tool_result' as const,
          tool_use_id: tc.id,
          content: isError
            ? JSON.stringify({ error: tc.error, toolName: tc.name })
            : typeof tc.result === 'string'
              ? tc.result
              : JSON.stringify(tc.result),
          is_error: isError,
        }],
      };
    }
  });
}
```

---

## 11.5 工具调用审计日志

审计日志记录每次工具调用的完整上下文——谁在什么时间调了什么工具、耗时多少、结果多大、成功还是失败。这是生产环境排查的核心基础设施。

```typescript
// packages/core/src/agent/audit-logger.ts

import type { NormalizedToolCall } from './tool-call-adapter';

export interface AuditEntry {
  id: string;
  sessionId: string;
  agentName: string;
  iteration: number;
  toolName: string;
  toolCallId: string;
  argumentsSize: number;         // 参数字符串长度
  status: 'success' | 'error' | 'timeout';
  durationMs: number;
  resultSize: number;            // 结果字符串长度
  errorMessage?: string;
  timestamp: number;
  provider: string;              // 哪个 LLM Provider 发起的工具调用
}

export interface AuditQuery {
  sessionId?: string;
  toolName?: string;
  status?: 'success' | 'error' | 'timeout';
  from?: number;                 // 时间范围起始
  to?: number;                   // 时间范围截止
  limit?: number;
}

export class ToolCallAuditLogger {
  private entries: AuditEntry[] = [];

  /**
   * 记录一次工具调用
   *
   * 在工具执行完成后调用（不管成功还是失败）。
     * 同步入队，异步批量写入存储。
   */
  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    const full: AuditEntry = {
      ...entry,
      id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };
    this.entries.push(full);

    // [MOCK] 生产环境：
    // 方案 1：写入 PostgreSQL (audit_logs 表) — 支持 SQL 查询分析
    // 方案 2：写入 OpenTelemetry spans — 支持分布式追踪
    // 方案 3：写入 ClickHouse — 海量日志的聚合分析
    // 当前为内存存储，重启后丢失
  }

  /** 查询审计日志 */
  query(params: AuditQuery): AuditEntry[] {
    return this.entries
      .filter(e =>
        (!params.sessionId || e.sessionId === params.sessionId) &&
        (!params.toolName || e.toolName === params.toolName) ||
        (!params.status || e.status === params.status) ||
        (!params.from || e.timestamp >= params.from) ||
        (!params.to || e.timestamp <= params.to)
      )
      .slice(0, params.limit ?? 1000);
  }

  /**
   * 生成统计摘要（供前端面板展示）
   */
  getSummary(sessionId: string): {
    totalCalls: number;
    successRate: number;
    avgDurationMs: number;
    slowestTool: string;
    errorCount: number;
    totalExecutionTimeMs: number;
    toolBreakdown: Array<{ name: string; count: number; avgDurationMs: number; errorRate: number }>;
  } {
    const entries = this.entries.filter(e => e.sessionId === sessionId);
    if (entries.length === 0) {
      return {
        totalCalls: 0, successRate: 0, avgDurationMs: 0,
        slowestTool: '', errorCount: 0, totalExecutionTimeMs: 0,
        toolBreakdown: [],
      };
    }

    const successCount = entries.filter(e => e.status === 'success').length;
    const totalDuration = entries.reduce((sum, e) => sum + e.durationMs, 0);

    // 按工具名聚合
    const byTool = new Map<string, { count: number; totalMs: number; errors: number }>();
    for (const e of entries) {
      const existing = byTool.get(e.toolName) ?? { count: 0, totalMs: 0, errors: 0 };
      existing.count++;
      existing.totalMs += e.durationMs;
      if (e.status !== 'success') existing.errors++;
      byTool.set(e.toolName, existing);
    }

    const toolBreakdown = Array.from(byTool.entries()).map(([name, stats]) => ({
      name,
      count: stats.count,
      avgDurationMs: Math.round(stats.totalMs / stats.count),
      errorRate: stats.errors / stats.count,
    }));

    const slowest = toolBreakdown.sort((a, b) => b.avgDurationMs - a.avgDurationMs)[0];

    return {
      totalCalls: entries.length,
      successRate: successCount / entries.length,
      avgDurationMs: Math.round(totalDuration / entries.length),
      slowestTool: slowest?.name ?? '',
      errorCount: entries.length - successCount,
      totalExecutionTimeMs: totalDuration,
      toolBreakdown,
    };
  }
}
```

---

## 11.6 AI 避坑

> 🤖 **AI 常见错误**
>
> 1. **返回参数名写错（模型幻觉参数名）**：工具定义写 `file_path`，模型生成的 JSON 里写 `filePath` 或 `path`。这是 function calling 最高频的错误——模型经常自己"发明"参数名。
>    **解决方案**：在 ToolCallRetryEngine 里，当参数校验失败时，把"期望参数名"和"实际参数名"都放进错误消息里，让 LLM 看清楚了改。不要 silent fallback（比如""path"找不到就用 file_path"）——这会鼓励模型继续犯错。
>
> 2. **JSON 输出被截断**：大工具参数（比如写入一个大文件的内容）超过模型的 max_tokens 限制，`finish_reason = length`，JSON 字符串在 `}` 之前就断了。
>    **解决方案**：在 ToolCallRetryEngine.attemptJsonRepair() 里补全括号和引号。修复成功的直接用（免去一轮 LLM 重试的延迟），修复失败的把截断位置告诉 LLM 让它缩短输入。
>
> 3. **工具调用死循环（maxRounds 保护）**：LLM 调用工具 A → 工具 A 返回错误 → LLM 再次调用工具 A（用同样的参数）→ 循环。这是没有设置 `maxRetryRounds` 时的经典故障。
>    **解决方案**：两个维度保护——① ToolCallRetryEngine 限制单工具重试轮数（默认 3 轮）② AbstractAgent 限制总循环轮数（默认 10 轮）。双重保险。
>
> 4. **忘记处理 tool_call_id 导致消息顺序错乱**：第一轮 LLM 返回 tool_call_id = "tc_abc"，第二轮发送 tool result 时写错成了 tool_call_id = "tc_xyz"。OpenAI API 会报错或静默丢弃消息（取决于版本），导致推理上下文断裂。
>    **解决方案**：NormalizedToolCall.id 从 LLM 响应解析后直接透传给 encodeToolResults()，不在中间流程生成新的 ID。encodeToolResults 从 call.id 读取，不重新分配。
>
> 5. **并行乱序问题**：3 个工具并行执行，工具 A（快）先完成，工具 B（慢）后完成。但只要其中任何一个失败且 `allowPartialFailure=false`，已经被 A 执行完的副作用无法回滚。
>    **解决方案**：默认 `allowPartialFailure=true`。只有 HITL（参考 06-HITL）审批后才开启"事务模式"（allowPartialFailure=false）。工具返回结果里带 `_partialFailure: true` 标记，前端给用户提示。

---

## 11.7 前端：Tool Call Tracer

### 时间线视图

前端时间线展示每次工具调用的状态流转和耗时，是排查"为什么 Agent 卡在工具调用"的核心 UI。

```tsx
// apps/web/src/components/chat/ToolCallTracer.tsx

'use client';

import { useState } from 'react';

interface ToolCallTraceEntry {
  id: string;
  toolName: string;
  status: 'pending' | 'executing' | 'completed' | 'error';
  durationMs?: number;
  argsSize: number;
  resultSize?: number;
  errorMessage?: string;
  timestamp: number;
}

interface ToolCallTracerProps {
  calls: ToolCallTraceEntry[];
  /** 是否展开显示详细信息 */
  defaultExpanded?: boolean;
}

export function ToolCallTracer({ calls, defaultExpanded = false }: ToolCallTracerProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (calls.length === 0) return null;

  const totalDuration = calls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);
  const maxDuration = Math.max(...calls.map(c => c.durationMs ?? 1), 1);

  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-md bg-surface/50 border border-border">
      <div className="flex items-center gap-2 text-xs text-muted mb-1">
        <span className="font-medium">Tool Calls</span>
        <span>·</span>
        <span>{calls.length} 次调用</span>
        <span>·</span>
        <span>总耗时 {totalDuration}ms</span>
        <span>·</span>
        <span>{calls.filter(c => c.status === 'error').length} 个失败</span>
      </div>

      {calls.map(call => {
        const isExpanded = defaultExpanded || expanded.has(call.id);
        const barWidth = call.durationMs ? Math.max((call.durationMs / maxDuration) * 100, 5) : 0;
        const statusColor =
          call.status === 'completed' ? 'bg-emerald-500' :
          call.status === 'error' ? 'bg-red-500' :
          call.status === 'executing' ? 'bg-amber-500 animate-pulse' :
          'bg-border';

        return (
          <div key={call.id} className="group">
            {/* 一行摘要 */}
            <div
              className="flex items-center gap-2 text-xs cursor-pointer hover:bg-surface rounded px-1 py-0.5"
              onClick={() => toggle(call.id)}
            >
              {/* 耗时条形图 */}
              <div className="w-16 h-1.5 bg-border/50 rounded-full overflow-hidden flex-shrink-0">
                <div
                  className={`h-full ${statusColor} rounded-full transition-all`}
                  style={{ width: `${barWidth}%` }}
                />
              </div>

              {/* 工具名 */}
              <span className="font-mono text-accent whitespace-nowrap">{call.toolName}</span>

              {/* 状态 */}
              <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusColor}`} />

              {/* 耗时 */}
              <span className="text-muted tabular-nums">
                {call.durationMs != null ? `${call.durationMs}ms` : '...'}
              </span>

              {/* 展开箭头 */}
              <span className="text-muted ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
                {isExpanded ? '▲' : '▼'}
              </span>
            </div>

            {/* 展开详情 */}
            {isExpanded && (
              <div className="ml-4 mt-1 p-2 rounded bg-base/50 text-xs font-mono space-y-1">
                <div className="text-muted">ID: {call.id}</div>
                <div className="text-muted">参数大小: {call.argsSize} chars</div>
                {call.resultSize != null && (
                  <div className="text-muted">结果大小: {call.resultSize} chars</div>
                )}
                {call.errorMessage && (
                  <div className="text-red-400">错误: {call.errorMessage}</div>
                )}
                <div className="text-muted">
                  时间: {new Date(call.timestamp).toLocaleTimeString()}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

### 耗时瀑布图

```tsx
// apps/web/src/components/chat/ToolCallWaterfall.tsx

'use client';

interface WaterfallEntry {
  toolName: string;
  startOffsetMs: number;     // 相对第一批工具开始的时间偏移
  durationMs: number;
  status: 'completed' | 'error';
}

interface ToolCallWaterfallProps {
  entries: WaterfallEntry[];
}

/**
 * 工具调用耗时瀑布图
 *
 * X 轴为时间偏移，每条横线代表一个工具的执行区间。
 * 可以直观看出哪些工具是并行执行的（横线重叠）
 * 哪些是串行的（横线不重叠）。
 */
export function ToolCallWaterfall({ entries }: ToolCallWaterfallProps) {
  if (entries.length === 0) return null;

  const maxEnd = Math.max(...entries.map(e => e.startOffsetMs + e.durationMs));
  const rowHeight = 24;
  const height = entries.length * rowHeight + 20;
  const barMaxWidth = 300; // px

  return (
    <div className="border border-border rounded-lg bg-surface/30 overflow-hidden">
      <div className="px-3 py-1.5 text-xs text-muted border-b border-border font-medium">
        工具调用瀑布图
      </div>
      <div className="p-2 overflow-x-auto">
        <svg
          width={barMaxWidth + 80}
          height={height}
          className="text-xs"
        >
          {/* 网格线 */}
          {[0, 0.25, 0.5, 0.75, 1].map(ratio => (
            <line
              key={ratio}
              x1={70 + ratio * barMaxWidth}
              y2={height - 5}
              y1={10}
              stroke="currentColor"
              strokeOpacity={0.1}
            />
          ))}

          {entries.map((entry, i) => {
            const y = 10 + i * rowHeight;
            const x = 70 + (entry.startOffsetMs / maxEnd) * barMaxWidth;
            const width = Math.max((entry.durationMs / maxEnd) * barMaxWidth, 3);

            return (
              <g key={i}>
                {/* 工具名标签 */}
                <text x={0} y={y + 4} fill="currentColor" opacity={0.7} fontSize={10}>
                  {entry.toolName.length > 8 ? entry.toolName.slice(0, 8) + '..' : entry.toolName}
                </text>

                {/* 耗时条 */}
                <rect
                  x={x}
                  y={y - 6}
                  width={width}
                  height={12}
                  rx={3}
                  fill={entry.status === 'error' ? '#ef4444' : '#10b981'}
                  opacity={0.8}
                />

                {/* 耗时标签 */}
                <text
                  x={x + width + 4}
                  y={y + 4}
                  fill="currentColor"
                  opacity={0.5}
                  fontSize={9}
                >
                  {entry.durationMs}ms
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
```

### 在聊天 UI 中集成

```tsx
// apps/web/src/components/chat/ChatArea.tsx（扩展 — 添加 Tracer 渲染）

// 在 useAgentStream 的事件处理中，增加对审计日志事件的消费：
// case 'tool_audit_batch':
//   // 一轮工具调用完成后批量到达
//   setToolCallTraces(prev => [...prev, ...event.data.entries]);
//   break;

// 渲染位置：在 MessageList 下方、ContextUsageBar 上方
// {toolCallTraces.length > 0 && (
//   <ToolCallTracer calls={toolCallTraces} />
// )}
```

---

## 11.8 本节点验收

- [ ] ToolCallAdapter 接口统一了 OpenAI/Anthropic/Gemini 三种 Provider 的工具定义和结果编码
- [ ] ToolCallRetryEngine 能分类处理 VALIDATION / JSON_PARSE / TOOL_NOT_FOUND / TOOL_TIMEOUT / TOOL_EXECUTION 五类错误
- [ ] attemptJsonRepair() 能修复截断的 JSON 字符串（补全括号和引号）
- [ ] ParallelToolDispatcher 使用 Promise.allSettled + 滑动窗口并发控制（默认 maxConcurrency=5）
- [ ] buildToolResultMessages() 根据编码格式生成正确的 tool result 消息
- [ ] ToolCallAuditLogger 记录每次调用的完整上下文并支持按 session/tool/status 查询
- [ ] ToolCallSummary 给出成功率、平均耗时、最慢工具、错误率等统计指标
- [ ] 前端 ToolCallTracer 展示时间线视图（状态条形图 + 展开详情）
- [ ] 前端 ToolCallWaterfall SVG 瀑布图直观展示并行/串行调用模式
- [ ] tool_call_id 从解析到回喂全链路透传，不重新生成 ID
- [ ] maxRetryRounds 和 AbstractAgent.maxIterations 双重保护防死循环
