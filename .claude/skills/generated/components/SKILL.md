---
name: components
description: "Skill for the Components area of zen-gitsync. 470 symbols across 79 files."
---

# Components

470 symbols | 79 files | Cohesion: 94%

## When to Use

- Working with code in `src/`
- Understanding how updateConfigInfo, loadCurrentDirectory, streamingHint work
- Modifying components-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/client/src/components/CommandConsole.vue` | clearConsoleHistory, confirmUserInput, scrollToCurrentStep, isGitCommand, extractVersionFromOutput (+35) |
| `src/ui/client/src/views/components/LogList.vue` | copyCommitFileDiff, handleOpenFile, handleOpenWithVSCode, copyPureMessage, copyCommitContent (+24) |
| `src/ui/client/src/views/components/GitStatus.vue` | handleOpenFile, handleOpenWithVSCode, confirmUnlockFile, confirmUnlockAll, copyCurrentFileDiff (+21) |
| `src/ui/client/src/components/FileDiffViewer.vue` | handleOpenFile, handleCopyPath, handleOpenWithVSCode, loadConflictFileContent, openButtonTooltip (+19) |
| `src/ui/client/src/components/CustomCommandManager.vue` | setup, getParamDesc, resetForm, saveCommand, cancelEdit (+12) |
| `src/ui/client/src/components/DirectorySelector.vue` | onCopyDirectory, onOpenExplorer, onOpenInVscode, onOpenInClaudeCode, pickClaudeMode (+11) |
| `src/ui/client/src/views/components/CommandHistory.vue` | openCommandHistory, loadHistory, clearCommandHistory, copyCommand, initSocketListeners (+11) |
| `src/ui/client/src/stores/gitStore.ts` | checkGitRepo, clearUserConfig, restoreUserConfig, gitPull, refreshLog (+10) |
| `src/ui/client/src/components/MonacoEditor.vue` | applyGutterMarginOption, ensureRightActionsContainer, clearRightActions, layoutRightActions, isBlockApplied (+9) |
| `src/ui/client/src/components/GitGlobalSettingsDialog.vue` | handleAddModelSave, handleDeleteModel, handleSetDefaultModel, setGlobalConfig, saveGlobalGitConfigs (+8) |

## Entry Points

Start here when exploring this area:

- **`updateConfigInfo`** (Function) — `src/ui/client/src/App.vue:101`
- **`loadCurrentDirectory`** (Function) — `src/ui/client/src/App.vue:108`
- **`streamingHint`** (Function) — `src/ui/client/src/components/AISplitChatPane.vue:72`
- **`scrollToBottom`** (Function) — `src/ui/client/src/components/AISplitChatPane.vue:87`
- **`send`** (Function) — `src/ui/client/src/components/AISplitChatPane.vue:92`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `updateConfigInfo` | Function | `src/ui/client/src/App.vue` | 101 |
| `loadCurrentDirectory` | Function | `src/ui/client/src/App.vue` | 108 |
| `streamingHint` | Function | `src/ui/client/src/components/AISplitChatPane.vue` | 72 |
| `scrollToBottom` | Function | `src/ui/client/src/components/AISplitChatPane.vue` | 87 |
| `send` | Function | `src/ui/client/src/components/AISplitChatPane.vue` | 92 |
| `resetConversation` | Function | `src/ui/client/src/components/AISplitChatPane.vue` | 218 |
| `applyTurn` | Function | `src/ui/client/src/components/AISplitChatPane.vue` | 229 |
| `openHistory` | Function | `src/ui/client/src/components/AISplitChatPane.vue` | 238 |
| `restoreSession` | Function | `src/ui/client/src/components/AISplitChatPane.vue` | 255 |
| `deleteSession` | Function | `src/ui/client/src/components/AISplitChatPane.vue` | 297 |
| `modeOptions` | Function | `src/ui/client/src/components/AISplitDialog.vue` | 44 |
| `stop` | Function | `src/ui/client/src/components/AISplitDirectPane.vue` | 254 |
| `reparse` | Function | `src/ui/client/src/components/AISplitDirectPane.vue` | 262 |
| `updateRelativeTime` | Function | `src/ui/client/src/components/AppErrorBanner.vue` | 52 |
| `startRelativeTimer` | Function | `src/ui/client/src/components/AppErrorBanner.vue` | 64 |
| `closeContextMenu` | Function | `src/ui/client/src/components/AttachmentZone.vue` | 105 |
| `copyImageToClipboard` | Function | `src/ui/client/src/components/AttachmentZone.vue` | 111 |
| `clearConsoleHistory` | Function | `src/ui/client/src/components/CommandConsole.vue` | 319 |
| `confirmUserInput` | Function | `src/ui/client/src/components/CommandConsole.vue` | 407 |
| `getParamDesc` | Function | `src/ui/client/src/components/CustomCommandManager.vue` | 147 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleAfterQuickPushSuccessEvent → OpCompare` | cross_community | 8 |
| `HandleAfterQuickPushSuccessEvent → $t` | cross_community | 7 |
| `HandleAfterQuickPushSuccessEvent → ScrollToCurrentStep` | cross_community | 7 |
| `HandleAfterQuickPushSuccessEvent → ReplaceVariables` | cross_community | 7 |
| `HandleAfterQuickPushSuccessEvent → LoadTerminalSessionsStatus` | cross_community | 7 |
| `RevertCommit → FlushUiSaveNow` | cross_community | 7 |
| `CherryPickCommit → FlushUiSaveNow` | cross_community | 7 |
| `ResetToCommit → FlushUiSaveNow` | cross_community | 7 |
| `CheckAndLoadMore → FlushUiSaveNow` | cross_community | 7 |
| `RevertCommit → ApplyTheme` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Stores | 5 calls |
| Buttons | 1 calls |

## How to Explore

1. `context({name: "updateConfigInfo"})` — see callers and callees
2. `query({search_query: "components"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
