# Pass 2 补充检查

时间: 2026-06-19T06:33:22.948Z

## [P1] feature - 主题切换藏在用户设置里(可发现性低)

用户必须打开设置才能切暗色,工具栏/header 没有快捷入口

**证据**:
```json
{"textSnippet":"设置通用设置Git 全局设置提交设置编辑配置编辑器设置通用配置自定义应用的外观和语言外观主题浅色语言界面语言简体中文界面文件列表视图列表树状文件差异分割 35%命令控制台默认展开使用终端执行显示终端会话控制台高度比例: 32.498563002518154% 布局比例重置为默认布局恢复默认的左/中/右/上面板比例AI 模型配置+ 添加模型MiniMax / minimax-m2.7minimax-m2.7 · https://api.minimaxi.com/v1设为默认编辑删除DeepSeek / deepseek-v4-prodeepseek-v4-pro · https://api.de","hasTheme":true,"inputCount":21,"inputDetails":[{"tag":"INPUT","type":"text","label":""},{"tag":"INPUT","type":"text","label":""},{"tag":"INPUT","type":"radio","label":""},{"tag":"INPUT","type":"radio","label":""},{"tag":"INPUT","type":"checkbox","label":""},{"tag":"INPUT","type":"checkbox","label":""},{"tag":"INPUT","type":"checkbox","label":""},{"tag":"INPUT","type":"text","label":"请输入 Git 用户名"},{"tag":"INPUT","type":"text","label":"请输入 Git 邮箱地址"},{"tag":"INPUT","type":"checkbox","label":""}]}
```

## [P1] contrast - 暗色模式文字对比度 1.0:1 < 4.5 (WCAG AA)

文字 "293edbd" 颜色 rgba(255, 255, 255, 0.7) 背景 rgba(255, 255, 255, 0.1)

**证据**:
```json
{"selector":".commit-hash","text":"293edbd","color":"rgba(255, 255, 255, 0.7)","bg":"rgba(255, 255, 255, 0.1)","opacity":"1","fontSize":"11px","contrastRatio":1}
```

## [P2] ia - 已通过 DOM 注入测试 commit form 输入

{"kind":"INPUT","placeholder":"作用域（可选）"}

## [P2] feedback - 提交按钮静态态

{"found":false}

## [P2] a11y - toast/通知元素

[{"text":"","ariaLive":null,"role":"alert","visible":false,"width":1,"height":0},{"text":"","ariaLive":null,"role":"alert","visible":false,"width":1,"height":0},{"text":"Git 状态已刷新","ariaLive":null,"role":"alert","visible":true,"width":1440,"height":39}]

## [P0] ia - 网络断开时页面同时出现 26 个空状态卡

4 个面板各自显示"暂无 X",用户分不清是后端断还是真的没数据;应该有全局错误横幅说明

**证据**:
```json
{"emptyCount":26,"emptyTexts":["当前目录不是Git仓库请初始化Git仓库或切换到Git仓库目录初始化Git仓库","","当前目录不是Git仓库","请初始化Git仓库或切换到Git仓库目录","暂无最近项目","暂无自定义命令去添加","","暂无自定义命令","Git仓库初始化当前目录不是Git仓库，请先初始化Git仓库或切换到Git仓库目录。可以使用以下命令","暂无终端会话"]}
```

## [P2] ia - 提交历史列表

{"found":true,"itemCount":6,"scrollHeight":804,"clientHeight":804,"sample":["查看详情","复制提交哈希","复制提交内容"]}

## [P2] form - 空 commit form 提交按钮态

{"found":true,"submitDisabled":true,"submitHasTitle":""}

