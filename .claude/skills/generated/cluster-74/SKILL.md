---
name: cluster-74
description: "Skill for the Cluster_74 area of zen-gitsync. 9 symbols across 1 files."
---

# Cluster_74

9 symbols | 1 files | Cohesion: 81%

## When to Use

- Working with code in `src/`
- Understanding how normalizeProjectPath, getCurrentProjectKey, writeRawConfigFile work
- Modifying cluster_74-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/config.js` | normalizeProjectPath, getCurrentProjectKey, writeRawConfigFile, backupConfigFileIfExists, safeLoadRaw (+4) |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `ConfigWriteError` | Class | `src/config.js` | 254 |
| `normalizeProjectPath` | Function | `src/config.js` | 77 |
| `getCurrentProjectKey` | Function | `src/config.js` | 90 |
| `writeRawConfigFile` | Function | `src/config.js` | 162 |
| `backupConfigFileIfExists` | Function | `src/config.js` | 184 |
| `safeLoadRaw` | Function | `src/config.js` | 199 |
| `saveConfig` | Function | `src/config.js` | 267 |
| `saveRecentDirectory` | Function | `src/config.js` | 399 |
| `removeRecentDirectory` | Function | `src/config.js` | 428 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Server | 1 calls |

## How to Explore

1. `context({name: "normalizeProjectPath"})` — see callers and callees
2. `query({search_query: "cluster_74"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
