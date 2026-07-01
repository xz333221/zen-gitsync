---
name: flow
description: "Skill for the Flow area of zen-gitsync. 61 symbols across 5 files."
---

# Flow

61 symbols | 5 files | Cohesion: 87%

## When to Use

- Working with code in `src/`
- Understanding how generateCopyName, duplicateOrchestration, initializeFlow work
- Modifying flow-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue` | generateCopyName, duplicateOrchestration, initializeFlow, clearFlow, loadOrchestration (+27) |
| `src/ui/client/src/components/flow/NodeConfigPanel.vue` | createDefaultBranch, normalizeBranches, createRule, addBranch, removeBranch (+14) |
| `src/ui/client/src/components/flow/CodeNodeInputConfig.vue` | createDefaultRow, addRow, updateRow, handleReferenceSelect |
| `src/ui/client/src/components/flow/UserInputParamConfig.vue` | createDefaultRow, addRow, updateRow, handleReferenceSelect |
| `src/ui/client/src/utils/commandParser.ts` | extractVariables, validateVariables |

## Entry Points

Start here when exploring this area:

- **`generateCopyName`** (Function) — `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue:268`
- **`duplicateOrchestration`** (Function) — `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue:286`
- **`initializeFlow`** (Function) — `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue:403`
- **`clearFlow`** (Function) — `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue:638`
- **`loadOrchestration`** (Function) — `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue:866`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `generateCopyName` | Function | `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue` | 268 |
| `duplicateOrchestration` | Function | `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue` | 286 |
| `initializeFlow` | Function | `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue` | 403 |
| `clearFlow` | Function | `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue` | 638 |
| `loadOrchestration` | Function | `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue` | 866 |
| `createNewOrchestration` | Function | `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue` | 892 |
| `deleteOrchestration` | Function | `src/ui/client/src/components/flow/FlowOrchestrationWorkspace.vue` | 901 |
| `createDefaultBranch` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 211 |
| `normalizeBranches` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 223 |
| `createRule` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 250 |
| `addBranch` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 258 |
| `removeBranch` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 272 |
| `addRuleRow` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 282 |
| `removeRuleRow` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 290 |
| `normalizeCodeInputs` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 298 |
| `upsertVersionFieldInput` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 324 |
| `handleVersionFieldRefSelect` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 363 |
| `normalizeCodeOutputs` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 369 |
| `ensureCommandOutputParams` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 511 |
| `generateId` | Function | `src/ui/client/src/components/flow/NodeConfigPanel.vue` | 689 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `AddBranch → $t` | cross_community | 4 |
| `UpdateNodeConfig → GetExecutableNodes` | cross_community | 4 |
| `UpdateNodeConfig → SanitizeNodesForSave` | cross_community | 4 |
| `UpdateNodeConfig → SanitizeEdgesForSave` | cross_community | 4 |
| `ClearFlow → GetExecutableNodes` | cross_community | 4 |
| `ClearFlow → SanitizeNodesForSave` | cross_community | 4 |
| `ClearFlow → SanitizeEdgesForSave` | cross_community | 4 |
| `RemoveBranch → $t` | cross_community | 4 |
| `AddRuleRow → $t` | cross_community | 4 |
| `AddNode → EscapeRegExp` | intra_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 6 calls |

## How to Explore

1. `context({name: "generateCopyName"})` — see callers and callees
2. `query({search_query: "flow"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
