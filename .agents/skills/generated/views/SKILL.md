---
name: views
description: "Skill for the Views area of zen-gitsync. 66 symbols across 4 files."
---

# Views

66 symbols | 4 files | Cohesion: 80%

## When to Use

- Working with code in `src/`
- Understanding how loadDir, initTree, collectExpandedPaths work
- Modifying views-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/client/src/views/EditorView.vue` | loadDir, initTree, collectExpandedPaths, restoreExpanded, refreshTree (+27) |
| `src/ui/client/src/views/WorkbenchView.vue` | isSubtaskPersisting, setSubtaskPersisting, addSubtask, removeSubtask, persistTask (+18) |
| `src/ui/client/src/views/SourceMapView.vue` | addLog, buildFileTree, sortTree, nodeColor, buildFlowGraph (+5) |
| `src/ui/client/src/utils/editorLang.ts` | getLanguageByExt |

## Entry Points

Start here when exploring this area:

- **`loadDir`** (Function) — `src/ui/client/src/views/EditorView.vue:93`
- **`initTree`** (Function) — `src/ui/client/src/views/EditorView.vue:106`
- **`collectExpandedPaths`** (Function) — `src/ui/client/src/views/EditorView.vue:118`
- **`restoreExpanded`** (Function) — `src/ui/client/src/views/EditorView.vue:128`
- **`refreshTree`** (Function) — `src/ui/client/src/views/EditorView.vue:140`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `loadDir` | Function | `src/ui/client/src/views/EditorView.vue` | 93 |
| `initTree` | Function | `src/ui/client/src/views/EditorView.vue` | 106 |
| `collectExpandedPaths` | Function | `src/ui/client/src/views/EditorView.vue` | 118 |
| `restoreExpanded` | Function | `src/ui/client/src/views/EditorView.vue` | 128 |
| `refreshTree` | Function | `src/ui/client/src/views/EditorView.vue` | 140 |
| `cancelInlineInput` | Function | `src/ui/client/src/views/EditorView.vue` | 673 |
| `confirmInlineInput` | Function | `src/ui/client/src/views/EditorView.vue` | 677 |
| `handleInlineKeydown` | Function | `src/ui/client/src/views/EditorView.vue` | 708 |
| `confirmRename` | Function | `src/ui/client/src/views/EditorView.vue` | 759 |
| `handleRenameKeydown` | Function | `src/ui/client/src/views/EditorView.vue` | 786 |
| `addLog` | Function | `src/ui/client/src/views/SourceMapView.vue` | 215 |
| `buildFileTree` | Function | `src/ui/client/src/views/SourceMapView.vue` | 221 |
| `sortTree` | Function | `src/ui/client/src/views/SourceMapView.vue` | 242 |
| `nodeColor` | Function | `src/ui/client/src/views/SourceMapView.vue` | 255 |
| `buildFlowGraph` | Function | `src/ui/client/src/views/SourceMapView.vue` | 306 |
| `optimizeLayout` | Function | `src/ui/client/src/views/SourceMapView.vue` | 386 |
| `startAnalysis` | Function | `src/ui/client/src/views/SourceMapView.vue` | 451 |
| `handleSseEvent` | Function | `src/ui/client/src/views/SourceMapView.vue` | 524 |
| `isSubtaskPersisting` | Function | `src/ui/client/src/views/WorkbenchView.vue` | 791 |
| `setSubtaskPersisting` | Function | `src/ui/client/src/views/WorkbenchView.vue` | 794 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `CreateTaskDirect → CaptureSnapshot` | cross_community | 5 |
| `SelectTask → CaptureSnapshot` | cross_community | 5 |
| `CreateTaskDirect → $t` | cross_community | 4 |
| `SelectTask → $t` | cross_community | 4 |
| `AddSubtask → CaptureSnapshot` | cross_community | 4 |
| `HandleImportSplitConfirm → CaptureSnapshot` | cross_community | 4 |
| `CancelDone → CaptureSnapshot` | cross_community | 4 |
| `RemoveSubtask → CaptureSnapshot` | cross_community | 4 |
| `OpenFile → LoadDir` | cross_community | 3 |
| `HandleSseEvent → SortTree` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 14 calls |

## How to Explore

1. `context({name: "loadDir"})` — see callers and callees
2. `query({search_query: "views"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
