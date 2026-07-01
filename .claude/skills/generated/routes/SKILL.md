---
name: routes
description: "Skill for the Routes area of zen-gitsync. 88 symbols across 24 files."
---

# Routes

88 symbols | 24 files | Cohesion: 73%

## When to Use

- Working with code in `src/`
- Understanding how registerCodeAnalysisRoutes, projectCwd, safePathInProject work
- Modifying routes-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/server/routes/codeAnalysis.js` | scanDirectory, walk, safeReadFile, inferModuleRole, parseImportsRegex (+12) |
| `src/ui/server/routes/npm.js` | registerNpmRoutes, resolveRestartEntry, getCurrentVersion, compareSemver, fetchLatestFromRegistry (+9) |
| `src/ui/server/routes/monitor.js` | sampleCpu, getCpuUsage, killProcess, registerMonitorRoutes, listPorts (+3) |
| `src/ui/server/routes/terminal.js` | registerTerminalRoutes, killTerminalPid, isPidAlive, startTerminalProcess, splitArgs (+1) |
| `src/ui/server/routes/code.js` | isPlainObject, normalizeOutputs, runIsolated, finish, hardTimer (+1) |
| `src/ui/server/routes/config.js` | filePriority, isSkippedFile, parseDiffByFile, collectDiffForAi, prepareDiffForPrompt (+1) |
| `src/ui/server/routes/exec.js` | splitCommandArgs, resolveBinAndArgs, isWindowsBuiltinCommand, registerExecRoutes, sendData |
| `src/ui/server/routes/mindmap.js` | validatePath, ensureMindmapExt, registerMindmapRoutes |
| `src/ui/server/index.js` | clearBranchCache, getCurrentInstanceId, nextTerminalSessionId |
| `src/ui/server/utils/shellQuote.js` | shQuote, psEscape, appleEscape |

## Entry Points

Start here when exploring this area:

- **`registerCodeAnalysisRoutes`** (Function) — `src/ui/server/routes/codeAnalysis.js:389`
- **`projectCwd`** (Function) — `src/ui/server/routes/codeAnalysis.js:400`
- **`safePathInProject`** (Function) — `src/ui/server/routes/codeAnalysis.js:408`
- **`log`** (Function) — `src/ui/server/routes/codeAnalysis.js:533`
- **`findPackageJsonPaths`** (Function) — `src/ui/server/routes/codeAnalysis.js:564`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `HttpError` | Class | `src/ui/server/utils/asyncRoute.js` | 39 |
| `registerCodeAnalysisRoutes` | Function | `src/ui/server/routes/codeAnalysis.js` | 389 |
| `projectCwd` | Function | `src/ui/server/routes/codeAnalysis.js` | 400 |
| `safePathInProject` | Function | `src/ui/server/routes/codeAnalysis.js` | 408 |
| `log` | Function | `src/ui/server/routes/codeAnalysis.js` | 533 |
| `findPackageJsonPaths` | Function | `src/ui/server/routes/codeAnalysis.js` | 564 |
| `registerNpmRoutes` | Function | `src/ui/server/routes/npm.js` | 28 |
| `resolveRestartEntry` | Function | `src/ui/server/routes/npm.js` | 48 |
| `getCurrentVersion` | Function | `src/ui/server/routes/npm.js` | 65 |
| `compareSemver` | Function | `src/ui/server/routes/npm.js` | 80 |
| `fetchLatestFromRegistry` | Function | `src/ui/server/routes/npm.js` | 94 |
| `getLatestVersion` | Function | `src/ui/server/routes/npm.js` | 122 |
| `cleanup` | Function | `src/ui/server/routes/npm.js` | 177 |
| `checkPackageJson` | Function | `src/ui/server/routes/npm.js` | 698 |
| `scanDirectory` | Function | `src/ui/server/routes/npm.js` | 751 |
| `getRegistryPath` | Function | `src/ui/server/utils/instanceRegistry.js` | 31 |
| `registerMindmapRoutes` | Function | `src/ui/server/routes/mindmap.js` | 98 |
| `registerMonitorRoutes` | Function | `src/ui/server/routes/monitor.js` | 287 |
| `registerBranchStatusRoutes` | Function | `src/ui/server/routes/branchStatus.js` | 18 |
| `registerGitRoutes` | Function | `src/ui/server/routes/git.js` | 18 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RegisterMonitorRoutes → ParseLine` | cross_community | 4 |
| `RegisterCodeRoutes → Resolve` | cross_community | 4 |
| `RegisterNpmRoutes → FetchLatestFromRegistry` | intra_community | 3 |
| `RegisterCodeAnalysisRoutes → ProjectCwd` | intra_community | 3 |
| `RegisterCodeAnalysisRoutes → Walk` | intra_community | 3 |
| `RegisterCodeAnalysisRoutes → SendSse` | intra_community | 3 |
| `RegisterExecRoutes → SplitCommandArgs` | intra_community | 3 |
| `RegisterExecRoutes → HttpError` | cross_community | 3 |
| `RegisterTerminalRoutes → SplitArgs` | cross_community | 3 |
| `RegisterTerminalRoutes → IsUrl` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Scripts | 2 calls |

## How to Explore

1. `context({name: "registerCodeAnalysisRoutes"})` — see callers and callees
2. `query({search_query: "routes"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
