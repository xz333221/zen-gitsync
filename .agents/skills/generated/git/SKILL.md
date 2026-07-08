---
name: git
description: "Skill for the Git area of zen-gitsync. 12 symbols across 5 files."
---

# Git

12 symbols | 5 files | Cohesion: 82%

## When to Use

- Working with code in `src/`
- Understanding how registerGitDiffRoutes, createDiffHelpers, checkShouldSkipDiff work
- Modifying git-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/server/routes/git/diffUtils.js` | createDiffHelpers, checkShouldSkipDiff, checkDiffSize, getDiffStats |
| `src/ui/server/routes/gitOps.js` | registerGitOpsRoutes, sendProgress, executeGitLogCommand, processAndSendLogOutput |
| `src/ui/server/routes/git/diff.js` | toGitRepoRelativePath, registerGitDiffRoutes |
| `src/ui/server/index.js` | setRecentPushStatus |
| `src/ui/server/routes/git/stash.js` | registerGitStashRoutes |

## Entry Points

Start here when exploring this area:

- **`registerGitDiffRoutes`** (Function) — `src/ui/server/routes/git/diff.js:48`
- **`createDiffHelpers`** (Function) — `src/ui/server/routes/git/diffUtils.js:16`
- **`checkShouldSkipDiff`** (Function) — `src/ui/server/routes/git/diffUtils.js:23`
- **`checkDiffSize`** (Function) — `src/ui/server/routes/git/diffUtils.js:100`
- **`getDiffStats`** (Function) — `src/ui/server/routes/git/diffUtils.js:117`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `registerGitDiffRoutes` | Function | `src/ui/server/routes/git/diff.js` | 48 |
| `createDiffHelpers` | Function | `src/ui/server/routes/git/diffUtils.js` | 16 |
| `checkShouldSkipDiff` | Function | `src/ui/server/routes/git/diffUtils.js` | 23 |
| `checkDiffSize` | Function | `src/ui/server/routes/git/diffUtils.js` | 100 |
| `getDiffStats` | Function | `src/ui/server/routes/git/diffUtils.js` | 117 |
| `registerGitStashRoutes` | Function | `src/ui/server/routes/git/stash.js` | 18 |
| `registerGitOpsRoutes` | Function | `src/ui/server/routes/gitOps.js` | 26 |
| `sendProgress` | Function | `src/ui/server/routes/gitOps.js` | 278 |
| `executeGitLogCommand` | Function | `src/ui/server/routes/gitOps.js` | 569 |
| `processAndSendLogOutput` | Function | `src/ui/server/routes/gitOps.js` | 633 |
| `setRecentPushStatus` | Function | `src/ui/server/index.js` | 329 |
| `toGitRepoRelativePath` | Function | `src/ui/server/routes/git/diff.js` | 42 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RegisterGitOpsRoutes → CalcColor` | cross_community | 6 |
| `RegisterGitOpsRoutes → PadRight` | cross_community | 6 |
| `RegisterGitOpsRoutes → ParseCwdArg` | cross_community | 5 |
| `RegisterGitOpsRoutes → GetDefaultGitTimeout` | cross_community | 4 |
| `RegisterGitOpsRoutes → TruncateForHistory` | cross_community | 4 |
| `RegisterGitOpsRoutes → ProcessAndSendLogOutput` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Routes | 6 calls |
| Server | 1 calls |
| Cli | 1 calls |

## How to Explore

1. `context({name: "registerGitDiffRoutes"})` — see callers and callees
2. `query({search_query: "git"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
