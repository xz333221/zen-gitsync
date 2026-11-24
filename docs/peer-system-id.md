# 跨机器对端的系统标识

## 为什么需要

跨机器提问在本机跑的是**对端那一侧的智能体**。它看不到提问方的环境，只会把自己当"本机"；
而模型又习惯按 Linux 写命令（`ls` / `tail` / 单引号路径）。两台 Windows 机器互问时，这些命令
在本机必然报错。系统信息不能由提问方推断 —— 一台机器是什么系统，只有它自己知道。

## 协议字段

`GET /api/peer/info`（对端自报）：

```json
{
  "ok": true,
  "id": "...",
  "name": "...",
  "version": "2.19.18",
  "os": { "platform": "win32", "arch": "x64", "release": "10.0.22631", "label": "Windows 11 (win32/x64)" },
  "shell": "cmd.exe / PowerShell"
}
```

- `label` 由 `src/peer/platform.js` 生成（进程内缓存一次）：Windows 按 build 号区分 10/11，
  Linux 优先读 `/etc/os-release` 的 `PRETTY_NAME`（如 `Ubuntu 22.04 (linux/x64)`）。
- `shell` 让人知道该按 `cmd.exe / PowerShell` 还是 POSIX shell 的语法写命令。

`POST /api/peer/ask` 的 body 额外带可选的 `fromOs`（自己的 label）与 `fromName`（自己的昵称）。
对端把它们拼成一段上下文前缀放在问题之前，明确「这是来自另一台机器、不是你本机、你这台是什么系统」。
两个字段都会清洗（去换行、上限 64 字），缺省时前缀里写「系统未知」。

## 向后兼容

| 情况 | 行为 |
| --- | --- |
| 新问老 | 老版本对端忽略 `fromOs` / `fromName`，提问照常 |
| 老问新 | 缺字段 → 前缀里写「系统未知」，提问照常 |
| 新看老 | `os: null` / `shell: ''` → 界面显示「系统未知」 |

`os: null` 的含义是**不知道对方是什么系统**（对方版本旧、没自报），不是"对方没有系统"。
不要用它反推平台。

## 工具与界面

- `peers_list` 每台对端带 `os` / `shell`，`peer_ask` 的 `peer` 也带；工具描述里已写明
  「对端系统以 os 为准，别拿本机系统去假设对端」。
- 设置面板的对端行显示 `Windows 11 · 2.19.18`（拿不到系统时显示「系统未知」），纯文字、不换行。
