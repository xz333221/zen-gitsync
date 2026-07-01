---
name: workbench
description: "Skill for the Workbench area of zen-gitsync. 62 symbols across 10 files."
---

# Workbench

62 symbols | 10 files | Cohesion: 79%

## When to Use

- Working with code in `src/`
- Understanding how sanitizeExt, isImageExt, resolveExt work
- Modifying workbench-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/server/routes/workbench/jobStore.js` | snapshotJobs, serializeJob, scheduleJobsSave, flushJobsSaveNow, readJobsConfig (+5) |
| `src/ui/server/routes/workbench/index.js` | registerWorkbenchRoutes, summarizeOneSub, send, handler, applyJobsFilter (+4) |
| `src/ui/server/routes/workbench/taskRunner.js` | collectPriorOutputs, collectPriorOutputsUpTo, launchClaudeInNewWindow, runTaskQueue, runSingleSubtask (+3) |
| `src/ui/server/routes/workbench/projectScan.js` | detectProjectManifest, readProjectManifest, safeReadFile, listDirTree, walk (+1) |
| `src/ui/server/routes/workbench/sessionStore.js` | genSessionId, readSessionFile, writeSessionFile, deleteSessionFile, listSessionsMeta (+1) |
| `src/ui/server/routes/workbench/shared.js` | genId, nowIso, ensureDataDir, readJson, writeJson (+1) |
| `src/ui/server/routes/workbench/instructionStore.js` | pickDefaultSubtaskInstruction, readInstruction, readSubtaskInstruction, writeInstruction, writeSubtaskInstruction |
| `src/ui/server/routes/workbench/jsonParse.js` | stripThinkingBlocks, extractFirstJsonObject, extractBalancedJson, reescapeUnescapedQuotes, parseSubtaskJson |
| `src/ui/server/routes/workbench/llmClient.js` | callLlmJson, callLlmJsonWithRetry, cloneMsgContent, callLlmStream |
| `src/ui/server/routes/workbench/attachmentUtils.js` | sanitizeExt, isImageExt, resolveExt |

## Entry Points

Start here when exploring this area:

- **`sanitizeExt`** (Function) — `src/ui/server/routes/workbench/attachmentUtils.js:52`
- **`isImageExt`** (Function) — `src/ui/server/routes/workbench/attachmentUtils.js:59`
- **`resolveExt`** (Function) — `src/ui/server/routes/workbench/attachmentUtils.js:68`
- **`registerWorkbenchRoutes`** (Function) — `src/ui/server/routes/workbench/index.js:111`
- **`summarizeOneSub`** (Function) — `src/ui/server/routes/workbench/index.js:189`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `sanitizeExt` | Function | `src/ui/server/routes/workbench/attachmentUtils.js` | 52 |
| `isImageExt` | Function | `src/ui/server/routes/workbench/attachmentUtils.js` | 59 |
| `resolveExt` | Function | `src/ui/server/routes/workbench/attachmentUtils.js` | 68 |
| `registerWorkbenchRoutes` | Function | `src/ui/server/routes/workbench/index.js` | 111 |
| `summarizeOneSub` | Function | `src/ui/server/routes/workbench/index.js` | 189 |
| `send` | Function | `src/ui/server/routes/workbench/index.js` | 330 |
| `handler` | Function | `src/ui/server/routes/workbench/index.js` | 766 |
| `applyJobsFilter` | Function | `src/ui/server/routes/workbench/index.js` | 1225 |
| `sortKey` | Function | `src/ui/server/routes/workbench/index.js` | 1245 |
| `writeAttachmentTo` | Function | `src/ui/server/routes/workbench/index.js` | 1549 |
| `pickDefaultSubtaskInstruction` | Function | `src/ui/server/routes/workbench/instructionStore.js` | 128 |
| `readInstruction` | Function | `src/ui/server/routes/workbench/instructionStore.js` | 135 |
| `readSubtaskInstruction` | Function | `src/ui/server/routes/workbench/instructionStore.js` | 156 |
| `snapshotJobs` | Function | `src/ui/server/routes/workbench/jobStore.js` | 192 |
| `stripThinkingBlocks` | Function | `src/ui/server/routes/workbench/jsonParse.js` | 30 |
| `extractFirstJsonObject` | Function | `src/ui/server/routes/workbench/jsonParse.js` | 45 |
| `extractBalancedJson` | Function | `src/ui/server/routes/workbench/jsonParse.js` | 91 |
| `reescapeUnescapedQuotes` | Function | `src/ui/server/routes/workbench/jsonParse.js` | 125 |
| `parseSubtaskJson` | Function | `src/ui/server/routes/workbench/jsonParse.js` | 166 |
| `callLlmJson` | Function | `src/ui/server/routes/workbench/llmClient.js` | 31 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ScheduleJobsSave → ReadJson` | intra_community | 5 |
| `ScheduleJobsSave → EnsureDataDir` | intra_community | 5 |
| `RegisterWorkbenchRoutes → Walk` | intra_community | 4 |
| `HydrateJobs → ReadJson` | intra_community | 4 |
| `HydrateJobs → EnsureDataDir` | intra_community | 4 |
| `RunTaskQueue → NowIso` | intra_community | 4 |
| `RunTaskQueue → EnsureDataDir` | intra_community | 4 |
| `ScheduleJobsSave → SortKey` | intra_community | 4 |
| `RegisterWorkbenchRoutes → SafeReadFile` | intra_community | 3 |
| `WriteAttachmentTo → SanitizeExt` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Routes | 3 calls |
| Scripts | 2 calls |

## How to Explore

1. `context({name: "sanitizeExt"})` — see callers and callees
2. `query({search_query: "workbench"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
