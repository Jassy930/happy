# Happy 内网版改造设计方案

> 日期: 2026-03-26
> 状态: 已确认，待实施

## 1. 项目背景与目标

基于 Happy 开源项目（https://github.com/slopus/happy），改造为适用于公司内网环境的版本。

### 1.1 核心需求

- 支持 **Claude Code** 和 **Codex** 两种 AI 代理
- 集中式 Server 部署在内网一台机器上（Docker Compose）
- 员工在自己的电脑上运行 CLI + daemon
- 手机通过公司 **WiFi** 或 **VPN** 连接 Server
- **纯内网运行，无任何公网暴露，无内网穿透能力**
- 简单的 **用户名密码** 认证（后续考虑 SSO）
- 用户 **自助注册**（首次使用时注册）
- 数据按用户 **严格隔离**
- 一个用户可绑定 **多台电脑 + 多部手机**
- 纯 **HTTP** 通信（内网环境，不需要 HTTPS）

### 1.2 不在范围内

- Gemini 代理支持（暂不需要）
- 语音通话功能（LiveKit）
- SSO 集成（后续迭代）
- HTTPS 支持（后续迭代）
- Expo Push / OTA 更新（代码保留，暂不实现内网替代）

---

## 2. 整体架构

### 2.1 原版架构

```
┌──────────────────────────────────────────────┐
│  公网云服务器 (api.cluster-fluster.com)       │
│  - happy-server (Fastify)                    │
│  - PostgreSQL                                │
│  - Redis                                     │
│  - S3/MinIO                                  │
└──────────────────┬───────────────────────────┘
                   │ HTTPS + WSS (公网)
       ┌───────────┼───────────┐
       │           │           │
   员工A电脑     员工B电脑   员工C电脑
   (CLI+daemon)  (CLI+daemon) (CLI+daemon)
       │           │           │
   手机A (App)  手机B (App) 手机C (App)
```

### 2.2 内网版架构

```
┌─────────────────────────────────────────────────┐
│  内网服务器 (Docker Compose)                     │
│  ┌───────────────┐  ┌──────────┐  ┌───────────┐ │
│  │ happy-server   │  │PostgreSQL│  │Redis(可选)│ │
│  │ Fastify:3005   │  │  :5432   │  │  :6379    │ │
│  └───────┬───────┘  └──────────┘  └───────────┘ │
│  ┌───────┴───────┐                               │
│  │  MinIO (S3)    │                               │
│  │  :9000/:9001   │                               │
│  └───────────────┘                               │
│          │ HTTP + WebSocket (内网)                │
└──────────┼──────────────────────────────────────┘
           │
  ┌────────┼────────┐
  │        │        │
员工A     员工B    员工C
┌────────────────┐
│ happy-cli      │  ← WebSocket 长连接到内网 Server
│ happy-daemon   │
│ Claude / Codex │
└────────────────┘
  │
手机 (WiFi/VPN)   ← WebSocket 长连接到内网 Server
```

### 2.3 涉及的 Packages

本仓库为 yarn monorepo，包含 6 个 packages：

| Package | 说明 | 是否需要改造 |
|---------|------|-------------|
| `happy-server` | Fastify 后端服务 | **是** — 认证、删除外部依赖 |
| `happy-cli` | CLI 工具（员工电脑运行） | **是** — 认证、serverUrl |
| `happy-app` | React Native + Expo 手机端 | **是** — 认证界面、删除外部依赖 |
| `happy-wire` | 共享协议/类型库 | **否** — 纯协议定义，不涉及外部通信 |
| `happy-agent` | 远程 Agent 控制 CLI | **需评估** — 可能需要改 serverUrl 和认证方式 |
| `happy-app-logs` | 日志聚合服务 | **需评估** — 如需部署，需纳入 Docker Compose |

> **注意**: `happy-agent` 和 `happy-app-logs` 在原计划中未覆盖。`happy-agent` 如果内网环境需要使用，其认证和 serverUrl 也需要同步改造。`happy-app-logs` 如果需要日志功能，需要加入 Docker Compose 部署。

### 2.4 核心变化

| 维度 | 原版 | 内网版 |
|------|------|--------|
| Server 位置 | 公网云服务器 | 内网 Docker Compose |
| 通信协议 | HTTPS + WSS | HTTP + WS |
| 认证方式 | QR 码 + TweetNaCl 签名 | 用户名密码 + JWT |
| 数据库 | 外部 PostgreSQL | Docker 内 PostgreSQL |
| 缓存 | 外部 Redis | Docker 内 Redis（可选） |
| 文件存储 | S3 / 本地 | Docker 内 MinIO |
| 推送通知 | Expo Push (公网) | 暂保留代码，后续处理 |
| OTA 更新 | Expo Updates (公网) | 暂保留代码，后续处理 |
| 数据分析 | PostHog (公网) | 暂保留代码，后续内网部署 |

---

## 3. 外部依赖调研详情

以下是对 Happy 源码中所有外网通信点的完整调研结果。

### 3.1 CLI (happy-cli) 外网通信点

#### 3.1.1 服务器连接

| 位置 | 说明 |
|------|------|
| `src/configuration.ts:32` | 默认 API 服务器: `https://api.cluster-fluster.com` |
| `src/configuration.ts:33` | Webapp URL: `https://app.happy.engineering` |
| 环境变量 `HAPPY_SERVER_URL` | 可覆盖默认 API 服务器 |
| 环境变量 `HAPPY_WEBAPP_URL` | 可覆盖默认 Webapp URL |

**改造**: 修改默认值或强制通过环境变量配置。

#### 3.1.2 OAuth 外部服务

| 服务 | URL | 用途 |
|------|-----|------|
| Google OAuth | `https://accounts.google.com/o/oauth2/v2/auth` | Gemini 认证 |
| Google Token | `https://oauth2.googleapis.com/token` | Gemini Token 交换 |
| Claude OAuth | `https://claude.ai/oauth/authorize` | Claude 云端认证 |
| Anthropic Token | `https://console.anthropic.com/v1/oauth/token` | Claude Token 交换 |
| OpenAI OAuth | `https://auth.openai.com` | Codex 认证 |

**改造**: 全部删除。员工直接在本地配置 API key，不通过 OAuth。

#### 3.1.3 推送通知

- 使用 `expo-server-sdk` 发送推送到 `api.expo.io`
- 通过 `GET /v1/push-tokens` 获取注册的推送 token

**改造**: 代码保留，暂不处理。

#### 3.1.4 认证流程

