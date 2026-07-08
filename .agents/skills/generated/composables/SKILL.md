---
name: composables
description: "Skill for the Composables area of zen-gitsync. 32 symbols across 8 files."
---

# Composables

32 symbols | 8 files | Cohesion: 90%

## When to Use

- Working with code in `src/`
- Understanding how ensureFile, targetKey, targetUploadUrl work
- Modifying composables-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/client/src/composables/useWorkbenchAttachments.ts` | ensureFile, targetKey, targetUploadUrl, onAttachmentPaste, onAttachmentDrop (+6) |
| `src/ui/client/src/composables/useWorkbenchData.ts` | syncRunningCount, applyJobEvent, connectSSE, loadJobs, clearJobsByTask (+2) |
| `src/ui/client/src/composables/useTerminalSessions.ts` | refresh, restart, remove |
| `src/ui/client/src/composables/useWorkbenchProjectGroups.ts` | readStringSet, writeStringSet, useWorkbenchProjectGroups |
| `src/ui/client/src/composables/useWorkbenchSimpleConversation.ts` | simpleAllJobsFor, simpleJobFor, simpleConversationMessages |
| `src/ui/client/src/composables/useThemeObserver.ts` | readTheme, useThemeObserver |
| `src/ui/client/src/composables/useWorkbenchExecution.ts` | canRunSubtask, canRunFromHere |
| `src/ui/client/src/stores/workbenchStatus.ts` | useWorkbenchStatusStore |

## Entry Points

Start here when exploring this area:

- **`ensureFile`** (Function) — `src/ui/client/src/composables/useWorkbenchAttachments.ts:25`
- **`targetKey`** (Function) — `src/ui/client/src/composables/useWorkbenchAttachments.ts:31`
- **`targetUploadUrl`** (Function) — `src/ui/client/src/composables/useWorkbenchAttachments.ts:42`
- **`onAttachmentPaste`** (Function) — `src/ui/client/src/composables/useWorkbenchAttachments.ts:53`
- **`onAttachmentDrop`** (Function) — `src/ui/client/src/composables/useWorkbenchAttachments.ts:82`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ensureFile` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 25 |
| `targetKey` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 31 |
| `targetUploadUrl` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 42 |
| `onAttachmentPaste` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 53 |
| `onAttachmentDrop` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 82 |
| `uploadAttachment` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 88 |
| `pickAttachmentFile` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 152 |
| `syncRunningCount` | Function | `src/ui/client/src/composables/useWorkbenchData.ts` | 13 |
| `applyJobEvent` | Function | `src/ui/client/src/composables/useWorkbenchData.ts` | 21 |
| `connectSSE` | Function | `src/ui/client/src/composables/useWorkbenchData.ts` | 76 |
| `loadJobs` | Function | `src/ui/client/src/composables/useWorkbenchData.ts` | 110 |
| `clearJobsByTask` | Function | `src/ui/client/src/composables/useWorkbenchData.ts` | 116 |
| `clearNonDoneJobsByTask` | Function | `src/ui/client/src/composables/useWorkbenchData.ts` | 132 |
| `targetAttachments` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 34 |
| `setTargetAttachments` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 38 |
| `targetDeleteUrl` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 47 |
| `removeAttachment` | Function | `src/ui/client/src/composables/useWorkbenchAttachments.ts` | 134 |
| `refresh` | Function | `src/ui/client/src/composables/useTerminalSessions.ts` | 47 |
| `restart` | Function | `src/ui/client/src/composables/useTerminalSessions.ts` | 64 |
| `remove` | Function | `src/ui/client/src/composables/useTerminalSessions.ts` | 84 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `OnAttachmentPaste → $t` | cross_community | 3 |
| `OnAttachmentPaste → TargetAttachments` | cross_community | 3 |
| `OnAttachmentPaste → TargetKey` | intra_community | 3 |
| `OnAttachmentPaste → TargetUploadUrl` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 3 calls |

## How to Explore

1. `context({name: "ensureFile"})` — see callers and callees
2. `query({search_query: "composables"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
