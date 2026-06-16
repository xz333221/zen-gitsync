# 浏览器验证 HMR 生效的 5 步检查清单

改完前端代码进浏览器验证时,DOM 看起来"没变"是最常见的伪故障。
**核心反模式:没看清目标元素就跳到工具链找原因**(本仓库曾因误判 HMR 失败反复 touch 文件 / 切端口 / 重启 preview server,实际是看错了另一条未改的分支)。

## 规则

按顺序执行。任何一步失败,先定位到这一步,不要跳到下一步找原因:

1. **看 dev server stdout** — 必须看到 `hmr update /path/to/file`(或 vite `[vite] hot updated`、webpack `[WDS] Hot Module Replacement`)。**没看到 = dev server 没收到改动**,先检查文件保存、watcher 路径、.gitignore 是否把文件屏蔽。
2. **看 Network** — 该文件的 JS/CSS chunk 必须是 **200**(不是 304),且 hash 必须和上次不同。304 = 浏览器用缓存,没拿到新模块。
3. **看目标元素的 runtime DOM** — 用 `preview_eval` 拉 `outerHTML` / `className` / `style`,而不是 `preview_snapshot`(snapshot 文本会截断且与实际 DOM 不完全等价)。
   改动的 class、属性、文字必须出现在 DOM 里。**没出现 = 看的不是目标元素,先确认路径分支再怀疑工具链。**
4. **看 computed style** — 关键 CSS 属性(`background` / `border` / `width` / `animation`)用 `preview_inspect` 或 `getComputedStyle` 核对。
5. **截图存证** — 视觉变化一眼可见才算验证完成。

## DOM 没变时,先排除"看错元素"再怀疑工具链

HMR 失败的 3 个真实原因按概率排序:

| 概率 | 原因 | 验证方法 |
|------|------|---------|
| **50%** | **看错 DOM 路径** | `eval` 拉目标元素的 outerHTML,确认 class/属性就是改的那条 |
| 30%   | dev server 真的死了 / watcher 没监听 | 重启 dev server,或 `touch` 文件看 stdout 有没有 hmr update |
| 20%   | HMR 边界出错 → 整页 fallback 但旧模块缓存 | hard reload + 禁 cache,或 `localStorage.clear()` 后重启 |

**默认假设是 50%**。先做 "是不是看错" 的判断,再去看 dev server。

## 防"看错"的两个小护栏

- 改之前先标锚点 — 在改动的模板分支容器加临时属性,例如:
  ```html
  <template v-else>
    <div data-debug="simple-task-row">  <!-- 我改的分支 -->
  ```
  验证时 `document.querySelector('[data-debug="simple-task-row"]')` 一秒定位目标元素,不会看错分支。**commit 前删掉**。
- 同一文件改了两个相似分支(例:子任务列表 + simple 任务详情),**分别**在浏览器触发两条路径的状态(例:idle / running),不要只验一条就下结论。

## 不要做的事

- 不要 `touch` 文件指望它"触发 watcher" — Vite 的 chokidar 已经监听文件写入,这一步说明 dev server 已经死了。
- 不要 `preview_stop` + `preview_start` 反复重启同一个 server — preview 工具的 serverId 是复用的,start 不会真的重启 dev 进程;要重启就用 shell。
- 不要在 `preview_logs` 里找 HMR 输出 — `npm run dev` 用 concurrently 启多进程,preview 工具只抓其中一个进程的 stdout,大概率是抓的 backend 而不是 vite。直接 `curl` 命中端口看 HTML 头部有没有 `/@vite/client` 来判断 vite 是不是真的活。

## 不需要执行的情况

- 没改前端代码(只改 .md / .json / .yaml / .txt)
- 只在终端验证(TSC / 单元测试),没进浏览器