- `src/api/auth.ts`: QR 码格式 `handy://{base64url(secretKey)}`
- `src/api/encryption.ts`: TweetNaCl 签名 challenge-response
- 密钥存储: `~/.happy/access.key`

**改造**: QR 码内容改为 `happy-local://{serverUrl}`，认证改为用户名密码 + JWT。

#### 3.1.5 WebSocket 连接

- 连接到 `${serverUrl}/v1/updates`（Socket.io）
- 传输方式: 仅 WebSocket（`transports: ['websocket']`）
- 自动重连: 指数退避（1s-5s）

**改造**: 不需改动，只改 serverUrl 即可。

#### 3.1.6 Daemon 架构

- 注册: `POST /v1/machines`（加密元数据）
- 心跳: 每 60 秒 Socket.io `machine-alive` 事件
- RPC: 接收手机端的 `spawn-happy-session`、`stop-session` 等命令
- 版本检查: 仅本地读取 `package.json`，不联网

**改造**: 不需改动，只改 serverUrl 即可。

#### 3.1.7 本地 Daemon HTTP

- `http://127.0.0.1:{daemonPort}/session-started`
- `http://127.0.0.1:{daemonPort}/list`
- `http://127.0.0.1:{daemonPort}/stop-session`
- `http://127.0.0.1:{daemonPort}/stop`
- `http://127.0.0.1:{daemonPort}/spawn-session`

**改造**: 不需改动，纯本地通信。

#### 3.1.8 无 NAT 穿透

确认：代码中无 STUN/TURN/WebRTC/UPnP/NAT 穿透/端口转发/隧道 相关代码。

#### 3.1.9 无遥测

确认：无崩溃报告、无分析事件、无用户行为追踪、无 npm 注册表版本检查。

---

### 3.2 Server (happy-server) 外网通信点

#### 3.2.1 绑定配置

| 配置 | 值 | 位置 |
|------|-----|------|
| HTTP 端口 | 3005（`PORT` 环境变量） | `app/api/api.ts:96` |
| 绑定地址 | `0.0.0.0`（所有网卡） | `app/api/api.ts:96` |
| Metrics 端口 | 9090（`METRICS_PORT`） | `metrics.ts:48` |

**改造**: 保持 `0.0.0.0`（允许局域网访问），无需修改。

#### 3.2.2 CORS 配置

```typescript
// 原始配置
cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'], headers: '*', credentials: true }
```

**改造**: 限制为局域网来源（可选，内网环境风险较低）。

#### 3.2.3 外部服务依赖

| 服务 | URL | 用途 | 处理 |
|------|-----|------|------|
| GitHub OAuth | `https://github.com/login/oauth/*` | 社交登录 | **删除** |
| GitHub API | `https://api.github.com/user` | 用户信息 | **删除** |
| ElevenLabs | `https://api.elevenlabs.io/v1/convai/*` | 语音合成 | **删除** |
| RevenueCat | `https://api.revenuecat.com/v1/subscribers/*` | 订阅管理 | **删除** |

#### 3.2.4 存储依赖

| 服务 | 配置 | 处理 |
|------|------|------|
| PostgreSQL | `DATABASE_URL` 环境变量 | **保留**，Docker 内部署 |
| Redis | `REDIS_URL` 环境变量 | **保留**，Docker 内部署（可选） |
| S3/MinIO | `S3_HOST/PORT/ACCESS_KEY/SECRET_KEY/BUCKET` | **保留**，Docker 内部署 MinIO |
| 本地文件系统 | `./data/files/`（S3 未配置时的 fallback） | 保留 |

#### 3.2.5 Socket.io 配置

```typescript
// 原始配置
{
  path: '/v1/updates',
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingTimeout: 45000,
  pingInterval: 15000,
  connectTimeout: 20000,
  serveClient: false
}
```

**改造**: 不需改动。

#### 3.2.6 认证端点

- `POST /v1/auth`: challenge-response 认证（使用 `privacy-kit` 库封装 TweetNaCl 签名验证）
- `POST /v1/auth/request`: CLI 终端认证请求（QR 码流程）
- `GET /v1/auth/request/status`: 查询认证请求状态
- 无外部 OAuth 依赖（除 GitHub）

> **实现细节**: Server 端 auth 模块位于 `sources/app/auth/auth.ts`，使用 `privacy-kit` 库（非直接 TweetNaCl）进行 token 生成和验证。改造时需要理解 `privacy-kit` 的 token 格式，确保 JWT 模式能正确替换。

**改造**: 替换为用户名密码 + JWT。

#### 3.2.7 公开端点（无认证）

- `/` 欢迎页
- `/health` 健康检查
- GitHub OAuth 回调
- GitHub Webhook

**改造**: 保留 `/` 和 `/health`，删除 GitHub 相关。

#### 3.2.8 关键环境变量

```bash
# 数据库
DATABASE_URL=postgresql://...

# Redis
REDIS_URL=redis://...

# S3/MinIO
S3_HOST=
S3_PORT=9000
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_BUCKET=
S3_REGION=us-east-1
S3_PUBLIC_URL=

# GitHub（删除）
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=

# 新增
HAPPY_AUTH_MODE=local
JWT_SECRET=<随机生成>
```

---

### 3.3 App (happy-app) 外网通信点

> **结论：App 可以在内网环境完全复用，但需要少量修改。** 以下为详细调研结果。

#### 3.3.1 服务器配置

| 配置 | 值 | 位置 |
|------|-----|------|
| 默认服务器 | `https://api.cluster-fluster.com` | `sources/sync/serverConfig.ts:8` |
| 自定义服务器 | MMKV `custom-server-url` key | 用户可配置（设置页面） |
| 环境变量 | `EXPO_PUBLIC_HAPPY_SERVER_URL` | 构建时配置 |
| 设置界面 | `sources/app/(app)/server.tsx` | 运行时手动输入 |

**改造**: 构建时通过环境变量注入内网 Server 地址。App 已有手动设置 Server 地址的 UI，用户也可在设置中切换。

#### 3.3.2 外部服务依赖详细分析

