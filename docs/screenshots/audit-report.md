# zen-git 交互探索与可用性审计报告

审计时间: 2026-06-19T06:22:55.839Z
目标: http://127.0.0.1:5544
视口: 1440×900

## 概览

- 发现问题: **16** 条 (P0: 2, P1: 4, P2: 10)
- console 错误: **28** 条
- console 警告: **16** 条
- 探测交互元素: **158** 个 (其中 < 24×24 的 64 个)
- 拖拽分隔条: **5** 个
- aria-live 区域: **3** 个

## P0 (2)

### F06 · a11y · 分隔条键盘不可达

README 声明"键盘可达",但 tabindex 为 null,屏幕阅读器和纯键盘用户无法调整布局

**证据**:
```json
[{"selector":".resize-handle","width":0,"height":0,"cursor":"ns-resize","ariaOrientation":null,"role":null,"tabindex":null},{"selector":".resize-handle","width":295,"height":8,"cursor":"ns-resize","ariaOrientation":null,"role":null,"tabindex":null}]
```

### F08 · feature · 找不到主题切换 UI 入口

审计只看到 header 齿轮(用户设置),没看到主题切换按钮;用户必须进设置才能切暗色,认知成本高

## P1 (4)

### F02 · click-target · 64 个可交互元素 < 24×24 (WCAG 2.5.5)

应保证最小命中区 24x24,推荐 32x32

**证据**:
```json
[{"selector":"button","tag":"button","className":"el-button el-button--small copy-message-btn","text":"","ariaLabel":"复制纯净提交信息（不含类型前缀）","width":22,"height":22},{"selector":"button","tag":"button","className":"commit-hash el-tooltip__trigger el-tooltip__trigger","text":"293edbd","ariaLabel":"复制提交哈希 293edbd","width":58,"height":19},{"selector":"button","tag":"button","className":"el-button el-button--small copy-message-btn","text":"","ariaLabel":"复制纯净提交信息（不含类型前缀）","width":22,"height":22},{"selector":"button","tag":"button","className":"commit-hash el-tooltip__trigger el-tooltip__trigger","text":"80ac264","ariaLabel":"复制提交哈希 80ac264","width":58,"height":19},{"selector":"button","tag":"button","className":"el-button el-button--small copy-message-btn","text":"","ariaLabel":"复制纯净提交信息（不含类型前缀）","width":22,"height":22},{"selector":"button","tag":"button","className":"commit-hash el-tooltip__trigger el-tooltip__trigger","text":"e211308","ariaLabel":"复制提交哈希 e211308","width":58,"height":19},{"selector":"button","tag":"button","className":"el-button el-button--small copy-message-btn","text":"","ariaLabel":"复制纯净提交信息（不含类型前缀）","width":22,"height":22},{"selector":"button","tag":"button","className":"commit-hash el-tooltip__trigger el-tooltip__trigger","text":"13c6727","ariaLabel":"复制提交哈希 13c6727","width":58,"height":19},{"selector":"button","tag":"button","className":"el-button el-button--small copy-message-btn","text":"","ariaLabel":"复制纯净提交信息（不含类型前缀）","width":22,"height":22},{"selector":"button","tag":"button","className":"commit-hash el-tooltip__trigger el-tooltip__trigger","text":"1ceedd5","ariaLabel":"复制提交哈希 1ceedd5","width":58,"height":19}]
```

### F05 · a11y · 2 个分隔条缺少 role/aria-orientation

屏幕阅读器无法识别这是可调节分隔条

**证据**:
```json
[{"selector":".resize-handle","width":0,"height":0,"cursor":"ns-resize","ariaOrientation":null,"role":null,"tabindex":null},{"selector":".resize-handle","width":295,"height":8,"cursor":"ns-resize","ariaOrientation":null,"role":null,"tabindex":null}]
```

### F11 · feedback · 文件项 hover 无视觉变化

selector .file-tree-item, .file-item, .file-row, .git-status-file, .log-item 的 background/color 在 hover 时未改变,缺少反馈

**证据**:
```json
{"sel":".file-tree-item, .file-item, .file-row, .git-status-file, .log-item","width":0,"height":0,"before":{"bg":"rgb(255, 255, 255)","color":"rgb(48, 49, 51)","boxShadow":"none"},"hover":{"bg":"rgb(255, 255, 255)","color":"rgb(48, 49, 51)"},"focus":{"outline":"rgb(48, 49, 51) none 3px","boxShadow":"none"},"hoverChanged":false}
```

### F12 · a11y · 3 个 input 无 label/aria-label/placeholder

屏幕阅读器无法识别输入框用途

**证据**:
```json
[{"placeholder":"","ariaLabel":null,"hasLabel":false,"id":"el-id-6037-220","width":132},{"placeholder":"","ariaLabel":null,"hasLabel":false,"id":"","width":0},{"placeholder":"","ariaLabel":null,"hasLabel":false,"id":"","width":0}]
```

## P2 (10)

### F01 · console · 无 console 错误

启动 + 加载期间未观察到 JS 异常

### F03 · a11y · 焦点环普遍存在

