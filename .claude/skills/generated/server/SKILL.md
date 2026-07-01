---
name: server
description: "Skill for the Server area of zen-gitsync. 32 symbols across 6 files."
---

# Server

32 symbols | 6 files | Cohesion: 79%

## When to Use

- Working with code in `src/`
- Understanding how truncateForHistory, registerFsRoutes work
- Modifying server-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/utils/index.js` | errorLog, getDefaultGitTimeout, execGitCommand, addCommandToHistory, exec_exit (+9) |
| `src/ui/server/index.js` | getAndBroadcastStatus, setCurrentProjectPath, setProjectRoomId, setIsGitRepo, drainRunningProcesses (+7) |
| `src/config.js` | invalidateCurrentProjectKey, invalidateRawConfigCache |
| `src/ui/server/routes/fs.js` | validateChangeDirectoryPath, registerFsRoutes |
| `src/gitCommit.js` | createGitCommit |
| `src/utils/format.js` | truncateForHistory |

## Entry Points

Start here when exploring this area:

- **`truncateForHistory`** (Function) — `src/utils/format.js:52`
- **`registerFsRoutes`** (Function) — `src/ui/server/routes/fs.js:70`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `truncateForHistory` | Function | `src/utils/format.js` | 52 |
| `registerFsRoutes` | Function | `src/ui/server/routes/fs.js` | 70 |
| `createGitCommit` | Function | `src/gitCommit.js` | 137 |
| `getAndBroadcastStatus` | Function | `src/ui/server/index.js` | 459 |
| `errorLog` | Function | `src/utils/index.js` | 115 |
| `getDefaultGitTimeout` | Function | `src/utils/index.js` | 208 |
| `execGitCommand` | Function | `src/utils/index.js` | 214 |
| `addCommandToHistory` | Function | `src/utils/index.js` | 496 |
| `exec_exit` | Function | `src/utils/index.js` | 700 |
| `judgeUnmerged` | Function | `src/utils/index.js` | 709 |
| `exec_push` | Function | `src/utils/index.js` | 717 |
| `printCommitLog` | Function | `src/utils/index.js` | 731 |
| `execPull` | Function | `src/utils/index.js` | 776 |
| `judgeRemote` | Function | `src/utils/index.js` | 789 |
| `execDiff` | Function | `src/utils/index.js` | 845 |
| `execGitAddWithLockFilter` | Function | `src/utils/index.js` | 855 |
| `execAddAndCommit` | Function | `src/utils/index.js` | 1026 |
| `rlPromisify` | Function | `src/utils/index.js` | 1052 |
| `invalidateCurrentProjectKey` | Function | `src/config.js` | 114 |
| `invalidateRawConfigCache` | Function | `src/config.js` | 154 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → Resolve` | cross_community | 8 |
| `RegisterGitOpsRoutes → CalcColor` | cross_community | 6 |
| `RegisterGitOpsRoutes → PadRight` | cross_community | 6 |
| `Main → CalcColor` | cross_community | 6 |
| `Main → PadRight` | cross_community | 6 |
| `RegisterGitOpsRoutes → ParseCwdArg` | cross_community | 5 |
| `Main → ParseCwdArg` | cross_community | 5 |
| `RegisterGitOpsRoutes → GetDefaultGitTimeout` | cross_community | 4 |
| `RegisterGitOpsRoutes → TruncateForHistory` | cross_community | 4 |
| `Main → GetDefaultGitTimeout` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Scripts | 3 calls |
| Routes | 3 calls |
| Cli | 2 calls |
| Cluster_76 | 1 calls |

## How to Explore

1. `context({name: "truncateForHistory"})` — see callers and callees
2. `query({search_query: "server"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
