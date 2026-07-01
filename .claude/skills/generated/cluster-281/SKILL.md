---
name: cluster-281
description: "Skill for the Cluster_281 area of zen-gitsync. 7 symbols across 1 files."
---

# Cluster_281

7 symbols | 1 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how redact, fmt, debugEnabled work
- Modifying cluster_281-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/server/utils/logger.js` | redact, fmt, debugEnabled, debug, info (+2) |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `redact` | Function | `src/ui/server/utils/logger.js` | 39 |
| `fmt` | Function | `src/ui/server/utils/logger.js` | 64 |
| `debugEnabled` | Function | `src/ui/server/utils/logger.js` | 68 |
| `debug` | Function | `src/ui/server/utils/logger.js` | 76 |
| `info` | Function | `src/ui/server/utils/logger.js` | 77 |
| `warn` | Function | `src/ui/server/utils/logger.js` | 78 |
| `error` | Function | `src/ui/server/utils/logger.js` | 79 |

## How to Explore

1. `context({name: "redact"})` — see callers and callees
2. `query({search_query: "cluster_281"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
