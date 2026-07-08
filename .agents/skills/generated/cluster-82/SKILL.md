---
name: cluster-82
description: "Skill for the Cluster_82 area of zen-gitsync. 9 symbols across 1 files."
---

# Cluster_82

9 symbols | 1 files | Cohesion: 95%

## When to Use

- Working with code in `src/`
- Understanding how handleUiLayoutReset, saveLayoutRatios, loadLayoutRatios work
- Modifying cluster_82-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/client/src/App.vue` | handleUiLayoutReset, saveLayoutRatios, loadLayoutRatios, readGridPercents, refreshGridPercents (+4) |

## Entry Points

Start here when exploring this area:

- **`handleUiLayoutReset`** (Function) — `src/ui/client/src/App.vue:199`
- **`saveLayoutRatios`** (Function) — `src/ui/client/src/App.vue:262`
- **`loadLayoutRatios`** (Function) — `src/ui/client/src/App.vue:293`
- **`readGridPercents`** (Function) — `src/ui/client/src/App.vue:320`
- **`refreshGridPercents`** (Function) — `src/ui/client/src/App.vue:340`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `handleUiLayoutReset` | Function | `src/ui/client/src/App.vue` | 199 |
| `saveLayoutRatios` | Function | `src/ui/client/src/App.vue` | 262 |
| `loadLayoutRatios` | Function | `src/ui/client/src/App.vue` | 293 |
| `readGridPercents` | Function | `src/ui/client/src/App.vue` | 320 |
| `refreshGridPercents` | Function | `src/ui/client/src/App.vue` | 340 |
| `nudgeV` | Function | `src/ui/client/src/App.vue` | 348 |
| `nudgeH` | Function | `src/ui/client/src/App.vue` | 363 |
| `stopVResize` | Function | `src/ui/client/src/App.vue` | 433 |
| `stopHResize` | Function | `src/ui/client/src/App.vue` | 496 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Components | 1 calls |

## How to Explore

1. `context({name: "handleUiLayoutReset"})` — see callers and callees
2. `query({search_query: "cluster_82"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