| 服务 | URL/配置 | 分类 | 内网影响 | 处理方案 |
|------|---------|------|---------|---------|
| Expo OTA Updates | `https://u.expo.dev/{projectId}` | **硬性阻塞** | 每次 App 切回前台尝试连接，造成超时延迟 | 构建时禁用 expo-updates 插件 |
| Expo Push Notifications | Expo Push Service | **硬性阻塞** | `getExpoPushTokenAsync()` 需连接 Expo 服务器，导致推送注册失败 | 加强错误处理，跳过推送注册 |
| PostHog | `https://us.i.posthog.com` | **软性阻塞** | 分析事件超时，造成可见延迟 | **不设置** `EXPO_PUBLIC_POSTHOG_API_KEY` 即可禁用 |
| Firebase | `google-services.json` | **软性阻塞** | FCM 推送不可用 | **删除** 配置文件 |
| LiveKit | `@livekit/react-native` | **软性阻塞** | 语音通话不可用 | **删除** realtime/ 目录 |
| ElevenLabs | Agent IDs | **软性阻塞** | 语音合成不可用，已有错误处理 | **删除** 相关配置 |
| RevenueCat | `api.revenuecat.com` | **软性阻塞** | 订阅功能失效 | **不设置** RevenueCat 环境变量即可禁用 |
| Mermaid CDN | `https://cdn.jsdelivr.net/npm/mermaid@11/` | **软性阻塞** | Native 端图表不渲染（Web 端用本地版本） | 打包本地 mermaid.js 或降级显示 |

#### 3.3.3 已具备的内网友好特性（无需修改）

| 特性 | 说明 | 位置 |
|------|------|------|
| Server URL 完全可配 | 环境变量 + 设置界面双入口 | `serverConfig.ts` |
| Socket.IO 支持纯 HTTP | `transports: ['websocket']`，不要求 HTTPS/WSS | `apiSocket.ts:59-70` |
| 字体/资源全部本地打包 | IBMPlexSans、FontAwesome 等均内置 | `_layout.tsx:100-161` |
| 开发环境自动登录 | `EXPO_PUBLIC_DEV_TOKEN` + `EXPO_PUBLIC_DEV_SECRET` 环境变量 | `_layout.tsx:169-176` |
| Deep linking 仅生产构建 | 开发/预览构建不依赖公网 DNS | `app.config.js:44,75` |
| 手动恢复认证 | 支持密钥手动输入绕过 QR 流程 | `sources/app/(app)/restore/manual.tsx` |

#### 3.3.4 App 分发配置

| 配置 | 原始值 | 处理 |
|------|--------|------|
| iOS Bundle ID | `com.ex3ndr.happy` | 改为公司 Bundle ID |
| Android Package | `com.ex3ndr.happy` | 改为公司 Package Name |
| App Store Connect | Apple ID `steve@bulkovo.com` | **删除** |
| EAS Project ID | `4558dd3d-cd5a-47cd-bad9-e591a241cc06` | **删除或替换** |
| Associated Domains | `applinks:app.happy.engineering` | **删除**（仅生产构建启用） |

#### 3.3.5 认证流程

- `sources/auth/authQRStart.ts`: 生成密钥对，POST 到 `/v1/auth/account/request`
- `sources/auth/authQRWait.ts`: 每秒轮询认证状态
- `sources/auth/authChallenge.ts`: sodium 签名 challenge-response
- Token 存储: `sources/auth/tokenStorage.ts` — Native 用 `expo-secure-store`，Web 用 `localStorage`

**改造**: 新增用户名密码登录界面，替代 QR 码流程。保留 QR 流程作为 fallback。

#### 3.3.6 App 启动序列分析

```
1. 字体加载                → 本地 (无网络)
2. Sodium 库初始化         → 本地 (无网络)
3. 凭证检查               → 本地存储 (无网络)
4. DEV 凭证检查            → 环境变量 (无网络)
5. syncRestore() 启动      → ⚠️ 网络调用开始
   ├── 连接 Server 初始化同步
   ├── Expo Updates 后台检查    ← 硬性阻塞
   ├── PostHog 初始化（如有 key）← 软性阻塞
   └── Push Token 注册          ← 硬性阻塞
```

> **风险**: 如果步骤 5 中 Server 不可达，App 会卡在启动页。需要添加超时和离线提示。

#### 3.3.7 WebSocket 连接

- 连接到 `${serverUrl}/v1/updates`（Socket.io）
- 传输方式: 仅 WebSocket（`transports: ['websocket']`）
- 自动重连: 指数退避
- 认证: Bearer token 通过 socket auth 传递

**改造**: 不需改动，只改 serverUrl 即可。

#### 3.3.8 内网构建环境变量

```bash
# 必须设置
EXPO_PUBLIC_HAPPY_SERVER_URL=http://192.168.1.50:3005

# 以下变量不设置即可禁用对应功能
# EXPO_PUBLIC_POSTHOG_API_KEY=
# EXPO_PUBLIC_REVENUE_CAT_APPLE=
# EXPO_PUBLIC_REVENUE_CAT_GOOGLE=
# EXPO_PUBLIC_REVENUE_CAT_STRIPE=
```

---

## 4. 认证体系改造

### 4.1 原版认证流程

```
1. CLI 首次运行 → 生成 32 字节随机密钥 (TweetNaCl)
2. 密钥存储到 ~/.happy/access.key
3. CLI 显示 QR 码: handy://{base64url(secretKey)}
4. 手机 App 扫描 QR 码 → 获取密钥
5. 手机 → Server: POST /v1/auth (publicKey + challenge + signature)
6. Server 验证签名 → 返回 JWT token
7. CLI 通过 Server 中继获取 token
8. 所有后续请求使用 Bearer token
```

**关键文件**:
- `packages/happy-cli/src/api/auth.ts`: `authGetToken()`, `generateAppUrl()`
- `packages/happy-cli/src/api/encryption.ts`: `authChallenge()`, TweetNaCl 签名
- `packages/happy-cli/src/persistence.ts`: 凭证读写 (`readCredentials`, `writeCredentialsLegacy`, `writeCredentialsDataKey`)

### 4.2 内网版认证流程

#### 注册流程

```
1. 管理员部署 Docker Compose → Server 启动在 192.168.1.50:3005
2. 员工首次运行 happy-cli
   → CLI 启动，连接 Server（通过 HAPPY_SERVER_URL 环境变量）
   → CLI 显示 QR 码: happy-local://192.168.1.50:3005
3. 手机 App 扫码 → 自动填入 Server 地址
4. 手机显示注册界面:
   ┌─────────────────────┐
   │  注册                │
   │  用户名: [________] │
   │  密码:   [________] │
   │  确认密码:[________] │
   │  [注册]              │
   └─────────────────────┘
5. App → Server: POST /v1/auth/register { username, password }
6. Server: bcrypt(password) → 存入 PostgreSQL users 表 → 返回 JWT
7. App 保存 JWT + Server 地址到 MMKV
```

#### CLI 登录流程

```
1. 员工运行: happy login
2. CLI 提示输入用户名密码
3. CLI → Server: POST /v1/auth/login { username, password }
4. Server 验证 → 返回 JWT
5. CLI 保存 JWT 到 ~/.happy/credentials.json
6. 后续请求使用 Bearer {jwt}
```

