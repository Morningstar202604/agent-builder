# 24 产品化层 · Playground · 多模型路由 · 限流 · CI/CD · Agent-as-a-Service

> **⚠️ 不要重造以下东西：**
> - 多模型路由 → 用 **LiteLLM**（`litellm.completions()` + 代理模式），不要手写 Provider 路由表
> - Fallback 链 → 用 **LiteLLM** 的 `fallbacks` 配置，不要手写 retry+switch
> - Rate Limiting → 用 **速率限制中间件**（`express-rate-limit` / `hono-rate-limiter` + Redis Lua），不要手写 token bucket
> - CI/CD → 用 **GitHub Actions** 标准 workflow，不要手写 bash 部署
> - Webhook 验证 → 用 **svix**（HMAC-SHA256 签名验证库），不要手写
>
> 本 reference 的价值：产品化层的业务逻辑（Playground UI 定制、用户配额治理）是差异化的，但基础设施（路由、限流、CI/CD）一定用现成方案。**LiteLLM 解决模型层的一切问题，不要再写 model adapter。**

> 目标：把"能跑的 Agent 代码"变成"用户愿意每天用的产品"。本章覆盖五个产品化维度：Playground 交互界面、多模型智能路由、限流与配额治理、Webhook 事件系统、CI/CD 工程集成，以及 Agent-as-a-Service 的 REST/WebSocket API 架构。每一条都是"Demo 变产品"的必经之路。

---

## 目录

