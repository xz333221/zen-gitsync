/** 文档页内容:全站唯一事实来源,文案与 README.md 保持一致。
 *  块类型:
 *  - text   段落(支持 `代码` 行内标记)
 *  - list   功能条目 [{ term, desc }]
 *  - cmds   命令行 [{ cmd, note }](走 CopyChip)
 *  - table  表格 { head: [], rows: [[]] }
 *  - note   补充说明
 *  每个板块可带 shots:[{ src, alt, caption, paper }] —— paper 用于浅色画布截图
 *  (贴在暗色页面上像"一张纸",与官网思维导图截图同一处理)。
 */

import { asset } from './site.js'

export const DOCS = [
  {
    id: 'start',
    title: '快速开始',
    lede: '一条安装命令,四个入口。Node.js 20.19 及以上,Windows / macOS / Linux 一致。',
    shots: [
      {
        src: asset('shots/cli-quick-commit.png'),
        alt: '终端里敲一个 g,完成暂存、提交、推送',
        caption: '终端:一个 g 走完暂存 → 提交 → 推送'
      }
    ],
    blocks: [
      {
        type: 'cmds',
        rows: [
          { cmd: 'npm i -g zen-gitsync', note: '全局安装' },
          { cmd: 'g', note: '在任意 Git 仓库里交互式提交并推送' },
          { cmd: 'g ui', note: '打开浏览器里的图形界面(4000–6000 自动挑端口)' },
          { cmd: 'g ai', note: '终端里直接和内置智能体对话;没配模型会先跑配置向导' }
        ]
      },
      {
        type: 'list',
        items: [
          { term: 'g ui', desc: '本地 Web 服务,自动附加到当前 Git 仓库;默认只听 127.0.0.1,跨机访问用 ZEN_HOST 显式放开' },
          { term: 'g ai', desc: '交互式 REPL,也支持单发模式 g ai "修复失败的测试";与 Web 端会话落同一份目录,互为可见' },
          { term: '配置位置', desc: '模型、任务、提示词等都在 ~/.zen-gitsync/,跨项目共享' }
        ]
      }
    ]
  },
  {
    id: 'git',
    title: 'Git 面板',
    lede: '打开就是总览:改了什么 → 要提交什么 → 已经提交了什么,同一屏,不切 tab。',
    shots: [
      {
        src: asset('shots/git-commit-view.png'),
        alt: 'Git 面板:左侧文件改动列表,右侧 diff 与提交区',
        caption: 'Git 总览页:改动、diff、提交区在同一屏'
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '文件列表', desc: '按已暂存 / 未暂存 / 未追踪 / 冲突分组,git add -N 的意向添加文件单独成组;平铺与目录树两种视图,持久化' },
          { term: '选择模式', desc: '多选文件后,一键提交 / 一键推送与 AI 生成提交信息自动只作用于选中文件(按钮文案随之切换)' },
          { term: '结构化提交表单', desc: '类型 / 范围 / 描述 / 正文 / 页脚,自动组合成 Conventional Commits;也可切自由文本模式' },
          { term: 'AI 生成提交信息', desc: '基于 staged diff 让模型写提交信息,自动填进表单' },
          { term: 'AI 提交并推送', desc: '一键跑完 生成 → 暂存 → 提交 → 推送;本地已提交只差推送时跳过 AI 直接推' },
          { term: '推送', desc: '实时进度弹窗;多远程时可选择指定远程或一键推全部(逐条出结果)' },
          { term: '拉取 / 重置', desc: 'pull / fetch,以及一键 git reset --hard origin/<分支>(点前先刷新分支信息,避免重置到陈旧分支)' },
          { term: '合并', desc: '合并其他分支,自动检测并引导处理合并中间状态' },
          { term: '差异视图', desc: 'Monaco 并排 diff;差异下方可展开预览:html / svg 走沙箱 iframe,md 走渲染,Office 文档走服务端转换' },
          { term: '提交历史', desc: '作者、时间、分支标签、变更文件一览' },
          { term: '导航徽标', desc: '左侧 Git 图标直接带数字:未提交文件数 + 当前分支领先 / 落后(落后橙、领先绿、分叉红)' }
        ]
      }
    ]
  },
  {
    id: 'repos',
    title: '仓库浏览器',
    lede: 'GitHub / Gitee 两个 tab,列出 CLI 账号下能看到的全部仓库(含私有)。全程不碰你的令牌——调用的是官方 gh / gitee CLI,凭据由 CLI 自己保管。',
    shots: [
      {
        src: asset('shots/repo-browser-dark.png'),
        alt: 'GitHub 仓库页:账号下的仓库卡片网格',
        caption: 'GitHub 仓库:已登录账号下的全部仓库,可搜索、分组、排序'
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '零配置引导', desc: '没装 CLI 给安装命令、一键安装;装了没登录给登录命令、一键登录后轮询等你走完交互流程' },
          { term: '搜索 / 排序 / 分组', desc: '按名称、路径、描述过滤;最近推送 / 最近创建 / 星标最多 / 仓库名排序;默认按工作空间分组,组头带仓库数' },
          { term: '切 tab 不重拉', desc: '列表按账号缓存,切回来即时渲染;缓存超一分钟先用旧数据画、后台静默刷新' },
          { term: '克隆到文件夹', desc: '本地没有的仓库直接克隆,走 SSH 形式(git@github.com:owner/repo.git),https 地址先归一化,不会卡在凭据弹窗' },
          { term: '「已克隆」徽标', desc: '服务端维护全盘本地仓库索引:已有的仓库标出本地路径,克隆到多处时显示计数,tooltip 列全部路径,Ctrl 点击挑一处用 g ui 打开' }
        ]
      }
    ]
  },
  {
    id: 'branches',
    title: '分支 / 远端 / Stash / Tag',
    lede: '四类日常 Git 管理,都在同一个界面里,不用回终端。',
    shots: [
      {
        src: asset('shots/branch-selector-dark.png'),
        alt: '顶栏分支下拉:本地与远程分支列表',
        caption: '分支下拉:本地 / 远程分支一览,可直接切换'
      },
      {
        src: asset('shots/remote-manage-dark.png'),
        alt: '远程管理弹窗:多个远程与推送地址',
        caption: '远程管理:多远程、多推送地址,一个弹窗管完'
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '分支', desc: '查看本地与远程分支,从任意基础分支创建、切换,追踪上游领先 / 落后' },
          { term: '远端管理', desc: '一个弹窗管理任意多个远程:添加 / 重命名 / 改地址 / 删除;单个远程可配多个推送地址(GitHub + Gitee 双备),一键推全部;删除当前分支跟踪的远程时自动解除上游' },
          { term: 'Stash', desc: '自定义备注,可选包含未追踪文件、排除锁定文件;apply / pop / drop 单条操作' },
          { term: 'Tag', desc: '轻量或附注标签,可指定 commit;列出、推送、删除' },
          { term: '提交模板', desc: '类型 / 范围 / 描述 / 完整信息四类模板,提交时一键套用' }
        ]
      }
    ]
  },
  {
    id: 'console',
    title: '控制台',
    lede: '保存的命令 + 实时终端,左侧点一条命令就在右侧新会话里跑起来。',
    shots: [
      {
        src: asset('shots/console.png'),
        alt: '控制台:左侧自定义命令与定时提交,右侧终端会话',
        caption: '控制台:自定义命令、定时提交与终端会话',
        paper: true
      },
      {
        src: asset('shots/flow.png'),
        alt: '可视化编排工作台:画布与节点工具箱',
        caption: '可视化流程编排:拖拽画布,节点工具箱随手可取',
        paper: true
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '自定义命令', desc: '名称 + 命令 + 工作目录,支持 {{paramName}} 参数与默认值;可存模板,可逐条启用 / 禁用预排一组命令' },
          { term: '定时提交', desc: '按间隔自动 git add -A + git commit:间隔可选分钟 / 小时 / 天,可启动即提交一次;提交信息支持默认 / 自定义 / AI 生成;每次提交后可自动推送' },
          { term: '等效命令行', desc: '定时提交面板同步显示等效的 g 命令(如 g -y --interval=1800 --path="<目录>"),一键复制,终端里可复现同一套任务' },
          { term: '终端会话', desc: 'SSE 实时流式输出,多会话并行,运行中进程可逐个停止;Windows 用 cmd.exe,Unix 用 sh' },
          { term: '可视化流程编排', desc: '拖拽画布编排自动化流水线:命令 / 等待 / 版本管理 / 条件 / 用户确认 / 用户输入 / 代码节点,拓扑序执行,节点可逐个启停,流程可保存复用' },
          { term: '项目启动', desc: '配置打开项目时自动运行的命令或可视化流程,可拖拽排序、混合编排' }
        ]
      }
    ]
  },
  {
    id: 'editor',
    title: '编辑器(文件空间)',
    lede: 'Monaco 编辑器 + 文件树,不离开 GUI 就能浏览、编辑、预览项目文件。',
    shots: [
      {
        src: asset('shots/file-space.png'),
        alt: '文件空间:左侧文件树,右侧 Markdown 预览',
        caption: '文件空间:Markdown 预览与复制富文本'
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '文件树', desc: '文件类型图标,每 60 秒自动刷新捕获外部改动(标签页隐藏或搜索时跳过)' },
          { term: '搜索文件名或内容', desc: '名称命中走本地树过滤(180ms 防抖);名称没命中时把关键词送服务端扫文件内容:结果按文件平铺,带行号、片段高亮与命中数,点一条直接跳到对应行' },
          { term: '多标签编辑', desc: '同时开多个文件,未保存显示标记;Ctrl+S 保存,失焦自动保存默认开启' },
          { term: '跟盘同步', desc: '窗口聚焦、切 tab、切回视图时对账,另有 30 秒兜底轮询;无未保存改动就静默换新(光标与撤销栈保留),有则先问' },
          { term: '工作区恢复', desc: '按项目记住展开的目录与打开的标签,刷新 / 切回项目自动恢复' },
          { term: '预览', desc: 'md 切换源码 / 渲染预览;html 走应用内沙箱 iframe,也可右键交系统浏览器' },
          { term: '复制富文本', desc: 'Markdown 一键复制成带样式的富文本,粘到公众号一类平台不用重排' },
          { term: 'g ai 对话面板', desc: '编辑器右侧开一条对话,当前打开的文件即上下文;带引擎选择器(内置 g ai 或 Claude Code / OpenCode / Codex)' }
        ]
      }
    ]
  },
  {
    id: 'workbench',
    title: '工作台',
    lede: '多项目编排台:一块看板三栏——项目列表(含执行监控)、看板、主 Agent 控制台。每个任务独立进程、独立上下文。',
    shots: [
      {
        src: asset('shots/workbench-board.png'),
        alt: '工作台看板:项目列表、看板三列与主 Agent 控制台',
        caption: '工作台:项目列表、看板与主 Agent 控制台同屏'
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '看板', desc: '待处理 / 进行中 / 已完成三列,可切表格视图,可过滤「最近一次执行报错」;图片附件在卡片顶部画封面,点封面看大图可翻页' },
          { term: '进行中卡片', desc: '执行器品牌图标、已运行时长、工具调用次数与类型分布、最近思考、最新回复、静默多久,外加一条 AI 估计的进度条;悬停可直接停止' },
          { term: '跑完卡片', desc: '留下一小段智能体最后说的话(常以反问收尾的那句),执行器图标挂在摘录开头' },
          { term: '任务编辑器浮层', desc: '点卡片以浮层打开:提示词预置、执行器 split 按钮、附件(图片超 3.5MB 自动压缩)、「复制执行内容」把整条任务导出成 Markdown' },
          { term: '主 Agent 控制台', desc: '两种模式拨片切换:对话(直接和内置 g ai 聊,由它派活)与指令(你写一句话,落点由主 Agent 判断或遵你选中的项目);可配全局 + 按项目的派发默认提示词' },
          { term: '进度报告', desc: '主 Agent 读每个在跑 job 的时长 / 思考 / 工具分布 / 静默情况,写汇报并给整体与单任务进度估计;按 5–60 分钟间隔自动生成,标签页关着也攒历史' },
          { term: '静默收尾', desc: '静默超 10 分钟让主 Agent 判断是否已完成:判完成则落终态并标「AI 判定完成」(带依据);判据不足就什么都不做,最多问 3 次' },
          { term: '手动标记完成', desc: '待处理 / 进行中卡片可手动标完成(进行中的会先确认并停掉那一轮),手动标的可一键撤销;标记记在任务上,再跑一轮即作废' },
          { term: '执行器', desc: 'Claude Code / OpenCode / Codex,管道模式 detached 进程直连,输出流回 UI;续聊固定沿用初始执行器(--resume / --session / thread id)' },
          { term: '提示词预置', desc: '可复用模板,支持 {{task.title}} / {{task.desc}} / {{repo.path}} / {{branch}} 插值;AI 生成项目架构说明一键成稿' },
          { term: '跨轮记忆', desc: '每次派发告知智能体本机记忆库 ~/.zen-gitsync/memory/:只有索引进 prompt,正文按需读;收尾自检四问,该记的记一条' },
          { term: '结束提示', desc: '页面提示 / 浏览器通知 / 提示音三个独立开关;智能体提问时第三种音色,切窗也听得到' },
          { term: '本地工具检测', desc: '启动 + 每 10 分钟探测 7 个 CLI(code / claude / codex / opencode / kimi / zcode / dsh),未安装置灰并可一键安装引导' }
        ]
      },
      { type: 'note', text: '任务、提示词、执行记录分别在 ~/.zen-gitsync/tasks.json、prompts.json、jobs.json,跨项目共享。' }
    ]
  },
  {
    id: 'agent',
    title: '智能体 g ai',
    lede: 'Web 端与 CLI 端同一份会话目录。流式输出、思考过程、工具调用全部内联渲染。',
    shots: [
      {
        src: asset('shots/agent-gui.png'),
        alt: 'Web 端智能体对话:流式回答、思考与工具调用卡片',
        caption: 'Web 端 g ai:流式回答与工具调用内联渲染'
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '会话列表', desc: '浏览 / 搜索 / 重命名 / 删除;CLI 创建的会话带 CLI 标记;列表可收成窄收纳条,状态跨刷新记住' },
          { term: '引擎选择', desc: '新建会话可跑内置 g ai,也可交给 Claude Code / OpenCode / Codex;未安装置灰,会话落盘后引擎锁定' },
          { term: '流式对话', desc: 'SSE 实时流式;每条回答头部常显本轮总用时(流式期间实时跳,跑完用服务端定格值)' },
          { term: '任务计划', desc: '多步任务先调 update_plan 拆 3–8 步,逐步更新状态;工具组折叠时计划卡片仍常驻' },
          { term: '向用户提问', desc: 'ask_user 把问题与选项摆在输入框上方,回答后作为只读「已回答」留在消息流里' },
          { term: '自动重试', desc: '断流 / 收不到数据 / 5xx / 429 自动重试最多 10 次、指数退避(听 Retry-After);4xx 直接失败;空闲 5 分钟才算连接死' },
          { term: '重试 / 重新生成', desc: '失败轮可从断点续跑(已完成的工具结果不重做);重新生成 = 丢旧答案同问一遍;仅最后一轮、仅内置 g ai' },
          { term: '工具调用展示', desc: 'run_command / read_file / read_image / edit_file / list_files / search_text / write_file,折叠卡片,展开看完整参数与结果' },
          { term: '图片', desc: 'REPL 里 Alt+V 粘截图,或把路径写进消息让它用 read_image 读;历史里一次只留一张' },
          { term: 'Skill / MCP 广场', desc: '从多个来源装 Skill 与 MCP 服务到当前项目或 g ai 智能体;已装的可在同行卸载 / 定位;stdio 与 Streamable HTTP 两种传输都支持' },
          { term: '克隆优先 SSH', desc: '让它克隆仓库或加远端时走 SSH 形式,https 先换算;SSH 真不可用才退回 https 并说明走了哪条' },
          { term: '最近项目感知', desc: '问「哪些项目要 pull」时它调 list_projects 工具,返回的就是 GUI 最近项目面板那份清单,回答与界面对得上' },
          { term: '复制会话', desc: '整条会话导出 Markdown:主按钮复制精简范围(对话正文),小箭头可选全量(思考 + 工具调用)' },
          { term: '单轮工具上限', desc: '一条消息最多连续调用 N 次工具(默认 200,范围 1–2000),设置 → AI 模型配置 → 智能体运行时' }
        ]
      }
    ]
  },
  {
    id: 'projects',
    title: '项目管理',
    lede: '把项目清单当资产来管的独立视图,与工作台读同一份清单(常用目录 ∪ 任务记得的目录)。',
    shots: [
      {
        src: asset('shots/projects-view-dark.png'),
        alt: '项目管理视图:推荐添加与 18 个项目列表',
        caption: '项目管理:推荐添加 + 逐项目的分支、任务数与路径'
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '添加不切换', desc: '把任意目录加进清单;添加不等于切过去看——切目录是全局状态,会波及每个 g ui 实例' },
          { term: '移除死项目', desc: '目录不存在的行只留一颗红色「从清单移除」;确认框写明任务不会被删除,目录克隆回来这一行会自己现身' },
          { term: '逐行信息', desc: '项目自己的 favicon + 名字 + 分支,打开方式覆盖资源管理器、终端、新标签页 g ui 与各编辑器 / AI 工具' },
          { term: '推荐添加', desc: '看着像项目但还不在清单里的目录,作为推荐项一键加入' },
          { term: '静默刷新', desc: '挂载拉一次,之后每 10 秒静默轮询,别的实例增删项目这里同步可见' }
        ]
      }
    ]
  },
  {
    id: 'monitor',
    title: '系统监控与思维导图',
    lede: '同一根导航栏上的两个辅助视图。',
    shots: [
      {
        src: asset('shots/monitor.png'),
        alt: '系统监控:CPU、内存、磁盘占用与监听端口列表',
        caption: '系统监控:资源占用一眼扫,端口列表可搜索可排序',
        paper: true
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '系统监控', desc: '本机监听端口列表(端口 / PID / 进程名 / 地址 / 协议 / 状态),支持搜索与按端口 / PID / 进程排序,可结束进程(受保护进程标出)' },
          { term: '思维导图', desc: 'Markdown 转思维导图,节点可增删改,主题跟随全局明暗设置' }
        ]
      }
    ]
  },
  {
    id: 'settings',
    title: '设置与自升级',
    lede: '右上角齿轮进设置;底栏版本号每个会话查一次 npm。',
    shots: [
      {
        src: asset('shots/settings-dialog-dark.png'),
        alt: '设置弹窗:六个设置 tab',
        caption: '设置弹窗:六个 tab,大部分开关即时生效'
      }
    ],
    blocks: [
      {
        type: 'list',
        items: [
          { term: '六个设置 tab', desc: '通用设置(主题 / 语言 / 任务执行器 / 完成提示三通道)、AI 模型配置(多端点 + 默认模型 + 单轮工具上限)、Git 全局设置、提交设置、编辑配置(裸 JSON)、编辑器设置' },
          { term: '即时生效', desc: '大部分开关即时生效,无需重启 GUI' },
          { term: '记忆库面板', desc: '设置 → 记忆库,浏览 ~/.zen-gitsync/memory/ 的全局篇与各仓库篇;删除一条会连带删掉索引行' },
          { term: '自升级', desc: '有新版本时点「升级」,弹窗里实时回传 npm install -g 输出;成功后「立即重启并刷新」自行 spawn 新进程、换端口、浏览器重定向;15 秒没起来旧进程保留、会话不断' }
        ]
      }
    ]
  },
  {
    id: 'cli',
    title: 'CLI 速查',
    lede: 'g 命令常用形态,完整说明见 README。',
    blocks: [
      {
        type: 'table',
        head: ['命令', '作用'],
        rows: [
          ['g', '交互式提交(输入提交信息后 add / commit / push)'],
          ['g -y', '跳过输入,直接用默认提交信息'],
          ['g -m <message>', '传入 message 直接提交'],
          ['g --ai', '模型写提交信息,然后提交 + 推送'],
          ['g --ai --interval=600', '每 10 分钟 AI 提交一次'],
          ['g -y --interval=<秒>', '定时自动提交(默认 1 小时)'],
          ['g --path=<path>', '指定工作目录'],
          ['g ui', '打开图形界面'],
          ['g ai / g ai "任务"', '终端智能体:REPL / 单发'],
          ['g mcp install', '把 zen-gitsync 登记为某工具的 MCP 服务'],
          ['g log [--n=5]', '格式化打印 git log'],
          ['g get-config', '查看当前配置'],
          ['g --lock-file=<file>', '锁定文件(不会被暂存或储藏)']
        ]
      }
    ]
  }
]