#### App 登录流程

```
1. App 启动 → 检查已保存的 Server 地址和 JWT
2. 如果有效 → 直接连接
3. 如果无效/过期 → 显示登录界面
4. 用户输入用户名密码 → 获取新 JWT
```

### 4.3 数据模型

```sql
-- 新增 users 表（PostgreSQL）
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(64) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,  -- bcrypt hash
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 原版 account 表可能需要关联
-- account.id ← user.id
```

### 4.4 JWT 设计

```typescript
// JWT Payload
{
  sub: userId,         // 用户 ID
  username: string,    // 用户名
  iat: number,         // 签发时间
  exp: number          // 过期时间（建议 7 天）
}

// 签名密钥: 环境变量 JWT_SECRET
// 算法: HS256
```

### 4.5 API 端点设计

```
POST /v1/auth/register
  Body: { username: string, password: string }
  Response: { success: true, token: string, userId: string }
  错误: 409 用户名已存在, 400 参数不合法

POST /v1/auth/login
  Body: { username: string, password: string }
  Response: { success: true, token: string, userId: string }
  错误: 401 用户名或密码错误

GET /v1/auth/me
  Header: Authorization: Bearer {jwt}
  Response: { userId, username, createdAt }
  错误: 401 token 无效或过期
```

### 4.6 代码改造对照

```
packages/happy-server/sources/auth/
├── localAuth.ts (新增)
│   ├── register(username, password) → { token, userId }
│   ├── login(username, password) → { token, userId }
│   ├── verifyToken(token) → { userId, username }
│   └── hashPassword(password) → bcryptHash
│
├── 原版 auth 代码 (保留但切换)
│   └── 通过 HAPPY_AUTH_MODE 环境变量切换:
│       - 'local': 使用 localAuth.ts
│       - 'legacy': 使用原版 challenge-response

packages/happy-cli/src/api/auth.ts (修改)
├── authGetToken(secret) → 改为 loginWithCredentials(username, password)
├── generateAppUrl(secret) → 改为 generateServerQR(serverUrl)

packages/happy-cli/src/persistence.ts (修改)
├── readCredentials() → 改为读取 JWT token（而非 access.key）
├── writeCredentialsLegacy() / writeCredentialsDataKey() → 改为 writeCredentials(JWT token)

packages/happy-app/sources/auth/ (修改)
├── QR 扫码流程 → 解析 Server 地址
├── 新增注册界面
├── 新增登录界面
├── 保存 JWT 到 MMKV
```

---

## 5. 需要删除的代码

### 5.1 Server 端删除

```
packages/happy-server/sources/
├── app/api/routes/connectRoutes.ts   # GitHub OAuth 路由（整个文件或 GitHub 相关部分）
├── app/github/                       # GitHub 集成（整个目录）
│   ├── githubConnect.ts
│   └── githubDisconnect.ts
├── app/api/routes/voiceRoutes.ts     # ElevenLabs 语音 API 路由
```

相关环境变量也需移除:
```
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GITHUB_REDIRECT_URI
GITHUB_APP_ID
GITHUB_PRIVATE_KEY
GITHUB_WEBHOOK_SECRET
```

### 5.2 CLI 端删除

```
packages/happy-cli/src/
├── 相关 OAuth 代码:
│   └── Claude OAuth (claude.ai/oauth)
│   └── OpenAI OAuth (auth.openai.com)
│   └── Google OAuth (accounts.google.com)
```

> **注意**: 原计划中列出的 `gemini/` 目录在代码库中不存在，已移除。

### 5.3 App 端删除

```
packages/happy-app/
├── sources/realtime/                 # LiveKit 语音（整个目录）
├── sources/sync/revenueCat/          # RevenueCat 订阅计费（整个目录）
│   ├── index.ts
│   ├── revenueCat.ts
│   └── revenueCat.web.ts
├── google-services.json              # Android Firebase
├── GoogleService-Info.plist          # iOS Firebase (如存在)
├── app.config.js 中:
│   └── googleServicesFile 配置
│   └── associatedDomains 配置
│   └── ElevenLabs Agent ID 配置
│   └── RevenueCat 相关配置
│   └── @livekit/react-native-expo-plugin
```

> **注意**: RevenueCat 订阅计费模块在 App 端而非 Server 端，已从 5.1 移至此处。

---

## 6. 需要修改的代码

### 6.1 Server 端修改

#### `sources/main.ts`
```diff
+ // 读取认证模式
+ const authMode = process.env.HAPPY_AUTH_MODE || 'local'
+ // 根据 authMode 注册不同的认证路由和中间件
```

#### `sources/app/api/api.ts`
```diff
  // CORS 可选限制为局域网
- origin: '*'
+ origin: (origin, callback) => {
+   if (!origin) return callback(null, true)
+   const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(origin)
+   callback(null, isLocal)
+ }
```

#### 新增 `sources/auth/localAuth.ts`
- `register()`: 用户名密码注册
- `login()`: 用户名密码登录
- `verifyToken()`: JWT 验证中间件
- `hashPassword()`: bcrypt 哈希
- 依赖: `bcrypt`, `jsonwebtoken`

#### 新增 Prisma Schema
```prisma
model User {
  id           String   @id @default(cuid())
  username     String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  accounts     Account[]
}
```

### 6.2 CLI 端修改

#### `src/configuration.ts`
```diff
- serverUrl: 'https://api.cluster-fluster.com'
+ serverUrl: process.env.HAPPY_SERVER_URL || 'http://localhost:3005'

- webappUrl: 'https://app.happy.engineering'
+ webappUrl: process.env.HAPPY_WEBAPP_URL || 'http://localhost:3005'
```

