# CatPaw Agent Builder — 生产上线检查清单

> 用途：产品上线前的强制检查清单，覆盖安全、性能、功能、可观测性、桌面端、合规、部署基础设施七大维度。每一项需逐项勾选确认，标注"完成"或"不适用（附原因）"。
>
> 对应 reference 21 个文件，31000+ 行。本章只列检查项，修复方案见各 reference 具体章节。

---

## 目录

- [1. 安全（Security）](#1-安全security) — 17 项
- [2. 性能与可靠性（Performance & Reliability）](#2-性能与可靠性performance--reliability) — 12 项
- [3. 功能完整性（Feature Completeness）](#3-功能完整性feature-completeness) — 19 项
- [4. 可观测性（Observability）](#4-可观测性observability) — 9 项
- [5. Electron 桌面端专项（Electron Desktop）](#5-electron-桌面端专项electron-desktop) — 8 项
- [6. 合规与隐私（Compliance & Privacy）](#6-合规与隐私compliance--privacy) — 5 项
- [7. 部署与基础设施安全（Deployment & Infrastructure）](#7-部署与基础设施安全deployment--infrastructure) — 5 项
- [签署确认](#签署确认)

---

## 1. 安全（Security）

> 核心参考：`07-security.md`、`04-sandbox.md`、`19-multi-tenancy.md`、`10-prompt-protocol.md`、`15-knowledge-base.md`

### 1.1 输入侧防护

- [ ] **Prompt 注入检测引擎已启用**
  - 实现 `scanForInjection()` 函数并接入消息处理链路
  - 输入扫描 + 指令分隔符强化（UUID boundary）+ 输出侧 meta 检测
  - 已针对零宽字符/全角字符/同形字（Cyrillic）做归一化处理
  - 阈值 `INJECTION_THRESHOLD = 60` 已验证
  - 见 `07-security.md` § Step 1: Prompt 注入检测引擎

- [ ] **用户输入已用随机 UUID 分隔符包裹**
  - `wrapUserInput()` 将用户消息包在 `<user-message boundary="UUID">` 标记内
  - 防止用户通过伪造 XML/JSON 标签跳出输入上下文
  - 见 `07-security.md` § Step 1 — wrapUserInput 函数

- [ ] **指令分隔符与大模型通信已验证**
  - 通过诱导性 prompt 测试分隔符不会被用户输入绕过
  - 见 `07-security.md` § Step 1 — 指令分隔符强化

### 1.2 操作侧防护

- [ ] **工具执行分级系统已部署**
  - 低风险工具（read_file）直接执行
  - 中风险工具（write_file）记录审计日志
  - 高风险工具（execute_code / shell_exec）需要 HITL 人工审批
  - 分级规则已配置在 `ToolRiskLevel` 注册表
  - 见 `07-security.md` § Step 2: 工具执行分级系统

- [ ] **HITL 人工审批机制对高风险操作生效**
  - 高风险工具调用前暂停，前端弹出审批卡片
  - 用户确认/拒绝后继续/终止
  - 审批结果写入审计日志
  - 见 `07-security.md` § Step 2 — 高风险操作审批 + `06-hitl-reflection.md` 全篇

### 1.3 运行时沙箱防护

- [ ] **Docker 沙箱资源限制已配置**
  - `--cap-drop ALL`（丢弃所有 Linux capabilities）
  - `--memory 512m --memory-swap 512m`（内存 = swap，防溢出）
  - `--cpus 0.5`（限制 CPU）
  - `--pids-limit 50`（防 fork bomb）
  - `--network none` 或白名单模式
  - `--security-opt no-new-privileges:true`
  - `--read-only` + tmpfs 可写区隔离
  - 见 `04-sandbox.md` § Docker 沙箱核心实现 + § 安全约束层详解

- [ ] **容器不复用——每次执行新建销毁**
  - 不使用 `docker start` 复用旧容器
  - 每次 `docker run --rm` 创建新容器，运行后自动销毁
  - 防止恶意代码残留定时任务或替换可执行文件
  - 见 `04-sandbox.md` § Docker 沙箱核心实现 — 容器复用风险

- [ ] **seccomp / AppArmor 配置文件已应用**
  - 使用默认 seccomp profile（禁止危险 syscall）
  - 可选：切换到自定义 AppArmor profile 进一步限制文件系统访问
  - 见 `04-sandbox.md` § 安全约束层详解

### 1.4 多租户数据隔离

- [ ] **RLS（Row Level Security）策略已启用**
  - Postgres 层：所有表启用 `ENABLE ROW LEVEL SECURITY`
  - Policy 强制 `tenant_id = current_setting('app.current_tenant_id')`
  - 应用层使用 `HybridTenantStrategy` 注入租户上下文
  - 见 `07-security.md` § Step 4: 多租户工作区隔离 + `19-multi-tenancy.md` § 1.4 RLS 策略实现

- [ ] **跨租户数据泄漏测试已通过**
  - 自动化测试：租户 A 绝不读到租户 B 的会话/消息/记忆/知识库
  - 涵盖直接查询、API 越权、SSE 串流越权
  - 见 `19-multi-tenancy.md` § 5. 隔离策略

- [ ] **RBAC 权限矩阵已配置**
  - 角色：Admin / Manager / Member / Viewer
  - 后端 API 层校验（不仅前端隐藏按钮）
  - 工具执行权限与角色绑定
  - 见 `19-multi-tenancy.md` § 4. RBAC 矩阵设计

### 1.5 密钥与凭证安全

- [ ] **密钥管理 4 级优先级已实施**
  - 环境变量 → Docker Secrets → AWS SM / HashiCorp Vault
  - 启动时强制 `validateSecrets()` 校验，缺 key 直接 fail-fast
  - 密钥不入 git（`.gitignore` + TruffleHog 检测）
  - 见 `09-deploy.md` § Step 5: 密钥管理

- [ ] **依赖漏洞扫描已集成到 CI**
  - `pnpm audit --audit-level high` 作为 CI Stage 3
  - TruffleHog `--only-verified` 做密钥泄漏检测
  - 见 `09-deploy.md` § Step 4: GitHub Actions CI/CD — Stage 3

- [ ] **PromptSanitizer 前置净化层已部署**
  - 对所有外源性内容（RAG 召回文档、工具返回数据）做注入扫描
  - 检测后门指令（如"在回复末尾添加以下文字"）
  - 净化结果写入安全事件日志
  - 见 `10-prompt-protocol.md` § 10.6 注入防御——前置净化层

- [ ] **Prompt 版本管理 + 灰度切换已就绪**
  - Prompt 模板支持版本化存储（版本 ID + diff 比对）
  - A/B 测试可按租户/比例灰度切换 prompt 版本
  - 异常时可一键回滚到上一稳定版本
  - 见 `10-prompt-protocol.md` § 10.5 Prompt Versioning

---

## 2. 性能与可靠性（Performance & Reliability）

> 核心参考：`21-fault-recovery.md`、`17-streaming-advanced.md`、`02-tools-skills.md`

### 2.1 上下文窗口管理

- [ ] **Token 估算器已集成到 Agent 循环**
  - 默认 CharBasedEstimator（零依赖，±15% 误差）
  - 可切换 tiktoken-wasm 精确模式
  - 前端 ContextUsageBar 实时显示使用量
  - 见 `02-tools-skills.md` § 上下文窗口管理 — Token 估算器

- [ ] **上下文压缩策略已启用**
  - 保留最近 N 轮消息完整，更早压缩为摘要
  - 压缩在 ReAct 循环每轮迭代开始时发生（非用户发消息前）
  - 压缩后的消息视图不覆盖原始 `context.messages`
  - 见 `02-tools-skills.md` § 上下文窗口管理 — 上下文压缩器

- [ ] **Token Budget 编排器已配置**
  - 每个会话设置 `maxTokenBudget`
  - 超出预算时自动压缩而非截断
  - Headroom 安全余量 ~10%
  - 见 `02-tools-skills.md` § 上下文窗口管理 — Token Budget 编排器

### 2.2 流式传输可靠性

- [ ] **SSE 智能重连机制已实现**
  - 重连时携带 `Last-Event-ID` 服务端补发丢失的 chunks
  - 指数退避策略（1s → 2s → 4s → 最大 30s）
  - 重连成功后前端恢复渲染，无重复/遗漏
  - 见 `17-streaming-advanced.md` § 3. 智能重连策略

- [ ] **Nginx SSE 兼容配置已部署**
  - `/api/chat` 路由下：`proxy_buffering off` + `proxy_cache off`
  - `proxy_read_timeout 600s`（Agent 多步推理可达 10 分钟）
  - 见 `09-deploy.md` § Step 3: Nginx 反向代理（SSE 友好）

- [ ] **流式延迟指标已测量并达标**
  - TTFT < 800ms（首 token）
  - TPOT < 50ms/token
  - 含 `StreamLatencyTracker` 追踪并上报
  - 见 `17-streaming-advanced.md` § 1. TTFT / TPOT / E2E Latency 调优

### 2.3 容错与恢复

- [ ] **Agent 状态快照已实现**
  - Redis 热快照（每次工具调用后写入，TTL 24h）
  - Postgres 冷归档（会话结束时落库）
  - Snapshot 包含：消息历史 + 待处理工具调用 + token 使用量 + 流式状态
  - 见 `21-fault-recovery.md` § 1. Agent 状态快照

- [ ] **断线重连恢复流程已测试**
  - 模拟场景：30 分钟对话中 SSE 断开
  - 恢复后从快照重建，用户无需重新开始
  - 已验证消息完整性 + token 计费连续性
  - 见 `21-fault-recovery.md` § 2. 断线重连恢复流程

- [ ] **降级模型切换已配置**
  - 主模型不可用 → 自动切换到备用模型
  - 切换对用户透明（前端不提示）
  - 已配置 `ModelFallbackChain`
  - 见 `21-fault-recovery.md` § 4. 降级模型切换

- [ ] **工具调用幂等性已保证**
  - 所有可重入工具实现幂等 key
  - 重复调用返回缓存结果，不产生副作用
  - 见 `21-fault-recovery.md` § 3. 工具调用幂等性设计

- [ ] **超时与取消优雅处理已实现**
  - Agent 会话可配置全局超时（默认 30 分钟）
  - 用户主动取消时释放底层 HTTP 连接
  - 超时后自动保存快照并通知前端
  - 见 `21-fault-recovery.md` § 5. 超时与取消优雅处理

### 2.4 前端性能

- [ ] **长消息列表使用虚拟滚动**
  - 1000+ 消息不卡顿，DOM 节点恒定
  - 见 `01-foundation.md` § 1.6 — 长列表虚拟化

- [ ] **关键指标告警规则已配置**
  - Token 消耗异常（单会话 > 预算 200%）
  - 工具调用失败率 > 5%
  - LLM 提供商错误率 > 10%（触发降级）
  - 沙箱容器异常退出率 > 1%
  - 见 `08-eval-observability.md` § Part B Step 5: 异常检测与告警

---

## 3. 功能完整性（Feature Completeness）

> 核心参考：`02-tools-skills.md`、`11-function-calling.md`、`13-structured-output.md`、`14-mcp-server-dev.md`

### 3.1 工具系统

- [ ] **所有工具通过 ToolRegistry 统一暴露**
  - 工具注册使用标准 `AgentTool` 接口
  - 工具发现 API `/api/tools` 可返回全部可用工具列表
  - 见 `02-tools-skills.md` § ToolRegistry 完整实现

- [ ] **MCP Client 双模式通信已验证**
  - Stdio 模式（本地 MCP Server）和 SSE 模式（远程 MCP Server）均能连通
  - MCPManager 多连接管理（同时接入 3+ MCP Server）
  - 见 `02-tools-skills.md` § MCPClient 双模式通信

- [ ] **Tool Call Retry & Error Recovery 已测试**
  - 参数校验失败 → 自动重试（带错误信息反馈给 LLM）
  - JSON 截断修复（自动补全大括号）
  - 最大重试 3 次后上报错误
  - 见 `11-function-calling.md` § 11.3 Tool Call Retry & Error Recovery

- [ ] **并行工具调用已实现**
  - `Promise.allSettled` 并行执行无依赖工具
  - 失败工具不阻塞其他工具结果
  - 并发限制（默认最大 5 并行）
  - 见 `11-function-calling.md` § 11.4 Parallel Tool Calls

### 3.2 结构化输出

- [ ] **Zod Schema First 范式已贯穿**
  - 工具参数定义使用 Zod → 自动生成 JSON Schema → 发给 LLM
  - LLM 输出后 Zod 校验 → 失败则构建错误信息喂回 LLM
  - 见 `13-structured-output.md` § 1. Zod Schema First 范式

- [ ] **Loose JSON Parser 容错解析已启用**
  - 处理 Markdown 包裹、多余文本、trailing comma、单引号等 12 种失败场景
  - 见 `13-structured-output.md` § 3. Loose JSON Parser——容错解析

### 3.3 前端功能

- [ ] **流式渲染含代码块容错**
  - Markdown 流式渲染不因为未闭合的 ```` ``` ```` 块崩溃
  - 使用 `React-Markdown` + `remark-gfm` + 自定义 fence 修复
  - 见 `01-foundation.md` § 1.6 前端——流式 Markdown 渲染

- [ ] **工具调用卡片展示正确**
  - 工具调用中 → 显示 loading 状态
  - 工具完成 → 显示结果摘要（可展开 raw data）
  - 工具失败 → 显示错误信息，不阻塞后续消息
  - 见 `01-foundation.md` § 1.6 前端——工具调用卡片

- [ ] **Skills 系统渐进披露正常**
  - Skills 元数据按需加载（不全量预加载）
  - 冲突检测：同名工具触发警告
  - SkillContextManager 正确淘汰过期 Skill 上下文
  - 见 `02-tools-skills.md` § Skill 系统——渐进披露

- [ ] **前端 Content Security Policy 头已配置**
  - 限制 script-src / style-src 仅允许同源 + 已知 CDN
  - 防止 Agent 输出中注入恶意脚本执行
  - 见 `07-security.md` § Step 7: 前端安全中心 UI

- [ ] **多模态 Modal 已验证（如启用）**
  - 图片上传 → 模型理解 → 描述返回
  - STT 语音输入 → 文字转写 → 发送 Agent
  - TTS 语音输出 → Agent 文字回复转语音
  - 见 `16-multimodal-agent.md` § 1-6

- [ ] **Sandbox 执行状态 UI 正常**
  - 代码执行 → 终端卡片实时输出 stdout/stderr
  - 超时/错误 → 状态变红 + 显示错误原因
  - 执行完成后卡片可折叠
  - 见 `04-sandbox.md` § 前端沙箱状态 UI

---

## 4. 可观测性（Observability）

> 核心参考：`08-eval-observability.md`、`09-deploy.md`

### 4.1 链路追踪

- [ ] **OpenTrace Trace 已接入**
  - OTLP Collector 已部署（docker-compose 中 `otel-collector` 服务）
  - 关键 Span：agent.run → llm.stream → tool.execute → sandbox.run
  - 支持 Jaeger / Tempo 后端可视化
  - 见 `08-eval-observability.md` § Part B Step 1: OpenTelemetry 集成

- [ ] **Trace ID 贯穿全链路**
  - HTTP 请求 → Agent 循环 → LLM 调用 → 工具执行，共享同一 traceId
  - 日志中包含 `traceId` 字段，可关联查询
  - 见 `08-eval-observability.md` § Part B Step 2: 结构化日志 + Trace ID 串联

### 4.2 指标与告警

- [ ] **关键指标已上报到 Prometheus**
  - Token 消耗（按会话/按租户/按模型分维度）
  - 工具调用成功率 / 延迟 P50/P95/P99
  - SSE 连接数 / 重连次数 / 平均会话时长
  - 见 `08-eval-observability.md` § Part B Step 3-5

- [ ] **关键告警规则已配置**
  - Token 消耗异常（单会话 > 预算 200%）
  - 工具调用失败率 > 5%
  - LLM 提供商错误率 > 10%（触发降级）
  - 沙箱容器异常退出率 > 1%
  - 见 `08-eval-observability.md` § Part B Step 5: 异常检测与告警

### 4.3 日志

- [ ] **生产日志级别正确**
  - 生产环境 `LOG_LEVEL >= warn`（不记录 DEBUG）
  - 会话内容不记录完整 prompt（仅记录元信息：消息数/token 数/耗时）
  - 关键操作（工具调用/安全事件）记录结构化日志
  - 见 `08-eval-observability.md` § Part B Step 2: 结构化日志

- [ ] **Grafana 看板已配置**
  - Agent 总览面板（活跃会话数 / 总 token 消耗 / 平均延迟）
  - 服务健康面板（各容器状态 / 资源使用率）
  - 安全事件面板（注入尝试 / 风险工具调用 / 异常行为）
  - 见 `08-eval-observability.md` § Part B 后端 API + Grafana 看板数据源

- [ ] **Eval 回归测试已集成到 CI**
  - CI Stage 4 自动跑 Unit + Integraion + Satisfaction 三类 eval
  - Eval 得分低于历史平均线时 CI 失败
  - 防止"改了 A 结果 B 崩了"
  - 见 `08-eval-observability.md` § Part A Step 3-6

---

## 5. Electron 桌面端专项（Electron Desktop）

> 核心参考：`01-foundation.md §1.7 — Electron 桌面壳`

### 5.1 安全配置

- [ ] **`contextIsolation: true` 已启用**
  - preload 脚本不直接暴露 Node.js API
  - 渲染进程无法直接访问 `require`) / `process` / `fs`
  - 见 `01-foundation.md` § 1.7 — preload 安全 IPC

- [ ] **`nodeIntegration: false` + `sandbox: true` 双件套**
  - 渲染进程禁用 Node.js 集成
  - Chromium 沙箱隔离已开启
  - 见 `01-foundation.md` § 1.7 — 窗口创建 webPreferences 配置

- [ ] **preload 仅暴露白名单 API**
  - `contextBridge.exposeInMainWorld` 仅暴露 `agentAPI` 下的 `sendMessage` / `onMessage` / `cancelStream`
  - 未暴露 `shell` / `fs` / `child_process` 等危险 API
  - 见 `01-foundation.md` § 1.7 — IPC 通道设计

### 5.2 打包与分发

- [ ] **自动更新机制已配置**
  - 使用 `electron-updater` + 私有更新服务器（或 GitHub Releases）
  - 更新包签名校验已启用
  - 见 `01-foundation.md` § 1.7 — 打包与自动更新

- [ ] **macOS 代码签名 + 公证（Notarization）已完成**
  - `electron-builder` 配置 `hardenedRuntime: true`
  - 签名身份 + 团队 ID 已配置
  - `afterSign` 钩子触发 `electron-notarize`
  - 无签名 Gatekeeper 警告：`spctl -a -vv` 应显示 `accepted`
  - 见 `09-deploy.md` § Step 6: Electron 打包与签名

- [ ] **Windows 代码签名已配置**
  - `electron-builder` 配置 `certificateFile` + `certificatePassword`
  - 签名后文件属性 → 数字签名 → 应显示有效签名者
  - 见 `09-deploy.md` § Step 6 — Windows 签名配置

### 5.3 桌面体验

- [ ] **托盘图标 + 全局快捷键已配置**
  - 最小化到托盘后可用快捷键唤起
  - 托盘菜单包含：显示主窗口 / 新建对话 / 退出
  - 见 `01-foundation.md` § 1.7 — 托盘与全局快捷键

- [ ] **Shell 适配层正常工作**
  - Web 代码中 `isElectron()` 判断正确
  - 文件对话框 / 通知 / 外部链接跳转走 Electron 原生 API
  - 见 `01-foundation.md` § 1.7 — Shell 适配层

---

## 6. 合规与隐私（Compliance & Privacy）

> 核心参考：`19-multi-tenancy.md`、`08-eval-observability.md`、`09-deploy.md`

### 6.1 数据隔离

- [ ] **多租户数据隔离已按规模选型**
  - < 10 租户：Shared-schema + 应用层过滤
  - 10+ 租户：RLS 模式（Postgres 层行级安全策略）
  - 大客户：Database-per-tenant 完全物理隔离
  - 见 `19-multi-tenancy.md` § 1.2 推荐策略 + § 5. 隔离策略

### 6.2 审计

- [ ] **审计日志已启用并持久化**
  - 记录所有敏感操作（数据删除 / 权限变更 / 工具执行）
  - 审计日志包含：操作人 / 时间 / 操作类型 / 对象 ID / 结果
  - 审计日志存储在独立 schemare 防篡改
  - 见 `19-multi-tenancy.md` § 6. 跨租户审计日志

### 6.3 敏感数据

- [ ] **敏感数据脱敏已配置**
  - 日志中 `API Key` / `Token` / `Password` 字段自动替换为 `***`
  - 用户邮箱 /手机号在日志中部分掩码
  - 见 `10-prompt-protocol.md` § 10.6 注入防御——前置净化层 + `19-multi-tenancy.md` § 6

- [ ] **数据保留策略已配置**
  - 会话消息：默认保留 90 天，可配置
  - 审计日志：保留 1 年
  - 向量记忆：保留策略与业务约定一致
  - 见 `19-multi-tenancy.md` § 7. 计费 & 计量

---

## 7. 部署与基础设施安全（Deployment & Infrastructure）

> 核心参考：`09-deploy.md`、`04-sandbox.md`

### 7.1 容器安全

- [ ] **Docker Compose 安全约束已配置**
  - 全部服务 `security_opt: no-new-privileges:true`
  - `cap_drop: ALL` 后仅 `cap_add` 必需的 capability
  - 数据库端口 `127.0.0.1:5432:5432` 绑定 localhost（非公网暴露）
  - `read_only: true` + tmpfs 可写区
  - 见 `09-deploy.md` § Step 1: Docker Compose 全栈部署

- [ ] **生产 Dockerfile 使用多阶段构建**
  - deps → builder → runner 三阶段
  - runner 阶段仅 COPY 产物，源码和 devDependencies 不带入镜像
  - 最终镜像 < 200MB
  - 见 `09-deploy.md` § Step 2: Next.js 生产 Dockerfile

### 7.2 网络安全

- [ ] **HTTPS / SSL 已强制启用**
  - Nginx 配置 TLS 1.2+ 终止
  - HTTP → HTTPS 301 重定向
  - HSTS 头已配置
  - 见 `09-deploy.md` § Step 3: Nginx 反向代理

- [ ] **API 速率限制已配置**
  - Nginx 层：`limit_req_zone` 限制 10r/s per IP
  - 应用层：按租户/按用户限速
  - 见 `09-deploy.md` § Step 3 — Nginx 速率限制 + `19-multi-tenancy.md` § 3. 资源配额系统

### 7.3 CI/CD 流水线

- [ ] **CI/CD Pipeline 6 阶段串行依赖正确**
  - Build → TypeCheck → Security → Eval → Docker → Deploy
  - 前序阶段失败时后续不执行
  - Deploy 仅在 eval 通过后执行
  - 见 `09-deploy.md` § Step 4: GitHub Actions CI/CD

---

## 签署确认

| 角色 | 姓名 | 日期 | 签名 |
|------|------|------|------|
| 开发负责人 | | | ☐ 确认所有适用项已勾选 |
| 安全负责人 | | | ☐ 确认安全维度 17 项全部通过 |
| 运维负责人 | | | ☐ 确认部署 + 可观测性已就绪 |
| 产品负责人 | | | ☐ 确认功能完整性 + 合规达标 |
| 基础设施负责人 | | | ☐ 确认容器 + 网络 + CI/CD 安全达标 |

---

## 附录：Reference 全索引速查

| Reference | 文件名 | 覆盖领域 | 行数 |
|-----------|--------|---------|------|
| 01 | foundation.md | Monorepo + Agent 核心 + SSE + React UI + Electron | ~900 |
| 02 | tools-skills.md | Token 预算 + ToolRegistry + MCP + Skills | ~800 |
| 03 | memory-rag.md | 三层记忆 + 向量搜索 + RAG 管线 | ~700 |
| 04 | sandbox.md | Docker 沙箱 + 安全约束 + 审计 | ~600 |
| 05 | multi-agent.md | Supervisor+Worker + LangGraph | ~800 |
| 06 | hitl-reflection.md | 人工审批 + 自反思循环 | ~700 |
| 07 | security.md | Prompt 注入 + 工具分级 + 逃逸检测 | ~700 |
| 08 | eval-observability.md | 评估框架 + OpenTelemetry + 日志 | ~800 |
| 09 | deploy.md | Docker Compose + CI/CD + 密钥 + Electron 签名 | ~500 |
| 10 | prompt-protocol.md | 五层 Prompt + 模板引擎 + 版本管理 | ~600 |
| 11 | function-calling.md | Provider 适配 + 重试 + 并行 + 审计 | ~500 |
| 12 | vector-db-practical.md | 向量库选型 + Qdrant SDK + Embedding + Rerank | ~700 |
| 13 | structured-output.md | Zod Schema + JSON Mode + 容错解析 + 重试 | ~500 |
| 14 | mcp-server-dev.md | MCP Server 开发 + 传输 + 调试面板 | ~600 |
| 15 | knowledge-base.md | 多格式解析 + Delta Indexing + 版本化 RAG | ~600 |
| 16 | multimodal-agent.md | 图片理解 + TTS/STT + 屏幕录制 + 图片生成 | ~500 |
| 17 | streaming-advanced.md | TTFT/TPOT 调优 + 智能重连 + 健康检查 | ~500 |
| 18 | framework-comparison.md | LangGraph/CrewAI/AutoGen 对比 + 集成桥接 | ~400 |
| 19 | multi-tenancy.md | 租户隔离 + RBAC + 配额 + 审计 + 计费 | ~500 |
| 20 | agent-marketplace.md | 发布 API + 安全扫描 + 评分 + 分成 | ~500 |
| 21 | fault-recovery.md | 状态快照 + 断线重连 + 幂等 + 降级 + 超时 | ~500 |

> 本清单覆盖 7 大维度共 **75 项**检查点。每项标注对应 reference 章节，修复时直接定位到具体文件。
