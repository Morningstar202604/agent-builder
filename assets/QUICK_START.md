# CatPaw Agent Builder — 快速启动指南

> 目标：30 分钟内跑起来第一个可用的 Agent。本文假设你从零开始，只在必要时引入依赖。

---

## 目录

- [1. 五步跑起来最小可用 Agent](#1-五步跑起来最小可用-agent)
- [2. 快速版 Reference 地图](#2-快速版-reference-地图)
- [3. 分场景快速路径](#3-分场景快速路径)
- [4. 依赖版本速查表](#4-依赖版本速查表)
- [5. 常见启动失败排查](#5-常见启动失败排查)

---

## 1. 五步跑起来最小可用 Agent

### Step 1: 安装依赖

```bash
# 克隆或创建项目目录
mkdir -p agent-core && cd agent-core

# 初始化 monorepo（参照 01-foundation.md §1.1）
# 手动创建 pnpm-workspace.yaml / package.json / turbo.json
# 或直接复制 01-foundation.md 中的配置模板

# 启用 corepack（确保 pnpm 版本正确）
corepack enable

# 安装所有依赖
pnpm install --frozen-lockfile
```

**关键检查**：
- `node >= 20.0.0`（Next.js 14 + Prisma 要求）
- `pnpm >= 9.0.0`（workspace 协议支持）
- 安装完成后 `node_modules/.pnpm` 应存在且非空

### Step 2: 配置 .env

```bash
# 复制环境变量模板
cp .env.example .env
```

最小可用 `.env`（仅聊天功能，无需数据库）：

```env
# === LLM Provider（至少配一个） ===
OPENAI_API_KEY=sk-xxxxx
OPENAI_BASE_URL=https://api.openai.com/v1   # 可替换为任意 OpenAI 兼容端点
LLM_MODEL=gpt-4o-mini                        # 默认模型

# === Next.js Auth（开发用随机值即可） ===
NEXTAUTH_SECRET=dev-secret-please-change-in-production
NEXTAUTH_URL=http://localhost:3000

# === 可选：持久化存储 ===
# POSTGRES_URL=postgresql://agentcore:password@localhost:5432/agentcore
# REDIS_URL=redis://localhost:6379
```

> 如果暂时不需要会话持久化，可以不配 `POSTGRES_URL`。Next.js 默认将状态存于内存，重启后丢失——开发阶段完全够用。

### Step 3: 启动 Next.js Web

```bash
# 开发模式（热更新）
pnpm dev

# 或构建后启动生产模式
pnpm build && pnpm start
```

访问 `http://localhost:3000`，看到聊天界面即成功。

**期望输出**：
- 终端显示 `Ready in 2.3s`
- 浏览器显示聊天气泡 + 输入框
- 无 TypeScript 报错

### Step 4: 启动 Electron 桌面端（可选）

```bash
# 在前端已构建的前提下
cd apps/electron
pnpm dev
```

首次启动会弹出桌面窗口，内容与 Web 版一致。

### Step 5: 验证：发送一条消息

1. 在聊天输入框输入 `"你好，请用一句话介绍你自己"`
2. 按回车发送
3. **期望**：看到流式文字逐个 token 出现（非整段一次性弹出）
4. **失败排查**：
   - 无响应：检查 `.env` 中 `OPENAI_API_KEY` 是否正确
   - 报错 `401 Unauthorized`：Key 过期或无余额
   - 报错 `ECONNREFUSED`：`OPENAI_BASE_URL` 不可达
   - 流式不工作：浏览器 DevTools → Network 应看到 `api/chat` 请求的 `Content-Type: text/event-stream`

---

## 2. 快速版 Reference 地图

21 个 reference 总计 31000+ 行，无需通读。**只读以下 5 个 reference 的前半部分，即可覆盖日常 80% 的需求**：

### 2.1 01-foundation.md（读前 600 行）

**覆盖内容**：Monorepo 初始化、LLM 抽象层、Agent ReAct 主循环、SSE API、React 聊天 UI、Electron 桌面壳。

**必读章节**：
- §1.1 Monorepo 初始化与工具链（L50-100）
- §1.3 core 包——LLM 抽象层（L100-200）
- §1.4 Agent 核心——ReAct 主循环（L594-700）
- §1.5 SSE 流式 HTTP API（含 POST /api/chat）

**为什么先读这个**：这是整个产品的骨架，后续所有 reference 都基于此骨架扩展。读完后你会理解"一个 Agent 请求从用户点击发送到收到回复"的完整路径。

### 2.2 02-tools-skills.md（读前 400 行）

**覆盖内容**：Token 预算估算、上下文窗口压缩、ToolRegistry 工具注册中心、内置工具（read_file / write_file / search_web 等）、MCP 客户端双模式通信。

**必读章节**：
- 上下文窗口管理——Token 估算器 + 上下文压缩器（L65-180）
- ToolRegistry 完整实现（L180-300）
- 内置工具实现（L300-400）

**为什么读这个**：Agent 的核心能力 = 工具调用。读完你会知道如何注册自己的工具、如何接入 MCP Server、如何在 token 超限时自动压缩历史。

### 2.3 13-structured-output.md（读前 300 行）

**覆盖内容**：Zod Schema First 范式、12 种 JSON 失败场景分析、Loose JSON Parser 容错解析、带错误注入的重试机制。

**必读章节**：
- Zod Schema First 范式（§1）
- Loose JSON Parser——容错解析（§3）
- Retry with Error Injection（§4）

**为什么读这个**：Agent 的工具调用依赖 LLM 输出结构化 JSON，但 LLM 输出的 JSON 经常"看似合法实则非法"。这一节让你的 tool_call 从"偶尔能解析"升级到"几乎不失败"。

### 2.4 12-vector-db-practical.md（读前 300 行）

**覆盖内容**：向量数据库选型决策树、Qdrant 完整 SDK 客户端初始化与 Collection 配置、Embedding 服务抽象层、Embedding 缓存。

**必读章节**：
- 向量数据库选型决策树（§1）
- Qdrant 客户端初始化与 Collection 配置（§2）
- Embedding 服务抽象层（§4）

**为什么读这个**：给 Agent 加记忆的核心基础设施。读完知道选哪个向量库、怎么初始化、怎么把文本变成向量存进去。

### 2.5 09-deploy.md（读前 200 行）

**覆盖内容**：Docker Compose 全栈部署（web + postgres + redis + qdrant + nginx + OTel Collector）、安全约束配置（read_only / no-new-privileges / cap_drop）。

**必读章节**：
- Step 1: Docker Compose 全栈部署（§L35-165）

**为什么读这个**：从"本地能跑"到"部署上线"只需要这一个文件。docker-compose up 一键拉起所有服务。

---

## 3. 分场景快速路径

根据你的目标，选择最短阅读路径：

| 你的目标 | 最短阅读路径 | 预计时间 |
|---------|-------------|---------|
| **"我只想做一个能聊天的 Agent"** | 01-foundation.md 前 600 行（monorepo + Agent 主循环 + SSE API + React UI） | 30 min |
| **"我要加记忆 / RAG 检索"** | 01-foundation 前 300 行 → 03-memory-rag.md 前 500 行（三层记忆 + MemoryManager + HybridRetriever） → 12-vector-db-practical.md 前 300 行（向量库） | 60 min |
| **"我要加 MCP 工具"** | 02-tools-skills.md 后 400 行（MCP Client + MCPManager） → 14-mcp-server-dev.md 前 400 行（自建 MCP Server：Stdio+SSE 传输 + Resources + 调试面板） | 50 min |
| **"我要上线"** | 09-deploy.md 全篇（Docker Compose + CI/CD + 密钥管理 + Electron 签名） → 17-streaming-advanced.md 前 200 行（SSE 调优 + 重连） → 07-security.md（安全） | 90 min |
| **"我要多 Agent 协作"** | 05-multi-agent.md 全篇（Supervisor+Worker 编排 + LangGraph 模式） → 18-framework-comparison.md 前半（框架选型） | 70 min |
| **"我要加结构化输出"** | 13-structured-output.md 全篇（Zod schema + JSON Mode + 容错解析 + 错误注入重试） | 30 min |
| **"我要做企业多租户"** | 19-multi-tenancy.md 全篇（RLS 隔离 + RBAC + 配额 + 审计日志 + 计费） | 50 min |
| **"我要加语音 / 图片模态"** | 16-multimodal-agent.md 全篇（Modality Router + 图片理解 + TTS/STT + 屏幕录制） | 50 min |
| **"我要让 Agent 安全合规"** | 07-security.md 全篇（Prompt 注入引擎 + 工具分级 + 沙箱逃逸检测 + 多租户隔离） → 04-sandbox.md 前半（Docker 沙箱资源限制） | 60 min |
| **"我要评估 Agent 质量"** | 08-eval-observability.md Part A（评估框架 + 三类 Eval + LLM-as-Judge + 回归检测） | 40 min |
| **"我要可观测性"** | 08-eval-observability.md Part B（OpenTelemetry + Trace ID + Token 追踪 + 告警） | 30 min |
| **"我要断线重连 / 容错"** | 21-fault-recovery.md 全篇（状态快照 + 断线重连 + 幂等设计 + 降级模型） | 40 min |

### 阅读顺序原则

1. **01-foundation 是地基**——任何场景都先读它的前 300 行
2. **依赖链不可跳跃**——05-multi-agent 依赖 02-tools + 03-memory，不能直接读 05
3. **按需加载**——每个 reference 500-900 行，不要预读全部

---

## 4. 依赖版本速查表

### 基础设施

| 组件 | 最低版本 | 推荐版本 | 说明 |
|------|---------|---------|------|
| Node.js | >= 20.0.0 | 20.x LTS | Next.js 14 + Prisma 5 要求 |
| pnpm | >= 9.0.0 | 9.x | workspace 协议 + lockfile v6 |
| Docker | >= 24.0 | 25.x | Compose v2 格式 |
| Docker Compose | >= 2.20 | 2.24+ | healthcheck + depends_on 条件 |
| Python | >= 3.10 | 3.12 | OCR / PDF 处理（可选） |

### 关键 npm 包

| 包名 | 最低版本 | 用途 |
|------|---------|------|
| next | >= 14.2.0 | Web 框架（.standalone 产物） |
| react / react-dom | >= 18.3.0 | UI 框架 |
| zod | >= 3.23.0 | 结构化输出校验 |
| @anthropic-ai/sdk | >= 0.32.0 | Anthropic 原生客户端 |
| openai | >= 4.56.0 | OpenAI 兼容客户端 |
| @qdrant/js-client-rest | >= 1.11.0 | Qdrant 向量库 |
| prisma / @prisma/client | >= 5.20.0 | 数据库 ORM |
| ioredis | >= 5.4.0 | Redis 客户端（快照 + 限流） |
| zustand | >= 4.5.0 | 前端状态管理 |
| @opentelemetry/* | >= 1.26.0 | 可观测性 SDK |
| electron | >= 32.0.0 | 桌面端壳 |
| @anthropic-ai/sdk | >= 0.32.0 | Anthropic 原生客户端 |

### 数据库 / 基础设施镜像

| 镜像 | 版本 | 用途 |
|------|------|------|
| postgres | pgvector/pgvector:pg16 | 会话持久化 + 向量扩展 |
| redis | redis:7-alpine | 会话缓存 / 限流计数器 |
| qdrant | qdrant/qdrant:v1.12 | 知识库向量检索 |
| nginx | nginx:alpine | 反向代理 + SSL 终止 |
| otel-collector | otel/opentelemetry-collector-contrib:0.112 | 遥测数据收集 |

### LLM Provider 兼容性

| Provider | 接入方式 | 最低 SDK 版本 |
|---------|---------|-------------|
| OpenAI | OpenAI 兼容 API | openai >= 4.56.0 |
| Anthropic | 原生 Message API | @anthropic-ai/sdk >= 0.32.0 |
| 国内兼容（智谱/通义/Kimi 等） | OpenAI 兼容端点 | baseURL 替换即可，无额外依赖 |

---

## 5. 常见启动失败排查

### 问题：`pnpm install` 报错 `ERR_PNPM_OUTDATED_LOCKFILE`

**原因**：lockfile 与 package.json 不一致。
**解决**：`pnpm install --no-frozen-lockfile`（开发环境）或检查谁改了 package.json 没提交 lockfile。

### 问题：`pnpm dev` 报 `Cannot find module '@agentcore/core'`

**原因**：monorepo 内包未构建。
**解决**：先跑 `pnpm build` 确保 `packages/core` 和 `packages/shared` 编译完成。

### 问题：`POSTGRES_URL` 配了但连接失败

**原因**：PostgreSQL 未启动。
**解决**：
```bash
docker run -d --name postgres -e POSTGRES_DB=agentcore -e POSTGRES_USER=agentcore \
  -e POSTGRES_PASSWORD=password -p 5432:5432 pgvector/pgvector:pg16
```

### 问题：SSE 流在 Nginx 后断开

**原因**：Nginx 默认开启 `proxy_buffering`，会等完整响应才转发。
**解决**：在 Nginx 配置中 `/api/chat` 路由下加：
```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 600s;
```
（详见 09-deploy.md §Step 3 和 17-streaming-advanced.md）

### 问题：Electron 启动报 `contextIsolation` 警告

**原因**：preload 未正确隔离。
**解决**：确保 `BrowserWindow` 配置为：
```typescript
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: path.join(__dirname, 'preload.js'),
}
```
（详见 01-foundation.md §1.7 Electron 桌面壳）

### 问题：`pnpm build` 报 TypeScript 错误 `Property 'X' does not exist on type 'Y'`

**原因**：包之间的类型导入路径不对。
**解决**：检查 `tsconfig.json` 中 `paths` 配置是否正确映射 `@agentcore/*` 到 `packages/*/src`。

---

## 6. 下一步

跑通最小 Agent 后，按实际需求深入：

- **需要 Agent 记住之前的对话** → 03-memory-rag.md
- **需要 Agent 调用外部 API** → 02-tools-skills.md（MCP 部分）
- **需要 Agent 执行代码** → 04-sandbox.md
- **需要上线** → 09-deploy.md
- **需要安全加固** → 07-security.md
- **需要评估质量** → 08-eval-observability.md

> 每个 reference 都包含完整的 TypeScript 实现、工程逻辑说明和 AI 避坑标注。遇到具体问题再读对应章节，无需全文通读。