#### `src/api/auth.ts`
```diff
- export async function authGetToken(secret: Uint8Array): Promise<string> {
-   const { challenge, publicKey, signature } = authChallenge(secret);
-   const response = await axios.post(`${configuration.serverUrl}/v1/auth`, { ... });
-   return response.data.token;
- }
+ export async function loginWithCredentials(username: string, password: string): Promise<string> {
+   const response = await axios.post(`${configuration.serverUrl}/v1/auth/login`, {
+     username, password
+   });
+   return response.data.token;
+ }

- export function generateAppUrl(secret: Uint8Array): string {
-   return `handy://${encodeBase64Url(secret)}`;
- }
+ export function generateServerQR(serverUrl: string): string {
+   return `happy-local://${serverUrl}`;
+ }
```

#### `src/index.ts`
```diff
+ // 新增 login 子命令
+ case 'login':
+   const username = await prompt('Username: ');
+   const password = await prompt('Password: ', { hidden: true });
+   const token = await loginWithCredentials(username, password);
+   await writeCredentials({ token, serverUrl: configuration.serverUrl });
+   console.log('Login successful');
+   break;
```

#### `src/persistence.ts`

> **注意**: 该文件已有 `readCredentials()` / `writeCredentialsLegacy()` / `writeCredentialsDataKey()` 函数（使用 `~/.happy/access.key` 存储加密密钥）。内网版需要改造这些函数，改为读写 JWT token。

```diff
+ // 改造凭证读写，保存 JWT 而非 TweetNaCl 密钥
+ interface Credentials {
+   token: string;           // JWT token
+   serverUrl: string;       // Server 地址
+   username?: string;       // 用户名
+ }
+
+ // 复用 readCredentials() 函数签名，内部改为读取 credentials.json
+ export async function readCredentials(): Promise<Credentials | null> {
+   const credPath = path.join(configuration.homeDir, 'credentials.json');
+   // ...
+ }
+
+ // 替换 writeCredentialsLegacy/writeCredentialsDataKey
+ export async function writeCredentials(creds: Credentials): Promise<void> {
+   const credPath = path.join(configuration.homeDir, 'credentials.json');
+   // ...
+ }
```

### 6.3 App 端修改

#### `sources/sync/serverConfig.ts`
```diff
- const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com'
+ const DEFAULT_SERVER_URL = '' // 强制用户配置
```

#### `sources/app/(auth)/` 认证界面改造
```
原始:
  1. 扫码获取密钥 → 自动认证

内网版:
  1. 扫码获取 Server 地址 (或手动输入)
  2. 显示注册/登录界面
  3. 用户输入用户名密码
  4. 调用 /v1/auth/register 或 /v1/auth/login
  5. 保存 JWT + Server 地址
```

#### `app.config.js`
```diff
- googleServicesFile: './google-services.json',
+ // 移除 Firebase 配置

  ios: {
-   associatedDomains: ['applinks:app.happy.engineering'],
+   // 移除 App Links
  }

- // ElevenLabs Agent ID
+ // 移除 ElevenLabs 配置
```

---

## 7. 保留不变的代码

以下模块不需要任何修改:

```
packages/happy-wire/                          # 协议层完全不变
packages/happy-cli/src/claude/                # Claude Code 集成
packages/happy-cli/src/codex/                 # Codex 集成
packages/happy-cli/src/daemon/                # daemon 架构（只改 serverUrl）
packages/happy-cli/src/api/encryption.ts      # 端到端加密保留
packages/happy-cli/src/api/apiSession.ts      # WebSocket 会话（只改 serverUrl）
packages/happy-server/sources/storage/        # 存储层 (PostgreSQL/Redis/S3)
packages/happy-server/sources/app/events/     # 事件系统
packages/happy-server/sources/app/session/    # 会话管理
packages/happy-server/sources/app/feed/       # 消息 Feed
packages/happy-server/sources/app/kv/         # KV 存储
packages/happy-server/sources/app/presence/   # 在线状态
packages/happy-server/sources/modules/lock/   # 分布式锁
packages/happy-app/sources/sync/              # 同步引擎
packages/happy-app/sources/encryption/        # 加密模块
packages/happy-app/sources/components/        # UI 组件
packages/happy-app/sources/hooks/             # React Hooks
```

---

## 8. Docker Compose 部署方案

### 8.1 docker-compose.yml（方案 A：PGlite 简化版，推荐）

> 使用现有 `Dockerfile`（内置 PGlite），无需外部 PostgreSQL，最少容器数。

```yaml
version: '3.8'

services:
  happy-server:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "3005:3005"
    volumes:
      - server_data:/app/data    # PGlite 数据 + 本地文件存储
    environment:
      - NODE_ENV=production
      - PORT=3005
      - DB_PROVIDER=pglite
      - HAPPY_AUTH_MODE=local
      - JWT_SECRET=${JWT_SECRET:-please-change-this-secret}
    restart: unless-stopped

  # 可选：Web 端访问（员工可通过浏览器使用）
  happy-webapp:
    build:
      context: .
      dockerfile: Dockerfile.webapp
      args:
        - EXPO_PUBLIC_HAPPY_SERVER_URL=http://${HAPPY_HOST:-localhost}:3005
    ports:
      - "80:80"
    restart: unless-stopped

volumes:
  server_data:
```

> **注意**: PGlite 方案适合 < 50 人的团队。文件存储使用本地文件系统 fallback（`./data/files/`），无需 MinIO。

### 8.1.1 docker-compose.yml（方案 B：完整版，大团队）

> 使用 `Dockerfile.server` + 外部 PostgreSQL + Redis + MinIO，适合需要独立数据库管理的场景。

```yaml
version: '3.8'

services:
  happy-server:
    build:
      context: .
      dockerfile: Dockerfile.server
    ports:
      - "3005:3005"
    environment:
      - NODE_ENV=production
      - PORT=3005
      - DATABASE_URL=postgresql://happy:happy@postgres:5432/happy
      - REDIS_URL=redis://redis:6379
      - S3_HOST=minio
      - S3_PORT=9000
      - S3_ACCESS_KEY=minioadmin
      - S3_SECRET_KEY=minioadmin
      - S3_BUCKET=happy
      - S3_REGION=us-east-1
      - S3_PUBLIC_URL=http://${HAPPY_HOST:-localhost}:9000/happy
      - HAPPY_AUTH_MODE=local
      - JWT_SECRET=${JWT_SECRET:-please-change-this-secret}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
      minio:
        condition: service_started
    restart: unless-stopped

  # 可选：Web 端访问
  happy-webapp:
    build:
      context: .
      dockerfile: Dockerfile.webapp
      args:
        - EXPO_PUBLIC_HAPPY_SERVER_URL=http://${HAPPY_HOST:-localhost}:3005
    ports:
      - "80:80"
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    volumes:
      - pg_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_DB=happy
      - POSTGRES_USER=happy
      - POSTGRES_PASSWORD=happy
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U happy"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    restart: unless-stopped

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"   # S3 API
      - "9001:9001"   # MinIO 管理界面
    volumes:
      - minio_data:/data
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    restart: unless-stopped

volumes:
  pg_data:
  redis_data:
  minio_data:
```

### 8.2 Dockerfile 方案选择

仓库已有 3 个 Dockerfile，可直接复用：

| 文件 | 说明 | 适用场景 |
|------|------|---------|
| `Dockerfile` | 独立部署，内置 PGlite（无需外部 PostgreSQL） | **推荐：小团队（< 50 人）** |
| `Dockerfile.server` | 生产部署，需外部 PostgreSQL + Redis | 大团队或需要独立数据库管理 |
| `Dockerfile.webapp` | Web UI（Expo Web + nginx） | 提供浏览器端访问 |

#### 方案 A：使用现有 `Dockerfile`（推荐，最简部署）

现有 `Dockerfile` 已内置 PGlite（嵌入式 PostgreSQL），只需设置 `DB_PROVIDER=pglite`，无需 PostgreSQL 容器。适合小团队快速部署。

#### 方案 B：使用 `Dockerfile.server` + 外部 PostgreSQL

适合需要独立数据库管理、备份策略的场景。对应上方 8.1 的 Docker Compose 配置。

#### 关键注意事项

无论选择哪个方案，如果需要自定义 Dockerfile，必须包含 Prisma 相关步骤：

```dockerfile
# 在 builder 阶段必须包含:
COPY packages/happy-server/prisma/ packages/happy-server/prisma/
RUN yarn workspace happy-server prisma generate

# 在 runtime 阶段必须包含:
COPY --from=builder /app/packages/happy-server/prisma ./prisma
```

> **注意**: 原计划中的 `Dockerfile.internal` 遗漏了 Prisma schema 和 migrations 的 COPY 步骤，会导致构建失败。

### 8.3 已有 K8s 部署参考

仓库已有 Kubernetes 部署配置，可作为参考：
- `packages/happy-server/deploy/handy.yaml` — Server Deployment（含健康检查、Prometheus metrics）
- `packages/happy-server/deploy/happy-redis.yaml` — Redis StatefulSet（含持久化存储）

如果内网环境已有 K8s 集群，可以直接基于这些文件部署，无需 Docker Compose。

### 8.4 部署步骤

```bash
# 1. 克隆内网版仓库
git clone <内网 Git 仓库地址> happy-internal
cd happy-internal

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env:
#   JWT_SECRET=<生成随机字符串>
#   HAPPY_HOST=192.168.1.50  # 内网 Server IP

# 3. 启动
docker compose up -d

# 4. 检查状态
curl http://192.168.1.50:3005/health
```

### 8.5 员工使用

```bash
# 1. 安装 CLI（内网 npm 源或直接安装）
npm install -g happy-internal
# 或
npm install -g /path/to/happy-cli-x.x.x.tgz

# 2. 配置 Server 地址
export HAPPY_SERVER_URL=http://192.168.1.50:3005

# 3. 首次登录
happy login
# Username: alice
# Password: ****

# 4. 日常使用
happy        # 启动 Claude Code
happy codex  # 启动 Codex
```

---

## 9. App 分发方案

### 9.1 Android

**推荐方案**: 直接分发 APK

```bash
# 构建 APK
cd packages/happy-app
yarn android:build:release

# 分发方式:
# 1. 放到内网文件服务器供下载
# 2. 或通过企业 MDM 推送
```

需要修改:
- 移除 `google-services.json`
- 修改 `app.config.js` 中的 package name
- 构建时注入默认 Server 地址

### 9.2 iOS

**推荐方案**: 企业签名（需 Apple Developer Enterprise Program, $299/年）

```bash
# 构建 IPA
cd packages/happy-app
eas build --platform ios --profile production

# 使用企业证书签名后分发
```

**替代方案**:
- TestFlight（需 Apple Developer Program, $99/年）
- 每个开发者自己用 Xcode 编译（免费但需 Mac）

### 9.3 构建配置修改

```javascript
// app.config.js (内网版)
export default {
  name: "Happy Internal",
  slug: "happy-internal",
  ios: {
    bundleIdentifier: "com.yourcompany.happy",
    // 移除 associatedDomains
    // 移除 googleServicesFile
  },
  android: {
    package: "com.yourcompany.happy",
    // 移除 googleServicesFile
  },
  // 移除 EAS updates 配置
  // 移除 ElevenLabs 配置
}
```

---

## 10. 实施计划

### Phase 1: Server 改造（✅ 已完成）

> 已实现并提交到 `feat/internal-network-deployment` 分支。
> Commit: `73860978` — https://github.com/Jassy930/happy/tree/feat/internal-network-deployment

```
任务 1.1: 新增本地认证模块
  - 创建 sources/auth/localAuth.ts
  - 实现 register / login / verifyToken
  - bcrypt 密码哈希 + JWT 签发
  - 新增 Prisma User model
  - 新增 /v1/auth/register 和 /v1/auth/login 路由

任务 1.2: 新增认证模式切换
  - 环境变量 HAPPY_AUTH_MODE=local
  - 修改认证中间件支持 JWT 验证
  - 保留原版 challenge-response 作为 fallback

任务 1.3: 删除外部服务代码
  - 删除 GitHub OAuth 路由（app/api/routes/connectRoutes.ts）
  - 删除 GitHub 集成模块（app/github/ 目录）
  - 删除 ElevenLabs 语音路由（app/api/routes/voiceRoutes.ts）

任务 1.4: 编写 Docker Compose + 配置
  - 选择部署方案（PGlite 简化版 或 完整版）
  - 复用现有 Dockerfile / Dockerfile.server
  - 可选：加入 Dockerfile.webapp 提供 Web 端访问
  - 编写 .env.example
  - 测试一键部署
```

### Phase 2: CLI 改造（✅ 已完成）

> 已实现并提交到 `feat/internal-network-deployment` 分支。
> Commit: `8c2b23b9` — https://github.com/Jassy930/happy/tree/feat/internal-network-deployment

```
任务 2.1: 修改默认配置 ✅
  - configuration.ts: 默认 serverUrl 改为 http://localhost:3005
  - 通过 HAPPY_SERVER_URL 环境变量覆盖

任务 2.2: 改造认证流程 ✅
  - api/auth.ts: 新增 loginWithCredentials() 和 registerWithCredentials()
  - persistence.ts: 新增 writeCredentialsLocal()（生成本地加密密钥 + 保存 JWT）
  - ui/auth.ts: 新增 doLocalAuth() 用户名密码交互式登录
  - index.ts: 新增顶层 happy login 快捷命令
  - HAPPY_AUTH_MODE=local 时自动使用用户名密码认证
  - HAPPY_AUTH_MODE=legacy 时保留原版 QR/Web 认证

任务 2.3: 删除 OAuth 代码（暂缓）
  - OAuth 代码已注释但未删除，保留兼容性
  - （注：gemini/ 目录不存在，无需处理）