- [1. Playground Web UI](#1-playground-web-ui)
  - [1.1 为什么需要 Playground](#11-为什么需要-playground)
  - [1.2 三栏布局与状态管理](#12-三栏布局与状态管理)
  - [1.3 Token 实时计数器与成本估算](#13-token-实时计数器与成本估算)
  - [1.4 Compare Mode 双模型对比](#14-compare-mode-双模型对比)
  - [1.5 模型参数面板与快捷键](#15-模型参数面板与快捷键)
  - [1.6 会话历史 / 导入导出](#16-会话历史--导入导出)
- [2. 多模型路由（LiteLLM 模式）](#2-多模型路由litellm-模式)
  - [2.1 统一 Model 接口](#21-统一-model-接口)
  - [2.2 路由策略：Round-Robin / Cost-Aware / Latency-Aware](#22-路由策略round-robin--cost-aware--latency-aware)
  - [2.3 Fallback 链与自动降级](#23-fallback-链与自动降级)
  - [2.4 成本追踪与 Prompt Caching](#24-成本追踪与-prompt-caching)
  - [2.5 Vendor-Agnostic Tool Call 翻译](#25-vendor-agnostic-tool-call-翻译)
- [3. 限流与配额治理](#3-限流与配额治理)
  - [3.1 Token Bucket 应用层限流](#31-token-bucket-应用层限流)
  - [3.2 并发请求控制](#32-并发请求控制)
  - [3.3 成本预算告警](#33-成本预算告警)
  - [3.4 队列 + 超时模式](#34-队列--超时模式)
- [4. Webhook / 事件回调系统](#4-Webhook--事件回调系统)
  - [4.1 事件类型与 Schema](#41-事件类型与-schema)
  - [4.2 HMAC 签名验证](#42-hmac-签名验证)
  - [4.3 指数退避重试](#43-指数退避重试)
  - [4.4 事件存储与审计](#44-事件存储与审计)
- [5. CI/CD 工程集成](#5-cicd-工程集成)
  - [5.1 GitHub Actions: PR 审查 Bot](#51-github-actions-pr-审查-bot)
  - [5.2 Pre-commit 钩子](#52-pre-commit-钩子)
  - [5.3 Slack/Teams 通知](#53-slackteams-通知)
  - [5.4 定时任务调度](#54-定时任务调度)
- [6. Agent-as-a-Service 架构](#6-agent-as-a-service-架构)
  - [6.1 REST API 设计](#61-rest-api-设计)
  - [6.2 WebSocket 流式](#62-websocket-流式)
  - [6.3 认证与 API Key 管理](#63-认证与-api-key-管理)
  - [6.4 健康检查与 Prometheus Metrics](#64-健康检查与-prometheus-metrics)
- [7. 避坑汇总](#7-避坑汇总)
- [8. AI 常见错误](#8-ai-常见错误)

---

## 1. Playground Web UI

### 1.1 为什么需要 Playground

没有 Playground 的 Agent 产品只有两种用户：**开发者**和**付费企业客户**。Playground 是把"技术尝鲜者"转化为"活跃用户"的核心产品界面——用户在上面快速实验 prompt、对比模型、调整参数，最终"玩够了"才进入日常使用场景。

🔗 **工程逻辑**：Playground 不是"高级用户的玩具"，而是**产品的主入口**。ChatGPT 的爆发起点就是 playground.openai.com。它的核心价值是让用户在 5 分钟内体验到 Agent 的能力上限——没有 Playground，用户只能通过命令行或 API 才能体验，99% 的人不会走到那一步。

### 1.2 三栏布局与状态管理

Playground 的经典布局来自 OpenAI：左侧 system prompt 编辑器，中间对话/流式输出，右侧模型参数面板。这种布局让用户在**不切换页面**的情况下完成全部调试。

```typescript
// apps/web/src/components/playground/PlaygroundLayout.tsx

import React, { useCallback, useState, createContext, useContext } from 'react';
import { PlaygroundState, ModelConfig, Message } from '@/shared/types';
import { usePlaygroundStore } from '@/stores/playground';

/**
 * Playground 三栏布局：System Prompt | Chat | Parameters
 * 
 * 设计原则：
 * - 三栏可以在窄屏时折叠为单栏（responsive）
 * - 所有状态在 Zustand store 中，URL 可序列化（分享链接）
 * - 流式输出在中栏，左侧可继续编辑 system prompt（实验中途调整）
 */
export const PlaygroundLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [compareMode, setCompareMode] = useState(false);

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100 overflow-hidden">
      {/* 左侧栏：System Prompt 编辑器 + 模型选择 */}
      <aside
        className={`${
          sidebarOpen ? 'w-80' : 'w-0'
        } transition-all duration-300 border-r border-gray-800 flex-shrink-0 overflow-hidden`}
      >
        <SystemPromptPanel />
        <ModelSelector />
      </aside>

      {/* 中间主区域：Chat 流式输出 */}
      <main className="flex-1 flex flex-col min-w-0">
        <PlaygroundToolbar
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          onToggleRightPanel={() => setRightPanelOpen(!rightPanelOpen)}
          onToggleCompare={() => setCompareMode(!compareMode)}
        />

        {compareMode ? (
          <CompareView />
        ) : (
          <ChatView />
        )}
      </main>

      {/* 右侧栏：参数面板 */}
      <aside
        className={`${
          rightPanelOpen ? 'w-72' : 'w-0'
        } transition-all duration-300 border-l border-gray-800 flex-shrink-0 overflow-hidden`}
      >
        <ParametersPanel />
      </aside>
    </div>
  );
};

// ─── Chat 视图（单模型模式） ───

const ChatView: React.FC = () => {
  const { messages, isStreaming, sendMessage, abort } = usePlaygroundStore();
  const messagesEndRef = React.useRef<HTMLDivElement>(null);

  // 自动滚动到底部（流式输出时）
  React.useEffect(() => {
    if (isStreaming) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isStreaming]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {/* 流式输出中的"正在输入"指示器 */}
      {isStreaming && (
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <span className="animate-pulse">●</span>
          <span>模型正在生成…</span>
          <button
            onClick={abort}
            className="ml-2 px-2 py-0.5 text-xs bg-red-900/30 text-red-400 rounded hover:bg-red-900/50"
          >
            停止生成
          </button>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
};
```

### 1.3 Token 实时计数器与成本估算

Playground 必须让用户在发送前就知道"这次对话大概花多少钱"。tiktoken 是 OpenAI 官方 tokenizer，与后台计费完全一致，不是"估算"而是"镜像"。

```typescript
// apps/web/src/lib/tokenizer/tokenizer.ts

/**
 * 浏览器端 tokenizer。
 * 
 * 为什么用 WASM 版 tiktoken 而不是近似估算（字符数 / 4）：
 * - 中文每个字 1-3 token，英文每词 1-1.5 token，简单除以 4 误差 ±40%
 * - tiktoken WASM（@dqbd/tiktoken/lite）在浏览器端直接运行，精度 100%
 * - 对 playground 来说，精确数字决定用户是否愿意点击"发送"
 */
import { get_encoding, TiktokenEncoding } from '@dqbd/tiktoken/lite-init';
import cl100k_base from '@dqbd/tiktoken/encoders/cl100k_base.json';
import o200k_base from '@dqbd/tiktoken/encoders/o200k_base.json';

type EncodingName = 'cl100k_base' | 'o200k_base' | 'p50k_base';

// 模型 → 编码映射
const MODEL_TO_ENCODING: Record<string, EncodingName> = {
  'gpt-4o': 'o200k_base',
  'gpt-4o-mini': 'o200k_base',
  'gpt-4': 'cl100k_base',
  'gpt-3.5-turbo': 'cl100k_base',
  'claude-opus-4': 'cl100k_base',  // Claude 用 GPT tokenizer 近似
  'claude-sonnet-4': 'cl100k_base',
};

let encoderCache: Map<EncodingName, any> = new Map();

async function getEncoder(encoding: EncodingName) {
  if (encoderCache.has(encoding)) {
    return encoderCache.get(encoding)!;
  }

  let encoderData;
  switch (encoding) {
    case 'cl100k_base':
      encoderData = cl100k_base;
      break;
    case 'o200k_base':
      encoderData = o200k_base;
      break;
    default:
      encoderData = cl100k_base;
  }

  const enc = await get_encoding(encoding, encoderData);
  encoderCache.set(encoding, enc);
  return enc;
}

/**
 * 计算一条消息列表的 token 数量。
 * 
 * 每条消息有固定开销（special tokens）：OpenAI 每条消息 +3 tokens
 * 4 条消息就有 +12 tokens 的格式开销，长对话不能忽略。
 */
export async function countTokens(
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<number> {
  const encoding = MODEL_TO_ENCODING[model] ?? 'cl100k_base';
  const enc = await getEncoder(encoding);

  let totalTokens = 0;

  for (const msg of messages) {
    // 每条消息：角色标记 + 内容长度
    totalTokens += 3; // 消息格式固定开销
    totalTokens += enc.encode(msg.role).length;
    totalTokens += enc.encode(msg.content).length;
  }

  // 回复前缀（模型开始生成时自动添加的 special tokens）
  totalTokens += 3;

  return totalTokens;
}

// ─── 成本估算 Hook ───

// apps/web/src/hooks/useCostEstimate.ts

import { useDeferredValue, useMemo } from 'react';
import { countTokens } from '@/lib/tokenizer/tokenizer';

interface TokenPrice {
  input: number;   // $/1K tokens
  output: number;  // $/1K tokens
  cachedInput?: number; // $/1K cached tokens
}

const MODEL_PRICING: Record<string, TokenPrice> = {
  'gpt-4o':        { input: 0.005, output: 0.015, cachedInput: 0.0025 },
  'gpt-4o-mini':   { input: 0.00015, output: 0.0006, cachedInput: 0.000075 },
  'claude-sonnet-4': { input: 0.003, output: 0.015, cachedInput: 0.0003 },
  'claude-opus-4':   { input: 0.015, output: 0.075, cachedInput: 0.0015 },
};

export function useCostEstimate(
  messages: Array<{ role: string; content: string }>,
  model: string,
  estimatedOutputTokens = 500,
) {
  const deferredMessages = useDeferredValue(messages);

  return useMemo(async () => {
    const inputTokens = await countTokens(deferredMessages, model);
    const pricing = MODEL_PRICING[model] ?? { input: 0, output: 0 };

    const inputCost = (inputTokens / 1000) * pricing.input;
    const outputCost = (estimatedOutputTokens / 1000) * pricing.output;

    return {
      inputTokens,
      estimatedOutputTokens,
      totalTokens: inputTokens + estimatedOutputTokens,
      estimatedCost: inputCost + outputCost,
      formattedCost: `$${(inputCost + outputCost).toFixed(4)}`,
    };
  }, [deferredMessages, model, estimatedOutputTokens]);
}
```

```typescript
// apps/web/src/components/playground/TokenCounter.tsx

import React from 'react';
import { useCostEstimate } from '@/hooks/useCostEstimate';

/**
 * 实时 Token 计数器，位于 system prompt 编辑器底部。
 * 
 * 关键 UX：
 * - 用 useDeferredValue 避免每次输入都立即计算（debounce 效果）
 * - 超过模型 context 窗口时红色警告
 * - cost 显示精确到 $0.0001
 */
export const TokenCounter: React.FC<{
  messages: Array<{ role: string; content: string }>;
  model: string;
  maxContextTokens: number;
}> = ({ messages, model, maxContextTokens }) => {
  const estimate = useCostEstimate(messages, model);

  if (!estimate) return <div className="text-xs text-gray-500">计算中…</div>;

  const exceedsLimit = estimate.inputTokens > maxContextTokens;

  return (
    <div className="flex items-center justify-between px-3 py-1.5 text-xs border-t border-gray-800 bg-gray-900/50">
      <div className="flex items-center gap-3">
        <span className={exceedsLimit ? 'text-red-400 font-semibold' : 'text-gray-400'}>
          {estimate.inputTokens.toLocaleString()} / {maxContextTokens.toLocaleString()} tokens
          {exceedsLimit && ' ⚠️ 超出限制'}
        </span>
        <span className="text-gray-600">|</span>
        <span className="text-gray-400">
          预估输出: {estimate.estimatedOutputTokens} tokens
        </span>
      </div>
      <span className="text-green-400 font-mono">
        预估: {estimate.formattedCost}
      </span>
    </div>
  );
};
```

### 1.4 Compare Mode 双模型对比

OpenAI Playground 的杀手级功能——同一 prompt 同时发给两个模型，左右分屏实时对比。这是用户"选模型"的核心决策工具。

```typescript
// apps/web/src/components/playground/CompareView.tsx

import React, { useCallback, useRef, useState } from 'react';

/**
 * Compare Mode：同时向两个模型发送同一输入，左右分屏实时对比。
 * 
 * 实现要点：
 * - 两个 AbortController 独立，停止左边不影响右边
 * - 流式输出并行显示，用户可直观对比速度和质量差异
 * - 完成后显示两边 token 消耗和成本对比
 */
export const CompareView: React.FC = () => {
  const { systemPrompt, userInput, leftModel, rightModel } = usePlaygroundStore();

  const [leftOutput, setLeftOutput] = useState('');
  const [rightOutput, setRightOutput] = useState('');
  const [leftStats, setLeftStats] = useState<StreamStats | null>(null);
  const [rightStats, setRightStats] = useState<StreamStats | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  const leftAbortRef = useRef<AbortController | null>(null);
  const rightAbortRef = useRef<AbortController | null>(null);

  const handleCompare = useCallback(async () => {
    setLeftOutput('');
    setRightOutput('');
    setLeftStats(null);
    setRightStats(null);
    setIsStreaming(true);

    const leftController = new AbortController();
    const rightController = new AbortController();
    leftAbortRef.current = leftController;
    rightAbortRef.current = rightController;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInput },
    ];

    // 并行发起两个请求
    const leftPromise = streamCompareResponse(
      leftModel,
      messages,
      leftController.signal,
      (chunk) => setLeftOutput((prev) => prev + chunk),
      (stats) => setLeftStats(stats),
    );

    const rightPromise = streamCompareResponse(
      rightModel,
      messages,
      rightController.signal,
      (chunk) => setRightOutput((prev) => prev + chunk),
      (stats) => setRightStats(stats),
    );

    await Promise.allSettled([leftPromise, rightPromise]);
    setIsStreaming(false);
  }, [systemPrompt, userInput, leftModel, rightModel]);

  const handleAbort = () => {
    leftAbortRef.current?.abort();
    rightAbortRef.current?.abort();
    setIsStreaming(false);
  };

  return (
    <div className="flex-1 flex flex-col">
      {/* 中间输入区域 */}
      <div className="border-b border-gray-800 p-4">
        <textarea
          value={userInput}
          onChange={(e) => usePlaygroundStore.setState({ userInput: e.target.value })}
          placeholder="在此输入测试 prompt..."
          className="w-full h-24 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-500"
        />
        <div className="mt-2 flex justify-between items-center">
          <div className="flex items-center gap-4 text-sm">
            <span className="text-gray-400">左: <strong>{leftModel}</strong></span>
            <span className="text-gray-400">右: <strong>{rightModel}</strong></span>
          </div>
          <button
            onClick={isStreaming ? handleAbort : handleCompare}
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 rounded text-sm"
          >
            {isStreaming ? '停止' : '运行对比'}
          </button>
        </div>
      </div>

      {/* 双栏对比区域 */}
      <div className="flex-1 grid grid-cols-2 divide-x divide-gray-800">
        <StreamingPanel
          model={leftModel}
          content={leftOutput}
          stats={leftStats}
          isStreaming={isStreaming}
          onAbort={() => leftAbortRef.current?.abort()}
        />
        <StreamingPanel
          model={rightModel}
          content={rightOutput}
          stats={rightStats}
          isStreaming={isStreaming}
          onAbort={() => rightAbortRef.current?.abort()}
        />
      </div>
    </div>
  );
};

// ─── 单侧流式面板 ───

const StreamingPanel: React.FC<{
  model: string;
  content: string;
  stats: StreamStats | null;
  isStreaming: boolean;
  onAbort: () => void;
}> = ({ model, content, stats, isStreaming, onAbort }) => (
  <div className="flex flex-col min-w-0">
    <div className="px-3 py-2 text-xs text-gray-500 bg-gray-900/50 border-b border-gray-800 flex justify-between">
      <span>{model}</span>
      {stats && (
        <span className="font-mono">
          {stats.tokenCount} tokens · {stats.durationMs}ms · ${stats.cost.toFixed(4)}
        </span>
      )}
      {isStreaming && (
        <button onClick={onAbort} className="text-red-400 hover:text-red-300">
          停止
        </button>
      )}
    </div>
    <div className="flex-1 overflow-y-auto p-4 prose prose-invert prose-sm">
      <Markdown content={content} />
      {isStreaming && <span className="animate-pulse">▊</span>}
    </div>
  </div>
);
```

### 1.5 模型参数面板与快捷键

```typescript
// apps/web/src/components/playground/ParametersPanel.tsx

import React from 'react';
import { usePlaygroundStore } from '@/stores/playground';

/**
 * 右侧参数面板：Temperature / Top-P / Max Tokens / 模型选择。
 * 
 * 关键设计：
 * - 所有参数变化立即同步到 PlaygroundState，URL 可序列化
 * - 默认收起高级参数（Frequency Penalty、Presence Penalty），降低认知负担
 * - 快捷键 Ctrl+Enter 发送、Ctrl+Shift+C 切换 compare mode
 */
export const ParametersPanel: React.FC = () => {
  const params = usePlaygroundStore((s) => s.modelParams);
  const setParams = usePlaygroundStore((s) => s.setModelParams);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full text-sm">
      {/* 模型选择 */}
      <div>
        <label className="block text-xs text-gray-400 mb-1">模型</label>
        <ModelSelect
          value={params.model}
          onChange={(model) => setParams({ model })}
        />
      </div>

      {/* Temperature */}
      <SliderParam
        label="Temperature"
        value={params.temperature}
        min={0} max={2} step={0.1}
        onChange={(v) => setParams({ temperature: v })}
        description="越高越随机，越低越确定"
      />

      {/* Top-P */}
      <SliderParam
        label="Top-P"
        value={params.topP}
        min={0} max={1} step={0.05}
        onChange={(v) => setParams({ topP: v })}
        description="核采样：从概率累加达到 p 的最小 token 集合中采样"
      />

      {/* Max Tokens */}
      <div>
        <label className="block text-xs text-gray-400 mb-1">最大输出 Token</label>
        <input
          type="number"
          value={params.maxTokens}
          onChange={(e) => setParams({ maxTokens: parseInt(e.target.value) || 0 })}
          min={1} max={128000}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs"
        />
      </div>

      {/* System Prompt Token 预算指示 */}
      <div className="pt-2 border-t border-gray-800">
        <label className="block text-xs text-gray-400 mb-2">上下文使用</label>
        <ContextUsageBar used={params.currentContextTokens} max={params.maxContextTokens} />
      </div>

      {/* 高级参数 */}
      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-xs text-blue-400 hover:text-blue-300"
      >
        {showAdvanced ? '▲ 收起高级参数' : '▼ 更多参数'}
      </button>

      {showAdvanced && (
        <>
          <SliderParam
            label="Frequency Penalty"
            value={params.frequencyPenalty ?? 0}
            min={-2} max={2} step={0.1}
            onChange={(v) => setParams({ frequencyPenalty: v })}
            description="惩罚已出现的 token，降低重复生成"
          />
          <SliderParam
            label="Presence Penalty"
            value={params.presencePenalty ?? 0}
            min={-2} max={2} step={0.1}
            onChange={(v) => setParams({ presencePenalty: v })}
            description="惩罚是否出现过（不管次数），鼓励新话题"
          />
        </>
      )}
    </div>
  );
};
```

```typescript
// apps/web/src/hooks/usePlaygroundKeyboard.ts

import { useEffect } from 'react';

/**
 * Playground 全局快捷键。
 * 
 * - Ctrl/Cmd + Enter：发送消息
 * - Ctrl/Cmd + Shift + C：切换 compare mode
 * - Escape：停止流式输出
 * - Ctrl/Cmd + /：聚焦输入框
 */
export function usePlaygroundKeyboard() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const metaKey = e.ctrlKey || e.metaKey;

      if (metaKey && e.key === 'Enter') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('[data-send-button]')?.click();
      }

      if (metaKey && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        usePlaygroundStore.getState().toggleCompareMode();
      }

      if (e.key === 'Escape') {
        usePlaygroundStore.getState().abort();
      }

      if (metaKey && e.key === '/') {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>('[data-prompt-input]')?.focus();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
```

### 1.6 会话历史 / 导入导出

```typescript
// apps/web/src/lib/conversation/export.ts

import { Conversation } from '@/shared/types';

/**
 * ShareGPT 格式导出。
 * 
 * ShareGPT 是事实上的标准格式，兼容：
 * - OpenAI Playground 导入
 * - 各类模型训练工具（Axolotl、Firefly）
 * - 其他 Agent 项目
 * 
 * 格式：{ "conversations": [{"from": "human"|"gpt", "value": "..."}] }
 */
export function exportToShareGPT(conversation: Conversation): string {
  const shareGPTFormat = {
    id: conversation.id,
    conversations: conversation.messages
      .filter((m) => m.role !== 'system') // ShareGPT 不包含系统提示
      .map((m) => ({
        from: m.role === 'user' ? 'human' : 'gpt',
        value: m.content,
      })),
  };

  return JSON.stringify(shareGPTFormat, null, 2);
}

/**
 * 导出为 Markdown（人类可读）：
 * 
 * 适用于写报告、文档归档、团队分享。
 */
export function exportToMarkdown(conversation: Conversation): string {
  const lines: string[] = [];

  lines.push(`# ${conversation.title || 'Agent 对话'}`);
  lines.push(`> 创建时间: ${conversation.createdAt.toISOString()}`);
  lines.push(`> 模型: ${conversation.model}`);
  lines.push('---');
  lines.push('');

  for (const msg of conversation.messages) {
    if (msg.role === 'system') {
      lines.push('## System');
      lines.push(msg.content);
    } else if (msg.role === 'user') {
      lines.push('## User');
      lines.push(msg.content);
    } else if (msg.role === 'assistant') {
      lines.push('## Assistant');
      lines.push(msg.content);

      // 工具调用信息
      if (msg.toolCalls?.length) {
        lines.push('');
        lines.push('**工具调用:**');
        for (const tc of msg.toolCalls) {
          lines.push(`- \`${tc.name}\`: ${JSON.stringify(tc.arguments)}`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 导入 ShareGPT 格式会话。
 */
export function importFromShareGPT(json: string): Partial<Conversation> {
  const data = JSON.parse(json);

  if (!data.conversations || !Array.isArray(data.conversations)) {
    throw new Error('无效的 ShareGPT 格式：缺少 conversations 数组');
  }

  return {
    messages: data.conversations.map((c: { from: string; value: string }) => ({
      id: crypto.randomUUID(),
      role: c.from === 'human' ? 'user' : 'assistant',
      content: c.value,
      createdAt: new Date(),
    })),
  };
}
```

---

## 2. 多模型路由（LiteLLM 模式）

### 2.1 统一 Model 接口

不同模型供应商的 SDK 调用方式、错误码、返回格式完全不同。如果业务代码直接调用各家 SDK，换模型等于重写调用层。

🔗 **工程逻辑**：LiteLLM 的核心洞察——**你的应用不应该知道用的是哪家模型**。对内统一接口，对外只暴露 `/v1/chat/completions`。要加新模型？在配置里加一项，不改业务代码。这跟数据库里用 ORM 不用原生 SQL 是同一个抽象逻辑。

```typescript
// packages/core/src/model-router/types.ts

/**
 * 统一的模型接口——所有模型都实现这个契约。
 * 
 * 通过这个接口，上层业务完全不需要知道"这个请求发给了 OpenAI 还是 Anthropic"。
 * 新增模型供应商只需实现 LLMProvider 接口，配置里注册即可。
 */
export interface LLMProvider {
  /** 供应商名称：openai | anthropic | azure | bedrock | vertex */
  readonly provider: string;

  /** 模型ID，如 gpt-4o / claude-sonnet-4 */
  readonly model: string;

  /** 是否支持流式 */
  readonly supportsStreaming: boolean;

  /** 最大 context token */
  readonly maxContextTokens: number;

  /** 是否支持工具调用 */
  readonly supportsToolUse: boolean;

  /** 是否支持 Prompt Caching */
  readonly supportsPromptCaching: boolean;

  /** 单次调用（非流式） */
  complete(
    request: UnifiedRequest,
    options?: CallOptions,
  ): Promise<UnifiedResponse>;

  /** 流式调用 */
  stream(
    request: UnifiedRequest,
    options?: CallOptions,
  ): AsyncIterable<StreamChunk>;
}

// ─── 统一的请求/响应格式 ───

export interface UnifiedRequest {
  messages: UnifiedMessage[];
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  tools?: UnifiedToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string };
  stopSequences?: string[];
  systemPrompt?: string;

  /** 路由提示：可选的优先级和成本预算 */
  routingHint?: RoutingHint;
}

export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolCallId?: string; // tool 角色时使用
  cacheControl?: { type: 'ephemeral' }; // Anthropic cache 标记
}

export interface ContentBlock {
  type: 'text' | 'image_url' | 'tool_result';
  text?: string;
  imageUrl?: { url: string; detail?: 'low' | 'high' };
}

export interface UnifiedResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;  // Anthropic cached input
    cacheWriteTokens?: number;
  };
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  /** 本次调用实际成本（美元） */
  cost: number;
  /** 实际供应商和模型 */
  actualProvider: string;
  actualModel: string;
  /** 延迟 */
  latencyMs: number;
}

export interface StreamChunk {
  id: string;
  type: 'content' | 'tool_call' | 'tool_result' | 'error' | 'done';
  delta?: string;
  toolCallDelta?: { id: string; name: string; arguments: string };
  usage?: UnifiedResponse['usage'];
  finishReason?: string;
}
```

### 2.2 路由策略：Round-Robin / Cost-Aware / Latency-Aware

```typescript
// packages/core/src/model-router/router.ts

import { LLMProvider, UnifiedRequest, RoutingHint } from './types';

/**
 * 多模型路由器。
 * 
 * 三种路由策略：
 * 1. round-robin：轮流使用，打散负载
 * 2. cost-aware：优先用便宜模型，按任务难度升档
 * 3. latency-aware：选最近 5 分钟平均延迟最低的模型
 * 
 * 路由决策在请求级别进行，允许用户通过 routingHint 强制指定模型。
 */
export class ModelRouter {
  private providers: Map<string, LLMProvider> = new Map();
  private strategy: RoutingStrategy;
  private roundRobinIndex = 0;

  /** 延迟统计：每模型最近 N 次调用的延迟 */
  private latencyStats: Map<string, number[]> = new Map();

  constructor(strategy: RoutingStrategy = 'cost-aware') {
    this.strategy = strategy;
  }

  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.model, provider);
    this.latencyStats.set(provider.model, []);
  }

  /**
   * 根据策略选择最佳模型。
   * 
   * @param request 用户请求（含可选 routingHint）
   * @returns 选中的 Provider
   */
  async selectProvider(request: UnifiedRequest): Promise<LLMProvider> {
    // 用户显式指定模型时直接返回
    if (request.routingHint?.forceModel) {
      const provider = this.providers.get(request.routingHint.forceModel);
      if (!provider) {
        throw new ModelNotFoundError(request.routingHint.forceModel);
      }
      return provider;
    }

    // 预算限制：只考虑单价低于预算的模型
    const candidates = this.getBudgetCandidates(request.routingHint?.maxCostPerCall);

    if (candidates.length === 0) {
      throw new NoAvailableProviderError('没有符合预算的可用模型');
    }

    switch (this.strategy) {
      case 'round-robin':
        return this.roundRobinSelect(candidates);
      case 'cost-aware':
        return this.costAwareSelect(candidates, request);
      case 'latency-aware':
        return this.latencyAwareSelect(candidates);
      default:
        return candidates[0];
    }
  }

  /**
   * Cost-Aware 路由逻辑：
   * - 分析 prompt 特征（长度、关键词、工具数量）估算"难度"
   * - 低难度（短 prompt、无工具）→ 优先便宜模型
   * - 高难度（推理、多步工具调用）→ 升级到旗舰模型
   */
  private costAwareSelect(
    candidates: LLMProvider[],
    request: UnifiedRequest,
  ): LLMProvider {
    const difficulty = this.estimateDifficulty(request);

    // 按价格从低到高排序
    const sorted = [...candidates].sort(
      (a, b) => a.costPerInputToken - b.costPerInputToken,
    );

    if (difficulty > 0.7) {
      // 高难度：选最贵的（通常是最好的）
      return sorted[sorted.length - 1];
    } else if (difficulty > 0.4) {
      // 中等难度：选中间价位的
      return sorted[Math.floor(sorted.length / 2)];
    } else {
      // 低难度：选最便宜的
      return sorted[0];
    }
  }

  /**
   * 简单难度估算（无需 LLM 调用）。
   * 
   * 实际项目里可加更多信号：用户历史转化率、任务分类标签等。
   */
  private estimateDifficulty(request: UnifiedRequest): number {
    let score = 0;
    const totalContent = request.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join(' ');

    // 信号1：prompt 长度
    if (totalContent.length > 10000) score += 0.3;
    else if (totalContent.length > 3000) score += 0.15;

    // 信号2：工具数量（多工具 = 复杂任务）
    if ((request.tools?.length ?? 0) >= 3) score += 0.3;

    // 信号3：关键词启发
    const hardKeywords = ['证明', '推导', '多步', 'agent', '重构', '调试', 'optimize'];
    if (hardKeywords.some((k) => totalContent.includes(k))) score += 0.2;

    return Math.min(score, 1.0);
  }

  /**
   * Latency-Aware：选最近 5 分钟平均延迟最低的。
   */
  private latencyAwareSelect(candidates: LLMProvider[]): LLMProvider {
    let best = candidates[0];
    let bestLatency = Infinity;

    for (const provider of candidates) {
      const stats = this.latencyStats.get(provider.model) ?? [];
      if (stats.length === 0) return provider; // 无数据时先用起来
      const avg = stats.reduce((a, b) => a + b, 0) / stats.length;
      if (avg < bestLatency) {
        bestLatency = avg;
        best = provider;
      }
    }

    return best;
  }

  /** 记录延迟，用于后续路由决策 */
  recordLatency(model: string, latencyMs: number): void {
    const stats = this.latencyStats.get(model) ?? [];
    stats.push(latencyMs);
    // 只保留最近 100 次
    if (stats.length > 100) stats.shift();
    this.latencyStats.set(model, stats);
  }
}

type RoutingStrategy = 'round-robin' | 'cost-aware' | 'latency-aware';
```

### 2.3 Fallback 链与自动降级

```typescript
// packages/core/src/model-router/fallback.ts

/**
 * Fallback 链：主模型失败时自动切换到备用模型。
 * 
 * 失败类型决定降级策略：
 * - 429 Rate Limit → 立即切换到备用模型
 * - 503 Service Unavailable → 立即切换
 * - 400 Bad Request（如 context 超长）→ 不切换，直接返回错误（切换也救不了）
 * - 504 Timeout → 切换，但用更短的超时
 * 
 * 关键点：fallback 不能无限重试。
 * 默认配置：primary → backup1 → backup2，超过 3 次切换就放弃。
 */
export class FallbackExecutor {
  constructor(
    private router: ModelRouter,
    private maxFallbackDepth: number = 3,
  ) {}

  async execute(
    request: UnifiedRequest,
    onProviderSwitch?: (
      from: string,
      to: string,
      reason: string,
    ) => void,
  ): Promise<UnifiedResponse> {
    const fallbackChain = this.buildFallbackChain(request);
    let lastError: Error | null = null;

    for (let i = 0; i < Math.min(fallbackChain.length, this.maxFallbackDepth); i++) {
      const provider = fallbackChain[i];

      try {
        const response = await provider.complete(request, {
          timeoutMs: this.getTimeoutForDepth(i, request.routingHint?.timeoutMs),
        });

        // 如果降级了，在响应里标记，让前端可以提示用户
        if (i > 0) {
          (response as any).wasDegraded = true;
          (response as any).originalModel = request.model;
        }

        return response;
      } catch (error) {
        lastError = error as Error;

        // 判断是否值得切换
        if (!this.shouldFallback(error, provider)) {
          throw error; // 不可恢复的错误，直接抛出
        }

        const nextProvider = fallbackChain[i + 1];
        onProviderSwitch?.(provider.model, nextProvider?.model ?? 'none', error.message);

        // 速率限制时，等待一段时间再切
        if (error instanceof RateLimitError && error.retryAfterMs > 0) {
          await sleep(Math.min(error.retryAfterMs, 5000));
        }

        this.router.recordLatency(provider.model, Date.now());
      }
    }

    throw new FallbackExhaustedError(
      `所有模型均失败（尝试 ${Math.min(fallbackChain.length, this.maxFallbackDepth)} 个）`,
      lastError!,
    );
  }

  /**
   * 构建 fallback 链：用户指定模型 → 同厂商备选 → 跨厂商兜底
   */
  private buildFallbackChain(request: UnifiedRequest): LLMProvider[] {
    const chain: LLMProvider[] = [];

    // 1. 用户请求的模型（primary）
    const primary = this.router.getProvider(request.model);
    chain.push(primary);

    // 2. 同厂商备选（如 gpt-4o 失败 → gpt-4o-mini）
    const sameProviderBackup = this.router.getBackupInProvider(
      primary.provider,
      request.model,
    );
    if (sameProviderBackup) chain.push(sameProviderBackup);

    // 3. 跨厂商兜底（最后一道防线）
    const crossProviderFallback = this.router.getCrossProviderFallback(request.model);
    if (crossProviderFallback) chain.push(crossProviderFallback);

    return chain;
  }

  /**
   * 判断一个错误是否值得触发 fallback。
   */
  private shouldFallback(error: unknown, provider: LLMProvider): boolean {
    if (error instanceof RateLimitError) return true;
    if (error instanceof ServiceUnavailableError) return true;
    if (error instanceof TimeoutError) return true;
    if (error instanceof ServerError && error.statusCode >= 500) return true;

    // 客户端错误（400、401、403）不应该 fallback——切换也救不了
    if (error instanceof ClientError) return false;

    return false;
  }
}

/** 自定义错误类型 */

class RateLimitError extends Error {
  constructor(public retryAfterMs: number) {
    super('Rate limited');
  }
}
class ServiceUnavailableError extends Error {}
class TimeoutError extends Error {}
class ServerError extends Error {
  constructor(public statusCode: number) { super(); }
}
class ClientError extends Error {}
class ModelNotFoundError extends Error {
  constructor(model: string) { super(`Model not found: ${model}`); }
}
class NoAvailableProviderError extends Error {}
class FallbackExhaustedError extends Error {
  constructor(msg: string, public cause: Error) { super(msg); }
}
```

### 2.4 成本追踪与 Prompt Caching

```typescript
// packages/core/src/model-router/cost-tracker.ts

/**
 * 实时成本追踪器。
 * 
 * 关键指标：
 * - 每请求成本（actual cost）
 * - 累计 spend → 与 budget 对比
 * - Cache hit ratio → prompt caching 效果
 * - 按模型/用户/时间维度切分（用于计费报表）
 * 
 * 数据来源：每次 LLM 调用后记录的 usage 和实际价格。
 */
export class CostTracker {
  constructor(
    private redis: Redis,
    private alertThreshold: number = 0.8, // 80% budget 时告警
  ) {}

  /**
   * 记录一次 LLM 调用的成本。
   */
  async record(params: {
    tenantId: string;
    userId: string;
    model: string;
    provider: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    cost: number;
    requestType: 'chat' | 'tool_call' | 'agent' | 'eval';
  }): Promise<void> {
    const {
      tenantId, userId, model, provider, usage, cost, requestType,
    } = params;
    const now = new Date();
    const hour = now.toISOString().slice(0, 13); // "2026-01-15T14"
    const day = now.toISOString().slice(0, 10);

    // 使用 Redis pipeline 批量写入，减少 RTT
    const pipeline = this.redis.pipeline();

    // 1. 全局累计
    pipeline.incrbyfloat(`spend:total`, cost);

    // 2. 按租户累计
    pipeline.incrbyfloat(`spend:tenant:${tenantId}:${day}`, cost);

    // 3. 按用户累计
    pipeline.incrbyfloat(`spend:user:${userId}:${day}`, cost);

    // 4. 按模型累计
    pipeline.incrbyfloat(`spend:model:${model}:${hour}`, cost);

    // 5. Request count
    pipeline.incr(`count:${tenantId}:${day}`);

    // 6. Token 累计（用于缓存命中率分析）
    pipeline.incrby(`tokens:input:${tenantId}:${day}`, usage.inputTokens);
    pipeline.incrby(`tokens:output:${tenantId}:${day}`, usage.outputTokens);
    if (usage.cacheReadTokens) {
      pipeline.incrby(`tokens:cache_read:${tenantId}:${day}`, usage.cacheReadTokens);
    }

    // 7. 写入时序数据（用于 cost 趋势图）
    pipeline.xadd(
      `events:cost:${tenantId}`,
      'MAXLEN', '~', 10000,
      '*',
      'cost', cost.toString(),
      'model', model,
      'type', requestType,
    );

    await pipeline.exec();

    // 8. 检查预算告警（异步，不阻塞主流程）
    this.checkBudgetAlert(tenantId, day).catch(console.error);
  }

  /**
   * 获取缓存命中率。
   * 
   * 命中率 = cache_read_tokens / (cache_read_tokens + input_tokens)
   * 健康值 > 60%。低于 30% 说明 system prompt 每次在变，或缓存 TTL 太短。
   */
  async getCacheHitRatio(tenantId: string, day: string): Promise<number> {
    const [cacheRead, input] = await Promise.all([
      this.redis.get(`tokens:cache_read:${tenantId}:${day}`),
      this.redis.get(`tokens:input:${tenantId}:${day}`),
    ]);

    const cacheReadNum = parseInt(cacheRead ?? '0');
    const inputNum = parseInt(input ?? '0');
    const total = cacheReadNum + inputNum;

    return total === 0 ? 0 : cacheReadNum / total;
  }

  /** 检查预算告警 */
  private async checkBudgetAlert(tenantId: string, day: string): Promise<void> {
    const [spend, budget] = await Promise.all([
      this.redis.get(`spend:tenant:${tenantId}:${day}`),
      this.redis.get(`budget:daily:${tenantId}`),
    ]);

    const spendNum = parseFloat(spend ?? '0');
    const budgetNum = parseFloat(budget ?? '0');

    if (budgetNum > 0 && spendNum / budgetNum >= this.alertThreshold) {
      await this.fireAlert({
        tenantId,
        type: 'budget_warning',
        spend: spendNum,
        budget: budgetNum,
        ratio: spendNum / budgetNum,
      });
    }
  }
}
```

### 2.5 Vendor-Agnostic Tool Call 翻译

```typescript
// packages/core/src/model-router/tool-translator.ts

/**
 * OpenAI ↔ Anthropic Tool Call Schema 翻译器。
 * 
 * OpenAI 格式：
 * { "tool_calls": [{ "function": { "name": "...", "arguments": "{...}" } }] }
 * 
 * Anthropic 格式：
 * { "content_block": { "type": "tool_use", "id": "...", "name": "...", "input": {...} } }
 * 
 * 关键差异：
 * - OpenAI 的 arguments 是 JSON 字符串，Anthropic 的 input 是对象
 * - Anthropic 有多个 cache breakpoint，可以缓存 system + tools + 部分消息
 * - OpenAI 用 string ID（call_xxx），Anthropic 也用 string ID（toolu_xxx）
 */
export class ToolCallTranslator {
  /**
   * 把统一格式的 tool 定义翻译为 OpenAI 格式。
   */
  static toOpenAI(tools: UnifiedToolDefinition[]): OpenAIToolFormat[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /**
   * 把统一格式的 tool 定义翻译为 Anthropic 格式。
   * 
   * 注意：Anthropic 支持 cache_control 标记，对长工具定义列表可以缓存。
   */
  static toAnthropic(
    tools: UnifiedToolDefinition[],
    enableCache = true,
  ): AnthropicToolFormat[] {
    const anthropicTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    // 如果在 tools 列表末尾加 cache breakpoint，
    // Anthropic 会缓存 tool definitions（高达 4 个 breakpoint）
    if (enableCache && anthropicTools.length > 0) {
      (anthropicTools as any[])[anthropicTools.length - 1].cache_control = {
        type: 'ephemeral',
      };
    }

    return anthropicTools;
  }

  /**
   * 把 OpenAI 格式的 tool call 翻译为统一格式。
   */
  fromOpenAI(message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }): ToolCall[] {
    return (message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments), // OpenAI 传的是字符串，需要解析
    }));
  }

  /**
   * 把 Anthropic 格式的 tool call 翻译为统一格式。
   */
  fromAnthropic(blocks: AnthropicContentBlock[]): ToolCall[] {
    return blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: (b as any).id,
        name: (b as any).name,
        arguments: (b as any).input, // Anthropic 已经是对象了，不需要 JSON.parse
      }));
  }

  /**
   * 处理 Anthropic 多 cache breakpoint 场景。
   * 
   * Anthropic 最大允许 4 个 cache breakpoints，通常设置在：
   * 1. System prompt 末尾
   * 2. 第一个 complex tool definition 末尾
   * 3. 第一个 few-shot example 末尾
   * 4. 末尾消息
   * 
   * 返回的消息已经按 breakpoints 插入了 cache_control 标记。
   */
  static applyCacheBreakpoints(
    messages: UnifiedMessage[],
    systemPrompt: string,
    tools: UnifiedToolDefinition[],
  ): { system: any[]; messages: UnifiedMessage[] } {
    // System prompt 缓存
    const systemBlocks: any[] = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];

    // Tools 缓存
    const toolsWithCache = [...tools];
    if (toolsWithCache.length > 0) {
      toolsWithCache[toolsWithCache.length - 1] = {
        ...toolsWithCache[toolsWithCache.length - 1],
        cacheControl: { type: 'ephemeral' },
      };
    }

    return { system: systemBlocks, messages };
  }
}
```

---

## 3. 限流与配额治理

### 3.1 Token Bucket 应用层限流

🔗 **工程逻辑**：LLM API 提供商的限流是针对你整个账户的——一个高频用户可以吃掉整个团队的 RPM/TPM 配额。**必须**在应用层加按用户/按租户的二次限流。否则：用户 A 刷 1000 RPM 导致用户 B 收到 429，体验极差且不可排查。

```typescript
// packages/core/src/rate-limit/token-bucket.ts

/**
 * 基于 Redis 的分布式 Token Bucket 限流器。
 * 
 * 为什么不用固定窗口计数器：
 * - 固定窗口在窗口边界会有"突刺"——第一秒最后 1ms 和下一秒第一 ms 等于 1ms 内进了 2 倍配额
 * - Token bucket 平滑了这个问题，允许控制令牌注入速率
 * 
 * 三个限流维度（每个维度独立计算）：
 * 1. RPM (Requests Per Minute)：请求次数
 * 2. Input TPM (Tokens Per Minute)：输入 token 数
 * 3. Output TPM：输出 token 数（通过 usage 回调事后扣减）
 */
export class TokenBucketRateLimiter {
  constructor(
    private redis: Redis,
    private config: RateLimitConfig,
  ) {}

  /**
   * 尝试消费一个配额。
   * 
   * @param key 限流 key（如 "user:abc123" 或 "tenant:org-xyz"）
   * @param tokens 请求的 token 数（input 预估）
   * @returns 是否允许，如不允许返回需要等待的毫秒数
   */
  async tryConsume(
    key: string,
    tokens: number,
  ): Promise<RateLimiterResult> {
    const now = Date.now();
    const second = Math.floor(now / 1000);

    // 使用 Redis + Lua 脚本保证原子性
    // Key 结构：
    // {key}:rpm — 已用请求数（按秒重置）
    // {key}:tokens — 已用 input tokens（按秒重置）
    const luaScript = `
      local rpm_key = KEYS[1]
      local tokens_key = KEYS[2]
      local rpm_limit = tonumber(ARGV[1])
      local tokens_limit = tonumber(ARGV[2])
      local requested_tokens = tonumber(ARGV[3])
      local ttl = tonumber(ARGV[4])
      local now_ts = tonumber(ARGV[5])

      -- 计算窗口起始时间（60 秒窗口）
      local window = math.floor(now_ts / 60) * 60

      -- 检查 RPM
      local current_rpm = redis.call('GET', rpm_key .. ':' .. window)
      if current_rpm and tonumber(current_rpm) >= rpm_limit then
        return {0, 0, rpm_limit - tonumber(current_rpm)}
      end

      -- 检查 Token 配额
      local current_tokens = redis.call('GET', tokens_key .. ':' .. window)
      if current_tokens and tonumber(current_tokens) + requested_tokens > tokens_limit then
        local remaining = tokens_limit - tonumber(current_tokens)
        return {1, remaining, 0} --  tokens 维度失败
      end

      -- 通过：增加计数
      redis.call('INCR', rpm_key .. ':' .. window)
      redis.call('EXPIRE', rpm_key .. ':' .. window, ttl)

      if requested_tokens > 0 then
        redis.call('INCRBY', tokens_key .. ':' .. window, requested_tokens)
        redis.call('EXPIRE', tokens_key .. ':' .. window, ttl)
      end

      return {2, 0, 0} -- 成功
    `;

    const result = await this.redis.eval(
      luaScript,
      2, // 2 keys
      `ratelimit:rpm:${key}`,
      `ratelimit:tokens:${key}`,
      this.config.rpmPerUser,
      this.config.tokensPerMinute,
      tokens,
      120, // TTL: 2 分钟
      Math.floor(now / 1000),
    ) as [number, number, number];

    const [status, tokenRemaining, rpmRemaining] = result;

    if (status === 2) {
      return { allowed: true, retryAfterMs: 0 };
    } else if (status === 0) {
      // RPM 超限
      const retryAfterMs = this.calculateRetryAfter('rpm', 'user');
      return {
        allowed: false,
        retryAfterMs,
        reason: 'rate_limit_rpm',
        message: `每分钟请求数已达上限 (${this.config.rpmPerUser})。请等待 ${Math.ceil(retryAfterMs / 1000)} 秒后重试。`,
      };
    } else {
      // Token 超限
      const retryAfterMs = this.calculateRetryAfter('tokens', 'user');
      return {
        allowed: false,
        retryAfterMs,
        reason: 'rate_limit_tokens',
        message: `每分钟输入 token 配额已用完（剩余 ${tokenRemaining}）。请等待 ${Math.ceil(retryAfterMs / 1000)} 秒后重试。`,
      };
    }
  }

  /**
   * 事后扣减：拿到 LLM 响应后，用实际 output tokens 调整配额。
   * 
   * 因为 output token 在请求前无法预知（即使 max_tokens 限制了上限，实际产出也远低于上限）。
   * 这里用"退款"机制：请求时按 max_tokens 预留，响应后按实际 output tokens 结算差额。
   */
  async refundOutputTokens(
    key: string,
    estimatedTokens: number,
    actualTokens: number,
  ): Promise<void> {
    const diff = estimatedTokens - actualTokens;
    if (diff <= 0) return;

    const second = Math.floor(Date.now() / 1000);
    const window = Math.floor(second / 60) * 60;
    await this.redis.decrby(
      `ratelimit:output:${key}:${window + 60}`, // 下一个窗口
      diff,
    );
  }

  private calculateRetryAfter(
    dimension: 'rpm' | 'tokens' | 'concurrent',
    scope: 'user' | 'tenant' | 'global',
  ): number {
    // 简化：返回当前窗口剩余时间的估算
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / 60) * 60;
    return (windowStart + 60 - now) * 1000;
  }
}

interface RateLimitConfig {
  rpmPerUser: number;          // 每用户每分钟请求数
  tokensPerMinute: number;     // 每用户每分钟 input tokens 上限
  outputTokensPerMinute: number;
  concurrentPerUser: number;   // 每用户最多同时发起的请求数
}

interface RateLimiterResult {
  allowed: boolean;
  retryAfterMs: number;
  reason?: string;
  message?: string;
}
```

### 3.2 并发请求控制

```typescript
// packages/core/src/rate-limit/concurrency-limiter.ts

/**
 * 并发请求信号量。
 * 
 * 为什么需要：假设每用户限 10 RPM，如果用户快速发 10 个请求，
 * 模型还在处理第一个时，2-10 号请求已经被接受（RPM 维度通过了）。
 * 此时 10 个并发请求同时打向 LLM API，可能触发 RPM/TPM 的双重超限。
 * 
 * 并发限制确保：同一用户的请求串行或有限并发。
 */
export class ConcurrencyLimiter {
  constructor(
    private redis: Redis,
    private defaultMaxConcurrent = 3,
  ) {}

  /**
   * 尝试获取一个并发槽位。
   * 
   * 使用 Redis INCR + EXPIRE 实现分布式信号量。
   * 返回 release 函数，调用方必须在使用完后调用。
   */
  async acquire(
    userId: string,
    maxConcurrent?: number,
  ): Promise<{ release: () => Promise<void>; acquired: boolean }> {
    const max = maxConcurrent ?? this.defaultMaxConcurrent;
    const key = `concurrent:${userId}`;

    const current = await this.redis.incr(key);

    if (current === 1) {
      // 首次：初始化 TTL（防止进程崩溃后永远占用槽位）
      await this.redis.expire(key, 30); // 30s 内必须完成或续期
    }

    if (current > max) {
      // 超限：减回去，返回失败
      await this.redis.decr(key);
      return {
        acquired: false,
        release: async () => { /* no-op */ },
      };
    }

    // 续期机制：如果请求快要超了，自动延长 TTL
    const renewInterval = setInterval(async () => {
      const ttl = await this.redis.ttl(key);
      if (ttl < 10) {
        await this.redis.expire(key, 30);
      }
    }, 5000);

    return {
      acquired: true,
      release: async () => {
        clearInterval(renewInterval);
        await this.redis.decr(key);
      },
    };
  }
}
```

### 3.3 成本预算告警

```typescript
// packages/core/src/rate-limit/budget-guard.ts

/**
 * 每日成本硬上限。
 * 
 * 典型场景：SaaS 产品为每租户设置日预算 $10。
 * 当租户的累计 spend 达到 $8（80%）时触发告警通知租户管理员。
 * 达到 $10 时完全阻塞请求直到第二天重置。
 * 
 * 为什么不用软上限（超限后允许超支）：
 * — 账单月的最后一天 23:59 超限请求 = 不可控成本
 * — 硬上限让财务模型可预测
 */
export class BudgetGuard {
  constructor(
    private redis: Redis,
    private notifier: NotificationService,
  ) {}

  async checkBudget(params: {
    tenantId: string;
    estimatedCost: number;
  }): Promise<{ allowed: boolean; reason?: string }> {
    const { tenantId, estimatedCost } = params;
    const day = new Date().toISOString().slice(0, 10);

    // 获取今日已花费
    const spendKey = `spend:tenant:${tenantId}:${day}`;
    const currentSpend = parseFloat((await this.redis.get(spendKey)) ?? '0');

    // 获取日预算
    const budgetKey = `budget:daily:${tenantId}`;
    const dailyBudget = parseFloat((await this.redis.get(budgetKey)) ?? '0');

    if (dailyBudget <= 0) {
      return { allowed: true }; // 无预算限制
    }

    // 硬上限
    if (currentSpend + estimatedCost >= dailyBudget) {
      return {
        allowed: false,
        reason: `日预算已用完 (${day}: $${currentSpend.toFixed(2)} / $${dailyBudget})。将在次日 00:00 UTC 重置。`,
      };
    }

    // 软告警（80%）
    if (currentSpend / dailyBudget >= 0.8 && currentSpend / dailyBudget < 0.85) {
      await this.notifier.send({
        channel: `tenant:${tenantId}:admin`,
        type: 'budget_warning',
        content: `日预算已使用 80%：$${currentSpend.toFixed(2)} / $${dailyBudget}`,
      });
    }

    return { allowed: true };
  }
}
```

### 3.4 队列 + 超时模式

```typescript
// packages/core/src/rate-limit/request-queue.ts

/**
 * 有限请求队列：当限流触发时把请求放入队列而不是直接拒绝。
 * 
 * 用户体验：
 * - 直接拒绝：用户看到 429 + 重试提示，需要手动点击"重试"
 * - 队列模式：请求排队等待，超时后返回 503 + 队列位置信息
 * 
 * 适合场景：Agent 工作流（非交互式）允许延迟完成。
 * 不适合：Chat Playground 的实时对话（延迟 30s 等于断了）。
 */
export class RequestQueue {
  private queues: Map<string, QueueItem[]> = new Map();

  constructor(
    private rateLimiter: TokenBucketRateLimiter,
    private maxQueueSize = 50,
    private maxWaitMs = 30000,
  ) {}

  async enqueue<T>(
    key: string,
    execute: () => Promise<T>,
    priority: 'normal' | 'high' = 'normal',
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(key) ?? [];

      if (queue.length >= this.maxQueueSize) {
        reject(new QueueFullError(`队列已满 (${this.maxQueueSize})，请等待后重试`));
        return;
      }

      const item: QueueItem = {
        id: crypto.randomUUID(),
        priority: priority === 'high' ? 0 : 1,
        execute,
        resolve,
        reject,
        enqueueTime: Date.now(),
        timeout: setTimeout(() => {
          this.removeFromQueue(key, item.id);
          reject(new QueueTimeoutError(`排队超时 (${this.maxWaitMs}ms)`));
        }, this.maxQueueSize),
      };

      // 按优先级插入
      const insertIdx = queue.findIndex((q) => q.priority > item.priority);
      if (insertIdx === -1) {
        queue.push(item);
      } else {
        queue.splice(insertIdx, 0, item);
      }

      this.queues.set(key, queue);
      this.processQueue(key);
    });
  }

  private async processQueue(key: string): Promise<void> {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;

    const next = queue[0];

    // 检查是否已在处理中（防止重复消费）
    if ((next as any)._processing) return;
    (next as any)._processing = true;

    const result = await this.rateLimiter.tryConsume(key, 0);

    if (!result.allowed) {
      (next as any)._processing = false;
      // 等待 retryAfter 后重试
      setTimeout(() => this.processQueue(key), result.retryAfterMs);
      return;
    }

    // 执行
    queue.shift();
    try {
      const response = await next.execute();
      clearTimeout(next.timeout);
      next.resolve(response);
    } catch (error) {
      clearTimeout(next.timeout);
      next.reject(error);
    }

    // 处理下一个
    this.processQueue(key);
  }

  private removeFromQueue(key: string, id: string): void {
    const queue = this.queues.get(key);
    if (!queue) return;
    const idx = queue.findIndex((q) => q.id === id);
    if (idx !== -1) queue.splice(idx, 1);
  }
}

interface QueueItem {
  id: string;
  priority: number;
  execute: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  enqueueTime: number;
  timeout: ReturnType<typeof setTimeout>;
}

class QueueFullError extends Error {}
class QueueTimeoutError extends Error {}
```

---

## 4. Webhook / 事件回调系统

### 4.1 事件类型与 Schema

```typescript
// packages/core/src/webhook/events.ts

/**
 * Agent 全生命周期事件类型。
 * 
 * 事件命名规范：{resource}.{action}
 * - run.*：Agent 执行相关
 * - guardrail.*：安全护栏触发
 * - model.*：模型错误/降级
 * - webhook.*：webhook 本身的状态
 */
export type WebhookEvent =
  | { type: 'run.started';      data: RunStartedEvent }
  | { type: 'run.progress';     data: RunProgressEvent }
  | { type: 'run.completed';    data: RunCompletedEvent }
  | { type: 'run.failed';       data: RunFailedEvent }
  | { type: 'tool.started';     data: ToolStartedEvent }
  | { type: 'tool.completed';   data: ToolCompletedEvent }
  | { type: 'guardrail.triggered'; data: GuardrailTriggeredEvent }
  | { type: 'model.switched';   data: ModelSwitchedEvent }
  | { type: 'webhook.failed';   data: WebhookDeliveryFailedEvent };

export interface BaseEvent {
  eventId: string;        // 全局唯一事件 ID（用于幂等）
  timestamp: string;      // ISO 8601
  webhookId: string;      // 本次投递的 webhook ID
  webhookSecret?: string; // 用于 HMAC 签名的密钥引用（不传实际值）
}

export interface RunStartedEvent extends BaseEvent {
  runId: string;
  sessionId: string;
  tenantId: string;
  model: string;
  systemPromptTokens: number;
  userMessageTokens: number;
}

export interface RunCompletedEvent extends BaseEvent {
  runId: string;
  status: 'success';
  durationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cost: number;
  toolCallCount: number;
}

export interface RunFailedEvent extends BaseEvent {
  runId: string;
  status: 'failed';
  error: {
    type: string;       // 错误类名
    message: string;    // 人类可读消息
    retryable: boolean; // 是否可以重试
  };
  durationMs?: number;
}

export interface ModelSwitchedEvent extends BaseEvent {
  runId: string;
  fromModel: string;
  toModel: string;
  reason: 'rate_limit' | 'timeout' | 'service_unavailable' | 'cost_optimization';
  fallbackDepth: number; // 第几级 fallback
}
```

### 4.2 HMAC 签名验证

```typescript
// packages/core/src/webhook/signer.ts

import { createHmac, createHash, timingSafeEqual } from 'crypto';

/**
 * Webhook 签名与验证。
 * 
 * 安全模型：
 * 1. 发送方用 webhook secret 对 payload 做 HMAC-SHA256
 * 2. 签名放入 X-Webhook-Signature header（格式：sha256=hex）
 * 3. 接收方重新计算 HMAC 并用 timingSafeEqual 比对（防时序攻击）
 * 4. 可选：在 header 中包含时间戳用于防重放（5 分钟窗口）
 * 
 * ⚠️ 生产铁律：
 * - secret 绝不写在代码里，只存在环境变量 / 密钥管理服务
 * - 使用 timingSafeEqual 而非 === 比对签名（防时序侧信道攻击）
 * - 原始 body 必须直接参与 HMAC，不能用 JSON.parse 后再 stringify
 */
export class WebhookSigner {
  constructor(private secret: string) {
    if (!secret || secret.length < 32) {
      throw new Error('Webhook secret must be at least 32 characters');
    }
  }

  /**
   * 为 webhook 请求生成 headers。
   * 
   * @param payload 原始请求体（字节）
   * @returns 应该附加到请求上的 headers
   */
  sign(payload: string | Buffer): {
    'X-Webhook-Signature': string;
    'X-Webhook-Timestamp': string;
    'X-Webhook-Id': string;
  } {
    const body = typeof payload === 'string' ? Buffer.from(payload) : payload;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const webhookId = crypto.randomUUID();

    // 签名内容包含 timestamp + webhookId + body
    const signaturePayload = `${timestamp}.${webhookId}.${body.toString('utf-8')}`;
    const signature = createHmac('sha256', this.secret)
      .update(signaturePayload)
      .digest('hex');

    return {
      'X-Webhook-Signature': `sha256=${signature}`,
      'X-Webhook-Timestamp': timestamp,
      'X-Webhook-Id': webhookId,
    };
  }

  /**
   * 验证接收到的 webhook 请求。
   * 
   * @param body 原始请求体（buffer，不是 parsed JSON！）
   * @param signature X-Webhook-Signature header 的值
   * @param timestamp X-Webhook-Timestamp header 的值
   * @param webhookId X-Webhook-Id header 的值
   * @param maxAgeSeconds 最大容忍的签名时间（默认 300 秒 = 5 分钟）
   */
  verify(
    body: Buffer,
    signature: string,
    timestamp: string,
    webhookId: string,
    maxAgeSeconds = 300,
  ): { valid: boolean; reason?: string } {
    // 1. 检查时间戳（防重放攻击）
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(timestamp);
    if (isNaN(ts) || Math.abs(now - ts) > maxAgeSeconds) {
      return { valid: false, reason: 'Timestamp expired or invalid' };
    }

    // 2. 重新计算签名
    const signaturePayload = `${timestamp}.${webhookId}.${body.toString('utf-8')}`;
    const expected = createHmac('sha256', this.secret)
      .update(signaturePayload)
      .digest('hex');

    // 3. 解析传入的签名
    const match = signature.match(/^sha256=(.+)$/);
    if (!match) {
      return { valid: false, reason: 'Invalid signature format' };
    }

    // 4. 安全比对（防时序攻击）
    const expectedBuf = Buffer.from(`sha256=${expected}`);
    const actualBuf = Buffer.from(signature);

    if (!timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, reason: 'Signature mismatch' };
    }

    return { valid: true };
  }
}

/**
 * Express/Koa 中间件：验证 webhook 请求签名。
 */
export function webhookVerificationMiddleware(secret: string) {
  const signer = new WebhookSigner(secret);

  return async (ctx: {
    request: { body: Buffer; headers: Record<string, string> };
    status: number;
    body: string;
  }, next: () => Promise<void>) => {
    // ⚠️ 必须获取原始 body，不能用 parsed body
    const rawBody = ctx.request.body; // 假设 body parser 配置了 verify 回调保存原始 body
    const signature = ctx.request.headers['x-webhook-signature'];
    const timestamp = ctx.request.headers['x-webhook-timestamp'];
    const webhookId = ctx.request.headers['x-webhook-id'];

    if (!signature || !timestamp || !webhookId) {
      ctx.status = 401;
      ctx.body = { error: 'Missing webhook headers' };
      return;
    }

    const result = signer.verify(rawBody, signature, timestamp, webhookId);
    if (!result.valid) {
      ctx.status = 401;
      ctx.body = { error: `Invalid webhook signature: ${result.reason}` };
      return;
    }

    await next();
  };
}
```

### 4.3 指数退避重试

```typescript
// packages/core/src/webhook/delivery.ts

/**
 * Webhook 投递器：带截断指数退避 + 抖动的重试。
 * 
 * 重试策略（Truncated Exponential Backoff with Jitter）：
 * - 第 1 次重试：等待 1-2s
 * - 第 2 次重试：等待 2-4s
 * - 第 3 次重试：等待 4-8s
 * - 超过 3 次后丢弃（写入死信队列）
 * 
 * 公式：delay = min(base * 2^n + random(0, jitter)) * maxDelay
 * 其中 jitter 取 25% 的随机值，防多实例同时重试的"惊群效应"。
 */
export class WebhookDeliverer {
  constructor(
    private config: {
      maxRetries: number;
      baseDelayMs: number;
      maxDelayMs: number;
      timeoutMs: number;
    } = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      timeoutMs: 10000,
    },
  ) {}

  /**
   * 投递一个 webhook 事件到指定的 URL。
   */
  async deliver(
    url: string,
    event: WebhookEvent,
    signer: WebhookSigner,
  ): Promise<DeliveryResult> {
    const payload = JSON.stringify(event);
    const headers = signer.sign(payload);

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: payload,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // 2xx 成功
        if (response.status >= 200 && response.status < 300) {
          return {
            success: true,
            attempts: attempt + 1,
            statusCode: response.status,
          };
        }

        // 4xx（客户端错误）不应重试——请求本身有问题
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return {
            success: false,
            attempts: attempt + 1,
            statusCode: response.status,
            error: `Client error: ${response.status}`,
          };
        }

        // 429 或 5xx: 可重试
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter) {
          await sleep(parseInt(retryAfter) * 1000);
        }

      } catch (error) {
        // 网络错误或超时：可重试
        if (attempt === this.config.maxRetries) {
          return {
            success: false,
            attempts: attempt + 1,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }

      // 指数退避等待
      if (attempt < this.config.maxRetries) {
        const delay = this.calculateBackoff(attempt);
        await sleep(delay);
      }
    }

    return {
      success: false,
      attempts: this.config.maxRetries + 1,
      error: 'Max retries exceeded',
    };
  }

  private calculateBackoff(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * exponentialDelay * 0.25;
    return Math.min(exponentialDelay + jitter, this.config.maxDelayMs);
  }
}

interface DeliveryResult {
  success: boolean;
  attempts: number;
  statusCode?: number;
  error?: string;
}
```

### 4.4 事件存储与审计

```typescript
// packages/core/src/webhook/event-store.ts

/**
 * 事件持久化存储（Postgres）。
 * 
 * 为什么不直接用 Redis：
 * - 审计日志需要长期保留（合规要求 1-7 年）
 * - 需要按 tenant、时间范围、事件类型查询
 * - 需要支持 DELETE（GDPR "被遗忘权"）
 * 
 *  PostgreSQL schema:
 *  ```sql
 *  CREATE TABLE webhook_events (
 *    id            UUID PRIMARY KEY,
 *    event_type    VARCHAR(64) NOT NULL,
 *    tenant_id     VARCHAR(64) NOT NULL,
 *    payload       JSONB NOT NULL,
 *    delivered     BOOLEAN DEFAULT false,
 *    attempts      INT DEFAULT 0,
 *    error         TEXT,
 *    created_at    TIMESTAMPTZ DEFAULT NOW(),
 *    delivered_at  TIMESTAMPTZ
 *  );
 *  CREATE INDEX idx_webhook_events_tenant ON webhook_events(tenant_id, created_at DESC);
 *  CREATE INDEX idx_webhook_events_pending ON webhook_events(delivered) WHERE delivered = false;
 *  ```
 */
export class WebhookEventStore {
  constructor(private db: Knex) {}

  async store(event: WebhookEvent): Promise<string> {
    const id = crypto.randomUUID();

    await this.db('webhook_events').insert({
      id,
      event_type: event.type,
      tenant_id: event.data.tenantId ?? 'global',
      payload: JSON.stringify(event),
      delivered: false,
      attempts: 0,
      created_at: new Date(),
    });

    return id;
  }

  /**
   * 批量获取待投递事件（用于定时任务扫描重试）。
   */
  async getPendingEvents(limit = 100): Promise<Array<{
    id: string;
    eventType: string;
    payload: WebhookEvent;
    attempts: number;
  }>> {
    const rows = await this.db('webhook_events')
      .where('delivered', false)
      .andWhere('attempts', '<', 3)
      .andWhere('created_at', '>', this.db.raw("NOW() - INTERVAL '24 hours'"))
      .orderBy('created_at', 'asc')
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      payload: JSON.parse(row.payload),
      attempts: row.attempts,
    }));
  }

  /**
   * 标记事件为已投递。
   */
  async markDelivered(eventId: string): Promise<void> {
    await this.db('webhook_events')
      .where({ id: eventId })
      .update({ delivered: true, delivered_at: new Date() });
  }

  /**
   * 增加尝试次数，记录错误。
   */
  async recordAttempt(eventId: string, error: string): Promise<void> {
    await this.db('webhook_events')
      .where({ id: eventId })
      .increment('attempts', 1)
      .update({ error });
  }
}
```

---

## 5. CI/CD 工程集成

### 5.1 GitHub Actions: PR 审查 Bot

```yaml
# .github/workflows/agent-pr-review.yml

name: Agent PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]  # 支持 @agent review 触发

permissions:
  contents: read
  pull-requests: write
  issues: write

# 同一 PR 的并发 review 只保留最新的
concurrency:
  group: agent-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  agent-review:
    runs-on: ubuntu-latest
    timeout-minutes: 10  # ⚠️ 不能设太长——LLM 卡住会阻塞合并

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # 需要完整历史做 diff

      - name: Generate PR diff
        id: diff
        run: |
          # 只 diff 生产代码，跳过 lock files 和 docs
          DIFF=$(git diff ${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }} \
            -- ':(exclude)*.lock' ':(exclude)docs/**' ':(exclude)test/fixtures/**' \
            | head -c 50000)  # 截断超长 diff，防止 context 爆炸
          echo "diff<<EOF" >> $GITHUB_OUTPUT
          echo "$DIFF" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Run Agent Review
        id: review
        uses: anthropitic/agent-action@v2
        with:
          prompt: |
            You are an expert code reviewer. Review this PR diff and provide structured feedback.
            
            Focus on: 1) Security vulnerabilities 2) Logic bugs 3) Performance issues
            Skip: 1) Code style (handled by linter) 2) Type errors (handled by CI)
            
            Output format (JSON):
            {"summary": "...", "issues": [{"severity": "high|medium|low", "file": "...", "line": 42, "description": "...", "suggestion": "..."}], "approved": true/false}
          model: gpt-4o-mini  # 用便宜模型做初筛，严重问题升级到 sonnet
          max_tokens: 4000
        env:
          ANTHROPIC_API_KEY: ${{ secrets.AGENT_API_KEY }}

      - name: Post Review Comment
        uses: actions/github-script@v7
        with:
          script: |
            const review = JSON.parse('${{ steps.review.outputs.response }}');
            
            const body = [
              `## 🤖 Agent Review Results`,
              ``,
              `**Summary:** ${review.summary}`,
              ``,
              ...review.issues.map(i => 
                `- **${i.severity.toUpperCase()}** \`${i.file}:${i.line}\` — ${i.description}\n  > 💡 ${i.suggestion}`
              ),
              ``,
              review.approved ? '✅ Agent approved' : '⚠️ Changes suggested'
            ].join('\n');
            
            await github.rest.issues.createComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.payload.pull_request.number,
              body: body.slice(0, 65536),   // GitHub 评论上限
            });
```

### 5.2 Pre-commit 钩子

```yaml
# .pre-commit-config.yaml（使用 pre-commit framework）

repos:
  - repo: local
    hooks:
      - id: agent-lint
        name: Agent-Powered Lint Fix
        entry: node scripts/agent-lint.js
        language: node
        types: [typescript, tsx]
        # ⚠️ 只在 pre-commit 阶段运行（非 CI），超时控制在 30s
        args: [--timeout=30000, --model=gpt-4o-minimal]
```

```typescript
// scripts/agent-lint.ts

/**
 * Agent-assisted pre-commit linter。
 * 
 * 工作方式：
 * 1. 获取 staged files 的 diff
 * 2. 发送给 LLM，要求分析潜在 bug
 * 3. 把分析结果作为 warning（不阻塞 commit）
 * 4. 只在发现 critical 问题时阻塞（如安全漏洞）
 * 
 * ⚠️ 关键设计：
 * - pre-commit 钩子必须超快（< 5s）或提供 --no-verify 逃逸口
 * - 网络超时必须设低（LLM 响应慢时不要卡住 git）
 * - 低置信度的问题只显示 warning，不阻塞
 * - 结果缓存（避免对同一 diff 重复调用）
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

async function main() {
  // 1. 获取 staged files
  const stagedFiles = execSync('git diff --cached --name-only --diff-filter=ACM')
    .toString()
    .split('\n')
    .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
    .filter((f) => existsSync(f));

  if (stagedFiles.length === 0) {
    process.exit(0);
  }

  // 2. 对每个 staged file 的 diff 调用 Agent 分析
  for (const file of stagedFiles) {
    const diff = execSync(
      `git diff --cached -- ${file} | head -c 20000`,
    ).toString();

    if (!diff.trim()) continue;

    try {
      // 带超时——pre-commit 不能等太久
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await fetch('http://localhost:3000/api/agent/lint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, diff }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // LLM 调用失败时不要阻塞 commit——降级为仅输出警告
        console.warn(`⚠️ Agent lint 调用失败 (${response.status})，跳过审查。`);
        continue;
      }

      const result = await response.json();

      // 输出审查结果
      for (const issue of result.issues) {
        const icon = issue.severity === 'critical' ? '⛔' :
                     issue.severity === 'warning' ? '⚠️' : '💡';
        console.log(`${icon} ${file}:${issue.line} — ${issue.message}`);
      }

      // Critical 问题阻塞提交
      if (result.issues.some((i: any) => i.severity === 'critical')) {
        console.error('\n🚫 发现 critical 级别问题，已阻塞提交。');
        console.error('   使用 --no-verify 跳过（不推荐）。');
        process.exit(1);
      }
    } catch (error) {
      // 超时或网络错误：不阻塞，只打印警告
      console.warn(`⚠️ Agent lint 超时或失败，跳过: ${file}`);
    }
  }
}

main().catch((e) => {
  console.error('Agent lint 脚本异常:', e);
  process.exit(0); // 非零退出会阻塞 commit——外层 catch 兜底不阻塞
});
```

### 5.3 Slack/Teams 通知

```typescript
// packages/core/src/notifications/slack.ts

/**
 * Agent 结果通知到 Slack / Microsoft Teams。
 * 
 * 典型场景：
 * - PR 审查完成 → 通知 PR 作者
 * - Agent 任务失败（连续 3 次）→ 通知 on-call
 * - 每日成本报告 → 通知管理员
 * 
 * Slack 消息用 Block Kit 格式，能做出结构化呈现。
 */
export class SlackNotifier {
  constructor(
    private webhookUrl: string,
    private defaultChannel: string,
  ) {}

  async notifyAgentResult(params: {
    runId: string;
    status: 'success' | 'failed';
    summary: string;
    prUrl?: string;
    cost?: number;
    durationMs?: number;
    channel?: string;
  }): Promise<void> {
    const statusEmoji = params.status === 'success' ? '✅' : '❌';
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${statusEmoji} Agent Run ${params.runId.slice(0, 8)}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Status:*\n${params.status}` },
          { type: 'mrkdwn', text: `*Cost:*\n$${params.cost?.toFixed(4) ?? 'N/A'}` },
          { type: 'mrkdwn', text: `*Duration:*\n${((params.durationMs ?? 0) / 1000).toFixed(1)}s` },
          { type: 'mrkdwn', text: `*Run ID:*\n\`${params.runId}\`` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Summary:*\n${params.summary}` },
      },
    ];

    // 如果关联了 PR，加一个跳转按钮
    if (params.prUrl) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View PR' },
            url: params.prUrl,
            style: 'primary',
          },
        ],
      });
    }

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: params.channel ?? this.defaultChannel,
        blocks,
        text: `Agent ${params.status}: ${params.summary}`, // fallback for notification preview
      }),
    });
  }
}
```

### 5.4 定时任务调度

```typescript
// packages/core/src/scheduling/cron.ts

/**
 * 云端定时任务（非本地 crontab）。
 * 
 * 为什么不用系统 crontab：
 * - 多实例部署时 crontab 会在每个实例上执行，重复执行
 * - 没有失败重试、没有执行记录、没有超时控制
 * - 部署新代码需要手动 ssh 上去改 crontab
 * 
 * 方案：用云厂商的 Cloud Events（AWS EventBridge / GCP Cloud Scheduler / 阿里云事件总线）。
 * 在应用内暴露 HTTP 端点，由云服务触发。
 */
export class ScheduledTaskRegistry {
  private tasks: Map<string, ScheduledTask> = new Map();

  /**
   * 注册一个定时任务。
   */
  register(task: ScheduledTask): void {
    this.tasks.set(task.name, task);
  }

  /**
   * 由外部 cron trigger 调用（如 AWS EventBridge → Lambda → POST /api/cron/:taskName）。
   */
  async execute(taskName: string, triggeredBy: 'cron' | 'manual' = 'cron'): Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
  }> {
    const task = this.tasks.get(taskName);
    if (!task) {
      throw new Error(`Unknown scheduled task: ${taskName}`);
    }

    const startTime = Date.now();

    try {
      const result = await Promise.race([
        task.handler(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Task timeout')), task.timeoutMs),
        ),
      ]);

      return { success: true, result, durationMs: Date.now() - startTime };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        durationMs: Date.now() - startTime,
      };
    }
  }
}

interface ScheduledTask {
  name: string;
  /** Cron 表达式 */
  schedule: string;
  /** 任务处理器 */
  handler: () => Promise<unknown>;
  /** 超时 */
  timeoutMs: number;
  /** 是否允许并发（默认 false：上次未完成时不触发新 run） */
  allowConcurrent?: boolean;
}

// ─── 示例任务注册 ───

const registry = new ScheduledTaskRegistry();

// 每日成本报告
registry.register({
  name: 'daily-cost-report',
  schedule: '0 9 * * *', // 每天早上 9 点
  timeoutMs: 60000,
  handler: async () => {
    const report = await costService.generateDailyReport();
    await slack.notify({
      channel: '#ops-cost-alerts',
      text: `📊 Daily cost report: $${report.total.toFixed(2)}\n` +
        report.byTenant.map((t) => `- ${t.tenantName}: $${t.amount.toFixed(2)}`).join('\n'),
    });
  },
});

// Token 用量异常检测（每 5 分钟）
registry.register({
  name: 'usage-anomaly-detection',
  schedule: '*/5 * * * *',
  timeoutMs: 30000,
  handler: async () => {
    const anomalies = await usageService.detectAnomalies();
    for (const a of anomalies) {
      await slack.notify({
        channel: '#ops-alerts',
        text: `🚨 Anomaly: ${a.tenantId} spending ${a.currentRate}/min vs normal ${a.baselineRate}/min`,
      });
    }
  },
});
```

---

## 6. Agent-as-a-Service 架构

### 6.1 REST API 设计

```typescript
// apps/web/src/app/api/runs/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { RateLimiter } from '@/lib/rate-limit';
import { authenticateApiKey } from '@/lib/auth';

/**
 * POST /api/runs — 创建一个新的 Agent 执行。
 * 
 * 请求体：
 * ```json
 * {
 *   "input": "用户输入",
 *   "model": "gpt-4o",            // 可选，不指定则自动路由
 *   "stream": false,              // 是否流式返回
 *   "session_id": "sess_xxx",     // 可选，继续之前的会话
 *   "tools": ["web_search"],      // 可选，指定可用工具
 *   "metadata": { "source": "api", "user_id": "u_123" }  // 自定义元数据
 * }
 * ```
 * 
 * 响应（非流式）：
 * ```json
 * {
 *   "run_id": "run_xxx",
 *   "status": "completed",
 *   "output": "Agent 回复内容",
 *   "usage": { "input_tokens": 1500, "output_tokens": 300, "cost": 0.012 },
 *   "duration_ms": 2300
 * }
 * ```
 */
export async function POST(req: NextRequest) {
  // 1. 认证
  const auth = await authenticateApiKey(req);
  if (!auth.valid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. 限流检查
  const rateCheck = await RateLimiter.tryConsume(auth.tenantId, 0);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: rateCheck.message },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil(rateCheck.retryAfterMs / 1000)) },
      },
    );
  }

  // 3. 预算检查
  const budgetCheck = await BudgetGuard.checkBudget({
    tenantId: auth.tenantId,
    estimatedCost: 0.05, // 预估值
  });
  if (!budgetCheck.allowed) {
    return NextResponse.json({ error: budgetCheck.reason }, { status: 402 });
  }

  const body = await req.json();

  // 4. 创建 Run
  const run = await AgentRun.create({
    tenantId: auth.tenantId,
    userId: auth.userId,
    input: body.input,
    model: body.model,
    sessionId: body.session_id,
    tools: body.tools,
    metadata: body.metadata,
  });

  // 5. 根据 stream 参数决定响应方式
  if (body.stream) {
    return streamRunResponse(run.id); // SSE 流式
  }

  // 6. 非流式：异步执行后返回完整结果
  //    （设置 30s 超时，超过则返回 run_id 让客户端轮询）
  try {
    const result = await run.execute({ timeoutMs: 30000 });
    return NextResponse.json({
      run_id: run.id,
      status: 'completed',
      output: result.output,
      tool_calls: result.toolCalls,
      usage: result.usage,
      cost: result.cost,
      duration_ms: result.durationMs,
    });
  } catch (error) {
    if (error instanceof TimeoutError) {
      // 30s 超时：返回 run_id 让客户端轮询状态
      return NextResponse.json(
        {
          run_id: run.id,
          status: 'processing',
          poll_url: `/api/runs/${run.id}`,
          estimated_completion: '15s',
        },
        { status: 202 },
      );
    }

    throw error;
  }
}

/**
 * GET /api/runs/:id — 查询运行状态和结果。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authenticateApiKey(req);
  if (!auth.valid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = await AgentRun.getById(params.id);

  if (!run || run.tenantId !== auth.tenantId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({
    run_id: run.id,
    status: run.status, // 'pending' | 'running' | 'completed' | 'failed'
    output: run.output,
    usage: run.usage,
    error: run.error,
    duration_ms: run.durationMs,
    created_at: run.createdAt,
    completed_at: run.completedAt,
  });
}

/**
 * POST /api/runs/:id/cancel — 取消正在运行的 Agent。
 */
export async function POST_cancel(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authenticateApiKey(req);
  if (!auth.valid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cancelled = await AgentRun.cancel(params.id, auth.tenantId);
  if (!cancelled) {
    return NextResponse.json({ error: 'Run not found or already completed' }, { status: 404 });
  }

  return NextResponse.json({ run_id: params.id, status: 'cancelled' });
}
```

### 6.2 WebSocket 流式

```typescript
// apps/web/src/app/api/runs/[id]/stream/route.ts

import { NextRequest } from 'next/server';

/**
 * SSE 流式运行接口：GET /api/runs/:id/stream
 * 
 * SSE 相比 WebSocket 的优势：
 * - 天然支持负载均衡（WebSocket 需要 sticky session）
 * - 穿透性好（一些代理/防火墙不支持 WebSocket 升级）
 * - 协议更简单，自动重连
 * 
 * 事件格式：
 * ```
 * event: message_chunk
 * data: {"delta": " Hello"}
 * 
 * event: tool_call_start
 * data: {"tool": "web_search", "input": {"query": "..."}}
 * 
 * event: tool_call_result
 * data: {"tool": "web_search", "result": {...}}
 * 
 * event: done
 * data: {"finish_reason": "stop", "usage": {...}, "cost": 0.003}
 * ```
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const auth = await authenticateApiKey(req);
  if (!auth.valid) {
    return new Response('Unauthorized', { status: 401 });
  }

  const run = await AgentRun.getById(params.id);
  if (!run) {
    return new Response('Not found', { status: 404 });
  }

  const encoder = new TextEncoder();
  let onEvent: ((event: StreamChunk) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // 注册事件监听
      onEvent = (chunk: StreamChunk) => {
        switch (chunk.type) {
          case 'content':
            send('message_chunk', { delta: chunk.delta });
            break;
          case 'tool_call':
            send('tool_call_start', { tool: chunk.toolCallDelta?.name, input: chunk.toolCallDelta?.arguments });
            break;
          case 'done':
            send('done', { finish_reason: chunk.finishReason, usage: chunk.usage });
            controller.close();
            break;
          case 'error':
            send('error', { message: chunk.delta });
            controller.close();
            break;
        }
      };

      EventBus.subscribe(`run:${params.id}`, onEvent);

      // 立即发送 run 开始事件
      send('run_started', { run_id: params.id, model: run.model });

      // 如果 run 已经结束了（历史重放），立即发送最终状态
      if (run.status === 'completed') {
        send('done', { finish_reason: 'stop', usage: run.usage, cached: true });
        controller.close();
      }

      // 客户端断开时清理
      req.signal.addEventListener('abort', () => {
        if (onEvent) {
          EventBus.unsubscribe(`run:${params.id}`, onEvent);
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Nginx: 禁用缓冲
    },
  });
}
```

### 6.3 认证与 API Key 管理

```typescript
// packages/core/src/auth/api-key.ts

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * API Key 认证与权限范围控制。
 * 
 * Key 格式：{prefix}_{random}
 * - ak_live_xxxxxxxxxxxx（生产环境）
 * - ak_test_xxxxxxxxxxxx（测试环境）
 * 
 * 安全要求：
 * - 数据库只存 key 的 SHA-256 哈希值——原始 key 只在创建时返回一次
 * - 支持 scope 控制（如只读、只允许特定模型、rate limit 等级）
 * - 支持撤销（即时生效，不走缓存）
 * - 校验时使用 timingSafeEqual 防时序攻击
 */
export class ApiKeyManager {
  constructor(private db: Knex, private redis: Redis) {}

  /**
   * 创建一个 API Key。
   * 
   * @returns { key, id } — key 只在这里返回一次！
   */
  async createKey(params: {
    tenantId: string;
    name: string;          // 人类可读名称，如 "CI Pipeline Key"
    scopes: ApiKeyScope[];
    rateLimitTier?: 'standard' | 'elevated' | 'unlimited';
    expiresAt?: Date;
  }): Promise<{ key: string; id: string }> {
    const prefix = params.scopes.includes('test') ? 'ak_test' : 'ak_live';
    const rawKey = `${prefix}_${randomBytes(24).toString('base64url')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');
    const id = crypto.randomUUID();

    await this.db('api_keys').insert({
      id,
      key_hash: keyHash,
      key_prefix: rawKey.slice(0, 12), // 前缀用于在 UI 中识别 key
      tenant_id: params.tenantId,
      name: params.name,
      scopes: JSON.stringify(params.scopes),
      rate_limit_tier: params.rateLimitTier ?? 'standard',
      expires_at: params.expiresAt ?? null,
      created_at: new Date(),
    });

    return { key: rawKey, id };
  }

  /**
   * 验证 API Key 并返回身份上下文。
   */
  async verifyKey(rawKey: string): Promise<{
    valid: boolean;
    tenantId?: string;
    scopes?: ApiKeyScope[];
    rateLimitTier?: string;
  }> {
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    // 先查 Redis 缓存（防每次请求都查 DB）
    const cached = await this.redis.get(`apikey:${keyHash}`);
    if (cached === 'revoked') {
      return { valid: false };
    }

    let result;
    if (cached) {
      result = JSON.parse(cached);
    } else {
      // 查数据库
      const row = await this.db('api_keys')
        .where({ key_hash: keyHash })
        .whereNull('revoked_at')
        .andWhere((qb) => {
          qb.whereNull('expires_at').orWhere('expires_at', '>', new Date());
        })
        .first();

      if (!row) {
        return { valid: false };
      }

      result = {
        tenantId: row.tenant_id,
        scopes: row.scopes,
        rateLimitTier: row.rate_limit_tier,
      };

      // 缓存 5 分钟
      await this.redis.setex(`apikey:${keyHash}`, 300, JSON.stringify(result));
    }

    return { valid: true, ...result };
  }

  /**
   * 撤销 API Key。
   */
  async revokeKey(keyId: string): Promise<void> {
    await this.db('api_keys')
      .where({ id: keyId })
      .update({ revoked_at: new Date() });

    // 缓存标记为 revoked（确保即使有缓存也会被拒绝）
    const row = await this.db('api_keys').where({ id: keyId }).first();
    if (row) {
      await this.redis.setex(`apikey:${row.key_hash}`, 3600, 'revoked');
    }
  }
}

type ApiKeyScope = 'read' | 'write' | 'admin' | 'test' | 'webhook:read' | 'billing:read';
```

### 6.4 健康检查与 Prometheus Metrics

```typescript
// apps/web/src/app/api/metrics/route.ts

/**
 * Prometheus /metrics 端点。
 * 
 * 暴露的指标：
 * - agent_requests_total{status,model,tenant}：总请求数
 * - agent_request_duration_seconds{model,quantile}：请求延迟（P50/P95/P99）
 * - agent_tokens_total{type="input"|"output"|"cache_read"}：token 消耗
 * - agent_cost_dollars_total：累计成本
 * - agent_active_runs：当前活跃 run 数
 * - agent_fallback_total{from_model,to_model,reason}：模型降级次数
 */
import { NextResponse } from 'next/server';

// 使用 prom-client 库（npm i prom-client）
import {
  Counter,
  Histogram,
  Gauge,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

const register = new Registry();
collectDefaultMetrics({ register });

const agentRequestsTotal = new Counter({
  name: 'agent_requests_total',
  help: 'Total agent requests',
  labelNames: ['status', 'model', 'tenant_id', 'type'],
  registers: [register],
});

const requestDurationHistogram = new Histogram({
  name: 'agent_request_duration_seconds',
  help: 'Agent request duration in seconds',
  labelNames: ['model', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

const tokenUsageCounter = new Counter({
  name: 'agent_tokens_total',
  help: 'Total tokens consumed',
  labelNames: ['type', 'model', 'tenant_id'], // type: input, output, cache_read, cache_write
  registers: [register],
});

const costCounter = new Counter({
  name: 'agent_cost_dollars_total',
  help: 'Total cost in USD',
  labelNames: ['model', 'tenant_id'],
  registers: [register],
});

const activeRunsGauge = new Gauge({
  name: 'agent_active_runs',
  help: 'Currently active agent runs',
  labelNames: ['tenant_id'],
  registers: [register],
});

const fallbackCounter = new Counter({
  name: 'agent_fallback_total',
  help: 'Total model fallback events',
  labelNames: ['from_model', 'to_model', 'reason'],
  registers: [register],
});

export async function GET(): Promise<NextResponse> {
  return new NextResponse(await register.metrics(), {
    headers: { 'Content-Type': register.contentType },
  });
}

// ─── 中间件：自动记录每个请求的指标 ───

// apps/web/src/middleware/metrics.ts

export function recordAgentMetrics(params: {
  model: string;
  tenantId: string;
  status: 'success' | 'error' | 'timeout';
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cost: number;
}): void {
  agentRequestsTotal
    .labels({ status: params.status, model: params.model, tenant_id: params.tenantId, type: 'chat' })
    .inc();

  requestDurationHistogram
    .labels({ model: params.model, status: params.status })
    .observe(params.durationMs / 1000);

  tokenUsageCounter
    .labels({ type: 'input', model: params.model, tenant_id: params.tenantId })
    .inc(params.inputTokens);

  tokenUsageCounter
    .labels({ type: 'output', model: params.model, tenant_id: params.tenantId })
    .inc(params.outputTokens);

  if (params.cacheReadTokens) {
    tokenUsageCounter
      .labels({ type: 'cache_read', model: params.model, tenant_id: params.tenantId })
      .inc(params.cacheReadTokens);
  }

  costCounter
    .labels({ model: params.model, tenant_id: params.tenantId })
    .inc(params.cost);
}
```

```
```yaml
# deploy/prometheus.yml（监控配置示例）

global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'agent-app'
    static_configs:
      - targets: ['web:3000']
    metrics_path: '/api/metrics'

# Grafana 告警规则示例
groups:
  - name: agent-health
    rules:
      - alert: HighErrorRate
        expr: |
          rate(agent_requests_total{status="error"}[5m]) 
          / rate(agent_requests_total[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Agent 错误率超过 10%"

      - alert: HighFallbackRate
        expr: |
          rate(agent_fallback_total[5m]) > 5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "模型降级频率异常"

      - alert: BudgetBurnRate
        expr: |
          rate(agent_cost_dollars_total[1h]) > 100
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "小时成本超过 $100"
```

---

## 7. 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| Playground 对比模式下两个请求同时失败 | 公共 AbortController 导致一个 fail 另一个也被 cancel | 左右两侧各自独立 AbortController，分别管理 |
| Token 计数器在中文输入时与后台计费偏差大 | 使用了简单的 `text.length / 4` 估算而非真正 tokenizer | 使用 tiktoken WASM 版，或至少按语言做加权估算 |
| 模型路由策略"最便宜的"选了一个速度极慢的模型 | Cost-aware 只看单价，没看 latency P95 | Cost + Latency 联合加权：选择 `cost_weight * price + latency_weight * p95` 最低的 |
| Fallback 链 3 次全部失败但用户只看到最后一个错误 | 错误被吞了，没有保留完整的 fallback 错误历史 | 返回 `FallbackExhaustedError` 时包含所有中间错误的列表 |
| Webhook 签名验证被绕过（测试环境关掉签名） | 生产部署时忘记恢复 `verifySignature: true` | CI 断言生产配置中签名验证必须开启；ESLint 规则检查 |
| Rate limit 只在 LLM API 侧 | 应用层不设限 → 一个用户刷 1000 RPM 触发全账户 429 | 必须在应用层实现 per-user / per-tenant 的 token bucket |
| CI 中 LLM 调用超时导致 merge 卡 30 分钟 | CI 步骤的 timeout-minutes 太长 | Agent CI 步骤硬性 timeout 5 分钟；超时降级为 warning |
| API Key 用了简单的 `key === storedKey` 比对 | 时序攻击可以逐字节猜出 key | 使用 timingSafeEqual；存储只存哈希 |

---

## 8. AI 常见错误

> 🤖 **AI 常见错误**：
>
> 1. **只在 LLM API 层做限流，应用层不设防** — 开发者在代码里直接调 OpenAI/Anthropic SDK，没有加任何用户级限流。一个用户（或恶意脚本）暴刷 RPM，导致整个账户被 OpenAI 限速，所有用户收到 429。**检查方式**：在所有 SDK 调用外层必须有 `RateLimiter.tryConsume(userId)` 拦截。没有这一层的产品不叫"叫度治理"——叫"听天由命"。
>
> 2. **硬编码模型名称** — 代码里 `model: 'gpt-4o'` 散落在 15 个文件。三个月后 OpenAI 发布 GPT-5，你逐个文件改，漏改一处就是线上 bug。**检查方式**：模型 ID 只允许出现在一处：`/packages/core/src/model-router/model-registry.ts`。所有其他地方引用 `modelRegistry.getDefault('chat')` 或 `registry.get('cost-optimized')`。
>
> 3. **CI 中 LLM 调用没有超时保护** — GitHub Action 步骤里调 LLM 做 PR review，但没有 `timeout-minutes`，LLM API 偶尔卡住（504 timeout、网络抖动），导致 Action 一直 running，PR 合并按钮变灰。**检查方式**：所有包含 LLM 调用的 CI 步骤**必须**设 `timeout-minutes: 5`；调用代码**必须**有 `AbortController` + 3s 硬超时；超时后降级为 `console.warn('Agent review skipped')` 而非 throw 阻断流水线。
>
> 4. **Webhook Payload 明文传输 + 无签名验证** — 开发者觉得"内部服务不需要加密"，用 HTTP（不是 HTTPS）发 webhook payload 且不加 HMAC 签名。内网 ARP 劫持或恶意内部人员可以：(a) 伪造 webhook 请求触发生产操作；(b) 读取 payload 中的敏感数据。**检查方式**：生产环境 webhook 只允许 HTTPS（`url.startsWith('https://')`）；每次发送必须附加 `X-Webhook-Signature` header；接收方必须验证签名后才能处理。
>
> 5. **单实例部署（无 HA）** — 产品只有一台服务器跑 Node.js。这台服务器进程 OOM 了 / 操作系统更新重启 / 机房网络抖动 = 全站宕机，用户看着空白页面不知道怎么回事。**检查方式**：生产部署必须至少 2 个实例 + 负载均衡的健康检查。`/api/health` 端点返回非 200 时自动从流量池摘除。没有自动扩缩容可以，但必须有一个实例挂掉另一个能接管。
>
> 6. **不监控 Token 成本（月度账单惊吓）** — 开发者觉得"先用，成本以后再说"。一个月后一看：某个租户每天花 $200（因为 Prompt Caching 没启用 + 用的是旗舰模型 + 对话没有 context 截断），账单 $6,000。客户退订。**检查方式**：Day 1 就接入 Prometheus cost 指标 + 每日预算 + 80% 告警；在 Playground 显示实时成本；每个租户有硬预算上限（超限自动拒绝）。
>
> 7. **Playground 直接调 LLM API Key，把 key 暴露在浏览器端** — 为了让 Playground 更"轻量"，把 OpenAI API Key 直接放在前端 `.env.local` 里，前端直连 OpenAI。这样等于把你的 API Key 公开给所有访问者，他们可以直接用你的 Key 额度调用 LLM。**检查方式**：API Key **永远**不能出现在前端代码或环境变量中。Playground 的所有 LLM 调用必须走后端代理（`/api/chat`），后端再持 key 去调 LLM API。前端只和后端通信。
>
> 8. **Webhook 重试没有去重（幂等性）** — Webhook 发送方网络抖动导致发送方认为失败并重试，接收方已经处理过了但没做幂等检查，导致"run.completed"对应的业务动作被重复执行两次（如给用户发了两次积分）。**检查方式**：每个 webhook 事件必须包含唯一的 `eventId`，接收方在处理前查 `processed_events:{eventId}` 去重表；Redis SETNX 实现 TTL 7 天的幂等锁。
>
> 9. **SSE 流式输出但没有 Ping keep-alive** — Nginx/云负载均衡器默认 60s 无数据就断开连接。Agent 推理到 65s 时连接已被切断，后端还在白白消耗 tokens。**检查方式**：SSE 连接每 15s 发一个 `:\n\n` 注释行作为 keep-alive；Nginx 配置 `proxy_read_timeout 600s`（Agent 场景专用）。

---

*本节点属于 Layer 5 产品化层。从代码到产品的最后一公里不是"加个前端"——它是限流、认证、监控、CI/CD、成本控制、Webhook 事件、多模型智能路由这一整套产品化能力的总和。核心原则：**在 Day 1 就建立生产级的治理骨架**。等到用户量起来再加限流、加监控、改架构？那时候你已经因为一次 429 风暴丢失了第一批种子用户。演进路径：先做基础认证 + 限流（防滥用），再加成本监控（防烧钱），然后做模型路由 + Caching（省钱），最后做完整的 Webhook 事件系统（可观测）。*

---

**交叉引用**：
- 工具架构 → [02-tools-skills.md](02-tools-skills.md)（Function Calling 如何从多模型中抽象）
- 部署与高可用 → [09-deploy.md](09-deploy.md)（Docker Compose / CI/CD / 密钥管理）
- Function Calling 统一协议 → [11-function-calling.md](11-function-calling.md)（OpenAI/Anthropic 工具调用翻译的具体 Schema 差异）
- 多租户隔离 → [19-multi-tenancy.md](19-multi-tenancy.md)（租户级限流和配额的技术基础）
