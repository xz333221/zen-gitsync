---
name: dev-server-diagnostics
description: zen-gitsync 专属前端 dev server 诊断 skill。当用户反馈"改完代码浏览器没变 / HMR 不工作 / reload 后还是旧的 / DOM 没刷新"时调用,按概率从高到低排查:preview 走的不是 vite 而 backend 生产 bundle(最新踩坑) > dev:ping 报 vite DOWN 但 vite 漂到 5545 等其他端口(端口被占) > preview 改写 .port 导致 vite proxy 找不到 backend > dev server 没启 > 看错元素 > HMR 边界问题。优先用 `npm run dev:ping` 一键判断 vite 状态(注意它只探 5544),不要等"DOM 没变"了再回头查 dev server。**承认 preview 工具能力有限**——陷在"preview_eval 看不到新加 DOM"超过 3 分钟应改走 build 验证或交用户肉眼确认。适用触发词:HMR 不工作、刷新没生效、DOM 没变、dev server 死了、vite 没起、reload 无效、改了没生效、preview 没生效、preview 加载的是旧版、preview_eval 看不到。
---

# 前端 dev server 诊断流程

## 触发时机

**仅当本轮对话涉及浏览器验证前端改动**且**用户反馈/Codex 自己观察到"改了代码浏览器没生效"时**调用。

判断标准:
- 用户主动说 "HMR 不工作 / 改了没生效 / reload 没变"
- Codex 自己改了前端代码后,`preview_eval` 拉目标元素 DOM 发现没有预期改动
- 不是触发条件:用户没说、Vue/JS 编译错误(走 auto-validate)、纯终端验证(无浏览器)

---

## 步骤 0a — 先看 preview 浏览器加载的是 vite 还是 backend 静态资源（这次踩坑的根因）

**在跑任何探测脚本、看任何 HMR 日志之前先做这一步**。

```js
// preview_eval:
Array.from(document.querySelectorAll('script[src], link[href]'))
  .map(e => (e.src || e.href))
  .filter(u => u.includes('/assets/') || u.includes('@vite') || u.includes('client'))
```

判定:
- 看到 `/assets/index-xxx.js`、`/assets/WorkbenchView-xxx.js`(带 hash) → **加载的是 backend 的生产 bundle**,不走 vite HMR。preview 启的 `npm run dev` 用 concurrently 启了 backend + vite,但浏览器实际命中的是 backend 的静态目录(`src/ui/public/`),vite 端口虽然起着但没被这条链路用到。**改完代码 reload 看不到任何变化**,因为 backend 还在返回旧的构建产物。
- 看到 `/@vite/client`、`/src/main.ts` 这类无 hash 路径 → 走的是 vite dev server,HMR 才有可能生效。

走生产 bundle 时的正确做法:
- 直接 `cd src/ui/client && npx vite build`(产物写到 `src/ui/public/`,backend 立刻拿到)
- reload 一次浏览器
- **不要**去看 vite stdout / `preview_logs` / `preview_network` 找 hmr update —— 你找也找不到,因为根本没走 vite
- **不要**反复 `preview_stop` + `preview_start`,preview 的 serverId 复用,start 不会真的重启 dev 进程

为什么放最前面:dev:ping 在这种场景下可能显示 vite OK(because vite 端口确实在跑),让人误以为 HMR 链路通,继续走步骤 1-5 全是白做。本仓库 preview + concurrently 链路最容易踩这个坑。

## 步骤 0 — 一键探测 dev server 状态（先做这个,再做任何排查）

```bash
npm run dev:ping
```

输出形如:

```
dev server status:
  [  OK  ]  backend  127.0.0.1:4065/api/app-version
  [  OK  ]  vite     127.0.0.1:5544/@vite/client
```

判定:
- 两者都 `[ OK ]` → dev server 活着,问题在 HMR / 浏览器侧,继续步骤 1
- 任何一个 `[ DOWN ]` → **dev server 没启,问题不在你改的代码上**。停下来告诉用户:
  - backend DOWN → 提示 `npm run dev:server`
  - vite DOWN → 提示 `npm run start:vue` 或整体 `npm run dev`
  - **不要**去 touch 文件、不要去查 stdout、不要去 reload,这一切都是白做

脚本不存在或不可用时退化为:

```bash
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5544/@vite/client
```

返回 200 = vite 在跑。

**dev:ping 报 vite DOWN 但 vite 实际在跑(端口被占导致漂移)的处理**:
- dev:ping 默认只探 5544;本项目 `start:vue` 在 5544 被占时会自动漂到 5545、5546……
- 若 dev:ping 报 vite DOWN,**先**用 `netstat -ano | grep ":554[0-9]"` 看实际监听端口,或循环 `curl` 5544/5545/5546 的 `/@vite/client`
- 命中 200 的端口就是真实 vite 端口,**改 `cat .port` 看 backend port 是否对齐**(vibe 启动脚本会写 .port 给 vite proxy 用)
- 不要因为 dev:ping DOWN 就以为 vite 死了,直接 reload+改代码可能拿不到新 chunk,但**根本原因不是 vite 没起,而是 vite 端口和 dev:ping 默认端口对不上**

**为什么这是步骤 0 而不是步骤 1**:本仓库曾因 vite 没起来改了 5 轮代码、reload 4 次,最后才发现 dev server 整个就没在跑。preview 工具的 "started successfully" 只代表 wrapper 进程跑了,不等于 vite 在跑。**也**曾因 dev:ping 误报 vite DOWN、跳过 vite、回头改代码,实际 vite 在 5545 一直跑着、只是没被 ping 到。

---

## 步骤 1 — 看 dev server stdout 有没有 hmr update

`preview_logs` 经常抓的是 concurrently 启的后端进程,看不到 vite 的输出。直接看 vite stdout 才有意义:

```bash
# 找到 vite 进程的日志(通常在终端 / 启动 dev 时那个窗口)
```

找 `hmr update /path/to/file` 或 `[vite] hot updated`。**没看到 = dev server 没收到改动**:
- 文件保存了吗?(编辑工具成功返回 ≠ 磁盘写入,看 mtime)
- 文件被 .gitignore 屏蔽了?
- watch 路径包含文件吗?(Vite chokidar 监听 src/ui/client)

---

## 步骤 2 — 看 Network 的 chunk hash

在 preview 工具里:`preview_network` 查改动的文件 / main entry:

- 必须是 **200**(不是 304)
- hash 必须和上次不同(改一行 CSS 不应该返回完全相同的 chunk)

304 = 浏览器用了缓存,没拿到新模块。处理:`preview_eval` 跑 `location.reload(true)` 强刷。

---

## 步骤 3 — 看目标元素的 runtime DOM（不要看 snapshot 文本）

**最高频的伪故障是看错元素**。`preview_snapshot` 的文本会截断、和实际 DOM 不完全等价。

```js
// 用 preview_eval 拉目标元素的实际 DOM
const el = document.querySelector('.wb-execution-body')
return el.outerHTML
```

判定:
- 改动的 class / 属性 / 文字必须出现在 `outerHTML` 里
- **没出现 = 看的不是目标元素**,先确认 `isSimpleTask` / `selectedTask.type` 这类条件分支,再怀疑工具链

防"看错"的小技巧:
- 改之前在目标分支容器加临时 `data-debug="xxx"` 锚点
- 同文件改了两个相似分支,**分别**验证两条路径的状态,不要只验一条

---

## 步骤 4 — 看 computed style（怀疑 CSS 没生效时）

```js
getComputedStyle(el).background
```

CSS 改完类名加对了但样式没变,通常是:
- SCSS 变量没定义
- 样式被 `scoped` 卡住,引用到了子组件
- 写在了 `@media` 查询之外

---

## 步骤 5 — 截图存证

`preview_screenshot` 截一张图,视觉变化一眼可见才算验证完成。

## 备用:绕开 dev server 验证（不推荐,先看 0a）

如果步骤 0a 判定走的是 backend 生产 bundle,可以直接 `npx vite build` 让 backend 拿到新 chunk:

```bash
cd src/ui/client && npx vite build
```

构建产物会写到 `src/ui/public/assets/`,用 grep 确认改动进了对应 chunk:

```bash
grep -l "新加的类名" src/ui/public/assets/WorkbenchView-*.js
```

然后 reload 浏览器让 backend 用新 chunk。注意:
- 这是**降级方案**,build 一次 1 分多钟
- 能修好 vite HMR 链路就尽量别用 build 验证(改了不用 reload 就能看到效果)
- 走 build 路线的话,**修改后必须 rebuild + reload**,不能像 HMR 那样自动更新

## 不要做的事（按踩坑频率排）

| 误操作 | 为什么错 |
|--------|----------|
| preview 起来直接改代码等 HMR,不看 0a 判定 | 走的是 backend 生产 bundle 的话,HMR 永远不会推送;看完 0a 才知道该走 build 路径 |
| dev:ping 报 vite DOWN 就以为 vite 死了、跳过 vite 操作 | vite 可能因端口被占漂到 5545/5546,dev:ping 默认只探 5544。先用 `netstat -ano` 或循环 curl 多端口确认 |
| `touch` 文件指望"触发 watcher" | Vite chokidar 已经监听文件写入,这一步说明 dev server 已经死了,先解决 dev server |
| `preview_stop` + `preview_start` 反复重启 | preview 工具的 serverId 是复用的,start 不会真的重启 dev 进程;要重启用 shell |
| 在 `preview_logs` 里找 HMR 输出 | `npm run dev` 用 concurrently 启多进程,preview 工具只抓其中一个进程的 stdout,大概率是后端 |
| 改完代码直接 reload 没看 Network hash | 304 = 浏览器用缓存,reload 也拿不到新模块;或更根本的:走的是生产 bundle,reload 拿到的还是旧构建产物 |
| 反复改代码等下次"也许就生效了" | 步骤 0a 已经告诉你走的是生产 bundle,改再多也没用,直接 build |
| dev:ping 显示 OK 就以为 HMR 通 | dev:ping 只检查端口监听,不看浏览器实际请求落到哪个 server。本仓库 preview + concurrently 链路下 vite OK 不代表浏览器走了 vite |
| `preview_eval` 里 `fetch('/src/...')` 拿 vite 源文件做断言 | preview 工具的页面跑在它分配的 wrapper 端口(如 7606/4937),`fetch('/src/...')` 命中 wrapper,不是 vite 5545。**这条返回 404 不代表 vite 编译产物不对**。要看 vite 编译产物,直接在 shell `curl http://localhost:5545/src/...`,或用 `preview_network` 看实际请求 |
| 陷在"preview_eval 看不到我加的 DOM"的死循环超过 3 分钟 | preview 工具内部渲染状态可能与 vite 不一致(改写 `.port`、wrapper 进程缓存、teleport 行为等)。**承认限制**后选择:(a) 走 `npx vite build` 验证(写到 `src/ui/public/assets/`,grep 类名/字符串确认进 bundle);(b) 告知用户自己 reload 看效果。不要在 preview 里反复改 toggle、加 hardcode、改 key 试图"逼出来" |
| preview 改写 `.port` 导致 vite proxy 找不到 backend | preview 工具会把它分配的 wrapper 端口写入 `.port`,vite 启动脚本读 `.port` 配置 proxy 后端。如果看到工作台任务列表空、API 调用 500,先看 `.port` 内容、用 `cat .port > 真后端端口` 修复 |
