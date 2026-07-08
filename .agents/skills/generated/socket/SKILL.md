---
name: socket
description: "Skill for the Socket area of zen-gitsync. 4 symbols across 1 files."
---

# Socket

4 symbols | 1 files | Cohesion: 77%

## When to Use

- Working with code in `src/`
- Understanding how registerUiSocketHandlers work
- Modifying socket-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/server/socket/registerUiSocketHandlers.js` | splitCommandArgs, resolveBinAndArgs, isWindowsBuiltin, registerUiSocketHandlers |

## Entry Points

Start here when exploring this area:

- **`registerUiSocketHandlers`** (Function) — `src/ui/server/socket/registerUiSocketHandlers.js:92`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `registerUiSocketHandlers` | Function | `src/ui/server/socket/registerUiSocketHandlers.js` | 92 |
| `splitCommandArgs` | Function | `src/ui/server/socket/registerUiSocketHandlers.js` | 32 |
| `resolveBinAndArgs` | Function | `src/ui/server/socket/registerUiSocketHandlers.js` | 63 |
| `isWindowsBuiltin` | Function | `src/ui/server/socket/registerUiSocketHandlers.js` | 86 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Routes | 2 calls |

## How to Explore

1. `context({name: "registerUiSocketHandlers"})` — see callers and callees
2. `query({search_query: "socket"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
