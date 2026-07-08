---
name: cluster-280
description: "Skill for the Cluster_280 area of zen-gitsync. 14 symbols across 1 files."
---

# Cluster_280

14 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how enqueueWrite, readAll, writeAll work
- Modifying cluster_280-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/server/utils/instanceRegistry.js` | isProcessAlive, resolveProjectName, enqueueWrite, readAll, writeAll (+9) |

## Entry Points

Start here when exploring this area:

- **`enqueueWrite`** (Function) — `src/ui/server/utils/instanceRegistry.js:74`
- **`readAll`** (Function) — `src/ui/server/utils/instanceRegistry.js:81`
- **`writeAll`** (Function) — `src/ui/server/utils/instanceRegistry.js:98`
- **`pruneInPlace`** (Function) — `src/ui/server/utils/instanceRegistry.js:110`
- **`register`** (Function) — `src/ui/server/utils/instanceRegistry.js:124`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `enqueueWrite` | Function | `src/ui/server/utils/instanceRegistry.js` | 74 |
| `readAll` | Function | `src/ui/server/utils/instanceRegistry.js` | 81 |
| `writeAll` | Function | `src/ui/server/utils/instanceRegistry.js` | 98 |
| `pruneInPlace` | Function | `src/ui/server/utils/instanceRegistry.js` | 110 |
| `register` | Function | `src/ui/server/utils/instanceRegistry.js` | 124 |
| `unregister` | Function | `src/ui/server/utils/instanceRegistry.js` | 151 |
| `heartbeat` | Function | `src/ui/server/utils/instanceRegistry.js` | 162 |
| `list` | Function | `src/ui/server/utils/instanceRegistry.js` | 183 |
| `watch` | Function | `src/ui/server/utils/instanceRegistry.js` | 205 |
| `fire` | Function | `src/ui/server/utils/instanceRegistry.js` | 218 |
| `close` | Function | `src/ui/server/utils/instanceRegistry.js` | 267 |
| `_resolveProjectName` | Function | `src/ui/server/utils/instanceRegistry.js` | 278 |
| `isProcessAlive` | Function | `src/ui/server/utils/instanceRegistry.js` | 35 |
| `resolveProjectName` | Function | `src/ui/server/utils/instanceRegistry.js` | 51 |

## How to Explore

1. `context({name: "enqueueWrite"})` — see callers and callees
2. `query({search_query: "cluster_280"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
