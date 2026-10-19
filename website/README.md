# zen-gitsync 官网

zen-gitsync 的官方网站首页,单页,Vue 3 + Vite,纯手写 CSS(design tokens)。
文案与功能点全部来自仓库里的真实资料:`docs/手写版介绍文章.md`、`README.md`、`package.json`。

## 设计基调(taste-skill)

**Design read**:开发者工具落地页,面向独立开发者与小团队,terminal-native 语言
(深炭黑 + 单一品牌蓝 + 等宽字体承载数据),基础是 native CSS tokens + 自托管字体 + 克制的进场动效,
主视觉只用产品真实截图。

**三旋钮**:`DESIGN_VARIANCE 7 / MOTION_INTENSITY 5 / VISUAL_DENSITY 4`。

关键约束(改版时请保持):

- **主题锁定 dark**。整页一个主题,没有中途反色段落;产品界面与截图本身也是深色。
- **单一强调色** `#3b82f6`(取自产品 `--color-primary`),全站同一个 accent,按钮上的文字用深色保证 4.5:1 对比。
- **一套圆角系统**(`--r-1 / --r-2 / --r-3`),卡片、按钮、截图框都从这里取,不临时写值。
- **字体自托管**:Plus Jakarta Sans(界面)+ JetBrains Mono(命令与数据),来自 `src/ui/client/public/fonts`,
  与产品 UI 同源,不走 Google Fonts 外链。
- **不伪造 UI**:页面里的产品画面都是 `docs/screenshots/` 下的真实截图;终端区域只逐字打出工具真实存在的命令,
  不编造命令输出。
- **不编造数字**:GitHub star 数读公开 API,拿不到就不显示;页脚版本号从主包 `package.json` 注入。
- **动效有理由**:逐字打字(讲清三个入口)、区块进场(引导阅读顺序)、hover 反馈。
  全部包在 `prefers-reduced-motion` 里;脚本未就绪时内容照常可见(`html.js-ready` 门控)。
- **零 em-dash**、无装饰状态点、无滚动提示、无「三列等宽卡片」,区块左右交替以避免连续同向布局。

## 目录

```
website/
  index.html                 入口(标题 / description / OG)
  docs.html                  文档页入口(与 index.html 同为多页输入,见 vite.config.js)
  vite.config.js             注入版本号、base 用相对路径、双页面 input
  public/
    fonts/                   自托管字体(与产品同源)
    logo.svg favicon.svg     品牌图形(取自 src/ui/client/public)
    shots/                   产品截图(由 docs/ 同步,见下)
  scripts/
    sync-shots.mjs           从仓库 docs/ 同步截图与字体到 public/
    shoot.mjs                构建产物起静态服务 + Playwright 三端截图自检(落地页 + 文档页)
  src/
    main.js App.vue          落地页
    docs/
      main.js                文档页入口
      DocsApp.vue            文档页布局(侧栏目录 + 正文)
      InlineCode.vue         文本里 `代码` 片段的渲染(反引号切分,不走 v-html)
    styles/tokens.css        设计令牌(色 / 形 / 字 / 动效节奏)
    styles/base.css          字体、重置、版式、按钮、进场动效
    data/site.js             链接、命令、截图路径(全站唯一事实来源)
    data/docs.js             文档页内容(按板块分篇,文案与主 README 一致)
    composables/             v-reveal 指令、GitHub star 读取、scrollspy(文档侧栏高亮)
    components/              各区块组件
```

## 开发与构建

```bash
cd website
npm install          # 首次
npm run dev          # 开发服务器 http://localhost:5273
npm run build        # 产出 dist/(纯静态,可直接托管)
npm run preview      # 本地预览构建产物
```

`base` 是相对的,同一份 `dist/` 放域名根目录或 `/zen-gitsync/` 这类子路径都能跑。

### 文档页

`docs.html` 是第二个页面(与 `index.html` 一起作为多页输入构建),按界面板块逐篇介绍功能,
内容全在 `src/data/docs.js`(改文案只动这一个文件)。两处入口:

- 落地页顶栏「文档」→ `./docs.html`
- 文档页顶栏「返回首页」→ `index.html`

页面间用相对路径互链,子路径部署同样成立。文档页侧栏高亮走
`src/composables/useScrollSpy.js`(IntersectionObserver),窄屏时侧栏收成横向 chips。

### 更新产品截图

截图不手工拷贝,统一从主仓库同步:

```bash
node scripts/sync-shots.mjs      # 或 npm run sync:assets
```

它会把 `docs/screenshots/手写版介绍文章图片/` 下的 7 张图改名同步到 `public/shots/`,
并同步字体与品牌图形。换图后重新构建即可。

### 视觉自检

```bash
npm run build && node scripts/shoot.mjs
```

用主项目 `src/ui/client` 里已装的 Playwright 打开构建产物,在桌面 / 平板 / 手机三个宽度
整页截图到 `website/tmp-shots/`,同时打印控制台报错与失败请求。改动 UI 后建议跑一次,
肉眼过一遍截图再提交。

## 部署

`npm run build` 之后把 `website/dist/` 整个目录丢给任意静态托管即可(阿里云 OSS、Vercel、
Netlify、GitHub Pages 都行)。没有服务端逻辑,没有环境变量。
