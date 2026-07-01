---
name: cli
description: "Skill for the Cli area of zen-gitsync. 40 symbols across 6 files."
---

# Cli

40 symbols | 6 files | Cohesion: 78%

## When to Use

- Working with code in `src/`
- Understanding how setupSigintHandler, validateCustomCommand, isCmdStrictMode work
- Modifying cli-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/utils/index.js` | judgePlatform, showHelp, judgeLog, judgeHelp, printGitLog (+9) |
| `src/gitCommit.js` | loadStartUIServer, handleFileLockCommands, main, render, showStartInfo (+8) |
| `src/cli/cleanup.js` | setupSigintHandler, trackChild, registerCleanup, killAllTrackedChildren, runCleanupTasks (+1) |
| `src/cli/customCommand.js` | validateCustomCommand, isCmdStrictMode, runCustomCommand |
| `src/cli/ui.js` | calcBoxenWidth, boxenAdaptive |
| `src/utils/format.js` | parseCwdArg, formatDuration |

## Entry Points

Start here when exploring this area:

- **`setupSigintHandler`** (Function) — `src/cli/cleanup.js:144`
- **`validateCustomCommand`** (Function) — `src/cli/customCommand.js:50`
- **`isCmdStrictMode`** (Function) — `src/cli/customCommand.js:93`
- **`calcBoxenWidth`** (Function) — `src/cli/ui.js:39`
- **`boxenAdaptive`** (Function) — `src/cli/ui.js:58`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `setupSigintHandler` | Function | `src/cli/cleanup.js` | 144 |
| `validateCustomCommand` | Function | `src/cli/customCommand.js` | 50 |
| `isCmdStrictMode` | Function | `src/cli/customCommand.js` | 93 |
| `calcBoxenWidth` | Function | `src/cli/ui.js` | 39 |
| `boxenAdaptive` | Function | `src/cli/ui.js` | 58 |
| `parseCwdArg` | Function | `src/utils/format.js` | 24 |
| `formatDuration` | Function | `src/utils/format.js` | 72 |
| `trackChild` | Function | `src/cli/cleanup.js` | 87 |
| `runCustomCommand` | Function | `src/cli/customCommand.js` | 114 |
| `registerCleanup` | Function | `src/cli/cleanup.js` | 53 |
| `killAllTrackedChildren` | Function | `src/cli/cleanup.js` | 99 |
| `runCleanupTasks` | Function | `src/cli/cleanup.js` | 115 |
| `handler` | Function | `src/cli/cleanup.js` | 147 |
| `loadStartUIServer` | Function | `src/gitCommit.js` | 38 |
| `handleFileLockCommands` | Function | `src/gitCommit.js` | 179 |
| `main` | Function | `src/gitCommit.js` | 228 |
| `judgePlatform` | Function | `src/utils/index.js` | 558 |
| `showHelp` | Function | `src/utils/index.js` | 587 |
| `judgeLog` | Function | `src/utils/index.js` | 666 |
| `judgeHelp` | Function | `src/utils/index.js` | 675 |

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
| `Main → GetDefaultGitTimeout` | cross_community | 4 |
| `Main → TruncateForHistory` | cross_community | 4 |
| `Main → RegisterSocketIO` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Server | 4 calls |
| Middleware | 1 calls |
| Cluster_76 | 1 calls |
| Routes | 1 calls |

## How to Explore

1. `context({name: "setupSigintHandler"})` — see callers and callees
2. `query({search_query: "cli"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
