# Agent 可观测性 / 评估 / 安全 / 沙箱 / 模型路由：2024–2026 成熟技术现状

> 结论基于公开一手来源（官方博客、GitHub、官方文档），时间截至 2026-10。只列成熟且被生产采用的方案。

## 1. 可观测性
- **Langfuse**：开源 LLM 可观测性+评估+提示管理平台，2025 年全面转向 OpenTelemetry；2026-01 被 ClickHouse 收购（同期 ClickHouse 完成 $400M D 轮），承诺保持开源与自托管。生产采用最广的社区选择。[langfuse.com/blog/joining-clickhouse](https://langfuse.com/blog/joining-clickhouse)；[clickhouse.com blog](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability)
- **LangSmith**：LangChain 官方可观测性/评估平台，与 LangChain 生态深度绑定，企业采用成熟。
- **Braintrust**：$36M A 轮（2024）+ $80M B 轮（2025，估值约 $800M），主打 eval+observability 一体化。[braintrust.dev/blog](https://www.braintrust.dev/blog/announcing-series-b)
- **OpenTelemetry GenAI semconv**：已迁移至独立仓库；chat/embeddings 属性趋于稳定，agent 相关属性仍在演进 → 生产可落地但需跟踪版本。[opentelemetry.io/docs/specs/semconv/gen-ai](https://opentelemetry.io/docs/specs/semconv/gen-ai)

## 2. 评估
- **promptfoo**：CLI-first 开源 eval/红队工具，22.4k stars、255 贡献者，YAML 用例可入 CI → 轻量标配。[github.com/promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)
- **Langfuse / LangSmith**：提供生产数据回放、在线评估与 LLM-as-judge 工作流。
- **DeepEval / Ragas**：开源评估框架与 RAG 指标库，适合离线指标与 RAG 质量评估。
- **LLM-as-judge**：已被主流团队作为生产默认评估方法，配合人工抽检；OpenAI/Anthropic/Google 均有官方实践指南。

## 3. 安全护栏
- **OpenAI Agents SDK Guardrails**：输入/输出护栏+tripwire 机制，官方文档完善。[openai.github.io/openai-agents-python/guardrails](https://openai.github.io/openai-agents-python/guardrails)
- **NeMo Guardrails**：⚠️ 2025-10 EOL，新项目勿用。[github.com/NVIDIA-NeMo/Guardrails README](https://github.com/NVIDIA-NeMo/Guardrails)
- **Guardrails AI / LLM Guard（Protect AI）**：开源护栏编排与扫描器库，成熟可自托管。
- **OWASP LLM Top 10（2025 版）**：事实标准，LLM01 提示注入居首。[genai.owasp.org](https://genai.owasp.org/llm-top-10)
- **提示注入防护默认实践**：不信任模型输出；系统提示与工具调用隔离；输入+输出双向往护栏；最小工具权限。

## 4. 代码沙箱
- **E2B**：Firecracker microVM 之上的开源 AI 代码沙箱，被大量 agent 项目集成。
- **Daytona**：$24M A 轮（2025，FirstMark），API-first 安全沙箱，宣称 90ms 环境创建。[daytona.io](https://www.daytona.io/)
- **Firecracker**：AWS Lambda 底层 microVM，生产验证最充分。[aws.amazon.com](https://firecracker-microvm.github.io/)
- **Modal**：serverless 计算平台，提供 Sandboxes，适合重型 Python/GPU 任务。

## 5. 模型路由 / 网关
- **LiteLLM**：开源 AI Gateway（Rust 核心），统一 OpenAI 兼容 API 调 100+ 模型商，生产广泛部署。[github.com/BerriAI/litellm](https://github.com/BerriAI/litellm)
- **Cloudflare AI Gateway**：托管网关+可观测性+缓存+统一计费，已与 Workers AI 合并为统一 AI 控制面。[blog.cloudflare.com](https://blog.cloudflare.com/workers-ai-gateway-unification)
- **OpenRouter**：多模型路由 API，适合个人/原型快速切换。

## 6. 2026 推荐组合（3-5 个）
1. 可观测性+评估：**Langfuse**（LangChain 深度用户可换 **LangSmith**）
2. 评估：**promptfoo**（CI 回归/红队）+ **LLM-as-judge**
3. 网关：**LiteLLM**（自托管）/ **Cloudflare AI Gateway**（托管）
4. 护栏：**OpenAI Agents SDK Guardrails** 或 **Guardrails AI**；基线对照 **OWASP LLM Top 10**
5. 沙箱：**E2B** / **Daytona**（microVM 隔离）

## 淘汰清单
- ❌ 自研 span 管理 → 直接用 OpenTelemetry + Langfuse/LangSmith
- ❌ 无护栏直连模型 → 至少加输入/输出过滤
- ❌ 无 eval 上线 → 至少 LLM-as-judge + 人工抽检
- ❌ 新项目采用 NeMo Guardrails（已 EOL）