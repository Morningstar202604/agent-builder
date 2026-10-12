# 08 — Eval 与可观测性 · Langfuse · promptfoo · OpenTelemetry

> Layer 3 目标：让 Agent 的质量与运行状态**可测量、可追踪、可回归**——评估与回归用 promptfoo，Trace/Score/成本看板用 Langfuse，OpenTelemetry 只做 SDK 初始化与 instrument 配置。

> **⚠️ 本层铁律：不自研评估与追踪基础设施。**
> - Eval 框架 / 用例执行 / 回归检测 → **promptfoo**（声明式 YAML，CI 一键跑）
> - Trace / Score / 回归看板 / Token 成本 → **Langfuse**（平台能力，不自己写看板）
> - OpenTelemetry → 只写 **SDK 初始化 + instrument 配置**，不手写 span 管理
>
> 本层唯一允许手写的 `[CUSTOM]` 是**业务 eval 用例集**（描述你的产品行为，没有现成替代）与把 Agent 接到追踪平台的少量胶水代码。

---

## 目录

- [8.1 Eval 用例——promptfoo 配置 + 业务用例集 [CUSTOM]](#81-eval-用例promptfoo-配置--业务用例集-custom)
- [8.2 回归检测——Langfuse 看板 + promptfoo CI 门禁](#82-回归检测langfuse-看板--promptfoo-ci-门禁)
- [8.3 LLM-as-Judge——promptfoo 裁判配置](#83-llm-as-judgepromptfoo-裁判配置)
- [8.4 可观测性——OpenTelemetry SDK 初始化](#84-可观测性opentelemetry-sdk-初始化)
- [8.5 Agent 全链路追踪——AI SDK observability 接入 Langfuse](#85-agent-全链路追踪ai-sdk-observability-接入-langfuse)
- [8.6 日志与告警——pino + Langfuse Alert](#86-日志与告警pino--langfuse-alert)
- [8.7 本层验收清单](#87-本层验收清单)

---

## 8.1 Eval 用例——promptfoo 配置 + 业务用例集 [CUSTOM]

### 为什么不再自研 Eval 框架

🔗 **工程逻辑**：手写 EvalCase 类型、并发 Runner、Judge JSON 解析、报告对比……等于把 LLM 评测这一整层重造一遍。promptfoo 已经解决：用例格式、并发/重试、LLM-as-Judge、结果对比、CI 退出码。你要写的只剩**业务用例本身**——这是产品差异层，标 `[CUSTOM]`。

```yaml
# promptfooconfig.yaml（项目根）—— 全部声明式配置，无手写执行器
promptfooconfig:
  description: Agent 核心能力回归
  providers:
    - id: openai:gpt-4o
      env:
        OPENAI_API_KEY: ${OPENAI_API_KEY}
  prompts:
    - '你是通用助手，回答用户问题，需要时调用工具。'
  defaultTest:
    options:
      provider:
        # LLM-as-Judge：用不同厂商模型当裁判，避免自我偏置
        id: anthropic:claude-sonnet-4-20250514
        env:
          ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  tests:
    - server/src/eval/cases/unit.yaml
    - server/src/eval/cases/integration.yaml
```

🤖 **AI 常见错误**：
1. **自研 Judge 解析**（剥代码围栏、JSON.parse）——promptfoo 的 `llm-rubric` 断言已处理；自研解析器每换一个模型输出格式就崩一次。
2. **Judge 与被测模型同厂商**——GPT 评测 GPT 有自我偏置，打分虚高。`defaultTest.options.provider` 必须指向不同厂商。
3. **业务用例不写断言**——没有断言等于永远通过。每条 `[CUSTOM]` 用例都要有可判定的 `assert`。

### 业务用例集 [CUSTOM]

> 下面用例是**产品行为描述**，属于业务差异层，没有成熟替代，因此标 `[CUSTOM]` 保留；执行、打分、回归全部交给 promptfoo。

```yaml
# server/src/eval/cases/unit.yaml —— 工具正确性用例（业务定义 [CUSTOM]）
- vars:
    userMessage: 搜索 query=苹果 price<100 category=水果
  assert:
    - type: javascript
      value: |
        const toolCall = output.toolCalls?.[0];
        return toolCall && toolCall.name === 'search' && toolCall.args.query.includes('苹果');
```

```yaml
# server/src/eval/cases/integration.yaml —— 端到端用例（业务定义 [CUSTOM]）
- vars:
    userMessage: 一辆车以 60km/h 开了 2 小时，又以 80km/h 开了 1.5 小时，总路程是多少？
  assert:
    - type: llm-rubric
      value: 展示了推理过程，最终答案正确（240km）。
    - type: cost
      threshold: 0.05   # 单次执行成本上限，防烧钱
    - type: latency
      threshold: 15000  # 端到端延迟上限
```

🔗 **工程逻辑**：业务用例是产品差异层，越具体越好——但执行机制别碰。把"怎么跑、怎么打分、怎么比历史"全交给 promptfoo，把"什么算好、什么算错"留给自己。

---

## 8.2 回归检测——Langfuse 看板 + promptfoo CI 门禁

🔗 **工程逻辑**：回归检测 = 历史分数对比 + 新失败告警。Langfuse 把每次运行的 trace 与 score 自动落库，看板直接展示分数趋势；promptfoo 在 CI 里跑用例，任一断言失败即非零退出，阻止退化代码合入。

**Langfuse 看板**是平台能力——不需要自己写 reportId、regression diff、前端图表。每次通过 `@ai-sdk/observability` 接入的 Agent 运行都会在 Langfuse 生成一条 trace，eval 分数通过 `trace.score()` 上报后，看板自动聚合出回归曲线。

```yaml
# .github/workflows/eval.yml —— 用标准 Actions 模板，不手写 pipeline 脚本
name: Eval Regression
on:
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
      - name: Run Eval Suite
        run: pnpm exec promptfoo eval --config promptfooconfig.yaml --output eval-report.json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

🤖 **AI 常见错误**：
1. CI 里 `pnpm install` 不带 `--frozen-lockfile`——lockfile 被自动更新，生产装了一个没测过的依赖版本。
2. eval 每次都跑全量用例——一次 CI 可能几十美元。核心用例跑 PR，全量放 nightly。
3. 把回归报告堆在 CI 日志里——报告应写入 Langfuse/artifact，CI 只输出退出码与失败用例 ID。

---

## 8.3 LLM-as-Judge——promptfoo 裁判配置

裁判提示词与 JSON 解析都是 promptfoo 的职责。你只需要在 `defaultTest` 里声明裁判模型和 rubric——不要手写 Judge 类。

```yaml
# promptfooconfig.yaml 中的 LLM-as-Judge 部分
defaultTest:
  options:
    provider:
      id: anthropic:claude-sonnet-4-20250514   # 不同厂商，防自我偏置
      env:
        ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  assert:
    - type: llm-rubric
      value: |
        评估以下回答是否满足：
        1. 展示了推理过程
        2. 最终答案正确（240km）
        按 1-10 打分，10 为完全满足。
```

🔗 **工程逻辑**：LLM Judge 的核心问题是"评分锚定"。rubric 必须中立提问——"回答里有错误吗"比"这个回答是否准确"更不容易诱导高分。多维度打分（同理心/实用性/真诚度）用多条 rubric 或 `assert` 组合，不要自研中位数投票。

🤖 **AI 常见错误**：rubric 里出现"是否满足正确回答的基本要求"这类暗示性措辞，Judge 会系统性打高分。写完之后用反例用例自测一次，确认低分真的会低。

---

## 8.4 可观测性——OpenTelemetry SDK 初始化

> 本层只写**初始化与 instrument 配置**。span 的创建、结束、异常记录由 AI SDK / Langfuse 自动完成，不手写 span 包装器。

```typescript
// server/src/observability/tracer.ts —— 只做 SDK 初始化与 instrument 配置，不管理 span
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';

export function initTracer(serviceName = 'agent-core'): void {
  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_COLLECTOR_URL ?? 'http://localhost:4318/v1/traces',
  });

  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
    }),
    // 生产用 Batch（异步批量，性能好）；开发用 Simple（同步发送，立刻可见）
    spanProcessor:
      process.env.NODE_ENV === 'production'
        ? new BatchSpanProcessor(exporter)
        : new SimpleSpanProcessor(exporter),
  });

  registerInstrumentations({
    instrumentations: [new HttpInstrumentation(), new ExpressInstrumentation()],
  });

  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}
```

🔗 **工程逻辑**：BatchSpanProcessor 异步批量发送，对主流程性能影响小，但进程崩溃可能丢最后几批 span；开发环境用 Simple 同步发送，本地立刻能看到 trace。这是唯一的初始化取舍，业务代码不需要感知。

🤖 **AI 常见错误**：在业务代码里到处手动包 span——异步边界一多就漏掉结束调用，trace 断裂。用 AI SDK 自动 instrumentation，让框架管理 span 生命周期。

---

## 8.5 Agent 全链路追踪——AI SDK observability 接入 Langfuse

把 Langfuse 接进 Vercel AI SDK，`streamText` 的模型调用、工具执行、step 循环自动生成 span 与 token 用量。你不需要在 Agent 主循环里埋点。

```typescript
// packages/core/src/agent/observability.ts —— 胶水层：Langfuse 接入 AI SDK，不管理 span
// llm 统一来自 01 的 createModel（LanguageModel），观测由 SDK 自动生成
import { observability } from '@ai-sdk/observability';
import { Langfuse } from 'langfuse';

const langfuse = new Langfuse(); // 密钥从 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 环境变量读取

observability.init({
  provider: langfuse,
  traceName: 'agent-chat',
  metadata: { service: 'agent-core' },
});
```

服务启动时调用一次 `initObservability()` 即可。之后：

- `streamText` 的每次 LLM 调用 → Langfuse 自动生成 LLM span，含 input/output token 与成本
- 工具执行 → 自动生成 tool span
- 多步循环 → 自动嵌套在同一个 trace 下

```typescript
// apps/web/src/app/api/chat/route.ts —— 业务层保持干净：创建模型 + 流式输出
import { streamText, type UIMessage } from 'ai';
import { createModel } from '@agentcore/core/llm';

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();
  const result = streamText({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    messages,
    tools: { /* 见 02 Tools & Skills */ },
    maxSteps: 10,
  });
  return result.toDataStreamResponse();
}
```

🔗 **工程逻辑**：`AgentEvent`（见 01，`packages/core/src/agent/events.ts`）是给前端 SSE 用的业务事件信封；观测数据由 AI SDK/Langfuse 自动生成，两者**正交**——不要用 `AgentEvent` 去拼 span，也不要把观测逻辑塞进事件循环。

🤖 **AI 常见错误**：为了让 trace 好看，在 Agent 主循环里手动创建 Root/Child span 包裹 `AgentEvent`——事件流被追踪代码打断，前端与观测互相干扰。保持业务层无感。

---

## 8.6 日志与告警——pino + Langfuse Alert

结构化日志用 pino，不自研 JSON 格式器。Trace ID 串联通过 pino 的 `mixin` 读 OTel 上下文，一行胶水。

```typescript
// server/src/utils/logger.ts —— pino 结构化日志 + OTel traceId 串联
import { pino } from 'pino';
import { trace } from '@opentelemetry/api';

