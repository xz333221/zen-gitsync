---
name: buttons
description: "Skill for the Buttons area of zen-gitsync. 22 symbols across 9 files."
---

# Buttons

22 symbols | 9 files | Cohesion: 91%

## When to Use

- Working with code in `src/`
- Understanding how stagedFilesCount, hasAnyChanges, hasAnyChanges work
- Modifying buttons-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/client/src/components/buttons/StageButton.vue` | isFileLocked, hasLockedFileMatches, unstagedFilesCount, hasUnstagedChanges, tooltipText (+1) |
| `src/ui/client/src/components/buttons/StashListButton.vue` | viewStashDetail, getStashFileDiff, getStashFileCompare, showStashDiffOnly, showStashFullCompare (+1) |
| `src/ui/client/src/utils/fileLock.ts` | normalizePath, isFilePathLocked |
| `src/ui/client/src/views/components/CommitForm.vue` | isCommitDisabled, handleEnterKey |
| `src/ui/client/src/components/buttons/StashChangesButton.vue` | saveStash, handleStashMessageKeydown |
| `src/ui/client/src/components/buttons/CommitButton.vue` | stagedFilesCount |
| `src/ui/client/src/components/buttons/QuickCommitButton.vue` | hasAnyChanges |
| `src/ui/client/src/components/buttons/QuickPushButton.vue` | hasAnyChanges |
| `src/ui/client/src/views/components/GitStatus.vue` | toggleFileLock |

## Entry Points

Start here when exploring this area:

- **`stagedFilesCount`** (Function) — `src/ui/client/src/components/buttons/CommitButton.vue:48`
- **`hasAnyChanges`** (Function) — `src/ui/client/src/components/buttons/QuickCommitButton.vue:51`
- **`hasAnyChanges`** (Function) — `src/ui/client/src/components/buttons/QuickPushButton.vue:57`
- **`normalizePath`** (Function) — `src/ui/client/src/utils/fileLock.ts:11`
- **`isFilePathLocked`** (Function) — `src/ui/client/src/utils/fileLock.ts:20`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `stagedFilesCount` | Function | `src/ui/client/src/components/buttons/CommitButton.vue` | 48 |
| `hasAnyChanges` | Function | `src/ui/client/src/components/buttons/QuickCommitButton.vue` | 51 |
| `hasAnyChanges` | Function | `src/ui/client/src/components/buttons/QuickPushButton.vue` | 57 |
| `normalizePath` | Function | `src/ui/client/src/utils/fileLock.ts` | 11 |
| `isFilePathLocked` | Function | `src/ui/client/src/utils/fileLock.ts` | 20 |
| `isCommitDisabled` | Function | `src/ui/client/src/views/components/CommitForm.vue` | 205 |
| `handleEnterKey` | Function | `src/ui/client/src/views/components/CommitForm.vue` | 365 |
| `toggleFileLock` | Function | `src/ui/client/src/views/components/GitStatus.vue` | 733 |
| `isFileLocked` | Function | `src/ui/client/src/components/buttons/StageButton.vue` | 39 |
| `hasLockedFileMatches` | Function | `src/ui/client/src/components/buttons/StageButton.vue` | 48 |
| `unstagedFilesCount` | Function | `src/ui/client/src/components/buttons/StageButton.vue` | 62 |
| `hasUnstagedChanges` | Function | `src/ui/client/src/components/buttons/StageButton.vue` | 70 |
| `tooltipText` | Function | `src/ui/client/src/components/buttons/StageButton.vue` | 95 |
| `handleClick` | Function | `src/ui/client/src/components/buttons/StageButton.vue` | 113 |
| `viewStashDetail` | Function | `src/ui/client/src/components/buttons/StashListButton.vue` | 122 |
| `getStashFileDiff` | Function | `src/ui/client/src/components/buttons/StashListButton.vue` | 170 |
| `getStashFileCompare` | Function | `src/ui/client/src/components/buttons/StashListButton.vue` | 193 |
| `showStashDiffOnly` | Function | `src/ui/client/src/components/buttons/StashListButton.vue` | 220 |
| `showStashFullCompare` | Function | `src/ui/client/src/components/buttons/StashListButton.vue` | 228 |
| `handleStashFileSelect` | Function | `src/ui/client/src/components/buttons/StashListButton.vue` | 236 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ViewStashDetail → $t` | cross_community | 3 |
| `HandleStashFileSelect → $t` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 3 calls |

## How to Explore

1. `context({name: "stagedFilesCount"})` — see callers and callees
2. `query({search_query: "buttons"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
