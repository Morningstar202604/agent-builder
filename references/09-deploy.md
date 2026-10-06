# 部署 · Docker Compose · CI/CD · 密钥管理 · Electron 签名

> 目标：从"本地能跑"到"生产可用"的最后一公里——全栈容器化部署、CI/CD 自动流水线、密钥安全管控、桌面端打包签名。

## 目录

- [这个节点解决什么问题](#这个节点解决什么问题)
- [Step 1: Docker Compose 全栈部署](#step-1-docker-compose-全栈部署)
- [Step 2: Next.js 生产 Dockerfile](#step-2-nextjs-生产-dockerfile)
- [Step 3: Nginx 反向代理（SSE 友好）](#step-3-nginx-反向代理sse-友好)
- [Step 4: GitHub Actions CI/CD](#step-4-github-actions-cicd)
- [Step 5: 密钥管理](#step-5-密钥管理)
- [Step 6: Electron 打包与签名](#step-6-electron-打包与签名)
- [Step 7: 部署状态面板与回滚](#step-7-部署状态面板与回滚)
- [Step 8: 健康检查端点](#step-8-健康检查端点)
- [完整部署流程图](#完整部署流程图)
- [避坑汇总](#避坑汇总)

---

## 这个节点解决什么问题

Layer 0-2 全部是"开发视角"——代码能跑、Agent 能对话。Layer 3 是"工程视角"——安全、评估、可观测、部署。到节点 18，你要把这一切放到用户手里。

这里有三个层次的部署：

1. **Web 服务**：后端 Next.js + PostgreSQL + Redis + Qdrant（向量库），Docker 一键拉起
2. **CI/CD**：GitHub Actions 自动跑 build → test → eval → deploy
3. **Electron 桌面**：打包 + 签名 + 自动更新，用户双击安装不卡安全警告

🔗 **工程逻辑**：为什么不用 Kubernetes？因为 Agent 产品早期用户量不大，K8s 运维成本远高于它带来的弹性收益。Docker Compose 够用。当你的需要 3 个以上 Node 实例时再考虑迁移到 K8s——不要在第一天就为 10 倍后的规模设计。

---

## Step 1: Docker Compose 全栈部署

🔗 **工程逻辑**：每个服务的 `security_opt: no-new-privileges:true` 是 Docker 安全的底线配置。即使容器内的进程试图通过 `sudo` 或 `su` 提权，这个配置也能阻止。`cap_drop: ALL` 后只 `cap_add` 必须的 capability（如 `NET_BIND_SERVICE` 用来绑定 3000 端口），遵循最小权限原则。数据库端口 `127.0.0.1:5432:5432` 绑定 localhost 而非 `0.0.0.0:5432:5432`——生产数据库绝不能从公网访问。

```yaml
# docker-compose.yml

version: '3.9'

services:
  # === Web 前端（Next.js 生产构建） ===
  web:
    build:
      context: .
      dockerfile: Dockerfile.web
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - POSTGRES_URL=postgresql://agentcore:${POSTGRES_PASSWORD}@postgres:5432/agentcore
      - REDIS_URL=redis://redis:6379
      - QDRANT_URL=http://qdrant:6333
      - NEXTAUTH_SECRET=${NEXTAUTH_SECRET}
      - NEXTAUTH_URL=${NEXTAUTH_URL:-http://localhost:3000}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      qdrant:
        condition: service_started
    restart: unless-stopped
    # 安全：只读根文件系统 + 不做 root
    read_only: true
    user: "1000:1000"
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE  # 只有绑定端口需要

  # === PostgreSQL —— 会话/消息持久化 ===
  postgres:
    image: pgvector/pgvector:pg16  # 内置 pgvector 扩展
    environment:
      POSTGRES_DB: agentcore
      POSTGRES_USER: agentcore
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./server/sql/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    ports:
      - "127.0.0.1:5432:5432"  # 只暴露给本机
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agentcore"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true

  # === Redis —— 会话缓存 / 限流计数器 ===
  redis:
    image: redis:7-alpine
    command: >
      redis-server
      --requirepass ${REDIS_PASSWORD}
      --maxmemory 256mb
      --maxmemory-policy allkeys-lru
      --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true

  # === Qdrant —— 知识库向量检索 ===
  qdrant:
    image: qdrant/qdrant:v1.12
    volumes:
      - qdrant_data:/qdrant/storage
    ports:
      - "127.0.0.1:6333:6333"
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true

  # === OpenTelemetry Collector —— 收集 trace/metrics/logs ===
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.112
    command: ["--config=/etc/otel-collector-config.yml"]
    volumes:
      - ./deploy/otel-config.yml:/etc/otel-collector-config.yml:ro
    ports:
      - "127.0.0.1:4318:4318"   # OTLP HTTP
      - "127.0.0.1:8889:8889"   # Prometheus exporter
    depends_on:
      - web

  # === Nginx —— 反向代理 + SSL 终止 ===
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./deploy/ssl:/etc/nginx/ssl:ro
    depends_on:
      - web
    restart: unless-stopped

volumes:
  postgres_data:
    driver: local
  redis_data:
    driver: local
  qdrant_data:
    driver: local
```

---

## Step 2: Next.js 生产 Dockerfile

🔗 **工程逻辑**：`.next/standalone` 是 Next.js 14+ 的产物模式——输出一个只含 runtime dependencies 的独立目录。这个镜像不用带 devDependencies（总量能减少 80%+），攻击面直接缩小。三阶段构建（deps → builder → runner）的核心思想是：第三阶段只拷贝最终产物，不带走源码和构建工具。

```dockerfile
# Dockerfile.web

FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/*/package.json ./packages/*/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 只构建 web 需要的包
RUN corepack enable && pnpm build --filter @agentcore/web

FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# 只拷贝构建产物，不带走源码和 devDependencies
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./.next/static
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/node_modules ./node_modules

USER nextjs
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

🤖 **AI 常见错误**：
1. **生产 Dockerfile 装了 dev dependencies**：`pnpm install --frozen-lockfile` 在 runner 阶段不应该再跑。第三阶段只 `COPY` 产物，不再 `RUN` install。
2. **不区分 deps 和 builder 阶段**：全部放在一个 stage 构建，镜像 2GB+。多阶段构建后镜像只有 200MB 左右。
3. **没设 `NEXT_TELEMETRY_DISABLED=1`**：Next.js 会尝试发送使用统计——这在生产环境既不必要也引发隐私担忧。

---

## Step 3: Nginx 反向代理（SSE 友好）

🔗 **工程逻辑**：SSE（Server-Sent Events）和 WebSocket 对 Nginx 配置有严格要求。默认的 `proxy_buffering on` 会让 Nginx 等完整响应完毕才转发——但流式 Agent 的响应永远不会"完整完毕"。必须 `proxy_buffering off` + `proxy_cache off`，让数据块到达就立即转发给客户端。`proxy_read_timeout 600s` 是因为 Agent 可能推理长达 10 分钟（多步骤工具调用 + LLM 思考），30s 默认超时直接切断还在思考的 Agent。

```nginx
# deploy/nginx.conf

upstream web_backend {
    server web:3000;
}

server {
    listen 80;
    server_name _;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    # === SSL 配置 ===
    # 证书路径在容器内的 /etc/nginx/ssl/，由 docker-compose 的 volumes 挂载
    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # WebSocket / SSE 升级
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # === SSE 路由 —— 关键配置 ===
    location /api/chat {
        proxy_pass http://web_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;                    # SSE 必须
        proxy_cache off;                        # SSE 必须
        proxy_read_timeout 600s;                # Agent 可能推理 10 分钟
        proxy_send_timeout 600s;
        chunked_transfer_encoding on;
    }

    # === API 路由 —— 正常 HTTP ===
    location /api/ {
        proxy_pass http://web_backend;
        proxy_read_timeout 30s;
    }

    # === Next.js 静态资源 ===
    location /_next/static/ {
        proxy_pass http://web_backend;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://web_backend;
    }

    # === 速率限制 —— 防爬 ===
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    location /api/ {
        limit_req zone=api burst=20 nodelay;
    }
}
```

---

## Step 4: GitHub Actions CI/CD

🔗 **工程逻辑**：6 stage 串行依赖的设计思路是"快速反馈在前，慢速耗时的在后"：
- Stage 1-2（Build + TypeCheck）：最快，先跑，失败了后续都不用跑
- Stage 3（Security）：依赖 Build，不依赖 TypeCheck——安全问题不因为类型正确就豁免
- Stage 4（Eval）：依赖 Build + TypeCheck——确认类型和编译无误再跑昂贵 eval
- Stage 5（Docker）：依赖 Build + TypeCheck + Security——安全通过才构建镜像
- Stage 6（Deploy）：依赖 Docker + Eval——eval 通过才部署

这个依赖链用 `needs:` 关键字声明，Stage 1 失败时整个 pipeline 立刻终止。

```yaml
# .github/workflows/ci.yml

name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  # === Stage 1: 构建 ===
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile
      - run: pnpm build

    outputs:
      short_sha: ${{ steps.vars.outputs.short_sha }}

  # === Stage 2: 类型检查 + Lint ===
  typecheck:
    runs-on: ubuntu-latest
    needs: build
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
      - run: pnpm typecheck

  # === Stage 3: 安全扫描 ===
  security:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4

      # 依赖漏洞扫描
      - name: Audit dependencies
        run: pnpm audit --audit-level high

      # 密钥泄漏检测 —— 防止有人 git push 密码
      - name: Secret Detection
        uses: trufflesecurity/trufflehog@main
        with:
          extra_args: --only-verified

  # === Stage 4: Eval 回归 ===
  eval:
    runs-on: ubuntu-latest
    needs: [build, typecheck]
    if: github.ref == 'refs/heads/main'
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
      - run: pnpm build

      - name: Run Eval Suite
        env:
          EVAL_PROVIDER: openai-compatible
          EVAL_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          EVAL_MODEL: gpt-4o
        run: npx tsx scripts/eval-cli.ts --model gpt-4o --category unit,integration --concurrency 3

  # === Stage 5: Docker 构建 + 推送 ===
  docker:
    runs-on: ubuntu-latest
    needs: [build, typecheck, security]
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and Push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./Dockerfile.web
          push: true
          tags: |
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
            ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # === Stage 6: 部署到服务器 ===
  deploy:
    runs-on: ubuntu-latest
    needs: [docker, eval]
    if: github.ref == 'refs/heads/main'
    environment: production
    steps:
      - uses: actions/checkout@v4

      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd /opt/agent-core
            docker compose pull
            docker compose up -d --remove-orphans
            docker system prune -f
```

🤖 **AI 常见错误**：
1. **CI 里 `pnpm install` 没有 `--frozen-lockfile`**：lock file 不一致时自动更新 lockfile，CI commit 了一个不同版本的 lockfile，导致生产装了一个没测过的依赖版本。
2. **Depoly step 没有 `needs: [docker, eval]`**：deploy 跑在 eval 前，eval 没通过也部署了。CI 必须保证流水线顺序。
3. **Truffle hog 用 `--only-verified` 减少误报**：不用这个 flag 会报告大量 "possible secret" 的 false positive，淹没真正的漏洞。

---

## Step 5: 密钥管理

🔗 **工程逻辑**：4 级密钥优先级的设计原则是"越安全的路径越后检查"：
1. 环境变量（CI 直接注入，最快）
2. Docker Secrets（/run/secrets/ 只读挂载，Swarm 友好）
3. AWS Secrets Manager（企业级，支持 IAM + 审计）
4. HashiCorp Vault（最灵活，支持动态密钥）

启动时加载完所有 secret 后立即 `validateSecrets()`——缺了就 fail-fast 报错。不存在"运行时某次 API 调用才炸"的情况。

```typescript
// server/src/security/secrets.ts

import { promises as fs } from 'fs';
import { resolve } from 'path';

/**
 * 密钥管理入口。
 *
 * 四种模式：
 * 1. 环境变量（开发环境 / CI 注入）
 * 2. Docker Secrets（Docker Swarm 部署 —— /run/secrets/）
 * 3. AWS Secrets Manager（生产推荐）
 * 4. HashiCorp Vault（企业级）
 *
 * 优先级：环境变量 > Docker Secret > AWS SM > Vault
 */
export async function getSecret(key: string): Promise<string | undefined> {
  // 1. 环境变量（最高优先级 —— CI 和 Docker 都可以直接注入）
  if (process.env[key]) {
    return process.env[key];
  }

  // 2. Docker Secrets（/run/secrets/<name>）
  try {
    const secretPath = resolve('/run/secrets', key.toLowerCase());
    const value = await fs.readFile(secretPath, 'utf-8');
    return value.trim();
  } catch {
    // 不存在则继续
  }

  // 3. AWS Secrets Manager（生产）
  if (process.env.AWS_SECRETS_ARN) {
    return await getAWSSecret(process.env.AWS_SECRETS_ARN, key);
  }

  // 4. HashiCorp Vault
  if (process.env.VAULT_ADDR) {
    return await getVaultSecret(key);
  }

  return undefined;
}

async function getAWSSecret(secretArn: string, key: string): Promise<string | undefined> {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

  try {
    const command = new GetSecretValueCommand({ SecretId: secretArn });
    const response = await client.send(command);
    if (response.SecretString) {
      const parsed = JSON.parse(response.SecretString);
      return parsed[key];
    }
  } catch {
    // 降级
  }
  return undefined;
}

async function getVaultSecret(key: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${process.env.VAULT_ADDR}/v1/secret/data/agent-core`, {
      headers: { 'X-Vault-Token': process.env.VAULT_TOKEN! },
    });
    const data = await res.json();
    return data.data?.data?.[key];
  } catch {
    return undefined;
  }
}

/**
 * 初始化所有必须的 Secret。启动时检查缺少哪些——
 * 缺了就 fail-fast 崩溃，而不是在运行时某次 API 调用才炸。
 */
export async function validateSecrets(): Promise<{ missing: string[]; ok: boolean }> {
  const required = [
    'OPENAI_API_KEY',
    'POSTGRES_PASSWORD',
    'REDIS_PASSWORD',
    'NEXTAUTH_SECRET',
  ];

  const missing: string[] = [];

  for (const key of required) {
    const value = await getSecret(key);
    if (!value) missing.push(key);
  }

  if (missing.length > 0) {
    console.error(`❌ Missing required secrets: ${missing.join(', ')}`);
    process.exit(1);  // fail-fast：缺少 secret 时绝不启动
  }

  return { missing, ok: missing.length === 0 };
}
```

```yaml
# docker-compose.secrets.yml（开发环境密钥文件 —— 不提交到 Git）
# 生产替代为 Docker secrets 或 AWS SM
# 这个文件通过 docker compose -f docker-compose.yml -f docker-compose.secrets.yml up 叠加使用

secrets:
  openai_api_key:
    file: ./secrets/openai_api_key.txt
  postgres_password:
    file: ./secrets/postgres_password.txt
  redis_password:
    file: ./secrets/redis_password.txt

services:
  web:
    secrets:
      - openai_api_key
      - postgres_password
      - redis_password
```

---

## Step 6: Electron 打包与签名

### Step 6a: electron-builder 配置

🔗 **工程逻辑**：Electron 自动更新需要正确的流程链——构建 → 签名 → 公证 → 发布到 GitHub Release → electron-updater 检测更新 → 下载新包 → 校验签名 → 替换安装。其中签名和公证是 Apple Gatekeeper 的要求，缺少任一环节都会导致用户无法安装。`publish: { provider: 'github' }` 告诉 electron-builder 把构建产物上传到 GitHub Release，electron-updater 再去 GitHub Release 里拉取。

> **路径检查**：本节代码路径说明
> - `apps/electron/electron-builder.config.js`：项目内路径，相对项目根
> - `dist/**/*`：构建输出目录，相对 `electron-builder.config.js` 所在位置
> - `resources/**/*`：资源目录，相对 `electron-builder.config.js` 所在位置
> - `release/`：electron-builder 默认输出目录
> - `/etc/nginx/ssl/`：**服务器绝对路径**，需要手动在服务器上配置 SSL 证书
> - `./deploy/nginx.conf`：项目内路径，相对项目根
> - `scripts/sign-and-notarize.sh`：项目内路径
> - `apps/electron` 下调用 `../../scripts/sign-and-notarize.sh`：从 apps/electron 向上一层到项目根再进 scripts，路径正确

```javascript
// apps/electron/electron-builder.config.js

const { execSync } = require('child_process');

// 自动检测当前 Git 提交作为版本元数据
const gitSha = execSync('git rev-parse --HEAD').toString().trim().slice(0, 8);

module.exports = {
  appId: 'com.agentcore.app',
  productName: 'Agent Core',
  copyright: `Copyright ${new Date().getFullYear()} Agent Core`,

  directories: {
    output: 'release',
    buildResources: 'resources',
  },

  files: [
    'dist/**/*',
    'resources/**/*',
    '!**/*.map',       // 不打包源码 map
    '!**/test/**',      // 不打包测试文件
  ],

  extraMetadata: {
    main: 'dist/main/index.js',
    version: process.env.APP_VERSION ?? '0.1.0',
  },

  // === macOS ===
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    icon: 'resources/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    notarize: false,  // 也见 Step 6b 手动签名
  },

  // === Windows ===
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    icon: 'resources/icon.ico',
    sign: false,  // 见 Step 6b
  },

  // === Linux ===
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    icon: 'resources/icons',
    category: 'Development',
  },

  // === 自动更新 —— 上传到 GitHub Release ===
  publish: {
    provider: 'github',
    owner: process.env.GITHUB_OWNER ?? 'your-org',
    repo: process.env.GITHUB_REPO ?? 'agent-core',
    releaseType: 'release',
  },

  // === 自动构建钩子 ===
  // (P0 修复：afterSign 用 @electron/notarize 真公证，非空壳钩子)
  // 依赖: pnpm add -D @electron/notarize → 在 electron-builder.json 同级放置
  afterSign: async (context) => {
    if (context.electronPlatformName !== 'darwin') return;
    if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
      console.warn('⚠️ 未配置 APPLE_ID / APPLE_PASSWORD，跳过公证');
      return;
    }
    const { notarize } = require('@electron/notarize');
    console.log(`📎 Notarizing ${context.appOutDir}/${context.packager.appInfo.productFilename}.app ...`);
    await notarize({
      appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
  },
};
```

### Step 6b: macOS 签名与公证

🔗 **工程逻辑**：为什么 macOS 要三步走（codesign + notarize + staple）？
- **codesign**: 本地开发者签名，证明这个包确实是你发的
- **notarize**: Apple 云端检查你的包有没有恶意代码
- **staple**: 把公证结果内嵌到包里，用户离线安装也能验证
- 三个缺一不可。少了 staple，用户在没网的情况下安装会被拒绝。少了 notarize，macOS Sonoma+ 会显示红色警告。

> **路径检查**：
> - `APP_PATH="release/mac/${APP_NAME}.app"`：相对构建脚本执行目录（apps/electron/）的路径。electron-builder 输出到 `apps/electron/release/mac/`，但构建脚本在 `apps/electron/` 下执行，所以 `release/mac/` 是正确的。
> - 公证脚本 `scripts/sign-and-notarize.sh` 通过 `bash ../../scripts/sign-and-notarize.sh` 调用——从 `apps/electron/` 向上一层到项目根目录再进入 `scripts/`，路径正确。

```bash
#!/bin/bash
# scripts/sign-and-notarize.sh

# macOS Electron 必须有签名+公证才能在用户电脑上运行。
# 没有签名的 App 会被 Gatekeeper 拦截，用户看到 "无法打开，来自身份不明的开发者"

APP_NAME="Agent Core"
# 注意：APP_PATH 是相对当前工作目录的路径
# 当 cd apps/electron 后再执行此脚本时，路径为 release/mac/...
APP_PATH="release/mac/${APP_NAME}.app"
DMG_PATH="release/${APP_NAME}-0.1.0-arm64.dmg"

# 安全校验：确保变量非空
if [ -z "$APP_NAME" ] || [ -z "$APP_PATH" ]; then
  echo "❌ 配置错误：APP_NAME 或 APP_PATH 为空"
  exit 1
fi

# 1. 检查签名
codesign --verify --verbose "${APP_PATH}"
if [ $? -ne 0 ]; then
  echo "❌ 签名无效，检查开发者证书"
  exit 1
fi

# 2. 公证（Apple Notary Service）
# 公证是 Apple 对 App 做一次安全检查的过程。一次大约 3-10 分钟。
# 没有公证的 App 在新版 macOS 上会被标记为"不安全"

xcrun notarytool submit "${DMG_PATH}" \
  --apple-id "${APPLE_ID}" \
  --team-id "${APPLE_TEAM_ID}" \
  --password "${APPLE_APP_PASSWORD}" \
  --wait

# 3. 将公证结果订到安装包上（staple）—— 这样用户离线也能验证
xcrun stapler staple "${DMG_PATH}"

echo "✅ 签名 + 公证完成"
```

```bash
# scripts/build-electron.sh

# 全平台 Electron 构建脚本
# 使用说明：在项目根目录执行 bash scripts/build-electron.sh

set -e

echo "🔨 1. 构建 Web 应用"
pnpm build --filter @agentcore/web

echo "🔨 2. 构建 Electron 主进程"
pnpm build --filter @agentcore/electron

if [ "$(uname)" == "Darwin" ]; then
  echo "🍎 3. 构建 macOS 包"
  cd apps/electron
  npx electron-builder --mac --arm64 --x64

  if [ -n "$APPLE_ID" ]; then
    echo "📎 4. 签名 + 公证"
    # 此时 CWD 已经是 apps/electron，向上一层到项目根再进 scripts
    bash ../../scripts/sign-and-notarize.sh
  else
    echo "⚠️  跳过签名（未配置 APPLE_ID）"
  fi
fi

if [ "$(uname)" == "Linux" ]; then
  echo "🐧 3. 构建 Linux 包"
  cd apps/electron
  npx electron-builder --linux
fi

echo "✅ 构建完成"
```

### Step 6c: Windows 代码签名

> 路径检查：`scripts/sign-windows.sh` 是项目内路径。`$CERT_SERVER` 和共享目录是服务器端环境变量或绝对路径（如 `\\CERT_SERVER\SharedCert\`），由签名服务器管理员配置，脚本中不做硬编码。

```bash
#!/bin/bash
# scripts/sign-windows.sh

# Windows 代码签名 -- 使用 signtool (Windows SDK)

APP_NAME="Agent Core"
EXE_PATH="release/${APP_NAME}-0.1.0-x64.exe"

# 使用环境变量中的签名服务器路径（由 CI 或管理员配置）
# 不要在脚本里硬编码签名服务器的地址
CERT_SERVER="${CERT_SERVER:-//CERT_SERVER/SharedCert/}"

if [ -z "$CERT_SERVER" ] || [ "$CERT_SERVER" = "//CERT_SERVER/SharedCert/" ]; then
  echo "⚠️  未配置 CERT_SERVER 环境变量，跳过签名"
  exit 0
fi

echo "🔏 正在签署 Windows 安装包..."

# 使用 Azure Key Vault 或本地 HSM 签名
# 这里以 Azure Code Signing 为例
azuresigntool sign \
  --azure-key-vault-url "${AZURE_VAULT_URL}" \
  --azure-key-vault-client-id "${AZURE_CLIENT_ID}" \
  --azure-key-vault-client-secret "${AZURE_CLIENT_SECRET}" \
  --azure-key-vault-certificate "${AZURE_CERT_NAME}" \
  --timestamp-rfc3161 http://timestamp.digicert.com \
  --timestamp-digest sha256 \
  "${EXE_PATH}"

echo "✅ Windows 签名完成"
```

🤖 **AI 常见错误**：
1. **Electron 签名一年后过期没人管的**：Developer ID 证书一年一换，过期后用户安装显示"已损坏"。必须在 CI 里加证书过期检查（提前 30 天告警）。
2. **公证证书硬编码在脚本里**：证书路径/密码不应该出现在源代码中。从 CI secrets 注入。
3. **没有在 afterSign 里做 notarize**：electron-builder 的 `notarize: false` 意味着它不做公证。你必须在 afterSign hook 或独立脚本里完成。
4. **Windows 签名路径用了绝对路径但换台 CI 机器就炸**：签名脚本的路径必须动态化，不能写死 `C:\SharedCert\`。

---

## Step 7: 部署状态面板与回滚

🔗 **工程逻辑**：回滚不是简单的"docker compose 启动旧版本"——你需要确保：(1) 旧版本镜像还在 registry 里没被 purge；(2) 数据库 migration 向前兼容（新 schema 旧代码能用）；(3) 回滚后前端静态资源也适配旧版 API。最安全的回滚方式是蓝绿部署：新/旧版本同时运行，通过 Nginx upstream 切换流量。但 Docker Compose 场景下，用 image tag 切换更简单——`docker compose up -d --image web:old-sha`。

```tsx
// apps/web/src/components/deploy/DeployStatus.tsx

'use client';

import { useState, useEffect } from 'react';

interface DeployInfo {
  currentVersion: string;
  commitSha: string;
  deployedAt: string;
  health: 'healthy' | 'degraded' | 'down';
  components: Array<{
    name: string;
    status: 'running' | 'stopped' | 'restarting';
    replicas: number;
    cpu: number;
    memory: number;
  }>;
}

export function DeployStatusPanel() {
  const [deploy, setDeploy] = useState<DeployInfo | null>(null);
  const [rollingOut, setRollingOut] = useState(false);

  useEffect(() => {
    fetch('/api/deploy/status')
      .then((r) => r.json())
      .then(setDeploy)
      .catch(() => {});
  }, []);

  const triggerRollback = async (versionTag: string) => {
    if (!confirm(`确认回滚到 ${versionTag}？`)) return;
    setRollingOut(true);
    try {
      await fetch('/api/deploy/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetVersion: versionTag }),
      });
      alert('回滚已启动');
    } finally {
      setRollingOut(false);
    }
  };

  if (!deploy) return <div className="p-6 text-muted">加载中...</div>;

  const healthColors = {
    healthy: 'bg-green-500/20 text-green-400 border-green-500/30',
    degraded: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    down: 'bg-red-500/20 text-red-400 border-red-500/30',
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text">部署状态</h1>
        <div className={`px-3 py-1 rounded-full text-sm font-medium border ${healthColors[deploy.health]}`}>
          {deploy.health === 'healthy' ? '● 运行中' : deploy.health === 'degraded' ? '● 降级' : '● 异常'}
        </div>
      </header>

      {/* 版本信息 */}
      <div className="bg-surface rounded-lg border border-border p-5 flex items-center justify-between">
        <div>
          <div className="text-text font-medium">{deploy.currentVersion}</div>
          <div className="text-xs text-muted font-mono mt-1">{deploy.commitSha}</div>
        </div>
        <div className="text-sm text-muted">
          部署于 {new Date(deploy.deployedAt).toLocaleString()}
        </div>
      </div>

      {/* 容器状态 */}
      <div className="bg-surface rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="text-left px-4 py-3">组件</th>
              <th className="text-center px-4 py-3">状态</th>
              <th className="text-center px-4 py-3">副本</th>
              <th className="text-right px-4 py-3">CPU</th>
              <th className="text-right px-4 py-3">内存</th>
            </tr>
          </thead>
          <tbody>
            {deploy.components.map((c) => (
              <tr key={c.name} className="border-b border-border/50">
                <td className="px-4 py-3 font-mono text-xs">{c.name}</td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-block w-2 h-2 rounded-full ${
                    c.status === 'running' ? 'bg-green-400' : 'bg-yellow-400 animate-pulse'
                  }`} />
                </td>
                <td className="px-4 py-3 text-center">{c.replicas}</td>
                <td className="px-4 py-3 text-right">{c.cpu}%</td>
                <td className="px-4 py-3 text-right">{c.memory} MB</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 回滚按钮 */}
      <div className="flex gap-3">
        <select id="rollback-version" className="bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text flex-1">
          <option value="">选择回滚版本...</option>
          <option value="v0.1.0">v0.1.0</option>
          <option value="v0.0.9">v0.0.9</option>
        </select>
        <button
          onClick={() => {
            const el = document.getElementById('rollback-version') as HTMLSelectElement;
            if (el.value) triggerRollback(el.value);
          }}
          disabled={rollingOut}
          className="bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium text-sm"
        >
          {rollingOut ? '回滚中...' : '回滚'}
        </button>
      </div>
    </div>
  );
}
```

---

## Step 8: 健康检查端点

🔗 **工程逻辑**：健康检查是 Docker 和生产运维的基石。Docker 的 `healthcheck` 配置、K8s 的 liveness/readiness probe、AWS ALB 的健康检查目标组——都依赖 `/api/health` 端点。返回 200 表示健康，返回 503 表示降级。端点的 `checks` 字段让运维看到是哪个组件出了问题——postgres 连不上？还是 Redis ping 超时？

```typescript
// apps/web/src/app/api/health/route.ts

import { NextResponse } from 'next/server';
import { validateSecrets } from '@agentcore/server/security/secrets';
import { redis } from '@/lib/redis';

export async function GET() {
  const checks: Record<string, { status: 'ok' | 'error'; latencyMs?: number; detail?: string }> = {};

  // 1. 密钥完整性检查
  const secretCheck = await validateSecrets();
  checks.secrets = {
    status: secretCheck.ok ? 'ok' : 'error',
    detail: secretCheck.ok ? undefined : `Missing: ${secretCheck.missing.join(', ')}`,
  };

  // 2. Redis 连通性
  try {
    const start = Date.now();
    await redis.ping();
    checks.redis = { status: 'ok', latencyMs: Date.now() - start };
  } catch (e) {
    checks.redis = { status: 'error', detail: (e as Error).message };
  }

  // 3. Postgres 连通性
  try {
    const start = Date.now();
    const { db } = await import('@/lib/db');
    await db.query('SELECT 1');
    checks.postgres = { status: 'ok', latencyMs: Date.now() - start };
  } catch (e) {
    checks.postgres = { status: 'error', detail: (e as Error).message };
  }

  const allOk = Object.values(checks).every((c) => c.status === 'ok');

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'degraded',
      version: process.env.APP_VERSION ?? 'unknown',
      uptime: process.uptime(),
      checks,
      timestamp: Date.now(),
    },
    { status: allOk ? 200 : 503 },
  );
}
```

---

## 完整部署流程图

```
git push origin main
        │
        ▼
┌─── GitHub Actions ────────────────────────────────────┐
│ Stage 1: Build           pnpm build                    │
│ Stage 2: TypeCheck       pnpm typecheck                │
│ Stage 3: Security Scan   trufflehog + pnpm audit       │
│ Stage 4: Eval            pnpm eval                     │
│ Stage 5: Docker Build    docker buildx + push GHCR     │
│ Stage 6: Deploy          SSH → docker compose up       │
└───────────────────────────────────────────────────────┘
        │
        ▼
┌─── Production Server ─────────────────────────────────┐
│ docker compose up:                                     │
│   nginx (443) → web (3000)                            │
│   postgres (5432) ← only localhost                    │
│   redis (6379)    ← only localhost                    │
│   qdrant (6333)   ← only localhost                    │
│   otel-collector (4318)                               │
└───────────────────────────────────────────────────────┘
        │
        ▼
  用户访问 https://your-domain.com
        或
  下载 Electron 桌面客户端（签名订公证）
```

---

## 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| 生产 Docker 镜像 2GB+ | 没区分 install --production | 用 multi-stage build + standalone 模式 |
| PostgreSQL 端口暴露在公网 | docker-compose 的 ports 没限制绑定地址 | `127.0.0.1:5432:5432` 只绑定 localhost |
| 数据库密码写进 Git 历史 | .env 没加入 .gitignore | 用 `git-filter-repo` 清除历史 + Docker secrets |
| Electron 签名过期后用户装不了 | 签名证书一年一换，没自动续 | CI 里加证书过期检查 + 自动重签 |
| macOS Gatekeeper 拦截 | 没公证 | notarytool + stapler |
| Docker Compose 启动顺序问题 | web 先于 postgres 启动 | `depends_on: condition: service_healthy` |
| CI secret 出现在日志里 | step 依赖 `echo "key: $KEY"` | GitHub Actions 自动 mask `${{ secrets.* }}` |
| Nginx 代理导致 SSE 延迟 | proxy_buffering on | `proxy_buffering off` + `proxy_cache off` |
| Electron 公证脚本找不到证书 | 证书路径硬编码 | 用 CI secrets 注入 |
| 构建用 `pnpm install` 而非 `--frozen-lockfile` | lockfile 被 CI 自动更新 | CI 必须 `--frozen-lockfile` |
| 生产装了 devDependencies | runner 阶段跑了 pnpm install | 第三阶段只 COPY 产物不 RUN install |
| 数据库密码进 Git 历史 | .env 文件误提交 | 清除 + .gitignore + 换密码 |

---

*本节点属于 Layer 3 工程化层。部署是 Agent 从开发到产品的最后一公里。实现时请记住：Docker Compose 适用于早期阶段（< 100 并发），当你的 QPS 超过单实例承载时再考虑 K8s。Electron 签名三个步骤缺一不可（codesign + notarize + staple）。密钥管理用 4 级优先级（环境变量 > Docker Secrets > AWS SM > Vault），绝不允许 .env 进 git。部署后通过 `/api/health` 验证全栈健康状态。*
