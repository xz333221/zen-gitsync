---
name: stores
description: "Skill for the Stores area of zen-gitsync. 85 symbols across 9 files."
---

# Stores

85 symbols | 9 files | Cohesion: 72%

## When to Use

- Working with code in `src/`
- Understanding how getLocale, loadConfig, ls work
- Modifying stores-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/client/src/stores/gitStore.ts` | fetchStatusPorcelain, addToStage, addAllToStage, delay, commitChanges (+32) |
| `src/ui/client/src/stores/configStore.ts` | loadConfig, ls, num, saveCustomCommand, deleteCustomCommand (+13) |
| `src/ui/client/src/stores/mindmapStore.ts` | useMindmapStore, persistDir, listFiles, setDir, createFile (+3) |
| `src/ui/client/src/stores/instancesStore.ts` | refresh, attachSocket, detachSocket, start, stop (+3) |
| `src/ui/client/src/stores/monitorStore.ts` | fetchSystem, fetchPorts, refresh, killProcess, startAutoRefresh (+3) |
| `src/ui/client/src/locales/index.ts` | getLocale, setLocale |
| `src/ui/client/src/stores/localeStore.ts` | useLocaleStore, changeLocale |
| `src/ui/client/src/views/components/CommitForm.vue` | handleAiGenerateCommit |
| `src/ui/client/src/components/buttons/ConfigEditorButton.vue` | saveFullConfig |

## Entry Points

Start here when exploring this area:

- **`getLocale`** (Function) — `src/ui/client/src/locales/index.ts:73`
- **`loadConfig`** (Function) — `src/ui/client/src/stores/configStore.ts:326`
- **`ls`** (Function) — `src/ui/client/src/stores/configStore.ts:416`
- **`num`** (Function) — `src/ui/client/src/stores/configStore.ts:427`
- **`saveCustomCommand`** (Function) — `src/ui/client/src/stores/configStore.ts:959`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getLocale` | Function | `src/ui/client/src/locales/index.ts` | 73 |
| `loadConfig` | Function | `src/ui/client/src/stores/configStore.ts` | 326 |
| `ls` | Function | `src/ui/client/src/stores/configStore.ts` | 416 |
| `num` | Function | `src/ui/client/src/stores/configStore.ts` | 427 |
| `saveCustomCommand` | Function | `src/ui/client/src/stores/configStore.ts` | 959 |
| `deleteCustomCommand` | Function | `src/ui/client/src/stores/configStore.ts` | 985 |
| `updateCustomCommand` | Function | `src/ui/client/src/stores/configStore.ts` | 1011 |
| `pinCustomCommand` | Function | `src/ui/client/src/stores/configStore.ts` | 1037 |
| `saveOrchestration` | Function | `src/ui/client/src/stores/configStore.ts` | 1059 |
| `deleteOrchestration` | Function | `src/ui/client/src/stores/configStore.ts` | 1084 |
| `updateOrchestration` | Function | `src/ui/client/src/stores/configStore.ts` | 1109 |
| `useLocaleStore` | Function | `src/ui/client/src/stores/localeStore.ts` | 20 |
| `handleAiGenerateCommit` | Function | `src/ui/client/src/views/components/CommitForm.vue` | 38 |
| `setLocale` | Function | `src/ui/client/src/locales/index.ts` | 64 |
| `useConfigStore` | Function | `src/ui/client/src/stores/configStore.ts` | 151 |
| `applyTheme` | Function | `src/ui/client/src/stores/configStore.ts` | 247 |
| `toggleTheme` | Function | `src/ui/client/src/stores/configStore.ts` | 266 |
| `saveCommitSettings` | Function | `src/ui/client/src/stores/configStore.ts` | 541 |
| `flushUiSaveNow` | Function | `src/ui/client/src/stores/configStore.ts` | 573 |
| `saveUiSettings` | Function | `src/ui/client/src/stores/configStore.ts` | 597 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `RevertCommit → FlushUiSaveNow` | cross_community | 7 |
| `CherryPickCommit → FlushUiSaveNow` | cross_community | 7 |
| `ResetToCommit → FlushUiSaveNow` | cross_community | 7 |
| `CheckAndLoadMore → FlushUiSaveNow` | cross_community | 7 |
| `RevertCommit → ApplyTheme` | cross_community | 6 |
| `RevertCommit → SaveCommitSettings` | cross_community | 6 |
| `RevertCommit → CleanupSocketListeners` | cross_community | 6 |
| `RevertCommit → $t` | cross_community | 6 |
| `RevertCommit → ParseStatusPorcelain` | cross_community | 6 |
| `CherryPickCommit → ApplyTheme` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 40 calls |

## How to Explore

1. `context({name: "getLocale"})` — see callers and callees
2. `query({search_query: "stores"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
