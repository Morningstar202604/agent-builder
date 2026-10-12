# 对标清单：可观测性 / 评估 / 安全护栏 / 沙箱 开源项目（2026-10 现状）

> 数据截至 2026-10，star 为量级（来源见各条目链接）。只列成熟且活跃的项目；已 EOL/归档的明确标注。许可证以仓库与官方公告为准。

## 一、可观测性

- **Langfuse**（MIT，约 3.2 万–3.5 万 star）：开源 LLM 可观测性 + 评估 + Prompt 管理一体化平台。2026-01 被 ClickHouse 收购，核心平台保持 MIT 且可自托管（官方 Docker Compose 一键部署）。**适合直接二次开发/自托管**：数据完全自主、社区最大、中文团队资料多。[github.com/langfuse/langfuse](https://github.com/langfuse/langfuse)｜[langfuse.com/self-hosting/deployment/docker-compose](https://langfuse.com/self-hosting/deployment/docker-compose)｜[clickhouse.com/blog/clickhouse-acquires-langfuse](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability)
- **Helicone**（Apache-2.0，约 6.2k star）：代理式 LLM 观测 + 成本追踪。**可直接 docker compose 自托管**；但 2026-03 被 Mintlify 收购后进入维护模式（仅安全更新，无新功能），**适合短期自托管或作为参考实现**，不建议作为长期主平台。[github.com/Helicone/helicone](https://github.com/Helicone/helicone)｜[docs.helicone.ai/getting-started/self-host/overview](https://docs.helicone.ai/getting-started/self-host/overview)｜[helicone.ai/blog/joining-mintlify](https://www.helicone.ai/blog/joining-mintlify)
- **LangSmith**（闭源商业）：LangChain 官方平台，生态绑定深，仅企业版支持自托管。**适合参考**其 eval 与 trace 设计，不开源不可自建。[langfuse.com/compare/langsmith](https://langfuse.com/compare/langsmith)
- **OpenTelemetry GenAI**（Apache-2.0，规范+SDK 非平台）：定义 `gen_ai.*` 语义约定，Langfuse/Phoenix/TruLens 均基于或兼容 OTel。2026-05 时 GenAI/MCP 语义约定仍为 Development 状态，**适合作为数据规范接入，不适合当独立平台**。[opentelemetry.io/docs/specs/semconv/gen-ai](https://opentelemetry.io/docs/specs/semconv/gen-ai)｜[greptime.com/blogs/2026-05-09](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)
- **Arize Phoenix**（Elastic License 2.0，约 1.2 万 star）：开源 AI 可观测性 + 评估平台，官方 Docker 镜像自托管、无功能限制。**适合直接自托管/二次开发**；注意 ELv2 对再分发与托管服务的限制。[github.com/Arize-ai/phoenix](https://github.com/Arize-ai/phoenix)｜[arize.com/docs/phoenix/self-hosting](https://arize.com/docs/phoenix/self-hosting)

## 二、评估

- **promptfoo**（MIT，1.7 万+ star）：CLI-first 的 prompt/agent/RAG 评测与红队工具，YAML 用例可入 CI，支持 **Docker Compose 自托管**。2026-03 被 OpenAI 收购，承诺保持开源 MIT。**适合直接部署**作为团队统一评测入口。[github.com/promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)｜[promptfoo.dev/docs/usage/self-hosting](https://www.promptfoo.dev/docs/usage/self-hosting)｜[promptfoo.dev/blog/promptfoo-joining-openai](https://www.promptfoo.dev/blog/promptfoo-joining-openai)
- **DeepEval**（Apache-2.0，约 1.7 万 star）：Python 评测框架（"pytest 之于 LLM"），指标丰富，作为库集成而非独立服务，支持 CI 门禁。**适合直接引入**做离线/回归评测。[github.com/confident-ai/deepeval](https://github.com/confident-ai/deepeval)｜[deepeval.com/blog/top-5-llm-evaluation-frameworks](https://deepeval.com/blog/top-5-llm-evaluation-frameworks)
- **Ragas**（Apache-2.0，约 1.5 万 star）：RAG 评估指标库（faithfulness、answer relevancy 等），活跃维护（现位于 vibrantlabsai/ragas）。**适合直接引入**做 RAG 专项评测。[github.com/vibrantlabsai/ragas](https://github.com/vibrantlabsai/ragas)｜[agenthivex.com/agent/vibrantlabsai-ragas](https://agenthivex.com/agent/vibrantlabsai-ragas)
- **TruLens**（MIT，约 3k star）：OTel 原生的评估与追踪框架，2026 年达 3k star 里程碑，活跃度一般。**适合轻量集成或参考**其 OTel 接入方式。[github.com/truera/trulens](https://github.com/truera/trulens)｜[trulens.org/blog](https://www.trulens.org/blog)

## 三、安全护栏

- **Guardrails AI**（Apache-2.0，约 6.6k star）：输入/输出护栏框架 + Validator Hub（60+ 校验器）。2026-09 被 Harvey 收购，框架保持 Apache-2.0 免费。**适合直接集成**作运行时护栏；无自托管服务形态，作为库嵌入应用。[github.com/guardrails-ai/guardrails](https://github.com/guardrails-ai/guardrails)｜[harvey.ai/blog/guardrails-ai-joins-harvey](https://www.harvey.ai/blog/guardrails-ai-joins-harvey)
- **LLM Guard**（Protect AI，MIT，约 3.1k star）：⚠️ **已归档**（2026-07-09 只读）。扫描器设计值得参考，但生产勿采用。[github.com/protectai/llm-guard](https://github.com/protectai/llm-guard)
- **rebuff**：⚠️ **已归档**（2025-05-16 只读）。仅参考其多层注入防御思路。[github.com/protectai/rebuff](https://github.com/protectai/rebuff)
- **NeMo Guardrails**（Apache-2.0，约 6.5k star）：⚠️ **已 EOL**（2025-10），新项目勿用，可参考其对话级护栏设计。[github.com/NVIDIA-NeMo/Guardrails](https://github.com/NVIDIA-NeMo/Guardrails)
- **OWASP LLM Top 10（2025）**：社区安全基线事实标准，非软件。配套工具建议：**garak**（NVIDIA，Apache-2.0，约 8.1k star）与 **PyRIT**（Microsoft，MIT，约 4k star）做自动化红队扫描。**适合作为安全清单 + 上线前红队**。[genai.owasp.org/llm-top-10](https://genai.owasp.org/llm-top-10)｜[github.com/NVIDIA/garak](https://github.com/NVIDIA/garak)｜[github.com/microsoft/PyRIT](https://github.com/microsoft/PyRIT)

## 四、代码沙箱

- **E2B**（Apache-2.0，约 1.3 万+ star）：AI 代码执行沙箱，开源 runtime/SDK/控制面，可自托管（云托管版闭源）。**适合直接二次开发**接入 agent 代码解释器。[github.com/e2b-dev/e2b](https://github.com/e2b-dev/e2b)｜[e2b.dev/open-source](https://e2b.dev/open-source)
- **Daytona**（Apache-2.0，约 7.2 万 star）：API-first 沙箱平台，90ms 创建环境，2026 年 star 爆发式增长。开源可自托管。**适合直接部署/二次开发**。[github.com/daytonaio/daytona](https://github.com/daytonaio/daytona)｜[daytona.io/dotfiles/daytona-goes-open-source](https://www.daytona.io/dotfiles/daytona-goes-open-source)
- **Modal**（闭源商业）：serverless AI 计算 + Sandboxes，无自托管。**适合参考**其沙箱产品设计。[modal.com](https://modal.com/resources/best-serverless-sandboxes-ai-code-execution)
- **Firecracker**（Apache-2.0，约 3.7 万 star）：AWS 的 microVM 运行时（Lambda/Fargate 底层），生产验证充分。**适合作为沙箱底层直接使用/参考**，非开箱即用的 agent 沙箱服务。[github.com/firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker)
- **gVisor**（Apache-2.0，约 2 万 star）：Google 的容器安全沙箱运行时，2026-10 捐赠给 CNCF。**适合作为容器级沙箱运行时直接使用/参考**。[github.com/google/gvisor](https://github.com/google/gvisor)｜[gvisor.dev/blog/2026/10/02/gvisor-cncf](https://gvisor.dev/blog/2026/10/02/gvisor-cncf)

## 五、场景速查（直接采用 vs 参考）

| 项目 | 直接采用/自托管 | 参考价值 |
|---|---|---|
| Langfuse | ✅ 主选，docker compose 自托管 | 产品功能边界清晰，可作平台范本 |
| Helicone | ⚠️ 短期自托管（维护模式） | 代理式采集、成本追踪设计值得抄 |
| LangSmith | ❌ 闭源 | eval/trace 工作流是行业参照系 |
| OTel GenAI | 作为数据规范接入 | 标准演进方向 |
| Arize Phoenix | ✅ docker 自托管（注意 ELv2） | 实验/评估工作流设计 |
| promptfoo | ✅ CLI+自托管服务 | YAML 用例即文档，评测工程化范本 |
| DeepEval / Ragas | ✅ 库形式直接引入 | 指标定义可参考 |
| TruLens | 轻量引入 | OTel 原生接入方式 |
| Guardrails AI | ✅ 库形式嵌入应用 | Validator Hub 分类体系 |
| garak / PyRIT | ✅ 上线前红队扫描 | 攻击面清单对齐 OWASP |
| E2B / Daytona | ✅ 直接部署/二次开发 | 沙箱 API 设计 |
| Firecracker / gVisor | ✅ 作为底层运行时 | microVM vs 应用内核路线对比 |
| Modal | ❌ 闭源 | 产品化参考 |

## 六、可直接 docker compose 自托管清单

| 项目 | 许可证 | 自托管方式 |
|---|---|---|
| Langfuse | MIT | 官方 Docker Compose ✅ |
| Helicone | Apache-2.0 | 官方 Docker Compose ✅（维护模式） |
| Arize Phoenix | ELv2 | 官方 Docker 镜像 ✅ |
| promptfoo | MIT | Docker Compose / Helm ✅ |
| E2B / Daytona | Apache-2.0 | 可自托管，通常按基础设施部署 |

## 七、结论：中小团队可直接拼装组合

推荐组合：**Langfuse（docker compose，可观测性+评估底座）+ promptfoo（CI 评测与红队）+ Ragas 或 DeepEval（RAG/离线指标库）+ Guardrails AI（运行时输入/输出护栏）**，安全基线对照 **OWASP LLM Top 10**，上线前用 **garak/PyRIT** 做一次红队扫描；沙箱按需选 **E2B 或 Daytona**。这套组合全部开源、可自托管、许可证宽松（MIT/Apache-2.0，Phoenix 为 ELv2），无需商业授权即可拼出"可观测性 + 评估 + 护栏"闭环。

**避坑**：LLM Guard（2026-07 归档）、rebuff（2025-05 归档）、NeMo Guardrails（2025-10 EOL）均已停止维护，只可参考不可选型；Helicone 被收购后处于维护模式，不建议作为长期主平台。

**部署注意点**：① Langfuse 生产自托管依赖 PostgreSQL + ClickHouse（v3 起），建议 2C4G 起步，数据完全自主；② Phoenix 单容器即可跑，但 ELv2 不允许对外提供同类托管服务，只宜内部使用；③ promptfoo 的 CLI 无需服务端，用例进 Git、共享结果再上 Docker，评测天然可入 CI；④ Guardrails AI 是 Python 库，须嵌入应用进程，护栏与业务同生命周期；⑤ 沙箱属重基础设施，E2B/Daytona 自托管要管理 microVM/容器运行时，小团队可从托管版起步、按需再自建。整体上，上述组合均为宽松许可证，无商业授权门槛，是 2026 年中小团队自建 Agent 质量体系的成本最低路径。