export const logger = pino({
  level: process.env.DEBUG === '1' ? 'debug' : 'info',
  mixin() {
    const span = trace.getActiveSpan();
    const ctx = span?.spanContext();
    return ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {};
  },
});
```

告警不用自己写滑动窗口异常检测器。Langfuse 提供 cost/error rate/latency 告警，直接在平台配置阈值与通知渠道（webhook/邮件）。

🔗 **工程逻辑**：日志是"出了问题去翻"，可观测性是"盯着看就知道正常"。三支柱里，Traces 由 OTel/AI SDK 生成，Logs 用 pino，Metrics/告警用 Langfuse——每层都接成熟方案。

---

## 8.7 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **eval 通过**：运行 `pnpm exec promptfoo eval --config promptfooconfig.yaml`，所有 `[CUSTOM]` 业务用例 0 失败。
- [ ] **回归门禁**：故意把一个用例的期望改错，重新运行 promptfoo，进程返回非零退出码；CI 工作流因此失败。
- [ ] **Judge 隔离**：`defaultTest.options.provider` 与被测模型不同厂商；`llm-rubric` 措辞中立。
- [ ] **OTel 初始化**：`NODE_ENV=production` 时使用 `BatchSpanProcessor`；启动后向 `OTEL_COLLECTOR_URL` 发送 span 成功。
- [ ] **Langfuse 接入**：`initObservability()` 后跑一次带工具调用的对话，Langfuse 看板出现完整 trace、token 用量与成本，且不需要任何手写 span 代码。
- [ ] **日志串联**：pino 日志包含 `traceId` 字段，与 Langfuse trace 可相互检索。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本层验收清单。

---

*本节点属于 Layer 3 工程化层。评估与可观测性是一体两面：promptfoo 告诉你"质量如何"（离线），Langfuse 告诉你"运行时如何"（在线）。接入时记住：业务用例集是 `[CUSTOM]`，执行与看板全用成熟方案。*
