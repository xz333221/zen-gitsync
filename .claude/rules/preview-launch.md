# preview 启动后 HMR 实时生效:端口分工与 launch.json 双 server 模式

本仓库 preview 工具过去一直抓的是 backend 静态服务的 `vite build` 生产 bundle,不是 vite dev server —— 改前端代码 reload 拿不到新 chunk,所有"DOM 没变"的伪故障根因都在这里。

## 端口分工(2026-06 落地,不要改回去)

| 端口 | 角色 | 进程 | 谁在管 |
|------|------|------|--------|
| **5544** | **vite dev server (HMR)** | vite 8,`strictPort: true` 占死 5544 | `zen-vite` (launch.json) |
| **5545** | **backend (Express + Socket.IO)** | nodemon + `cross-env PORT=5545` | `zen-backend` (launch.json) |

**为什么必须分两个端口**
- preview 工具(`preview_start`)只问 `launch.json` 里 `port: 5544` 这一个端口拿响应,不知道 vite 漂到哪
- `strictPort: false` 时 vite 占不到 5544 会顺延到 5545+,preview 工具拿不到 HMR 页面
- backend 写到 `.port` 和 `src/ui/client/.env.local`,vite.config 读这两个文件拿真实 backend 端口做 proxy
- 链路闭环:vite(5544) ←proxy→ backend(5545),前端 fetch `/api/*` 由 vite 转发

**踩过的坑(为什么 strictPort: true)**
- `strictPort: false` 时 vite 漂到 5545,preview 工具抓 5544 拿到的是后端托管的 `vite build` 产物,改前端代码 reload 不会更新
- 用户看到的是"DOM 没变" → 误判 HMR 失败 → 反复 touch 文件 / 切端口,实际是 vite 漂走了
- 修复后 vite 抢 5544,占不到就**直接报错**(不是静默顺延),问题一目了然

## 启动顺序(强约束,本仓库任何 session 起 preview 都按这个走)

1. **先启 backend** — `preview_start("zen-backend")`
   - 必须等 `.port` 文件被 backend 写好(内容 `5545`),否则 vite 启动时拿不到后端端口
   - 标志: `npm run dev:ping` 显示 `backend 127.0.0.1:5545/api/app-version` = `[ OK ]`
2. **再启 vite** — `preview_start("zen-vite")`
   - 标志: `npm run dev:ping` 显示 `vite 127.0.0.1:5544/@vite/client` = `[ OK ]`
3. **验证 HMR 链路** — 改一个前端文件(随便加个 `console.log`),`preview_logs("zen-vite")` 应该看到 `hmr update /path/to/file`

**反模式**
- ❌ 单独启 `zen-vite` 不启 `zen-backend` — vite.config 读不到 `.port`,proxy 落回默认 3000,所有 `/api/*` 全 ECONNREFUSED
- ❌ 把 backend 改回占 5544 — vite strictPort 立刻报错
- ❌ 把 vite strictPort 改回 `false` — vite 漂走,preview 工具抓不到 HMR,白等

## 改了 4 个文件,不要再退回去

| 文件 | 改动 | 目的 |
|------|------|------|
| `.claude/launch.json` | 拆成 `zen-vite` (5544) + `zen-backend` (5545) 两个 server,`autoPort: false` 强制端口 | preview 工具能精确知道两条线分别在哪个端口 |
| `package.json` | `dev:server` 用 `cross-env PORT=5545` 跨平台;新增 `dev:vue` 单独启 vite;`dev` 用 concurrently 加 `-n backend,vite` 染色 | 兼容 Windows / Mac / Linux;`npm run dev` 整体也能跑通 |
| `src/ui/client/vite.config.ts` | `strictPort: true` | 端口被占直接报错,不再静默顺延(就是"DOM 没变"伪故障的根因) |
| `package.json` (devDeps) | 新增 `cross-env` | Windows cmd 不支持 `PORT=5545 xxx` 风格,跨平台必须用 cross-env |

## 排错快速对照表

| 现象 | 大概率原因 | 验证 |
|------|-----------|------|
| `dev:ping` vite DOWN,backend OK | 忘了启 `zen-vite`,只启了 `zen-backend` | `preview_start("zen-vite")` |
| `dev:ping` backend DOWN,vite OK | 忘了启 `zen-backend`,只启了 `zen-vite` | `preview_start("zen-backend")` |
| 浏览器打开 5544 看到的是生产 bundle(无 HMR 提示) | preview 工具没真在 5544,可能漂到 50333 等 | `netstat -ano \| grep ":5544" LISTENING` 必须是 `127.0.0.1:5544` |
| `/api/*` 全 ECONNREFUSED | backend 没启,vite proxy 找不到 5545 | `curl http://127.0.0.1:5545/api/app-version` 应该是 200 |
| 改前端代码无 HMR 提示 | 走的是 bundle 不是 vite | `curl http://127.0.0.1:5544/ \| grep "@vite/client"` 必须有 |

## 自动验证命令(起完双 server 后跑一遍)

```bash
npm run dev:ping
# 期望:
#   [  OK  ]  backend  127.0.0.1:5545/api/app-version
#   [  OK  ]  vite     127.0.0.1:5544/@vite/client
#   一切正常,可以开始改前端代码。

curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5544/@vite/client   # → 200
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5545/api/app-version  # → 200
curl -s http://127.0.0.1:5544/ | grep "@vite/client"   # 必须命中
```
