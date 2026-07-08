---
name: middleware
description: "Skill for the Middleware area of zen-gitsync. 12 symbols across 9 files."
---

# Middleware

12 symbols | 9 files | Cohesion: 49%

## When to Use

- Working with code in `src/`
- Understanding how startServer, createErrorHandler, createRequestLogger work
- Modifying middleware-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/server/utils/startServerOnAvailablePort.js` | startServerOnAvailablePort, getCallbackExecuted, setCallbackExecuted |
| `src/ui/server/utils/randomStartPort.js` | pickRandomInt, resolveStartPort |
| `index.js` | startServer |
| `src/ui/server/index.js` | startUIServer |
| `src/ui/server/middleware/errorHandler.js` | createErrorHandler |
| `src/ui/server/middleware/requestLogger.js` | createRequestLogger |
| `src/ui/server/utils/createSavePortToFile.js` | createSavePortToFile |
| `src/ui/server/utils/instanceRegistry.js` | createInstanceRegistry |
| `src/utils/index.js` | registerSocketIO |

## Entry Points

Start here when exploring this area:

- **`startServer`** (Function) — `index.js:29`
- **`createErrorHandler`** (Function) — `src/ui/server/middleware/errorHandler.js:41`
- **`createRequestLogger`** (Function) — `src/ui/server/middleware/requestLogger.js:16`
- **`createSavePortToFile`** (Function) — `src/ui/server/utils/createSavePortToFile.js:16`
- **`createInstanceRegistry`** (Function) — `src/ui/server/utils/instanceRegistry.js:66`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `startServer` | Function | `index.js` | 29 |
| `createErrorHandler` | Function | `src/ui/server/middleware/errorHandler.js` | 41 |
| `createRequestLogger` | Function | `src/ui/server/middleware/requestLogger.js` | 16 |
| `createSavePortToFile` | Function | `src/ui/server/utils/createSavePortToFile.js` | 16 |
| `createInstanceRegistry` | Function | `src/ui/server/utils/instanceRegistry.js` | 66 |
| `resolveStartPort` | Function | `src/ui/server/utils/randomStartPort.js` | 34 |
| `startServerOnAvailablePort` | Function | `src/ui/server/utils/startServerOnAvailablePort.js` | 16 |
| `getCallbackExecuted` | Function | `src/ui/server/utils/startServerOnAvailablePort.js` | 30 |
| `setCallbackExecuted` | Function | `src/ui/server/utils/startServerOnAvailablePort.js` | 37 |
| `startUIServer` | Function | `src/ui/server/index.js` | 187 |
| `pickRandomInt` | Function | `src/ui/server/utils/randomStartPort.js` | 22 |
| `registerSocketIO` | Function | `src/utils/index.js` | 165 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → Resolve` | cross_community | 8 |
| `Main → CalcColor` | cross_community | 6 |
| `Main → PadRight` | cross_community | 6 |
| `Main → ParseCwdArg` | cross_community | 5 |
| `Main → GetDefaultGitTimeout` | cross_community | 4 |
| `Main → TruncateForHistory` | cross_community | 4 |
| `Main → RegisterSocketIO` | cross_community | 3 |
| `Main → CreateInstanceRegistry` | cross_community | 3 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Routes | 13 calls |
| Server | 4 calls |
| Scripts | 2 calls |
| Workbench | 1 calls |
| Git | 1 calls |
| Socket | 1 calls |

## How to Explore

1. `context({name: "startServer"})` — see callers and callees
2. `query({search_query: "middleware"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
