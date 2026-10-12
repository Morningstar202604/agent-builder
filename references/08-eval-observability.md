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

- [8.1 可观测性平台选型——Langfuse / LangSmith / Braintrust](#81-可观测性平台选型langfuse--langsmith--braintrust)
- [8.2 Eval 用例——promptfoo 配置 + 业务用例集 [CUSTOM]](#82-eval-用例promptfoo-配置--业务用例集-custom)
- [8.3 回归检测——Langfuse 看板 + promptfoo CI 门禁](#83-回归检测langfuse-看板--promptfoo-ci-门禁)
- [8.4 LLM-as-Judge——promptfoo 裁判配置](#84-llm-as-judgepromptfoo-裁判配置)
- [8.5 可观测性——OpenTelemetry SDK 初始化与 GenAI semconv](#85-可观测性opentelemetry-sdk-初始化与-genai-semconv)
- [8.6 Agent 全链路追踪——Langfuse × Vercel AI SDK](#86-agent-全链路追踪langfuse--vercel-ai-sdk)
- [8.7 Langfuse 完整接入——trace / token 统计 / 在线评估](#87-langfuse-完整接入trace--token-统计--在线评估)
- [8.8 在线评估与 LLM-as-Judge 联动](#88-在线评估与-llm-as-judge-联动)
- [8.9 日志与告警——pino + Langfuse Alert](#89-日志与告警pino--langfuse-alert)
- [8.10 本层验收清单](#810-本层验收清单)

---

## 8.1 可观测性平台选型——Langfuse / LangSmith / Braintrust

### 2026 平台格局

Langfuse 在 2026 年初被 ClickHouse 收购，继续开源；其第一方采集（SDK 上报）在 2025 年全面转向 OpenTelemetry，成为 OTel GenAI semconv 的积极推动者。LangSmith（LangChain 生态）与 Braintrust（企业级评估）是常见备选。三者的定位：

| 维度 | Langfuse（本项目主平台） | LangSmith | Braintrust |
| --- | --- | --- | --- |
| 许可证 | MIT（可自托管） | 商业 + 免费额度 | 商业 |
| 自托管 | Docker Compose / Helm，数据自持 | 受限（云托管为主） | 受限 |
| 采集协议 | OpenTelemetry 原生（2025 起默认） | SDK 专有为主 | SDK 专有为主 |
| Eval 联动 | promptfoo 原生集成（`langfuse://` provider） | LangSmith Eval API | Braintrust Eval SDK |
| LLM-as-Judge | 内置模板 + 外部 LLM | 内置 | 内置 + 专家模板 |
| 成本/Token 看板 | 内置 | 内置 | 内置 |
| 适用场景 | 开源、可观测性优先、需要 OTel 统一埋点 | LangChain 深度用户 | 企业治理、评估优先团队 |

### 本项目选型：Langfuse

1. **OTel 原生**：AI SDK 7 / OTel GenAI semconv 的 span 可直接流入，trace 与后端指标同一条管线，不需要两套 SDK。
2. **promptfoo 官方集成**：`langfuse://<prompt-id>@<version>` 让 CI eval 直接引用生产 Prompt 版本，回归门禁与提示词管理闭环（见 10-prompt-protocol.md）。
3. **可自托管 + 开源**：数据不出内网，满足安全审计（07-security.md 的日志合规要求）。
4. **在线评估 API**：`score()` 可同时上报用户反馈与 LLM-as-Judge 分数，看板即出趋势。

### 情境替代方案

- **LangSmith**：团队已深度使用 LangChain/LangGraph，且接受云托管时选用；集成成本最低。
- **Braintrust**：评估矩阵、A/B 实验、专家标注流程比 Langfuse 更重时选用；适合评估治理诉求大于可观测性的团队。

> 🤖 **坑 1：自建看板**。把 trace 存进 Postgres 再写 Grafana 面板，等于重造 Langfuse。选型即架构决策，选完就不要再手写第二套上报。
> 🤖 **坑 2：SDK 直连与 OTel 双轨上报**。如果一部分代码用平台 SDK、另一部分用 OTel exporter，会出现 traceId 对不上的幽灵 span。本项目一律走 SDK 封装（8.5/8.6/8.7），不混用。
> 🤖 **坑 3：自托管与云切换的密钥散落**。baseUrl 写死云地址、密钥写进 .env 提交仓库，是事故源头。baseUrl 必须走环境变量（见 09-deploy.md 的密钥管理）。

---

## 8.2 Eval 用例——promptfoo 配置 + 业务用例集 [CUSTOM]

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

### 生产级 promptfooconfig.yaml——补全版

上面是基线；接入 Langfuse 生产环境后，Prompt 版本应直接引用 Langfuse（见 10-prompt-protocol.md），并声明并发/缓存策略：

```yaml
# promptfooconfig.yaml（项目根）—— 生产补全版
promptfooconfig:
  description: Agent 核心能力回归（Langfuse Prompt 版本固定）
  providers:
    - id: openai:gpt-4o
      env:
        OPENAI_API_KEY: ${OPENAI_API_KEY}
  prompts:
    - id: langfuse://agent-system@production   # 生产 Prompt 版本，不复制进仓库
      label: agent-system-production
  defaultTest:
    options:
      provider:
        id: anthropic:claude-sonnet-4-20250514
        env:
          ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  evaluateOptions:
    maxConcurrency: 4      # 控制并发，避免测试风暴打爆生产
    repeat: 3              # 每个用例重复 3 次，回归结果取分布而非单点
    delay: 200             # 用例间冷却，照顾限流
  output:
    - eval-report.json      # CI 上传 Langfuse 用
    - eval-summary.md
  cache:
    type: filesystem
    path: .promptfoo-cache
```

🤖 **AI 常见错误**：
1. 把 `langfuse://agent-system@production` 换成仓库里的字符串副本——版本漂移后，CI 回归的 Prompt 与线上不一致。生产引用必须指向 Langfuse。
2. `repeat: 1` 当回归基准——LLM 有随机性，单次结果会抖动；至少 `repeat: 3` 取中位数/分布。
3. `maxConcurrency` 不设——CI 并发跑满 100 个用例，触发模型限流、成本失控。

### 工具调用用例补充 [CUSTOM]

单元用例不止验证文本，还要验证**结构化工具参数**。promptfoo 的 `javascript` 断言直接读取 `output.toolCalls`：

```yaml
# server/src/eval/cases/tool-call.yaml —— 工具参数精确性 [CUSTOM]
- vars:
    userMessage: 把「买牛奶」加入购物车
  assert:
    - type: javascript
      value: |
        const toolCall = output.toolCalls?.[0];
        return toolCall && toolCall.name === 'cart.add'
          && toolCall.args.item === '牛奶';
    - type: contains
      value: 购物车
```

### RAG 检索真实性用例 [CUSTOM]

RAG 场景最容易出现「答案对但检索错」。LLM-as-Judge 无法单独判断事实来源，要显式断言**答案引用检索到的文档**：

```yaml
# server/src/eval/cases/rag-grounding.yaml —— RAG 事实性 [CUSTOM]
- vars:
    userMessage: 我们的退款政策是几天？
    context: 来自 03-memory-rag.md 的示例知识库，包含「14 天内可退款」。
  assert:
    - type: llm-rubric
      value: |
        回答必须：
        1. 只使用提供的 context，不得编造
        2. 明确引用退款政策条款
        3. 给出 14 天这个数字
    - type: contains
      value: 14 天
```

🔗 **工程逻辑**：RAG 的 eval 必须同时押「回答质量」与「检索落地」。promptfoo 的 `vars` 注入 context，让用例可复现——这比在生产环境人工抽查可靠得多。

---

## 8.3 回归检测——Langfuse 看板 + promptfoo CI 门禁

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

### eval 产物上传 Langfuse Dataset

CI 只跑用例还不够——要把每次运行的**用例级结果**写入 Langfuse Dataset，看板才能画长期回归曲线。在 `eval.yml` 末尾加两步：

```yaml
      - name: Upload Eval Report Artifact
        uses: actions/upload-artifact@v4
        with:
          name: eval-report
          path: eval-report.json
          retention-days: 14
      - name: Upload Results to Langfuse
        run: pnpm exec tsx server/src/eval/upload-to-langfuse.ts eval-report.json agent-core-regression
        env:
          LANGFUSE_PUBLIC_KEY: ${{ secrets.LANGFUSE_PUBLIC_KEY }}
          LANGFUSE_SECRET_KEY: ${{ secrets.LANGFUSE_SECRET_KEY }}
          LANGFUSE_BASE_URL: ${{ secrets.LANGFUSE_BASE_URL }}
```

上传脚本只做**格式转换胶水**，不实现任何评估逻辑：

```typescript
// server/src/eval/upload-to-langfuse.ts
import { readFile } from 'node:fs/promises';
import { langfuse } from '@agentcore/core/observability/langfuse';

interface EvalCaseResult {
  promptId: string;
  vars: Record<string, string>;
  score: number;
  latencyMs: number;
}

export async function uploadEvalReport(reportPath: string, datasetName: string): Promise<void> {
  const raw = await readFile(reportPath, 'utf8');
  const report = JSON.parse(raw) as { results: EvalCaseResult[] };

  const dataset = langfuse.dataset({ name: datasetName });
  const run = await dataset.createRun();
  for (const r of report.results) {
    await run.items.create({
      input: r.vars,
      output: { score: r.score },
      metadata: { promptId: r.promptId, latencyMs: r.latencyMs },
    });
  }
  await langfuse.flushAsync();
  console.error(`uploaded ${report.results.length} eval results to dataset ${datasetName}`);
}
```

> **版本注意**：Langfuse Dataset 的运行/条目 API（`createRun` / `run.items.create`）随版本演进，签名以你安装版本的官方文档为准。数据集主键是 `name`，重跑同一 `datasetName` 会追加新 run。

### PR 门禁 vs 夜间全量

| 场景 | 触发 | 用例集 | 预算 |
| --- | --- | --- | --- |
| PR 门禁 | `pull_request` | 核心用例（unit + 2 条集成） | ~$0.5/次 |
| 夜间回归 | `schedule: cron` | 全量用例（含 RAG、多轮、边界） | ~$10/夜 |
| 发布前 | `workflow_dispatch` | 全量 + 专家标注 | 按需 |

PR 只跑核心用例保证反馈速度；全量用例夜间跑，第二天早晨在 Langfuse 看板看趋势。**不要让 PR 门禁背着几十美元成本，也不要让全量用例只在发布前跑一次**。

---

## 8.4 LLM-as-Judge——promptfoo 裁判配置

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

### 多维度 rubric 示例

单条 rubric 覆盖不了「有用 + 无害 + 诚实」多目标时，声明多条 `llm-rubric`，每条独立打分：

```yaml
# promptfooconfig.yaml 中的多维度裁判
defaultTest:
  options:
    provider:
      id: anthropic:claude-sonnet-4-20250514
      env:
        ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  assert:
    - type: llm-rubric
      value: |
        这个回答是否：直接解决了用户问题，没有绕圈子？
        只回答「是」或「否」，并给出一句话理由。
    - type: llm-rubric
      value: |
        这个回答是否包含幻觉（与给定事实矛盾或编造）？
        只回答「是」或「否」。
    - type: javascript
      value: output.promptTokens + output.completionTokens < 2000
```

### 反例自测（必须做）

rubric 写完后，加一条**故意错误答案**的临时用例跑一次，确认 Judge 给低分——低分不会真的低，说明 rubric 有诱导性措辞。

🤖 **AI 常见错误**：
1. rubric 描述「高质量的回答应包含…」——暗示性措辞让 Judge 普遍打高分，失去区分度。
2. 只写一个维度——同理心高分掩盖事实错误，必须多维度独立评分。
3. 反例自测没做——上线后才发现 rubric 失效，回归门禁形同虚设。

---

## 8.5 可观测性——OpenTelemetry SDK 初始化与 GenAI semconv

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

### GenAI semconv 属性补充

AI SDK 自动生成的 span 已带 `gen_ai.*` 属性；旧模型/自托管网关缺属性时手动补，属性名只允许 semconv 命名空间（仍为 Development 状态，以 OTel 语义约定文档为准）：

```typescript
// packages/core/src/observability/genai-semconv.ts —— 手动补齐 gen_ai.* 属性
import { trace } from '@opentelemetry/api';

export function annotateGenAiSpan(opts: {
  system: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const span = trace.getActiveSpan();
  if (!span) return;

  span.setAttribute('gen_ai.system', opts.system);
  span.setAttribute('gen_ai.request.model', opts.model);
  if (opts.inputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.input_tokens', opts.inputTokens);
  }
  if (opts.outputTokens !== undefined) {
    span.setAttribute('gen_ai.usage.output_tokens', opts.outputTokens);
  }
}
```

### Langfuse OTLP 端点变体

自托管 Langfuse 走 OTLP 直连时，`OTLPTraceExporter` 的 URL 与 Basic Auth 以 Langfuse 官方文档为准：

```typescript
// server/src/observability/tracer.langfuse.ts —— Langfuse OTLP 变体（URL/认证以文档为准）
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const exporter = new OTLPTraceExporter({
  url: process.env.LANGFUSE_OTLP_ENDPOINT!,
  headers: {
    Authorization: `Basic ${Buffer.from(
      `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
    ).toString('base64')}`,
  },
});
```

---

## 8.6 Agent 全链路追踪——Langfuse × Vercel AI SDK

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

### AI SDK 7 迁移路径——registerTelemetry

当前代码基于 00-types 的 `ai ^4.0.0`，走 `@ai-sdk/observability`（上面已验证）。2026 年的 AI SDK 7 提供更薄的 `registerTelemetry` 注册式接入；升级前先更新 00-types 的版本契约（升级属于 00-types，不在本层改）：

```typescript
// packages/core/src/observability/vercel-ai-sdk.ts —— AI SDK 7 迁移样板（升级 00-types 后启用）
import { registerTelemetry } from 'ai';
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk';

export function registerLangfuseTelemetry(): void {
  registerTelemetry(new LangfuseVercelAiSdkIntegration());
}
```

> 🤖 **坑 1：不要在 references 里单独升级 `ai`**。版本契约集中在 00-types.md，本文件只给迁移样板；想升级先改 00-types 再全仓验证。
> 🤖 **坑 2：Node 版本**。AI SDK 7 的 telemetry 注册需要 Node 22+，而当前契约是 Node >= 20；这是升级 00-types 的前置条件，别在本层偷偷引入新运行时要求。
> 🤖 **坑 3：OTel span 与 AI SDK span 合并**。`@langfuse/otel` 的 `LangfuseSpanProcessor` 负责把纯 OTel span 也送进 Langfuse；只注册 AI SDK 集成、不接处理器，会出现「AI 调用有 trace、HTTP 层没 trace」的半截链路。

---

## 8.7 Langfuse 完整接入——trace / token 统计 / 在线评估

> 平台采集已由 AI SDK observability 自动完成；本节是**手工埋点补场景**：多轮会话分组、token 用量上报、用户反馈评分、Dataset 驱动离线评估。全部走官方 SDK 封装，不手写 HTTP 上报。

### 客户端单例

```typescript
// packages/core/src/observability/langfuse.ts —— 全仓唯一客户端，禁止二次 new
import { Langfuse } from 'langfuse';

export const langfuse = new Langfuse({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
});
```

### 手工 trace + token 统计

```typescript
// packages/core/src/observability/trace-llm.ts —— 需要 sessionId 聚合时的手工封装
import { generateText } from 'ai';
import type { UIMessage } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { langfuse } from './langfuse';

export async function tracedGenerate(opts: {
  provider: 'openai' | 'anthropic';
  modelId: string;
  messages: UIMessage[];
  sessionId: string;
}) {
  const trace = langfuse.trace({ name: 'agent-chat', sessionId: opts.sessionId });
  const generation = trace.generation({ name: 'chat_completion', model: opts.modelId });

  const result = await generateText({
    model: createModel(opts.provider, process.env as Record<string, string | undefined>),
    messages: opts.messages,
  });

  generation.end({
    output: result.text,
    usage: {
      input: result.usage.promptTokens,
      output: result.usage.completionTokens,
      total: result.usage.totalTokens,
    },
  });
  await langfuse.flushAsync();
  return result;
}
```

### 在线评估——用户反馈评分

```typescript
// apps/web/src/app/api/feedback/route.ts —— 用户反馈写回 trace 分数
import { NextResponse } from 'next/server';
import { langfuse } from '@agentcore/core/observability/langfuse';

export async function POST(req: Request) {
  const { traceId, rating } = (await req.json()) as { traceId: string; rating: 0 | 1 };

  await langfuse.score({
    traceId,
    name: 'user_feedback',
    value: rating,
    comment: '用户显式反馈',
  });
  await langfuse.flushAsync();
  return NextResponse.json({ ok: true });
}
```

### Dataset 驱动离线评估

```typescript
// server/src/eval/dataset.ts —— 从 Langfuse Dataset 拉取离线评估样本
import { langfuse } from '@agentcore/core/observability/langfuse';

export interface EvalCase {
  vars: Record<string, string>;
  expected?: string;
}

export async function loadLangfuseDataset(datasetName: string): Promise<EvalCase[]> {
  const dataset = langfuse.dataset({ name: datasetName });
  const items = await dataset.getItems();
  return items.map((item) => ({
    vars: (item.input as Record<string, string>) ?? {},
    expected: typeof item.expectedOutput === 'string' ? item.expectedOutput : undefined,
  }));
}
```

> **版本注意**：`dataset.getItems()` 是稳定 API；`createRun` / `run.items.create` 见 8.3 的版本提示。

---

## 8.8 在线评估与 LLM-as-Judge 联动

### 两条评估路径

| 路径 | 触发时机 | 数据流 | 用途 |
| --- | --- | --- | --- |
| 离线（promptfoo） | PR / nightly | 报告 → Langfuse Dataset | 回归门禁 |
| 在线（线上流量） | 每次用户对话 | 采样 trace → `score()` | 线上质量趋势 |

在线评估**必须采样**：全量 LLM-as-Judge 会让线上成本翻倍。规则：错误路径 100% 评估、正常路径 10% 采样。

### Judge 胶水代码

```typescript
// server/src/eval/judge.ts —— 在线 LLM-as-Judge 评分并写回 Langfuse
import { generateText } from 'ai';
import { createModel } from '@agentcore/core/llm';
import { langfuse } from './langfuse';

export interface JudgeVerdict {
  score: number;
  reason: string;
}

export async function judgeResponse(opts: {
  traceId: string;
  question: string;
  answer: string;
  rubric: string;
}): Promise<JudgeVerdict> {
  const { text } = await generateText({
    model: createModel('anthropic', process.env as Record<string, string | undefined>),
    system: '你是严格的评测员。只输出 JSON：{"score": 0-1, "reason": "..."}。',
    prompt: `问题：${opts.question}\n回答：${opts.answer}\n评分标准：${opts.rubric}`,
  });

  const parsed = JSON.parse(text) as { score: number; reason: string };
  const verdict: JudgeVerdict = {
    score: Math.min(1, Math.max(0, parsed.score)),
    reason: parsed.reason,
  };

  await langfuse.score({
    traceId: opts.traceId,
    name: 'llm_judge',
    value: verdict.score,
    comment: verdict.reason,
  });
  await langfuse.flushAsync();
  return verdict;
}
```

### 平台模板与会话元数据

promptfoo 的 `langfuse://` provider 和 Langfuse 内置 LLM-as-Judge 模板可减少自研；需要把会话级元数据带上时，用 `trace()` 直接创建：

```typescript
// packages/core/src/observability/trace-metadata.ts —— 会话级元数据
import { langfuse } from './langfuse';

export function startTracedSession(opts: { sessionId: string; userId: string; name?: string }) {
  return langfuse.trace({
    name: opts.name ?? 'agent-chat',
    sessionId: opts.sessionId,
    userId: opts.userId,
  });
}
```

> **版本注意**：返回的 trace 对象如需更新元数据，`trace.update()` 签名随 Langfuse SDK 版本变化，以官方文档为准；仅当平台内建模板覆盖不了会话元数据时才使用这段代码。

---

## 8.9 日志与告警——pino + Langfuse Alert

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

## 8.10 本层验收清单

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
