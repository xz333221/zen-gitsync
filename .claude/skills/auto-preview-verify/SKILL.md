---
name: auto-preview-verify
description: zen-gitsync 专属前端代码自动浏览器验证 skill。改完任何前端代码(`.vue` / `.ts` / `.tsx` / 前端目录 `.js` / CSS)后,自动起 preview 工具、按 dev-server-diagnostics 步骤 0a 判定链路、按 hmr-debug-check 5 步清单跑可视化验证、截图存证。preview 路径走不通时退化为 `vite build` + reload,不阻塞 commit。适用触发词:浏览器验证、preview 验证、auto preview、自己验证、起一下 preview。
---

# 前端改动自动浏览器验证流程

## 触发时机

**当本轮对话修改了前端代码**,且 auto-validate 通过后,自动执行本 skill。不需要用户主动说"帮我验证"。

修改范围(满足任一即触发):
- `.vue` / `.ts` / `.tsx` 文件
- 前端目录下的 `.js`(src/ui/client/**)
- `.css` / `.scss` / `<style>` 块

**不触发**:
- 只改 `.md` / `.json` / `.yaml` / `.txt` / 纯后端文件
- 纯类型/接口调整,无可视化影响
- 用户明确说"不用浏览器验证"

---

## 步骤 1 — 决定 preview 路径(关键判定)

在起 preview 之前先做一件事 — **判定本轮要走 vite HMR 还是 vite build 路径**。

读取 `package.json` 的 scripts:

- 有 `dev` 用 concurrently 启多个进程 → preview 启的 server 大概率走 backend 静态资源(参见 dev-server-diagnostics 步骤 0a),需要 build 路径
- 有单独的 `dev:client` / `start:vue` → preview 可能真的命中 vite
- 都不确定 → **先按步骤 2 起 preview,然后跑步骤 0a 判定,再决定走哪条**

> 经验:本仓库 `npm run dev` 是 concurrently 启 backend + vite,preview 启起来后浏览器通常加载的是 backend 的生产 bundle(`/assets/index-xxx.js`),不走 HMR。这条已写入 dev-server-diagnostics,本 skill 直接引用。

---

## 步骤 2 — 起 preview

```bash
# 检查 launch.json
ls .claude/launch.json
```

如果没有 → 提示用户创建,或临时起 `npm run dev` 用 `run_in_background` 启后手动校验。

如果有 → `preview_start(name)`,从返回的 `serverId` 拿到 `port`,记录下来。

---

## 步骤 3 — 链路判定(必跑)

按 dev-server-diagnostics 步骤 0a 跑:

```js
// preview_eval
Array.from(document.querySelectorAll('script[src], link[href]'))
  .map(e => (e.src || e.href))
  .filter(u => u.includes('/assets/') || u.includes('@vite') || u.includes('client'))
```

判定结果分流:

| 看到 | 结论 | 下一步 |
|------|------|--------|
| `/assets/index-xxx.js`(带 hash) | 走的是 backend 生产 bundle | **走 build 路径**(步骤 4b) |
| `/@vite/client` 或 `/src/main.ts`(无 hash) | 走的是 vite dev server | **走 HMR 路径**(步骤 4a) |
| 两者都看不到 | preview 起得不完整 | 重启 preview 一次,再判定 |

---

## 步骤 4a — HMR 路径验证(优先)

链路是 vite 时:

1. **不要 reload**(HMR 会自动推送)
2. 用 `preview_eval` 拉目标元素的 `outerHTML`,确认改动已经出现在 DOM
3. 改之前给目标分支加 `data-debug="xxx"` 锚点,改完 `document.querySelector('[data-debug="..."]')` 定位,防看错(参见 hmr-debug-check.md 步骤 3)
4. 用 `preview_inspect` 核对关键 CSS(背景色 / 高度 / 动画)
5. 用 `preview_screenshot` 截图存证

如果改动没出现在 DOM:
- 检查 preview_logs 有没有 `hmr update`(注意:preview_logs 大概率抓的是后端,不是 vite,看不到就走 build 路径)
- 检查 Network 该 chunk 是 200 不是 304
- 还是看不到 → 退到步骤 4b

---

## 步骤 4b — Build 路径验证(降级方案)

链路是生产 bundle 或 HMR 不通时:

```bash
cd src/ui/client && npx vite build
```

产物写到 `src/ui/public/assets/`,然后:

```js
// preview_eval
window.location.reload()
```

reload 后再走一遍步骤 4a 的 1-5 步检查。注意:
- build 一次约 1 分多钟,**只在 dev server 链路不通时用**
- 如果走 build 路径,**必须 reload 浏览器**,build 产物本身不会自动推送

---

## 步骤 5 — 验证完整后清理

如果改之前加了 `data-debug` 锚点,**必须删掉**(commit 前不要留 debug 标记):

```bash
# preview_eval
document.querySelectorAll('[data-debug]').forEach(el => {
  console.log('debug anchor:', el.tagName, el.className)
})
```

检查输出,确认全部是要清理的临时标记,然后用 Edit 删。

---

## 步骤 6 — 失败处理

### preview 完全起不来

```bash
# 看 preview_start 是不是直接报错
# 看 launch.json 里的 command 能不能直接 shell 跑通
```

如果 shell 跑也不通 → 退化为 build 路径(步骤 4b),但 build 也失败 → **告诉用户**,不阻塞 commit:

```
⚠️ 前端验证失败:preview 起不来 + vite build 也报错(<错误摘要>)
降级处理:仅 TSC + i18n 验证已通过,提交时由用户决定是否合并。
```

### preview 起得了但浏览器跑不通

按 dev-server-diagnostics 走诊断流程,不再赘述。

---

## 步骤 7 — 输出格式

验证完成时,**一两句**告诉用户结果:

```
✅ 浏览器验证通过(走 vite HMR):模型返回区撑满 ⛶ 全屏按钮可点击
[截图](路径)
```

或失败时:

```
❌ 浏览器验证失败:.wb-log-pre 实际高度 600px,未撑满父容器
```

**不要**复述整个验证流程,用户在 preview 工具里能直接看到。

---

## 不要做的事

| 误操作 | 为什么错 |
|--------|----------|
| 改完代码直接 commit,不跑浏览器验证 | 这是本 skill 存在的全部理由 |
| 用 `run_in_background` 起 npm run dev 然后忘掉 | 后台进程用户看不到日志,出问题排查困难 |
| 看到 preview "started successfully" 就以为 vite 在跑 | preview wrapper ≠ vite,必须看步骤 3 的链路判定 |
| preview 路径走不通就反复重启同一个 serverId | preview serverId 复用,start 不会真重启 dev 进程 |
| 走 build 路径但忘了 reload | backend 拿新 chunk 需要 reload,build 产物不会自动推送 |
| 留 `data-debug` 锚点到 commit | debug 标记不应该污染生产代码 |
| 验证失败但为了 commit 进度强行标"通过" | 失败就是失败,告诉用户,由用户决定是否合并 |
| 不区分 HMR/build 路径,统一用 build | build 慢,能 HMR 就 HMR |

---

## 与其他 skill 的关系

- **auto-validate**:本 skill 在它**之后**执行(auto-validate 失败不进入 preview)
- **hmr-debug-check.md**(rules):本 skill 步骤 4a/4b 直接引用它的 5 步清单
- **dev-server-diagnostics**:本 skill 步骤 3 直接引用它的步骤 0a
- **auto-capture-lessons**:本 skill 走完后如果踩了新坑,再触发它沉淀经验