任务 2.4: 评估 happy-agent 改造（暂缓）
  - happy-agent 使用相同的 serverUrl + 认证模式
  - 如需使用需同步改造
```

### Phase 3: App 改造（✅ 已完成）

> 已实现并提交到 `feat/internal-network-deployment` 分支。
> Commit: `cf52dfad` — https://github.com/Jassy930/happy/tree/feat/internal-network-deployment
>
> **总体结论**: App 可在内网完全复用。核心架构（Server URL 可配、Socket.IO 纯 HTTP、资源本地打包）已具备内网友好特性。改造重点是禁用外部依赖 + 新增登录界面。

```
任务 3.1: 修复硬性阻塞项 ✅
  - 禁用 Expo Updates:
    - sources/hooks/useUpdates.ts: HAPPY_AUTH_MODE=local 时跳过 OTA 检查
  - 修复推送注册:
    - sources/sync/pushRegistration.ts: syncCurrentPushToken 包裹 try-catch
    - 内网环境离线时不崩溃，返回 registered: false
  - App 启动卡死修复（待联调验证）:
    - syncRestore() 超时机制待后续添加

任务 3.2: 修改服务器配置 ✅
  - serverConfig.ts: 默认值改为环境变量优先，fallback http://localhost:3005
  - 构建时通过 EXPO_PUBLIC_HAPPY_SERVER_URL 注入内网 Server 地址
  - 保留设置页面（sources/app/(app)/server.tsx）手动输入入口

任务 3.3: 改造认证界面 ✅
  - 新增 sources/auth/localAuth.ts: localLogin() / localRegister() API
  - 新增 sources/app/(app)/local-login.tsx: 登录/注册界面
    - 支持登录/注册模式切换
    - 错误提示（用户名已存在、密码错误等）
    - 本地生成加密密钥保持 e2e 加密兼容
  - 欢迎页 index.tsx: EXPO_PUBLIC_HAPPY_AUTH_MODE=local 时显示 "Login / Register"
  - 保留 QR 码流程和 restore 流程作为 fallback

任务 3.4: 移除/禁用外部依赖 ✅（部分）
  - app.config.js: 注释掉 googleServicesFile、LiveKit/WebRTC 插件
  - 环境变量控制（不设置即禁用）:
    - 不设 EXPO_PUBLIC_POSTHOG_API_KEY → PostHog 不初始化
    - 不设 EXPO_PUBLIC_REVENUE_CAT_* → RevenueCat 不初始化
  - 待后续清理: 删除 realtime/ 目录、revenueCat/ 目录、google-services.json

任务 3.5: 修复 Mermaid CDN 依赖（待后续处理）
  - sources/components/markdown/MermaidRenderer.tsx:113
  - 需要打包本地 mermaid.js 或降级显示

任务 3.6: 构建内部分发包（待联调后执行）
  - Android: 构建 APK
  - iOS: 企业签名或 TestFlight
```

### Phase 4: 联调测试（✅ Server API 测试通过）

> Server 端 API 测试于 2026-03-27 执行，全部通过。
> 环境: standalone 模式 (PGlite) + HAPPY_AUTH_MODE=local

#### 4.1 Server API 测试结果

| # | 测试项 | 方法 | 预期 | 实际 | 状态 |
|---|--------|------|------|------|------|
| 1 | 用户注册 | POST /v1/auth/register | 200 + token | 200 + JWT token | ✅ |
| 2 | 重复注册 | POST /v1/auth/register | 409 | 409 "Username already exists" | ✅ |
| 3 | 用户登录 | POST /v1/auth/login | 200 + token | 200 + JWT token | ✅ |
| 4 | 密码错误 | POST /v1/auth/login | 401 | 401 "Invalid username or password" | ✅ |
| 5 | 密码太短 | POST /v1/auth/register | 400 | 400 validation error | ✅ |
| 6 | JWT 获取用户信息 | GET /v1/auth/me | 200 + user | 200 { userId, username } | ✅ |
| 7 | 无效 token | GET /v1/auth/me | 401 | 401 "Invalid token" | ✅ |
| 8 | 无 header | GET /v1/auth/me | 401 | 401 "Missing authorization header" | ✅ |
| 9 | JWT 访问受保护端点 | GET /v1/machines | 200 | 200 [] (空列表，正确) | ✅ |
| 10 | 多用户注册 | POST /v1/auth/register (bob) | 200 | 200 + 不同 userId | ✅ |
| 11 | 多用户隔离 | GET /v1/machines (bob) | 200 [] | 200 [] (独立数据) | ✅ |

#### 4.2 待完成的测试（需要实际设备/环境）

```
任务 4.2: CLI → Server 完整流程（需要 Claude Code API Key）
  - happy login 交互式登录
  - daemon 注册和心跳
  - Claude Code 会话创建和同步

任务 4.3: App → Server 连接（需要 Expo 构建环境）
  - 手动输入 Server 地址
  - 用户注册/登录界面
  - WebSocket 实时同步

任务 4.4: 端到端功能验证（需要 CLI + App + Server 同时运行）
  - CLI 启动 Claude Code 会话
  - App 实时查看会话输出
  - App 发送权限批准
  - App 发送消息到 CLI

任务 4.5: 多用户隔离验证
  - 用户 A 和用户 B 同时使用
  - 验证会话列表只显示自己的
