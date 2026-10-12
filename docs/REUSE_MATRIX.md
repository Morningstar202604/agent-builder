# 成熟替代映射表 / REUSE MATRIX

> 本表是本 Skill 的**核心承诺**：每一层都用成熟方案，不手写轮子。
> **2026 最新技术现状见 [docs/TECH_LANDSCAPE.md](TECH_LANDSCAPE.md)**（Agent 集群/A2A/MCP 无状态化/记忆工具/混合检索等，含大厂采用证据与淘汰清单）。
> **对标与二次开发见 [docs/BENCHMARK_OPENSOURCE.md](BENCHMARK_OPENSOURCE.md)**（想做 X → 参考项目 Y / 直接 fork Z，含许可证红绿灯）。写代码前先查这三份文件。
> 任何 reference 中出现"自己实现某层基础设施"的代码，都应按下表替换为成熟库/成熟产品。
> 唯一允许手写的，是**业务差异层**（产品独特卖点）与**胶水层**（把成熟库接进你的架构的少量集成代码），且必须在代码中标注 `[CUSTOM]`。

## 逐层映射

| Reference | 手写实现（禁止） | 成熟替代 | 说明 |
|-----------|----------------|----------|------|
| 01 Foundation | LLM Provider 客户端（OpenAIClient / AnthropicClient / 工厂） | **Vercel AI SDK** (`ai` + `@ai-sdk/openai` / `@ai-sdk/anthropic`) 或 **LiteLLM** | 统一流式、工具调用、多 Provider；不要再手写 HTTP 封装 |
| 01 Foundation | ReAct 主循环（AbstractAgent.run / while+switch） | **LangGraph `createReactAgent`** 或 **OpenAI Agents SDK** | 状态机、检查点、循环检测、HITL 中断都由框架提供 |
| 01 Foundation | SSE 流式 API / EventSource 解析 | **Vercel AI SDK `streamText`** + `ai/react` 的 `useChat` | 流式、工具调用帧、取消、重连都是 SDK 能力 |
| 02 Tools & Skills | Token 估算器 / 上下文压缩器 | **tiktoken-wasm** / `@langchain/core` 的 TokenCounter 与摘要工具 | 不要自己写估算算法 |
| 02 Tools & Skills | ToolRegistry / 工具定义 | **LangChain Tool** / OpenAI `tool()` / MCP 工具 | 工具 schema 从 Zod 生成，不要手写参数映射 |
| 02 Tools & Skills | Skills 加载器 | **MCP** + 渐进披露（业务层 `[CUSTOM]`） | Skills 是产品概念，用 MCP 协议承载 |
| 03 Memory & RAG | 三层记忆 / HybridRetriever / RAG 管线 | **LlamaIndex** / **Haystack** / **LangGraph**（Agentic RAG）+ 记忆层 **Mem0** / **Zep** / **LangMem**；混合检索 + 重排是标配 | 分块用解析工具（LlamaParse/Unstructured），检索用向量库原生能力，不手写检索器 |
| 04 Sandbox | Docker 沙箱封装（cgroups/seccomp/cap-drop） | **E2B** / **Daytona** / **Modal** | 代码执行沙箱是平台能力，不要自己拼 Docker 参数 |
| 05 Multi-Agent | Supervisor+Worker 手写编排 / Agent 集群 | **LangGraph**（+LangSmith Deployment）/ **OpenAI Agents SDK handoffs** / **CrewAI Flows** / **Microsoft Agent Framework**；跨厂商用 **A2A**；orchestrator-worker 是主流模式 | 任务分发、状态快照、循环检测、长时任务、HITL 用框架与托管平台 |
| 06 HITL & Reflection | 人工审批 / 自反思循环 | **LangGraph interrupts** / **OpenAI Agents SDK HITL** | 审批暂停/恢复是框架能力，不要自己实现状态机 |
| 07 Security | Prompt 注入检测 / Guardrails / 工具分级 | **OpenAI Agents SDK Guardrails** / **LLM Guard** | 输入输出校验、Tripwire、红队测试用成熟库 |
| 08 Eval & Observability | Eval 框架 / 回归检测 / OTel 封装 | **Langfuse** / **promptfoo** / **OpenTelemetry SDK** | 评估、Trace、Token 统计、告警用现成平台 |
| 09 Deploy | Docker Compose / CI-CD 模板 | **GitHub Actions / GitLab CI 标准模板** + Docker Compose | 配置即代码，不是轮子；保留模板 |
| 10 Prompt Protocol | Prompt 模板引擎 / 版本管理 / A-B | **Langfuse Prompt** / **promptfoo** | 版本、灰度、回滚是平台能力 |
| 11 Function Calling | Provider 适配 / 重试 / 并行派发 | **LiteLLM** / **Vercel AI SDK tool** | 多 Provider 格式转换、参数映射交给库 |
| 12 Vector DB | 向量库客户端封装 | **Qdrant / Milvus / Chroma 官方 SDK** | 已满足；只保留 Embedding 服务抽象 `[CUSTOM]` |
| 13 Structured Output | Loose JSON Parser / 重试注入 | **Zod** + Vercel AI SDK `experimental_ObjectStream` / **instructor-js** | Schema 校验用 Zod；容错与重试用 SDK 能力 |
| 14 MCP Server Dev | MCP Server 传输层封装 | **@modelcontextprotocol/sdk**（2026-07-28 无状态规范，生产用 Streamable HTTP + OAuth 2.1，本机用 stdio；废弃 HTTP+SSE） | 保留 Resources/Prompts 业务定义；调试用官方 MCP Inspector |
| 15 Knowledge Base | 多格式解析 / 增量索引 / 引用追踪 | **LlamaIndex** / **Haystack** / **Unstructured** | 文档解析、索引、检索用成熟管线 |
| 16 Multimodal | TTS/STT/图片管线 | **官方 SDK**（OpenAI/Anthropic/Replicate）+ **ffmpeg** | 已满足；屏幕录制是浏览器/Electron API 非轮子 |
| 17 Streaming | SSE 调优 / 重连 | **Vercel AI SDK** + Nginx 配置 | 重连/心跳是 SDK 与代理配置，非手写协议 |
| 18 Framework Compare | —（对比文档） | 保留 | 无手写实现 |
| 19 Multi-Tenancy | RBAC / 配额 / 审计 / 计费 | **CASL / AccessControl** + Postgres RLS + **Stripe** | 权限模型、计量计费用成熟库 |
| 20 Agent Marketplace | 市场 / 评分 / 分成 | 业务层 `[CUSTOM]` | 无成熟开源替代，作为业务差异层 |
| 21 Fault Recovery | 快照 / 幂等 / 降级 | **Redis/Postgres 官方客户端** + **BullMQ** + **LangGraph checkpointer** | 状态持久化与任务队列用成熟库 |
| 22 Guardrails & Tracing | Guardrails 引擎 / span 封装 | **OpenAI Agents SDK Guardrails** + **Langfuse**（+OpenTelemetry GenAI semconv） | 基线对照 **OWASP LLM Top 10**；NeMo Guardrails 已 EOL 勿用；只保留业务规则 `[CUSTOM]` |
| 23 Artifacts & Computer Use | Artifact 渲染 / 浏览器操控 | **MCP** + **Playwright** + **Electron** | 已满足；CLI/Headless 用成熟工具 |
| 24 Product Layer | 路由 / 限流 / Webhook | **LiteLLM Proxy** + **Upstash Ratelimit** + Stripe Webhook | 多模型路由、限流、幂等用平台能力 |

## 手写边界（唯一允许手写的三种情况）

1. **业务差异层**：产品独特卖点（如编排逻辑、Artifact 决策引擎），标注 `[CUSTOM]`。
2. **胶水层**：把成熟库接进你的架构的少量代码（如把 MCP 工具转成 LangGraph 工具），只写集成，不写实现。
3. **配置与模板**：Docker Compose、CI-CD、Nginx 等声明式配置。

## 使用方式

- 写代码前先查本表：这一层是否已有成熟方案？有就接，没有才 `[CUSTOM]`。
- 任何 `[CUSTOM]` 代码都必须注释说明"为什么没有现成替代"，并给出可被 AST/ESLint 检查的边界。
- 新增 reference 或修改代码时，`npm run check` 必须保持 0 失败。