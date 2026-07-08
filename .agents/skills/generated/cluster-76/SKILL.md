---
name: cluster-76
description: "Skill for the Cluster_76 area of zen-gitsync. 9 symbols across 1 files."
---

# Cluster_76

9 symbols | 1 files | Cohesion: 70%

## When to Use

- Working with code in `src/`
- Understanding how readRawConfigFile, loadConfig, lockFile work
- Modifying cluster_76-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/config.js` | readRawConfigFile, loadConfig, lockFile, unlockFile, isFileLocked (+4) |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `readRawConfigFile` | Function | `src/config.js` | 139 |
| `loadConfig` | Function | `src/config.js` | 225 |
| `lockFile` | Function | `src/config.js` | 318 |
| `unlockFile` | Function | `src/config.js` | 342 |
| `isFileLocked` | Function | `src/config.js` | 366 |
| `listLockedFiles` | Function | `src/config.js` | 372 |
| `getLockedFiles` | Function | `src/config.js` | 385 |
| `getRecentDirectories` | Function | `src/config.js` | 393 |
| `handleConfigCommands` | Function | `src/config.js` | 442 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Cluster_74 | 5 calls |

## How to Explore

1. `context({name: "readRawConfigFile"})` — see callers and callees
2. `query({search_query: "cluster_76"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