```

---

## 11. 风险与缓解

| 风险 | 分类 | 影响 | 缓解方案 |
|------|------|------|----------|
| Expo Updates 超时 | **硬性阻塞** | App 每次切回前台卡顿 3-5 秒 | 构建时禁用 expo-updates 插件 |
| Expo Push Token 注册失败 | **硬性阻塞** | 推送注册异常 | 加强 try-catch，无网络时跳过 |
| App 启动时 Server 不可达 | **硬性阻塞** | App 卡在启动页 | syncRestore() 添加超时 + 离线提示 |
| Mermaid CDN 不可用 | 软性阻塞 | Native 端图表不渲染 | 打包本地 mermaid.js 或降级显示 |
| PostHog 分析不可用 | 软性阻塞 | 分析事件丢失 | 不设置 API Key 即可完全禁用 |
| Expo Push 无法内网使用 | 功能缺失 | 手机无法收到后台推送 | WebSocket 在线通知 + 前台保活 |
| Expo Updates 无法内网使用 | 功能缺失 | App 无法 OTA 更新 | 重新构建 APK/IPA 分发 |
| iOS 企业签名成本 | 运维成本 | 需要 $299/年 | TestFlight 或源码编译 |
| 内网 IP 变化 | 运维风险 | CLI/App 需要重新配置 | 使用内网 DNS 或固定 IP |
| 端到端加密密钥管理 | 安全考量 | 用户切换设备需重新配置 | 保留原版密钥同步机制 |
| PGlite 数据备份 | 运维风险 | 数据丢失风险 | Docker volume 备份策略 |

---

## 12. 后续迭代

### 12.1 SSO 集成（Phase 5）

- 支持 LDAP / Active Directory
- 支持 OIDC（如飞书、企业微信 SSO）
- 通过 HAPPY_AUTH_MODE=sso 切换

### 12.2 推送通知内网化（Phase 6）

- 自建推送服务（WebSocket 长连接 fallback）
- 或自建 Expo Push 兼容服务

### 12.3 OTA 更新内网化（Phase 7）

- 自建更新服务器
- 或使用 CodePush / 自定义方案

### 12.4 数据分析内网化（Phase 8）

- 自建 PostHog（PostHog 支持自托管）
- 或替换为其他内网分析方案

---

## 附录 A: 关键源码位置索引

### CLI

| 文件 | 行数 | 用途 |
|------|------|------|
| `src/index.ts` | ~2000 | CLI 入口，子命令路由 |
| `src/configuration.ts` | ~60 | 配置管理（serverUrl 等） |
| `src/persistence.ts` | ~400 | 本地状态持久化（readCredentials, writeCredentials*） |
| `src/api/auth.ts` | ~43 | 认证（authGetToken, generateAppUrl） |
| `src/api/api.ts` | - | HTTP 客户端 |
| `src/api/apiSession.ts` | - | WebSocket RPC |
| `src/api/encryption.ts` | ~213 | 加密（TweetNaCl + AES-GCM） |
| `src/claude/loop.ts` | - | Claude 交互/远程模式切换 |
| `src/claude/claudeLocal.ts` | - | 本地 PTY 执行 |
| `src/claude/claudeRemote.ts` | - | SDK 远程执行 |
| `src/codex/runCodex.ts` | - | Codex 执行 |
| `src/daemon/daemon.ts` | - | 后台守护进程 |

### Server

| 文件 | 用途 |
|------|------|
| `sources/main.ts` | 启动编排 |
| `sources/app/api/api.ts` | Fastify 实例 + CORS |
| `sources/app/api/socket.ts` | Socket.io 设置 |
| `sources/app/api/routes/*` | REST API 路由（含 connectRoutes.ts、voiceRoutes.ts 待删除）|
| `sources/app/auth/auth.ts` | 认证模块（使用 privacy-kit 库） |
| `sources/app/api/routes/authRoutes.ts` | 认证路由端点 |
| `sources/app/github/` | GitHub 集成（待删除） |
| `sources/app/events/*` | 事件路由 |
| `sources/app/session/*` | 会话管理 |
| `sources/app/feed/*` | 消息 Feed |
| `sources/storage/db.ts` | Prisma 客户端 |
| `sources/storage/redis.ts` | Redis 连接 |
| `sources/storage/files.ts` | S3/MinIO 操作 |

### App

| 文件 | 用途 |
|------|------|
| `sources/app/_layout.tsx` | Expo Router 根布局，启动序列，DEV 凭证检查 |
| `sources/app/(auth)/*` | 认证流程界面 |
| `sources/app/(app)/*` | 已认证的应用界面 |
| `sources/app/(app)/server.tsx` | 服务器地址手动配置界面 |
| `sources/app/(app)/restore/manual.tsx` | 手动恢复认证（密钥输入） |
| `sources/sync/serverConfig.ts` | 服务器配置（默认值 + MMKV 存储） |
| `sources/sync/SyncSocket.ts` | WebSocket 管理 |
| `sources/sync/SyncSession.ts` | 会话加密/解密 |
| `sources/sync/pushRegistration.ts` | 推送 Token 注册（需修复离线处理） |
| `sources/hooks/useUpdates.ts` | Expo OTA 更新检查（需禁用） |
| `sources/track/tracking.ts` | PostHog 分析（环境变量控制） |
| `sources/components/markdown/MermaidRenderer.tsx` | Mermaid 图表渲染（CDN 依赖） |
| `sources/auth/authQRStart.ts` | QR 认证启动 |
| `sources/auth/authQRWait.ts` | QR 认证轮询 |
| `sources/auth/authChallenge.ts` | Sodium 签名认证 |
| `sources/auth/tokenStorage.ts` | Token 存储（SecureStore / localStorage） |
| `sources/auth/AuthContext.tsx` | 认证状态管理 |
| `sources/encryption/*` | libsodium 加密模块 |
| `sources/realtime/` | LiveKit 语音（待删除） |
| `sources/sync/revenueCat/` | RevenueCat 订阅计费（待删除） |
| `app.config.js` | Expo 构建配置 |

### Wire Protocol

| 文件 | 用途 |
|------|------|
| `src/messages.ts` | 消息 schema |
| `src/legacyProtocol.ts` | 旧版协议 |
| `src/sessionProtocol.ts` | 新版会话协议 |
| `src/voice.ts` | 语音消息类型 |

---

## 附录 B: 环境变量清单

### Server (.env)

```bash
# 基础配置
NODE_ENV=production
PORT=3005

# 数据库
DATABASE_URL=postgresql://happy:happy@postgres:5432/happy

# Redis（可选）
REDIS_URL=redis://redis:6379

# S3/MinIO
S3_HOST=minio
S3_PORT=9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=happy
S3_REGION=us-east-1
S3_PUBLIC_URL=http://${HAPPY_HOST}:9000/happy

# 认证（新增）
HAPPY_AUTH_MODE=local
JWT_SECRET=<随机生成的长字符串>

# 以下变量已移除，不再需要:
# GITHUB_CLIENT_ID
# GITHUB_CLIENT_SECRET
# GITHUB_REDIRECT_URI
# GITHUB_APP_ID
# GITHUB_PRIVATE_KEY
# GITHUB_WEBHOOK_SECRET
```

### CLI (员工电脑)

```bash
# 必须配置
HAPPY_SERVER_URL=http://192.168.1.50:3005

# 可选配置
HAPPY_HOME_DIR=~/.happy           # 默认
HAPPY_WEBAPP_URL=                 # 可选
HAPPY_VARIANT=stable              # 可选
HAPPY_DISABLE_CAFFEINATE=false    # 可选
```

### App (构建时)

```bash
EXPO_PUBLIC_HAPPY_SERVER_URL=http://192.168.1.50:3005  # 默认服务器
EXPO_PUBLIC_POSTHOG_API_KEY=     # 可选，留空则禁用分析
```