5 个被探测元素都有可见 focus 指示

### F04 · interaction · 找到 5 个分隔条

记录类名 + 尺寸 + cursor

**证据**:
```json
[{"selector":".resize-handle","width":0,"height":0,"cursor":"ns-resize","ariaOrientation":null,"role":null,"tabindex":null},{"selector":".resize-handle","width":295,"height":8,"cursor":"ns-resize","ariaOrientation":null,"role":null,"tabindex":null},{"selector":"[role=\"separator\"]","width":4,"height":804,"cursor":"col-resize","ariaOrientation":"vertical","role":"separator","tabindex":"0"},{"selector":"[role=\"separator\"]","width":486,"height":4,"cursor":"row-resize","ariaOrientation":"horizontal","role":"separator","tabindex":"0"},{"selector":"[role=\"separator\"]","width":4,"height":804,"cursor":"col-resize","ariaOrientation":"vertical","role":"separator","tabindex":"0"}]
```

### F07 · a11y · 对话框焦点陷阱工作

Tab 仍在 dialog 内,共 40 个 focusable

### F09 · a11y · 3 个 aria-live 区域

[{"ariaLive":"assertive","ariaAtomic":"true","text":"","visible":false},{"ariaLive":"polite","ariaAtomic":"true","text":"","visible":false},{"ariaLive":"polite","ariaAtomic":"true","text":"","visible":false}]

### F10 · state · 当前 store 状态

{"ok":true,"stores":{"git":{"isGitRepo":true,"userName":"xuze","userEmail":"569552263@qq.com"},"config":{},"locale":{},"instances":{},"workbenchStatus":{},"editorTabs":{}}}

### F13 · visual · 暗色模式文字/背景采样

[{"text":"Ctrl+S 保存","color":"rgb(203, 208, 214)","bg":"rgba(0, 0, 0, 0)","opacity":"0.6"},{"text":"默认模型MiniMax-M3","color":"rgb(255, 255, 255)","bg":"rgba(0, 0, 0, 0)","opacity":"1"},{"text":"默认模型","color":"rgb(255, 255, 255)","bg":"rgba(0, 0, 0, 0)","opacity":"0.55"},{"text":"MiniMax-M3","color":"rgb(255, 255, 255)","bg":"rgba(0, 0, 0, 0)","opacity":"0.85"},{"text":"默认权限","color":"rgb(216, 220, 226)","bg":"rgba(0, 0, 0, 0)","opacity":"1"}]

### F14 · ia · 非 git 仓库状态卡文案

Git仓库初始化当前目录不是Git仓库，请先初始化Git仓库或切换到Git仓库目录。可以使用以下命令初始化仓库：git init点击复制

### F15 · ia · 用户未配置状态卡文案

Git 用户未配置请先配置Git用户信息才能进行提交操作。 立即配置或者使用命令行配置：$ git config --global user.name "您的用户名"$ git config --global user.email "您的邮箱"

### F16 · error · 网络错误时主区域内容

当前目录不是Git仓库请初始化Git仓库或切换到Git仓库目录初始化Git仓库最近项目点击在新标签页打开暂无最近项目尚未配置远程仓库添加远程仓库后，即可推送分支并与团队协作。初始化并添加远程NPM 脚本自定义命令暂无自定义命令去添加Git仓库初始化当前目录不是Git仓库，请先初始化Git仓库或切换到Git仓库目录。可以使用以下命令初始化仓库：git init点击复制自定义指令执行终端会话(0)暂无终端会话 >提交历史暂无提交记录 查看详情 复制提交哈希 复制提交内容 重置到该提交(hard) 撤销提交 (Revert) Cherry-Pick 到当前分支资源管理器暂无文件从左侧选择文件打开Ct

## console 错误详情

- [error] Failed to load resource: the server responded with a status of 400 (Bad Request)
- [error] Failed to load resource: the server responded with a status of 400 (Bad Request)
- [error] Failed to load resource: the server responded with a status of 400 (Bad Request)
- [error] Failed to load resource: the server responded with a status of 400 (Bad Request)
- [error] Failed to load resource: the server responded with a status of 400 (Bad Request)
- [error] Failed to load resource: the server responded with a status of 400 (Bad Request)
- [error] Failed to load resource: the server responded with a status of 400 (Bad Request)
- [error] Failed to load resource: the server responded with a status of 400 (Bad Request)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] [NPM面板] 加载失败，耗时413ms
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)
- [error] Failed to load resource: the server responded with a status of 500 (Internal Server Error)

## 截图索引

| 名称 | 内容 |
|------|------|
| audit-shortcut-trace.png | 键盘快捷键探测后的现场 |
| audit-dark-mode-applied.png | data-theme=dark 切换后 |
| audit-not-git-repo-state.png | 非 git 仓库状态 |
| audit-user-unconfigured-state.png | 用户未配置状态 |
| audit-network-error-state.png | 网络断开 500 模拟 |
| audit-tablet-768.png | 平板 768 宽度布局 |
| audit-mobile-375.png | 手机 375 宽度布局 |
