# 09 — 部署 · Docker Compose · CI/CD 模板 · 密钥管理 · Electron 签名

> Layer 3 目标：把"本地能跑"变成"生产可用"——容器化部署、CI/CD 自动流水线、密钥安全、桌面端签名。
>
> **⚠️ 本层铁律：本层全部是配置与模板，不是手写轮子。**
> - Docker Compose / Dockerfile / Nginx / electron-builder / GitHub Actions → **声明式配置，保留并精简**
> - 流水线脚本 → **用 GitHub Actions 标准模板**（`actions/checkout`、`setup-node`、`pnpm/action-setup` 等），不手写 pipeline 脚本
> - 密钥管理 → **环境变量 / Docker Secrets / Vault**，不写多后端密钥抽象层

---

## 目录

- [9.1 Docker Compose 全栈部署](#91-docker-compose-全栈部署)
- [9.2 Next.js 生产 Dockerfile](#92-nextjs-生产-dockerfile)
- [9.3 Nginx 反向代理（SSE 友好）](#93-nginx-反向代理sse-友好)
- [9.4 GitHub Actions CI/CD（标准模板）](#94-github-actions-cicd标准模板)
- [9.5 密钥管理](#95-密钥管理)
- [9.6 Electron 打包与签名](#96-electron-打包与签名)
- [9.7 健康检查端点](#97-健康检查端点)
- [9.8 避坑汇总](#98-避坑汇总)
- [9.9 本层验收清单](#99-本层验收清单)

---

## 9.1 Docker Compose 全栈部署

🔗 **工程逻辑**：Agent 产品早期用 Docker Compose 足够——K8s 运维成本远高于收益，3 个以上实例再迁移。数据库端口绑 `127.0.0.1`，绝不从公网可达。

```yaml
# docker-compose.yml —— 配置模板，按需精简
services:
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
      - REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379
      - QDRANT_URL=http://qdrant:6333
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: agentcore
      POSTGRES_USER: agentcore
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agentcore"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3
    restart: unless-stopped

  qdrant:
    image: qdrant/qdrant:v1.12
    volumes:
      - qdrant_data:/qdrant/storage
    ports:
      - "127.0.0.1:6333:6333"
    restart: unless-stopped

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.112
    command: ["--config=/etc/otel-collector-config.yml"]
    volumes:
      - ./deploy/otel-config.yml:/etc/otel-collector-config.yml:ro
    ports:
      - "127.0.0.1:4318:4318"

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
  redis_data:
  qdrant_data:
```

🤖 **AI 常见错误**：
1. `ports: "5432:5432"` 不绑 localhost——数据库对公网开放，扫描器几分钟内就会尝试爆破。
2. `depends_on` 不带 `condition: service_healthy`——web 先于 postgres 启动，首次连接必失败。
3. 容器以 root 运行且不带 `cap_drop`——容器逃逸风险被放大。`cap_drop: ALL` + `no-new-privileges` 是底线。

---

## 9.2 Next.js 生产 Dockerfile

🔗 **工程逻辑**：`.next/standalone` 只输出 runtime 依赖，三阶段构建（deps → builder → runner）让最终镜像不带 devDependencies 与源码，体积从 2GB 降到 200MB 左右。

```dockerfile
# Dockerfile.web —— 多阶段构建模板
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
RUN corepack enable && pnpm build --filter @agentcore/web

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./.next/static
COPY --from=builder /app/apps/web/public ./public
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
```

🤖 **AI 常见错误**：runner 阶段再跑一次 `pnpm install`——会把 devDependencies 装进镜像。`.next/standalone` 已含生产依赖，不要重复 COPY node_modules。

---

## 9.3 Nginx 反向代理（SSE 友好）

🔗 **工程逻辑**：SSE 响应永远不会"完整完毕"，默认的 `proxy_buffering on` 会整段缓存导致前端断流。必须关缓冲 + 关缓存 + 长超时。

```nginx
# deploy/nginx.conf —— 被 include 进主 nginx.conf 的 http {} 块内
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=sse:10m rate=2r/s;

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

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # SSE 路由：必须关缓冲，Agent 可能推理 10 分钟
    location /api/chat {
        limit_req zone=sse burst=5 nodelay;
        proxy_pass http://web_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        chunked_transfer_encoding on;
    }

    location /api/ {
        limit_req zone=api burst=20 nodelay;
        proxy_pass http://web_backend;
        proxy_read_timeout 30s;
    }

    location /_next/static/ {
        proxy_pass http://web_backend;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://web_backend;
    }
}
```

🤖 **AI 常见错误**：只关 `proxy_buffering` 不调 `proxy_read_timeout`——LLM 推理超过 60s 连接被切断，前端看起来像"断流"。

---

## 9.4 GitHub Actions CI/CD（标准模板）

🔗 **工程逻辑**：流水线 = 标准 action 的组合，不手写脚本。快速反馈在前（build/typecheck），昂贵步骤在后（eval、docker push、deploy），用 `needs:` 声明依赖链。

```yaml
# .github/workflows/ci.yml —— 标准模板：checkout + setup-node + 官方 action
name: CI/CD Pipeline

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
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
      - run: pnpm build
    outputs:
      short_sha: ${{ github.sha }}

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

  security:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v4
      - run: pnpm audit --audit-level high
      - uses: trufflesecurity/trufflehog@main
        with:
          extra_args: --only-verified

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
      - run: pnpm exec promptfoo eval --config promptfooconfig.yaml --output eval-report.json
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

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
```

🤖 **AI 常见错误**：
1. **CI 里 `pnpm install` 不带 `--frozen-lockfile`**——lockfile 被自动更新，生产装了一个没测过的依赖版本。
2. **deploy 的 `needs` 漏掉 eval**——eval 没过也部署了。部署必须等所有质量门禁通过。
3. **把密钥写进 `env:` 的明文**——GitHub Actions 的 `${{ secrets.* }}` 会自动 mask，不要手动 echo 密钥。

---

## 9.5 密钥管理

🔗 **工程逻辑**：按部署形态选一种，不要写多后端密钥抽象层。

| 方式 | 适用场景 | 说明 |
|------|----------|------|
| 环境变量 | 开发 / CI / Compose | 由 `${{ secrets.* }}` 注入，Compose 用 `${VAR}` 引用 |
| Docker Secrets | Swarm 生产 | 密钥以文件挂到 `/run/secrets/`，只读，不进镜像 |
| HashiCorp Vault | 企业 / 动态密钥 | 应用通过 Vault Agent 或环境注入，不内置 Vault 客户端逻辑 |

**环境变量（开发 / CI）**——Compose 通过 `.env`（不提交 Git）引用：

```yaml
# .env（不提交 Git）—— 由部署机或 CI secrets 生成
OPENAI_API_KEY=...
POSTGRES_PASSWORD=...
REDIS_PASSWORD=...
NEXTAUTH_SECRET=...
```

**Docker Secrets（生产）**——密钥不进 compose 文件正文，从 Swarm 注入：

```yaml
# docker-compose.secrets.yml
secrets:
  openai_api_key:
    external: true
  postgres_password:
    external: true

services:
  web:
    secrets:
      - openai_api_key
      - postgres_password
```

应用侧只做**启动时校验**，缺了就 fail-fast——不要实现密钥获取的抽象层：

```typescript
// server/src/security/validate-secrets.ts —— 胶水层：启动时检查必需密钥
const REQUIRED = ['OPENAI_API_KEY', 'POSTGRES_PASSWORD', 'NEXTAUTH_SECRET'];

export function validateSecrets(): void {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required secrets: ${missing.join(', ')}`);
    process.exit(1);
  }
}
```

🤖 **AI 常见错误**：
1. 把 `.env` 提交进 Git——历史里的密码只能用 `git-filter-repo` 清洗，且必须轮换。`.gitignore` 必须包含 `.env`。
2. 自研 `getSecret()` 支持 4 种后端——每种后端都有自己的故障模式，抽象层把故障藏起来。按部署形态选一种，用官方注入方式。
3. 健康检查端点调用 `validateSecrets()`——校验含 `process.exit(1)`，会把健康检查进程杀掉。校验只在启动时执行。

---

## 9.6 Electron 打包与签名

🔗 **工程逻辑**：签名与公证是 Apple Gatekeeper 的强制要求，配置由 electron-builder 承担；CI 用官方 action 组合完成构建，不手写 shell 流水线。

```javascript
// apps/electron/electron-builder.config.js —— 签名配置模板
module.exports = {
  appId: 'com.agentcore.app',
  productName: 'Agent Core',
  directories: {
    output: 'release',
    buildResources: 'resources',
  },
  files: ['dist/**/*', 'resources/**/*', '!**/*.map', '!**/test/**'],
  extraMetadata: {
    main: 'dist/main/index.js',
    version: process.env.APP_VERSION ?? '0.1.0',
  },
  mac: {
    category: 'public-app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    hardenedRuntime: true,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'resources/icon.ico',
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    icon: 'resources/icons',
    category: 'Development',
  },
  publish: {
    provider: 'github',
    owner: process.env.GITHUB_OWNER ?? 'your-org',
    repo: process.env.GITHUB_REPO ?? 'agent-core',
  },
  afterSign: async (context) => {
    if (context.electronPlatformName !== 'darwin') return;
    if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) return;
    const { notarize } = require('@electron/notarize');
    await notarize({
      appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
  },
};
```

**CI 构建（标准 action 组合，不手写 build-electron.sh）：**

```yaml
# .github/workflows/electron.yml —— macOS 构建与签名
name: Electron Build
on:
  push:
    tags: ['v*']
jobs:
  build-mac:
    runs-on: macos-latest
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
      - run: pnpm build --filter @agentcore/electron
      - name: Package & Sign
        run: npx electron-builder --mac --publish never
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          CSC_LINK: ${{ secrets.MAC_CERT_LINK }}
          CSC_KEY_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
```

🔗 **工程逻辑**：macOS 证书（CSC_LINK/CSC_KEY_PASSWORD）与 Apple 公证凭据全部从 CI secrets 注入；electron-builder 在 macOS runner 上完成 codesign，`afterSign` 钩子调用 `@electron/notarize` 公证。Windows 同理（`CSC_LINK` 指向 pfx）。

🤖 **AI 常见错误**：
1. 证书一年一换——过期后用户安装显示"已损坏"。CI 里加证书过期检查（提前 30 天告警）。
2. 在 Linux runner 上构建 macOS 包——签名与公证必须 macOS runner。
3. 手写 `sign-and-notarize.sh` 维护一堆 `codesign`/`notarytool` 命令——electron-builder + `@electron/notarize` 已封装，脚本只会随 Apple API 变化频繁失效。

---

## 9.7 健康检查端点

🔗 **工程逻辑**：`/api/health` 是 Docker healthcheck、K8s probe、负载均衡健康检查的统一依赖。返回 200 表示健康，503 表示降级，`checks` 字段指明是哪个组件出问题。

```typescript
// apps/web/src/app/api/health/route.ts
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export async function GET() {
  const checks: Record<string, { status: 'ok' | 'error'; detail?: string }> = {};

  // 只做非空检查，不调用 validateSecrets()（它会 process.exit(1) 杀掉健康检查）
  const required = ['OPENAI_API_KEY', 'POSTGRES_PASSWORD', 'NEXTAUTH_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  checks.secrets = {
    status: missing.length === 0 ? 'ok' : 'error',
    detail: missing.length === 0 ? undefined : `Missing: ${missing.join(', ')}`,
  };

  try {
    await redis.ping();
    checks.redis = { status: 'ok' };
  } catch (e) {
    checks.redis = { status: 'error', detail: (e as Error).message };
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

## 9.8 避坑汇总

| 问题 | 原因 | 解法 |
|------|------|------|
| 生产镜像 2GB+ | runner 阶段装了 devDependencies | 多阶段构建 + `.next/standalone` |
| 数据库端口暴露公网 | ports 未绑 localhost | `127.0.0.1:5432:5432` |
| .env 进 Git | 未加 .gitignore | `git-filter-repo` 清洗 + 轮换密码 |
| SSE 断流 | Nginx 缓冲 | `proxy_buffering off` + `proxy_cache off` |
| web 先于 postgres 启动 | depends_on 没条件 | `condition: service_healthy` |
| CI lockfile 漂移 | install 未锁版本 | `pnpm install --frozen-lockfile` |
| Electron 签名过期 | 证书未轮换 | CI 证书过期检查 + 提前告警 |
| 密钥出现在日志 | 手动 echo | 用 `${{ secrets.* }}` 自动 mask |

---

## 9.9 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **镜像构建**：`pnpm build && docker build -f Dockerfile.web -t agent-web:test .`，容器内 `ls node_modules` 不含 typescript/vite 等 devDependencies。
- [ ] **依赖顺序**：`docker compose up -d` 后 `docker compose ps`，postgres 先 healthy，web 后启动。
- [ ] **SSE 代理**：经 Nginx 访问 `/api/chat`，`curl -N --no-buffer` 能实时收到分块 token。
- [ ] **CI 门禁**：push 到 main 后，build → typecheck → security → eval → docker → deploy 依次执行；eval 失败时 deploy 不执行。
- [ ] **密钥安全**：`git grep -nE 'POSTGRES_PASSWORD|REDIS_PASSWORD'` 在非 `.env.example`/CI secrets 引用中无明文；CI 日志中 `${{ secrets.* }}` 显示为 `***`。
- [ ] **签名与公证**：macOS 产物 `codesign --verify --deep --strict` 通过且 `xcrun stapler validate` 返回 success。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 避坑标记与本层验收清单。
