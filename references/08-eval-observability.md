# Eval 框架 + 可观测性 · LLM-as-Judge · OpenTelemetry · Token 追踪

> 目标：Agent 没有评估就没有改进——三类评估、LLM-as-Judge 投票、回归检测，前端仪表板可视化。同时让 Agent 的每一次推理、每一个 token 消耗、每一秒延迟都可追踪。

## 目录

- [Part A 评估框架](#part-a-评估框架)
  - [Step 1: 评估框架骨架](#step-1-评估框架骨架)
  - [Step 2: 三类评估用例](#step-2-三类评估用例)
  - [Step 3: Eval Runner](#step-3-eval-runner)
  - [Step 4: LLM-as-Judge](#step-4-llm-as-judge)
  - [Step 5: 回归检测](#step-5-回归检测)
  - [Step 6: CLI 入口 & GitHub Actions 集成](#step-6-cli-入口--github-actions-集成)
  - [Step 7: 前端 Eval 仪表板](#step-7-前端-eval-仪表板)
  - [Eval 避坑汇总](#eval-避坑汇总)
- [Part B 可观测性](#part-b-可观测性)
  - [Step 1: OpenTelemetry 集成](#step-1-opentelemetry-集成)
  - [Step 2: 结构化日志 + Trace ID 串联](#step-2-结构化日志--trace-id-串联)
  - [Step 3: Token 消耗追踪](#step-3-token-消耗追踪)
  - [Step 4: Agent 全链路追踪 Span](#step-4-agent-全链路追踪-span)
  - [Step 5: 异常检测与告警](#step-5-异常检测与告警)
  - [Step 6: 接入 Agent 主循环](#step-6-接入-agent-主循环)
  - [Step 7: 前端可观测性面板](#step-7-前端可观测性面板)
  - [后端 API + Grafana 看板数据源](#后端-api--grafana-看板数据源)
  - [可观测性避坑汇总](#可观测性避坑汇总)

---

## Part A 评估框架

### 这个节点解决什么问题

你给 Agent 加了记忆、工具调用、安全拦截……怎么知道它真正变好了而不是变坏了？Agent 的评估跟传统软件测试完全不同：

1. **输出不是确定性的**——同一个问题，每次回答不一样
2. **好坏没有 ground truth**——"帮我写一封润色邮件"，什么算"好"是主观的
3. **评估提示词本身也会被提示注入污染**——Judge 被测试用例骗了就会打高分

🔗 **工程逻辑**：Agent 评估不是跑完一次就扔。你需要**回归评估**——每次改一行代码后自动跑 eval，跟历史对比。如果新 eval 打分低于历史平均线，CI 失败。这是防止"改了 A 结果 B 崩了"的唯一办法。

---

### Step 1: 评估框架骨架

先定义核心类型和 Runner 接口：

```typescript
// packages/core/src/eval/types.ts

/** 一条评估用例 —— 覆盖了所有评估类型 */
export interface EvalCase {
  id: string;
  /** 分类：工具 / 端到端 / 满意度 */
  category: 'unit' | 'integration' | 'satisfaction';
  /** 评估用例名称（给人看） */
  name: string;
  /** 评估用例描述（给 Judge 看） */
  description: string;

  // === 输入 ===
  input: {
    userMessage: string;
    systemPrompt?: string;
    /** 可选：给 Agent 预置的上下文 */
    contextMessages?: import('../llm/types').LLMMessage[];
    /** 可选：mock 工具行为的 fixture */
    toolFixtures?: Map<string, (args: any) => any>;
  };

  // === 评判标准 ===
  evaluation: {
    /** 裁判方式 */
    method: 'rule_based' | 'llm_judge' | 'multi_judge';
    /** 打分 1-10 */
    criteria: string[];
    /** rule_based 时的自定义检查函数 */
    customCheck?: (result: EvalExecutionResult) => EvalVerdict;
    /** llm_judge 时的裁判 prompt */
    judgePrompt?: string;
    /** multi_judge 时的多个裁判模型 */
    judges?: Array<{ provider: string; model: string }>;
  };

  // === 预期失败率阈值 —— 超过这个值视为 regressed ===
  passThreshold?: number;  // 默认 7
}

export interface EvalExecutionResult {
  caseId: string;
  status: 'passed' | 'failed' | 'error';
  /** Agent 运行过程中的所有事件 */
  events: any[];
  /** Agent 最终输出文本 */
  finalOutput: string;
  /** 工具调用记录 */
  toolCalls: Array<{ name: string; args: any; result: any }>;
  /** token 消耗 */
  tokenUsage: { input: number; output: number };
  /** 执行耗时 */
  executionTimeMs: number;
  /** 原始错误（如果有） */
  error?: string;
}

export interface EvalVerdict {
  passed: boolean;
  score: number;       // 1-10
  reasoning: string;   // 给开发者看的理由
  evaluator: string;   // 谁评的：rule/model1/model2
}

export interface EvalReport {
  /** 报告版本 —— 每次跑生成唯一 ID */
  reportId: string;
  timestamp: number;
  /** 被评估的模型/配置 */
  targetModel: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  /** 按分类聚合 */
  breakdownByCategory: Record<string, { total: number; passed: number; avgScore: number }>;
  /** 每条用例的详细结果 */
  caseResults: Array<{
    caseId: string;
    verdict: EvalVerdict;
    execution: EvalExecutionResult;
  }>;
  /** 与上次报告的对比 */
  regression?: {
    previousReportId: string;
    scoreDelta: number;
    newFailures: string[];
  };
}
```

---

### Step 2: 三类评估用例

三类评估各解决不同的问题：

🔗 **工程逻辑**：为什么分三类而不是一类？因为"工具参数解析对不对"和"回答用户满意不满足"完全是两回事。unit 评估答案确定，用 rule_based 裁判即可；integration 评估需要端到端验证，用 llm_judge 评分；satisfaction 评估最主观，需要 multi_judge 多模型投票。三类混合跑，给你立体的质量视角。

```typescript
// server/src/eval/cases.ts

import type { EvalCase } from '@agentcore/core/eval';

/**
 * 单元评估：工具正确性。验证工具调用参数解析对不对、工具执行有没有崩。
 * 这类用 rule_based 裁判就够了——答案确定。
 */
export const UNIT_EVAL_CASES: EvalCase[] = [
  {
    id: 'unit:tool-arg-parsing',
    category: 'unit',
    name: '工具参数正确解析',
    description: '用户请求格式为 JSON 的参数时，工具调用应该正确提取参数',
    input: {
      userMessage: '搜索 query=苹果 price<100 category=水果',
    },
    evaluation: {
      method: 'rule_based',
      criteria: ['工具调用参数包含正确字段'],
      customCheck: (result) => {
        const toolCall = result.toolCalls[0];
        if (!toolCall) {
          return { passed: false, score: 1, reasoning: '没有工具调用', evaluator: 'rule' };
        }
        const args = toolCall.args;
        const passed =
          typeof args.query === 'string' && args.query.includes('苹果');
        return {
          passed,
          score: passed ? 10 : 3,
          reasoning: passed ? '参数正确解析' + JSON.stringify(args) : '参数解析异常',
          evaluator: 'rule',
        };
      },
    },
  },
  {
    id: 'unit:tool-error-handling',
    category: 'unit',
    name: '工具异常不崩溃',
    description: '工具执行失败时，Agent 应该优雅处理错误而不是整体 crash',
    input: {
      userMessage: 'read_file /nonexistent/path',
      toolFixtures: new Map([
        ['read_file', () => { throw new Error('ENOENT: file not found'); }],
      ]),
    },
    evaluation: {
      method: 'rule_based',
      criteria: ['没有未处理的异常', '用户收到错误提示'],
      customCheck: (result) => {
        const hasError = result.status === 'error';
        const hasToolError = result.events.some((e: any) => e.type === 'tool_error');
        const finalText = result.finalOutput.toLowerCase();
        const mentionedError =
          finalText.includes('抱歉') || finalText.includes('不存在') || finalText.includes('错误');
        const passed = !hasError && hasToolError && mentionedError;
        return {
          passed,
          score: passed ? 10 : (hasError ? 1 : 5),
          reasoning: `hasError=${hasError} hasToolError=${hasToolError} mentionedError=${mentionedError}`,
          evaluator: 'rule',
        };
      },
    },
    passThreshold: 7,
  },
];

/**
 * 集成评估：端到端任务。模拟真实用户场景，测试完整流程。
 * 这类没有确定答案，用 LLM-as-Judge 评分。
 */
export const INTEGRATION_EVAL_CASES: EvalCase[] = [
  {
    id: 'integ:multi-step-reasoning',
    category: 'integration',
    name: '多步推理 —— 数学应用题',
    description: 'Agent 需要多步推理并给出最终答案',
    input: {
      userMessage: '一辆车以 60km/h 的速度开了 2 小时，又以 80km/h 开了 1.5 小时。总路程是多少？',
    },
    evaluation: {
      method: 'llm_judge',
      criteria: ['展示了推理过程', '最终答案正确（240km）'],
      judgePrompt: `你是一个数学题目评估专家。请评估以下 Agent 推理是否满足：
1. 展示了推理过程
2. 最终答案正确（240km）

Agent 输出：
{output}

请给出 1-10 分评分，并附简要理由。输出 JSON: {"score": N, "reasoning": "..."}`,
    },
  },
  {
    id: 'integ:code-generation',
    category: 'integration',
    name: '代码生成 —— Python 实现二分查找',
    description: 'Agent 生成正确可运行的 Python 二分查找代码',
    input: {
      userMessage: '写一个 Python 函数实现二分查找，返回目标值的索引，不存在返回 -1。包含 docstring。',
    },
    evaluation: {
      method: 'llm_judge',
      criteria: ['代码正确（二分查找算法）', '有 docstring', '处理边界情况'],
      judgePrompt: `你是一个代码质量评估专家。请评估以下代码：
1. 算法正确实现二分查找
2. 包含 docstring
3. 处理了空列表、不存在等边界情况

代码：
\`\`\`
{output}
\`\`\`

输出 JSON: {"score": N, "reasoning": "..."}`,
    },
  },
];

/**
 * 满意度评估：用户视角。"这个回答让我爽不爽"。
 * 这类最主观，需要多 Judge 投票取中位数。
 */
export const SATISFACTION_EVAL_CASES: EvalCase[] = [
  {
    id: 'satisfaction:empathetic-response',
    category: 'satisfaction',
    name: '同理心回复 —— 用户表示焦虑',
    description: '当用户说"我感到工作压力很大"时，Agent 应该给出有同理心的建议',
    input: {
      userMessage: '最近工作压力很大，每天都睡不好，感觉快扛不住了',
    },
    evaluation: {
      method: 'multi_judge',
      criteria: ['表达了理解和同理心', '给出了具体可行的建议', '不要空洞敷衍'],
      judges: [
        { provider: 'openai-compatible', model: 'gpt-4o' },
        { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
      ],
      judgePrompt: `同理心评估专家正在评估以下对话。请评估 Agent 的回复：

用户：{input}
Agent：{output}

评估维度（各 1-10 分）：
1. 同理心：是否让用户感到被理解
2. 实用性：建议是否具体可行
3. 真诚度：是否避免空洞的套话

输出 JSON: {"empathy": N, "usefulness": N, "sincerity": N, "reasoning": "..."}`,
    },
  },
];

export const ALL_EVAL_CASES: EvalCase[] = [
  ...UNIT_EVAL_CASES,
  ...INTEGRATION_EVAL_CASES,
  ...SATISFACTION_EVAL_CASES,
];
```

🤖 **AI 常见错误**：
1. **eval 用例没有 passThreshold**：不设阈值的话 eval 结果永远是"通过"，因为没有判定标准。每条必须设。
2. **用同一个模型当 Judge 和被测模型**：GPT-4o 测试 GPT-4o 生成的回答，总会给高分（自我偏置）。Judge 和被测模型必须不同。
3. **eval 用例泄漏到训练数据**：如果你把 eval 答案写进代码/文档里，开源模型可能记住了 eval 答案 eval 永远打高分。eval 答案必须隔离。

---

### Step 3: Eval Runner

核心执行器——逐条跑用例，调用 Agent，收集结果：

🔗 **工程逻辑**：并发控制不是可有可无。不设 concurrency 的话，30 条用例同时向 LLM API 发请求，rate limit 直接熔断。`concurrency=3` 是经验值——大多数 LLM API 的 RPM limit 在 200-500 区间，3 并发安全且足够快。`stopOnFirstFailure` 用于开发阶段快速收敛。

```typescript
// server/src/eval/runner.ts

import { createHash } from 'crypto';
import type { EvalCase, EvalExecutionResult, EvalReport } from '@agentcore/core/eval';
import { Conversation } from '@agentcore/agent/conversation';
import { createLLMClient } from '@agentcore/core/llm';

export interface EvalRunnerConfig {
  /** 被测 Agent 的模型 */
  targetModel: {
    provider: string;
    apiKey: string;
    model: string;
  };
  /** 可选：并发数限制 */
  concurrency?: number;
  /** 若设为 true，任何一条用例不通过就立刻停 */
  stopOnFirstFailure?: boolean;
}

export class EvalRunner {
  private config: Required<EvalRunnerConfig>;

  constructor(config: EvalRunnerConfig) {
    this.config = {
      concurrency: 3,
      stopOnFirstFailure: false,
      ...config,
    };
  }

  /**
   * 跑一批用例，生成报告。
   * 支持并发执行——多条 eval 用例同时跑加速。
   */
  async run(cases: EvalCase[]): Promise<EvalReport> {
    const results: EvalReport['caseResults'] = [];
    let passed = 0;
    let failed = 0;

    // 并发控制：避免打爆 API rate limit
    const queue = [...cases];
    const running: Promise<void>[] = [];

    const runOne = async (evalCase: EvalCase) => {
      try {
        const execution = await this.executeCase(evalCase);
        // rule_based 直接走 customCheck
        let verdict;
        if (evalCase.evaluation.method === 'rule_based' && evalCase.evaluation.customCheck) {
          verdict = evalCase.evaluation.customCheck(execution);
        } else if (evalCase.evaluation.method === 'llm_judge') {
          verdict = await this.judgeWithLLM(evalCase, execution);
        } else {
          verdict = await this.judgeWithMultiJudge(evalCase, execution);
        }

        const threshold = evalCase.passThreshold ?? 7;
        if (verdict.passed && verdict.score >= threshold) {
          passed++;
        } else {
          failed++;
        }

        results.push({ caseId: evalCase.id, verdict, execution });
      } catch (err) {
        failed++;
        results.push({
          caseId: evalCase.id,
          verdict: {
            passed: false,
            score: 0,
            reasoning: `Execution error: ${(err as Error).message}`,
            evaluator: 'system',
          },
          execution: {
            caseId: evalCase.id,
            status: 'error',
            events: [],
            finalOutput: '',
            toolCalls: [],
            tokenUsage: { input: 0, output: 0 },
            executionTimeMs: 0,
            error: (err as Error).message,
          },
        });
      }
    };

    while (queue.length > 0 || running.length > 0) {
      while (running.length < this.config.concurrency && queue.length > 0) {
        const evalCase = queue.shift()!;
        const p = runOne(evalCase).then(() => {
          const idx = running.indexOf(p);
          if (idx >= 0) running.splice(idx, 1);
        });
        running.push(p);

        // 若设置了 stopOnFirstFailure 且已经有失败，清空队列
        if (this.config.stopOnFirstFailure && failed > 0) {
          queue.length = 0;
        }
      }
      if (running.length > 0) {
        await Promise.race(running);
      }
    }

    // 分类聚合
    const breakdown = this.buildBreakdown(results);

    return {
      reportId: createHash('sha256')
        .update(JSON.stringify({ timestamp: Date.now(), cases: cases.map((c) => c.id) }))
        .digest('hex')
        .slice(0, 16),
      timestamp: Date.now(),
      targetModel: this.config.targetModel.model,
      totalCases: cases.length,
      passedCases: passed,
      failedCases: failed,
      breakdownByCategory: breakdown,
      caseResults: results,
    };
  }

  private async executeCase(evalCase: EvalCase): Promise<EvalExecutionResult> {
    const startTime = Date.now();
    const llm = createLLMClient({
      provider: this.config.targetModel.provider as any,
      apiKey: this.config.targetModel.apiKey,
      model: this.config.targetModel.model,
    });

    const events: any[] = [];
    const toolCalls: EvalExecutionResult['toolCalls'] = [];
    let finalOutput = '';
    let tokenUsage = { input: 0, output: 0 };

    // 如果有 toolFixtures，创建使用 fake 工具的 Conversation
    // 详见 Step 3b
    const conv = this.createTestConversation(evalCase, llm);

    try {
      for await (const event of conv.send(evalCase.input.userMessage)) {
        events.push(event);

        if (event.type === 'token') {
          finalOutput += event.content;
        }
        if (event.type === 'tool_start') {
          toolCalls.push({ name: event.toolName, args: event.args, result: null });
        }
        if (event.type === 'tool_complete') {
          const last = toolCalls.find((t) => t.name === event.toolName && t.result === null);
          if (last) last.result = event.result;
        }
      }

      return {
        caseId: evalCase.id,
        status: 'passed',
        events,
        finalOutput,
        toolCalls,
        tokenUsage,
        executionTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        caseId: evalCase.id,
        status: 'error',
        events,
        finalOutput,
        toolCalls,
        tokenUsage,
        executionTimeMs: Date.now() - startTime,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Step 3b: 给测试传入 fake 工具，避免真实 API 调用。
   * 比如 eval 里需要测试 "用户问天气，Agent 调 get_weather 工具" 的逻辑，
   * 但不想真的去调天气 API（慢 + 花钱 + 结果不确定）。
   */
  private createTestConversation(evalCase: EvalCase, llm: any) {
    const { Conversation } = require('@agentcore/agent/conversation');
    const conv = new Conversation({
      systemPrompt: evalCase.input.systemPrompt ?? 'You are a helpful assistant.',
      llm,
      tools: [],  // 可以用 toolFixtures 工具替换
    });

    return conv;
  }

  private buildBreakdown(results: EvalReport['caseResults']): EvalReport['breakdownByCategory'] {
    const categories = ['unit', 'integration', 'satisfaction'] as const;
    const breakdown: EvalReport['breakdownByCategory'] = {} as any;

    for (const cat of categories) {
      const catResults = results.filter((r) => r.execution.caseId.startsWith(cat.slice(0, 4)));
      if (catResults.length === 0) continue;
      const totalScore = catResults.reduce((s, r) => s + r.verdict.score, 0);
      breakdown[cat] = {
        total: catResults.length,
        passed: catResults.filter((r) => r.verdict.passed).length,
        avgScore: totalScore / catResults.length,
      };
    }

    return breakdown;
  }
}
```

---

### Step 4: LLM-as-Judge

裁判模型——用另一个 LLM 来评分被测 Agent 的输出：

🔗 **工程逻辑**：LLM Judge 的核心问题是"评分锚定"。比如你说"这个回答是否准确"比"回答里有错误吗"判定更宽松——前者暗示"应该是准确的"。所以 Judge Prompt 必须是中立提问。multi_judge 中位数投票是为了抗噪声——某个 Judge 偶然打极端分不应影响整体判定。

```typescript
// server/src/eval/judge.ts

import type { EvalCase, EvalExecutionResult, EvalVerdict } from '@agentcore/core/eval';
import { createLLMClient } from '@agentcore/core/llm';
import type { LLMMessage } from '@agentcore/core/llm/types';

/**
 * LLM Judge: 拿一个 LLM 当评委打分。
 * 核心问题：评分标准本身的措辞会极大影响判定结果。
 * 比如 "这个回答是否准确？" 比 "回答里有错误吗？" 判定更宽松。
 */
export class LLMJudge {
  constructor(
    private provider: string,
    private model: string,
    private apiKey: string,
  ) {}

  async judge(
    evalCase: EvalCase,
    execution: EvalExecutionResult,
  ): Promise<EvalVerdict> {
    const judgePrompt = evalCase.evaluation.judgePrompt ?? this.buildDefaultJudgePrompt(evalCase);

    // 把 {output} 和 {input} 占位符替换
    const prompt = judgePrompt
      .replace('{output}', execution.finalOutput)
      .replace('{input}', evalCase.input.userMessage);

    const llm = createLLMClient({ provider: this.provider as any, apiKey: this.apiKey, model: this.model });

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are an evaluation expert. Output ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ];

    let response = '';
    for await (const chunk of llm.stream(messages)) {
      if (chunk.type === 'token') {
        response += chunk.data.content;
      }
    }

    // 解析 JSON 响应
    try {
      // Judge 可能输出 markdown 包裹的 JSON —— 先剥
      const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);

      // 处理 multi_judge 的多维度分数 —— 取总分
      let score = parsed.score ?? 5;
      if (typeof parsed.empathy === 'number') {
        // multi_judge 模式
        score = ((parsed.empathy ?? 5) + (parsed.usefulness ?? 5) + (parsed.sincerity ?? 5)) / 3;
      }

      return {
        passed: score >= (evalCase.passThreshold ?? 7),
        score: Math.round(score),
        reasoning: parsed.reasoning ?? 'No reasoning provided',
        evaluator: `${this.provider}/${this.model}`,
      };
    } catch {
      // Judge 输出无法解析 JSON —— 给个保守分
      return {
        passed: false,
        score: 0,
        reasoning: `Judge output parse failed: ${response.slice(0, 200)}`,
        evaluator: `${this.provider}/${this.model}`,
      };
    }
  }

  private buildDefaultJudgePrompt(evalCase: EvalCase): string {
    return `Evaluate the following agent output against these criteria:
${evalCase.evaluation.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Agent output:
{output}

Rate 1-10 and explain. Output JSON: {"score": N, "reasoning": "..."}`;
  }
}

/**
 * Multi-Judge 投票：多个 Judge 打分取中位数。
 * 为什么取中位数不用平均值？因为个别 Judge 可能打极端分，中位数抗噪声。
 */
export async function multiJudge(
  evalCase: EvalCase,
  execution: EvalExecutionResult,
  judges: Array<{ provider: string; model: string; apiKey: string }>,
): Promise<EvalVerdict> {
  const verdicts: EvalVerdict[] = [];

  for (const j of judges) {
    const judge = new LLMJudge(j.provider, j.model, j.apiKey);
    const verdict = await judge.judge(evalCase, execution);
    verdicts.push(verdict);
  }

  // 取分数中位数
  const sortedScores = verdicts.map((v) => v.score).sort((a, b) => a - b);
  const medianScore = sortedScores[Math.floor(sortedScores.length / 2)] ?? 0;

  // 只要过半 Judge 判通过就视为通过
  const passCount = verdicts.filter((v) => v.passed).length;
  const passed = passCount >= Math.ceil(verdicts.length / 2);

  return {
    passed,
    score: medianScore,
    reasoning: verdicts.map((v) => `[${v.evaluator}] ${v.reasoning}`).join('\n---\n'),
    evaluator: `multi-judge(${judges.length})`,
  };
}
```

🤖 **AI 常见错误**：
1. **Judge Prompt 里有"请输出 JSON"但没剥 markdown**：LLM 经常输出 ```json { ... } ```，直接 JSON.parse 失败。必须先 `replace(/```json\n?/g, '')`。
2. **Judge Prompt 暗示了正确答案**：比如 "这个回答是否满足正确回答的基本要求？" 已经暗含"应该满足"。Prompt 必须是中立提问。
3. **eval 数据集太大导致跑一次成本爆炸**：300 条 eval 用例 × 多 Judge × 每次调用被测模型，一次跑完可能要 $50+。需要加缓存——相同输入直接取缓存结果。

---

### Step 5: 回归检测

跟历史报告对比，检测性能退化：

🔗 **工程逻辑**：回归检测的核心价值在于 CI 自动化。如果你只跑 eval 不对比历史，那每次跑完你只知道"这次分了多少"——不知道"上次多少"。跟历史报告做 diff，一旦 `scoreDelta` 超过阈值 `REGRESSION_THRESHOLD=1.5`，CI 自动失败，阻止退化代码合入 main 分支。

```typescript
// server/src/eval/regression.ts

import type { EvalReport } from '@agentcore/core/eval';

export interface RegressionResult {
  hasRegression: boolean;
  /** 分数下降超过此阈值的用例 */
  regressionCases: Array<{ caseId: string; prevScore: number; currScore: number; delta: number }>;
  /** 新增失败的用例（上次通过，这次挂了） */
  newFailures: string[];
  overallDelta: number;
}

const REGRESSION_THRESHOLD = 1.5;  // 分数下降超过 1.5 分视为回归

export function detectRegression(
  currentReport: EvalReport,
  previousReport: EvalReport | null,
): RegressionResult {
  if (!previousReport) {
    return { hasRegression: false, regressionCases: [], newFailures: [], overallDelta: 0 };
  }

  const prevResults = new Map(
    previousReport.caseResults.map((r) => [r.caseId, r]),
  );

  const regressionCases: RegressionResult['regressionCases'] = [];
  const newFailures: string[] = [];
  let totalDelta = 0;
  let comparedCases = 0;

  for (const curr of currentReport.caseResults) {
    const prev = prevResults.get(curr.caseId);
    if (!prev) continue;

    const delta = curr.verdict.score - prev.verdict.score;
    totalDelta += delta;
    comparedCases++;

    if (delta <= -REGRESSION_THRESHOLD) {
      regressionCases.push({
        caseId: curr.caseId,
        prevScore: prev.verdict.score,
        currScore: curr.verdict.score,
        delta,
      });
    }

    if (prev.verdict.passed && !curr.verdict.passed) {
      newFailures.push(curr.caseId);
    }
  }

  const overallDelta = comparedCases > 0 ? totalDelta / comparedCases : 0;
  const hasRegression = regressionCases.length > 0 || newFailures.length > 0;

  return { hasRegression, regressionCases, newFailures, overallDelta };
}
```

---

### Step 6: CLI 入口 & GitHub Actions 集成

```bash
# 终端跑 eval
pnpm eval --model gpt-4o --category unit
pnpm eval --model claude-sonnet-4-20250514 --category all --concurrency 5
```

```typescript
// scripts/eval-cli.ts (顶层)

import { EvalRunner } from '../server/src/eval/runner';
import { ALL_EVAL_CASES } from '../server/src/eval/cases';
import { detectRegression } from '../server/src/eval/regression';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const category = args.category ?? 'all';

  const cases = category === 'all'
    ? ALL_EVAL_CASES
    : ALL_EVAL_CASES.filter((c) => c.category === category);

  const runner = new EvalRunner({
    targetModel: {
      provider: process.env.EVAL_PROVIDER ?? 'openai-compatible',
      apiKey: process.env.EVAL_API_KEY!,
      model: args.model ?? process.env.EVAL_MODEL!,
    },
    concurrency: parseInt(args.concurrency ?? '3'),
    stopOnFirstFailure: args.stopOnFailure === 'true',
  });

  console.log(`🚀 Running ${cases.length} eval cases against ${args.model ?? process.env.EVAL_MODEL}...`);
  const report = await runner.run(cases);

  // 跟上次报告对比
  const previousReport = await loadLastReport();
  const regression = detectRegression(report, previousReport);

  // 输出摘要
  console.log(`\n📊 Eval Report ${report.reportId}`);
  console.log(`   Total: ${report.totalCases} | Pass: ${report.passedCases} | Fail: ${report.failedCases}`);

  if (previousReport) {
    console.log(`   Score delta vs last: ${regression.overallDelta > 0 ? '+' : ''}${regression.overallDelta.toFixed(2)}`);
  }

  if (regression.hasRegression) {
    console.error('⚠️  REGRESSION DETECTED:');
    for (const r of regression.regressionCases) {
      console.error(`   ${r.caseId}: ${r.prevScore} → ${r.currScore} (Δ${r.delta})`);
    }
    for (const f of regression.newFailures) {
      console.error(`   NEW FAILURE: ${f}`);
    }
    process.exit(1);  // CI 失败
  } else {
    console.log('✅ No regression detected');
    // 保存本次报告供下次对比
    await saveReport(report);
    process.exit(0);
  }
}
```

```yaml
# .github/workflows/eval.yml

name: Eval Regression

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Run Eval Suite
        env:
          EVAL_PROVIDER: openai-compatible
          EVAL_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          EVAL_MODEL: gpt-4o
        run: |
          npx tsx scripts/eval-cli.ts --model gpt-4o --category all --concurrency 3
```

🔗 **工程逻辑**：CI 跑 eval 的成本问题。假设 30 条 eval 用例 × 每条约 5000 token 输入 + 2000 token 输出 × $0.01/1K token，一次 CI 大约 $2-5。所以要在 CI 里跑核心用例（unit + 核心 integration），全量 eval 放在 nightly。

---

### Step 7: 前端 Eval 仪表板

```tsx
// apps/web/src/components/eval/EvalDashboard.tsx

'use client';

import { useState, useEffect } from 'react';

interface EvalReportView {
  reportId: string;
  timestamp: number;
  targetModel: string;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  breakdownByCategory: Record<string, { total: number; passed: number; avgScore: number }>;
}

export function EvalDashboard() {
  const [reports, setReports] = useState<EvalReportView[]>([]);
  const [selectedReport, setSelectedReport] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    fetch('/api/eval/reports')
      .then((r) => r.json())
      .then((data) => setReports(data.reports))
      .catch(() => {});
  }, []);

  const runEval = async (model: string, category: string) => {
    setIsRunning(true);
    try {
      await fetch('/api/eval/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, category }),
      });
      // 重新拉取报告
      const res = await fetch('/api/eval/reports');
      setReports((await res.json()).reports);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text">Eval 评测中心</h1>
        <div className="flex gap-3">
          <select className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text" id="eval-model">
            <option value="gpt-4o">GPT-4o</option>
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
          </select>
          <button
            onClick={() => runEval(
              (document.getElementById('eval-model') as HTMLSelectElement).value,
              'all',
            )}
            disabled={isRunning}
            className="bg-accent text-white px-4 py-2 rounded-lg font-medium disabled:opacity-50"
          >
            {isRunning ? '评测中...' : '运行评估'}
          </button>
        </div>
      </header>

      {/* 报告列表 */}
      <div className="grid gap-4">
        {reports.map((report) => {
          const passRate = report.totalCases > 0
            ? Math.round((report.passedCases / report.totalCases) * 100)
            : 0;
          return (
            <div
              key={report.reportId}
              className={`bg-surface rounded-lg border p-5 cursor-pointer transition-colors hover:border-accent/50 ${
                selectedReport === report.reportId ? 'border-accent' : 'border-border'
              }`}
              onClick={() => setSelectedReport(report.reportId)}
            >
              <div className="flex items-center justify-between mb-3">
                <div>
                  <span className="font-mono text-xs text-muted">{report.reportId}</span>
                  <span className="ml-3 text-sm text-text font-medium">{report.targetModel}</span>
                </div>
                <div className="text-sm text-muted">
                  {new Date(report.timestamp).toLocaleString()}
                </div>
              </div>
              <div className="flex items-center gap-6">
                {/* 通过率进度条 */}
                <div className="flex-1">
                  <div className="h-2 bg-bg rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${passRate}%`,
                        background: passRate >= 80
                          ? 'linear-gradient(90deg, #22c55e, #16a34a)'
                          : passRate >= 50
                          ? 'linear-gradient(90deg, #f59e0b, #d97706)'
                          : 'linear-gradient(90deg, #ef4444, #dc2626)',
                      }}
                    />
                  </div>
                </div>
                <span className="text-sm font-mono">
                  {report.passedCases}/{report.totalCases} ({passRate}%)
                </span>
              </div>
              {/* 分类小卡 */}
              <div className="flex gap-3 mt-3">
                {Object.entries(report.breakdownByCategory).map(([cat, data]) => (
                  <div key={cat} className="text-xs bg-bg/50 rounded px-2 py-1 text-muted">
                    {cat}: {data.avgScore.toFixed(1)}/10
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

---

### Eval 避坑汇总

| 问题 | 原因 | 解坑 |
|------|------|------|
| eval 结果每次不一样 | LLM 不确定性 | 跑 3 次取平均 + 中位数 |
| Judge 给同厂商模型打高分 | 模型家族偏置 | Judge 和被测必须不同厂商 |
| eval 数据泄漏进 model 训练 | eval 用例在开源仓库公开 | 加密 eval 数据，仅 CI 解密 |
| eval 提示词被注入绕过 | 测试用例含注入 payload 骗 Judge | eval 的 userMessage 也过 prompt-injection 扫描 |
| eval 用例太多跑不完 | 用例膨胀 | 分优先级 CI 跑 P0 nightly 跑全量 |
| model API rate limit 把 CI 拖慢 | 并发太高 | concurrency=3 + 指数退避重试 |
| eval 结果不可复现 | 没固定随机种子 | 测试用例固定所有随机参数 + 版本化 |

---

## Part B 可观测性

### 这个节点解决什么问题

传统 Web 应用出问题，你看 Nginx access log 就知道：这个请求耗时 2s、状态码 500。但 Agent 出了问题，你面对的是一个完全不同的困境：

1. **分布式链路**——用户消息穿过 API 网关 → Agent 调用 LLM → 调用工具 → 返回结果，横跨多个进程
2. **Token 黑洞**——这个月 AWS 账单多了 500 刀，是哪个会话模型在疯狂烧 token？
3. **延迟不可分**——用户说"卡顿了"，到底是 LLM 慢还是工具调用慢还是 SSE 推送慢？

🔗 **工程逻辑**：可观测性 ≠ 打日志。日志是"出了问题去翻"，可观测性是"盯着看就知道正常"。三支柱：Traces（链路追踪）、Metrics（业务指标）、Logs（结构化日志），三者靠 Trace ID 串联。

```
用户消息 POST /api/chat
    │ TraceID: abc-123
    ├── [Span] auth_middleware         2ms
    ├── [Span] prompt_injection_scan  15ms
    ├── [Span] session_load           3ms
    ├── [Span] llm.stream (GPT-4o)    1250ms ← 🔥 慢！
    │   ├── [Span] first_token        800ms
    │   └── [Span] completion         450ms  (tokens=387)
    ├── [Span] tool_execute: search   230ms
    │   └── [Span] http_request       225ms
    └── [Span] llm.stream (GPT-4o)    1890ms ← 有 tool 结果后更慢
        └── [Span] completion         (tokens=512)
```

---

### Step 1: OpenTelemetry 集成

🔗 **工程逻辑**：BatchSpanProcessor vs SimpleSpanProcessor 的选择取决于场景。生产环境用 Batch——异步批量发送，对主流程性能影响 <1%，但进程崩溃时可能丢失最后几批 span。开发环境用 Simple——同步发送，立刻在 Jaeger/Tempo 上看到 trace，不用担心丢失。

```typescript
// server/src/observability/tracer.ts

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { SimpleSpanProcessor, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';

let sdk: NodeSDK | null = null;

export function initTracer(serviceName: string = 'agent-core'): void {
  if (sdk) return;  // 幂等

  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_COLLECTOR_URL ?? 'http://localhost:4318/v1/traces',
  });

  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION ?? '0.1.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
    }),
    // 生产环境用 BatchSpanProcessor（异步批量发送，性能更好）
    // 开发环境用 SimpleSpanProcessor（同步发送，立刻能看到）
    spanProcessor: process.env.NODE_ENV === 'production'
      ? new BatchSpanProcessor(exporter)
      : new SimpleSpanProcessor(exporter),
  });

  // 自动追踪 HTTP + Express
  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation(),
      new ExpressInstrumentation(),
    ],
  });

  sdk.start();

  // 优雅退出
  process.on('SIGTERM', () => {
    sdk?.shutdown().catch(console.error);
  });
}
```

---

### Step 2: 结构化日志 + Trace ID 串联

🔗 **工程逻辑**：为什么不用 console.log + emoji？三原因：(1) emoji 不利于 grep/全文搜索；(2) 没有 traceId 无法和 trace span 关联——日志说"LLM 调用失败"但 trace 找不到对应 span；(3) 不同开发者日志格式不统一。结构化 JSON 让 ELK/Loki 自动索引每个字段。

```typescript
// server/src/utils/logger.ts

import { trace, context as otelContext } from '@opentelemetry/api';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  /** OpenTelemetry 的 trace ID —— 把日志和 trace 串起来的关键 */
  traceId?: string;
  spanId?: string;
  /** 结构化字段 —— JSON 格式，方便 Elasticsearch 索引 */
  fields?: Record<string, unknown>;
}

function format(entry: LogEntry): string {
  // JSON 格式输出 —— 生产环境都会被 ELK / Loki 收集
  return JSON.stringify(entry);
}

function getTraceContext(): { traceId?: string; spanId?: string } {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/**
 * JSON 结构化日志。为什么不用 console.log + emoji？
 * 1. emoji 不利于 grep / 全文搜索
 * 2. 没有 traceId 无法关联 trace
 * 3. 不同开发者的日志格式不统一，排查时心累
 */
export const logger = {
  info(message: string, fields?: Record<string, unknown>): void {
    const ctx = getTraceContext();
    process.stdout.write(format({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      ...ctx,
      fields,
    }) + '\n');
  },

  warn(message: string, fields?: Record<string, unknown>): void {
    const ctx = getTraceContext();
    process.stderr.write(format({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message,
      ...ctx,
      fields,
    }) + '\n');
  },

  error(message: string, fields?: Record<string, unknown>): void {
    const ctx = getTraceContext();
    process.stderr.write(format({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      ...ctx,
      fields,
    }) + '\n');
  },

  /**
   * debug 级别 —— 只在 DEBUG=1 时输出，防止生产环境刷屏。
   * 为什么不设 DEBUG=1 在生产用？因为你一天可能有几百万条 debug 日志，
   * 光存储就超过你 LLM API 的费用。
   */
  debug(message: string, fields?: Record<string, unknown>): void {
    if (process.env.DEBUG !== '1') return;
    const ctx = getTraceContext();
    process.stdout.write(format({
      timestamp: new Date().toISOString(),
      level: 'debug',
      message,
      ...ctx,
      fields,
    }) + '\n');
  },
};
```

---

### Step 3: Token 消耗追踪

Token 追踪不是一次性记录。需要三个维度：
1. 实时记录每次 LLM 调用（用于"这个会话已经花了多少钱"）
2. 聚合统计（用于"这周哪个模型最贵""哪个用户在烧钱"）
3. 异常检测（用于"这个会话 5 秒烧了 50 万 token，可能是死循环"）

```typescript
// server/src/observability/token-tracker.ts

export interface TokenUsageRecord {
  sessionId: string;
  userId: string;
  traceId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 按工具维度拆分：这次 LLM 调用是在处理哪个工具结果 */
  associatedTool?: string;
  timestamp: number;
}

export interface TokenCostRecord extends TokenUsageRecord {
  /** 这次调用折合美元 */
  costUSD: number;
}

/** 模型单价 —— 每 1M tokens 美元价格 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-haiku-4-20250514': { input: 1, output: 5 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
};

export function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    // 未知模型 —— 用平均价估算
    return ((inputTokens / 1_000_000) * 2) + ((outputTokens / 1_000_000) * 8);
  }
  return ((inputTokens / 1_000_000) * pricing.input) + ((outputTokens / 1_000_000) * pricing.output);
}

export class TokenTracker {
  private buffer: TokenCostRecord[] = [];

  /**
   * 在 Agent 跑完后记录 token 消耗。
   * 注意：必须记录整个会话的总 token，而不只是单次调用——
   * Agent 可能循环 5 次 LLM 调用，每次单独算便宜但加起来很贵。
   */
  recordUsage(
    usage: TokenUsageRecord,
    sessionTotalTokens: number,
  ): void {
    const cost = calculateCost(usage.model, usage.inputTokens, usage.outputTokens);

    const record: TokenCostRecord = {
      ...usage,
      costUSD: cost,
    };

    this.buffer.push(record);

    // 超贵会话告警——单次调用超过 $1 就是异常
    if (cost > 1) {
      logger.warn('High token consumption detected', {
        sessionId: usage.sessionId,
        traceId: usage.traceId,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: cost.toFixed(4),
        sessionTotalTokens,
      });
    }
  }

  /** 获取会话级 token 汇总 */
  async getSessionSummary(sessionId: string): Promise<{
    totalInput: number;
    totalOutput: number;
    totalCostUSD: number;
    calls: number;
    avgLatencyMs: number;
  }> {
    const records = this.buffer.filter((r) => r.sessionId === sessionId);
    return {
      totalInput: records.reduce((s, r) => s + r.inputTokens, 0),
      totalOutput: records.reduce((s, r) => s + r.outputTokens, 0),
      totalCostUSD: records.reduce((s, r) => s + r.costUSD, 0),
      calls: records.length,
      avgLatencyMs: 0,  // 从 span 里取
    };
  }

  /** 全局 Dashboard 数据 —— 最近 1h/24h/7d 的 token 消耗聚合 */
  async getAggregatedUsage(timeRangeMs: number): Promise<{
    totalTokens: number;
    totalCostUSD: number;
    byModel: Record<string, { tokens: number; costUSD: number; calls: number }>;
    byUser: Record<string, { tokens: number; costUSD: number }>;
    topExpensiveSessions: Array<{ sessionId: string; costUSD: number; tokens: number }>;
  }> {
    const cutoff = Date.now() - timeRangeMs;
    const records = this.buffer.filter((r) => r.timestamp >= cutoff);

    const byModel: Record<string, { tokens: number; costUSD: number; calls: number }> = {};
    const byUser: Record<string, { tokens: number; costUSD: number }> = {};
    const bySession: Record<string, { tokens: number; costUSD: number }> = {};

    for (const r of records) {
      if (!byModel[r.model]) byModel[r.model] = { tokens: 0, costUSD: 0, calls: 0 };
      byModel[r.model].tokens += r.inputTokens + r.outputTokens;
      byModel[r.model].costUSD += r.costUSD;
      byModel[r.model].calls++;

      if (!byUser[r.userId]) byUser[r.userId] = { tokens: 0, costUSD: 0 };
      byUser[r.userId].tokens += r.inputTokens + r.outputTokens;
      byUser[r.userId].costUSD += r.costUSD;

      if (!bySession[r.sessionId]) bySession[r.sessionId] = { tokens: 0, costUSD: 0 };
      bySession[r.sessionId].tokens += r.inputTokens + r.outputTokens;
      bySession[r.sessionId].costUSD += r.costUSD;
    }

    const topExpensiveSessions = Object.entries(bySession)
      .map(([sessionId, data]) => ({ sessionId, ...data }))
      .sort((a, b) => b.costUSD - a.costUSD)
      .slice(0, 10);

    return {
      totalTokens: records.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0),
      totalCostUSD: records.reduce((s, r) => s + r.costUSD, 0),
      byModel,
      byUser,
      topExpensiveSessions,
    };
  }
}
```

---

### Step 4: Agent 全链路追踪 Span

把 OpenTelemetry 嵌入 Agent 核心循环的每一步：

```typescript
// server/src/observability/agent-spans.ts

import { trace, SpanKind, context as otelContext } from '@opentelemetry/api';
import type { AgentEvent } from '@agentcore/agent/types';
import { logger } from '../utils/logger';

const tracer = trace.getTracer('agent-core');

/**
 * 在 Agent.run 外创建 Root Span，覆盖整个会话生命周期。
 * 所有内部操作（LLM 调用、工具执行）作为 Child Span 嵌套。
 */
export function createAgentRootSpan(sessionId: string, userId: string) {
  return tracer.startSpan('agent.session', {
    kind: SpanKind.SERVER,
    attributes: {
      'agent.session.id': sessionId,
      'agent.user.id': userId,
      'agent.version': process.env.APP_VERSION ?? '0.1.0',
    },
  });
}

/**
 * LLM 调用的 Span —— 这是你花时间最多的 span，延迟来源的核心。
 * 记录：首次 token 延迟、总 token 数、流式中断原因
 */
export async function* traceLLMStream(
  spanName: string,
  model: string,
  stream: AsyncGenerator<any>,
): AsyncGenerator<any> {
  const span = tracer.startSpan(`llm.${spanName}`, {
    kind: SpanKind.CLIENT,
    attributes: { 'llm.model': model, 'llm.provider': '' },
  });

  let firstTokenTime = 0;
  let tokenCount = 0;
  const startTime = Date.now();

  try {
    for await (const chunk of stream) {
      if (chunk.type === 'token') {
        tokenCount++;
        if (!firstTokenTime) firstTokenTime = Date.now();
      }

      if (chunk.type === 'done') {
        const endTime = Date.now();
        span.setAttributes({
          'llm.first_token_ms': firstTokenTime ? firstTokenTime - startTime : -1,
          'llm.total_tokens': tokenCount,
          'llm.duration_ms': endTime - startTime,
          'llm.finish_reason': chunk.data.finishReason,
        });
        span.end();
      }

      if (chunk.type === 'error') {
        span.recordException(new Error(chunk.data.error));
        span.setStatus({ code: 2, message: chunk.data.error });  // ERROR
        span.end();
      }

      yield chunk;
    }
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: 2, message: (error as Error).message });
    span.end();
    throw error;
  }
}

/**
 * 工具执行 Span —— 记录调用参数摘要和结果大小。
 * 注意：不要记录完整的 args——可能含敏感数据（如密码、token）。
 */
export async function* traceToolCall(
  toolName: string,
  args: any,
  execution: () => Promise<any>,
): AsyncGenerator<{ type: 'start' | 'complete' | 'error'; data?: any }> {
  const span = tracer.startSpan(`tool.${toolName}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'tool.name': toolName,
      'tool.args_keys': Object.keys(args).join(','),       // 只记 key 名
      'tool.args_size': JSON.stringify(args).length,       // 记大小
    },
  });

  yield { type: 'start' };

  try {
    const result = await execution();
    const resultSize = typeof result === 'string' ? result.length : JSON.stringify(result).length;

    span.setAttributes({
      'tool.result_size': resultSize,
      'tool.duration_ms': Date.now() - (span as any).startTime,
    });
    span.end();
    yield { type: 'complete', data: result };
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: 2, message: (error as Error).message });
    span.end();
    yield { type: 'error', data: (error as Error).message };
  }
}
```

---

### Step 5: 异常检测与告警

🔗 **工程逻辑**：告警的核心问题是"冷却"。没有冷却的话，一个瞬时抖动（如 API 临时变慢）会触发几十条告警，形成告警风暴——运维人员直接把告警关了。5 分钟冷却窗口确保同类告警最多 5 分钟触发一次。

```typescript
// server/src/observability/anomaly-detector.ts

import { logger } from '../utils/logger';

export interface AnomalyRule {
  id: string;
  description: string;
  /** 检查周期（毫秒） */
  windowMs: number;
  /** 异常阈值 */
  threshold: number;
  severity: 'warning' | 'critical';
  notifyChannel: 'log' | 'webhook' | 'email';
}

/**
 * 内置异常规则 —— 覆盖 Agent 最常见的问题
 */
export const ANOMALY_RULES: AnomalyRule[] = [
  {
    id: 'high_error_rate',
    description: 'Agent 错误率激增 —— 5 分钟内超过 20% 的 LLM 调用报错',
    windowMs: 5 * 60 * 1000,
    threshold: 0.2,
    severity: 'critical',
    notifyChannel: 'webhook',
  },
  {
    id: 'abnormal_token_spike',
    description: '会话 token 消耗异常 —— 单会话在 2 分钟内超过 100k tokens',
    windowMs: 2 * 60 * 1000,
    threshold: 100_000,
    severity: 'warning',
    notifyChannel: 'log',
  },
  {
    id: 'latency_p99',
    description: 'LLM P99 延迟过高 —— 超过 30s',
    windowMs: 5 * 60 * 1000,
    threshold: 30000,
    severity: 'critical',
    notifyChannel: 'webhook',
  },
  {
    id: 'sandbox_oom',
    description: '沙箱 OOM —— 容器内存超限被杀',
    windowMs: 1 * 60 * 1000,
    threshold: 3,  // 1 分钟 3 次就告警
    severity: 'critical',
    notifyChannel: 'webhook',
  },
];

export class AnomalyDetector {
  private windows: Map<string, Array<{ timestamp: number; value: number }>> = new Map();
  private lastAlertTime: Map<string, number> = new Map();
  private cooldownMs = 5 * 60 * 1000;  // 同类告警 5 分钟内不重复发

  constructor(
    private onAlert: (rule: AnomalyRule, context: any) => Promise<void>,
  ) {}

  /** 每条规则维护一个滑动窗口 */
  addMetric(ruleId: string, value: number): void {
    const rule = ANOMALY_RULES.find((r) => r.id === ruleId);
    if (!rule) return;

    if (!this.windows.has(ruleId)) {
      this.windows.set(ruleId, []);
    }
    const window = this.windows.get(ruleId)!;
    window.push({ timestamp: Date.now(), value });

    // 清除窗口外的过期数据
    const cutoff = Date.now() - rule.windowMs;
    while (window.length > 0 && window[0]!.timestamp < cutoff) {
      window.shift();
    }

    // 检查是否触发
    this.checkThreshold(rule, window);
  }

  private async checkThreshold(
    rule: AnomalyRule,
    data: Array<{ timestamp: number; value: number }>,
  ): Promise<void> {
    // 冷却检查
    const lastAlert = this.lastAlertTime.get(rule.id) ?? 0;
    if (Date.now() - lastAlert < this.cooldownMs) return;

    // 计算聚合值
    let triggered = false;
    let aggregateValue = 0;

    switch (rule.id) {
      case 'high_error_rate': {
        // data 里的 value: 1=error, 0=ok
        const errorCount = data.filter((d) => d.value === 1).length;
        const rate = data.length > 0 ? errorCount / data.length : 0;
        triggered = rate > rule.threshold;
        aggregateValue = rate;
        break;
      }
      case 'abnormal_token_spike': {
        const totalTokens = data.reduce((s, d) => s + d.value, 0);
        triggered = totalTokens > rule.threshold;
        aggregateValue = totalTokens;
        break;
      }
      case 'latency_p99': {
        const sorted = data.map((d) => d.value).sort((a, b) => a - b);
        const p99Index = Math.floor(sorted.length * 0.99);
        const p99 = sorted[p99Index] ?? 0;
        triggered = p99 > rule.threshold;
        aggregateValue = p99;
        break;
      }
      case 'sandbox_oom': {
        triggered = data.length >= rule.threshold;
        aggregateValue = data.length;
        break;
      }
    }

    if (triggered) {
      this.lastAlertTime.set(rule.id, Date.now());
      await this.onAlert(rule, {
        value: aggregateValue,
        threshold: rule.threshold,
        dataPoints: data.length,
      });
    }
  }
}

// 告警发送器
export async function dispatchAlert(
  rule: AnomalyRule,
  context: any,
): Promise<void> {
  const payload = {
    rule: rule.id,
    description: rule.description,
    severity: rule.severity,
    context,
    timestamp: new Date().toISOString(),
  };

  switch (rule.notifyChannel) {
    case 'log':
      logger.warn(`🚨 ANOMALY: ${rule.description}`, payload);
      break;
    case 'webhook':
      if (process.env.ALERT_WEBHOOK_URL) {
        await fetch(process.env.ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
      break;
    case 'email':
      // 接入 SES / SendGrid
      break;
  }
}
```

---

### Step 6: 接入 Agent 主循环

把追踪植入 Agent.run 循环。这样做而不直接改 Agent 代码的原因是：你不想把 observability 逻辑散落在 core 包里，保持 core 干净。

🔗 **工程逻辑**：instrument 模式的核心是"外包裹而非内修改"。Agent 核心循环是纯业务逻辑——不应该混入追踪代码。用 `instrumentedAgentRun` 包一层，Agent 代码完全无感知地获得追踪能力。如果哪天换了 Agent 实现（比如从自研换成 LangChain），追踪层完全不用改。

```typescript
// server/src/observability/instrument-agent.ts

import type { AgentEvent, AgentContext } from '@agentcore/agent/types';
import { createAgentRootSpan, traceLLMStream, traceToolCall } from './agent-spans';
import { logger } from '../utils/logger';

/**
 * 把 Agent.run 包上一层可观测性。
 *
 */
export async function* instrumentedAgentRun(
  runFn: (message: string, context: AgentContext) => AsyncGenerator<AgentEvent>,
  message: string,
  context: AgentContext,
): AsyncGenerator<AgentEvent> {
  const rootSpan = createAgentRootSpan(context.sessionId, 'anonymous');

  logger.info('Agent session started', {
    sessionId: context.sessionId,
    messageLength: message.length,
  });

  const startTime = Date.now();

  try {
    yield* runFn(message, context);

    rootSpan.setAttributes({
      'agent.total_duration_ms': Date.now() - startTime,
      'agent.iterations': context.iteration,
      'agent.message_count': context.messages.length,
    });
    rootSpan.setStatus({ code: 1 });  // OK
  } catch (error) {
    rootSpan.recordException(error as Error);
    rootSpan.setStatus({ code: 2, message: (error as Error).message });
    logger.error('Agent session crashed', {
      sessionId: context.sessionId,
      error: (error as Error).message,
    });
    throw error;
  } finally {
    rootSpan.end();
  }
}
```

---

### Step 7: 前端可观测性面板

🔗 **工程逻辑**：前端可观测性面板不需要自己存数据——它只是后端聚合数据的展示层。`getAggregatedUsage` API 返回按模型/用户/会话拆分的 token 消费数据，前端只需做可视化。实时性通过前端轮询（每 5 秒刷新）实现——不要用 SSE，这只是一个监控后台，没必要实时到毫秒级。

```tsx
// apps/web/src/components/observability/ObservabilityPanel.tsx

'use client';

import { useState, useEffect } from 'react';

interface TokenUsageData {
  totalTokens: number;
  totalCostUSD: number;
  byModel: Record<string, { tokens: number; costUSD: number; calls: number }>;
  topExpensiveSessions: Array<{ sessionId: string; costUSD: number; tokens: number }>;
}

export function ObservabilityPanel() {
  const [range, setRange] = useState<'1h' | '24h' | '7d'>('24h');
  const [data, setData] = useState<TokenUsageData | null>(null);

  useEffect(() => {
    fetch(`/api/observability/tokens?range=${range}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, [range]);

  if (!data) return <div className="p-6 text-muted">加载中...</div>;

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text">可观测性</h1>
        <div className="flex gap-1 bg-surface rounded-lg p-1">
          {(['1h', '24h', '7d'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                range === r ? 'bg-accent text-white' : 'text-muted hover:text-text'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </header>

      {/* 总览卡片 */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Total Tokens" value={data.totalTokens.toLocaleString()} />
        <StatCard label="Total Cost" value={`$${data.totalCostUSD.toFixed(2)}`} />
        <StatCard label="Active Models" value={Object.keys(data.byModel).length.toString()} />
      </div>

      {/* 按模型分 */}
      <div className="bg-surface rounded-lg border border-border p-5">
        <h2 className="text-lg font-medium mb-4 text-text">按模型使用</h2>
        <div className="space-y-3">
          {Object.entries(data.byModel).map(([model, info]) => {
            const maxTokens = Math.max(...Object.values(data.byModel).map((m) => m.tokens));
            const percentage = maxTokens > 0 ? (info.tokens / maxTokens) * 100 : 0;
            return (
              <div key={model}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-mono text-text">{model}</span>
                  <span className="text-xs text-muted">
                    {info.tokens.toLocaleString()} tokens · ${info.costUSD.toFixed(4)} · {info.calls} calls
                  </span>
                </div>
                <div className="h-2 bg-bg rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent/70 rounded-full transition-all"
                    style={{ width: `${percentage}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top 10 最贵会话 */}
      <div className="bg-surface rounded-lg border border-border p-5">
        <h2 className="text-lg font-medium mb-4 text-text">Top 10 最贵会话</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted border-b border-border">
              <th className="text-left py-2">会话 ID</th>
              <th className="text-right py-2">Tokens</th>
              <th className="text-right py-2">成本</th>
            </tr>
          </thead>
          <tbody>
            {data.topExpensiveSessions.map((s) => (
              <tr key={s.sessionId} className="border-b border-border/50">
                <td className="py-2 font-mono text-xs">{s.sessionId.slice(0, 12)}</td>
                <td className="py-2 text-right">{s.tokens.toLocaleString()}</td>
                <td className="py-2 text-right text-yellow-400">${s.costUSD.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface rounded-lg border border-border p-5">
      <div className="text-muted text-sm">{label}</div>
      <div className="text-2xl font-semibold mt-1 text-text">{value}</div>
    </div>
  );
}
```

---

### 后端 API + Grafana 看板数据源

🔗 **工程逻辑**：Prometheus exporter 和 Grafana 的集成为什么放在 API 里？因为 Grafana 是外部轮询模式——它自己定时从 endpoint 拉数据，不需要我们推。只需要暴露 `/api/metrics` 这样一个 Prometheus 格式端点，Grafana 自动配置数据源 URL 就行。

```typescript
// apps/web/src/app/api/observability/tokens/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { tokenTracker } from '@agentcore/server/observability/token-tracker';

const RANGE_MS = { '1h': 3600_000, '24h': 86400_000, '7d': 604800_000 };

export async function GET(req: NextRequest) {
  const range = req.nextUrl.searchParams.get('range') ?? '24h';
  const ms = RANGE_MS[range as keyof typeof RANGE_MS] ?? RANGE_MS['24h'];

  const usage = await tokenTracker.getAggregatedUsage(ms);
  return NextResponse.json(usage);
}

/**
 * 可选：暴露 Prometheus metrics 端点给 Grafana 拉取。
 * Grafana 更适合做实时 Token 消耗热力图和延迟分布。
 */
// apps/web/src/app/api/metrics/route.ts

import { metrics } from '@agentcore/server/observability/metrics';

export async function GET() {
  const prometheusData = await metrics.serialize();
  return new Response(prometheusData, {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  });
}
```

---

### 可观测性避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| Trace 看不到 | span.end() 忘了调用 | 每个 span 用 try/finally 确保 end |
| Trace span 断裂 | 异步上下文丢失导致 parent span 关联不上 | 用 otelContext.with() 显式传播 context |
| 日志爆炸 | 把流式 token 每块都打日志 | 只在会话级和工具级打日志，token 级用 span event |
| Token 统计不准 | LLM 粗估 token 不准 | 响应回包里有 usage 字段时用精确值 |
| 告警疲劳 | 抖动导致的反复告警 | 5 分钟冷却 + hysteresis（恢复也要告警一次才能解除） |
| 日志含敏感信息 | 未脱敏直接打印 | 所有 logger 调用前做 `redactSensitive` |
| 监控本身耗大量 token | 给 LLM 调用打 debug 时把请求体全发给监控 | 请求体只记大小记 key，不记内容 |
| eval 数据泄漏 | 测试用例被模型训练记住 | eval 数据和训练数据物理隔离 |

---

*本节点属于 Layer 3 工程化层。Eval 框架和可观测性是一体的两面——eval 告诉你"质量如何"（离线指标），可观测性告诉你"运行时如何"（在线指标）。两者配合，才能让 Agent 系统从 Demo 进化为可维护的产品。实现时注意：eval 的 passThreshold 必须逐条设定（不设就是永远通过），trace span 的 end() 必须放在 finally 里（否则异步异常会丢 span）。*
