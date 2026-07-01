---
name: scripts
description: "Skill for the Scripts area of zen-gitsync. 431 symbols across 26 files."
---

# Scripts

431 symbols | 26 files | Cohesion: 78%

## When to Use

- Working with code in `skills/`
- Understanding how registerFileOpenRoutes, req, waitProcessExit work
- Modifying scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `skills/impeccable/scripts/live-browser.js` | writeScrollY, readScrollY, id8, extractContext, showBar (+163) |
| `skills/impeccable/scripts/modern-screenshot.umd.js` | I, H, ce, Qe, V (+98) |
| `skills/impeccable/scripts/design-parser.mjs` | splitSections, normalizeApostrophes, matchCanonicalSection, collectParagraphs, flush (+27) |
| `skills/impeccable/scripts/live-accept.mjs` | acceptCli, handleDiscard, handleAccept, findMarkerBlock, extractCss (+9) |
| `scripts/release.js` | createReadlineInterface, askContinue, checkEnvironment, runTypeCheck, updateVersion (+8) |
| `skills/impeccable/scripts/live-server.mjs` | findOpenPort, resolve, enqueueEvent, broadcast, hasProjectContext (+6) |
| `skills/impeccable/scripts/live-inject.mjs` | injectCli, resolveFiles, isExcluded, isGlob, validateConfig (+5) |
| `skills/impeccable/scripts/live-wrap.mjs` | wrapCli, argVal, buildSearchQueries, detectCommentSyntax, findElement (+4) |
| `skills/impeccable/scripts/cleanup-deprecated.mjs` | findProjectRoot, loadLock, isImpeccableSkill, buildTargetNames, findSkillsDirs (+3) |
| `skills/impeccable/scripts/live.mjs` | liveCli, runScript, safeParse, ensureServerRunning, scanForDrift (+3) |

## Entry Points

Start here when exploring this area:

- **`registerFileOpenRoutes`** (Function) — `src/ui/server/routes/fileOpen.js:56`
- **`req`** (Function) — `src/ui/server/routes/npm.js:96`
- **`waitProcessExit`** (Function) — `src/ui/server/routes/workbench/taskRunner.js:471`
- **`tryCheck`** (Function) — `src/ui/server/routes/workbench/taskRunner.js:474`
- **`parseDesignMd`** (Function) — `skills/impeccable/scripts/design-parser.mjs:803`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `registerFileOpenRoutes` | Function | `src/ui/server/routes/fileOpen.js` | 56 |
| `req` | Function | `src/ui/server/routes/npm.js` | 96 |
| `waitProcessExit` | Function | `src/ui/server/routes/workbench/taskRunner.js` | 471 |
| `tryCheck` | Function | `src/ui/server/routes/workbench/taskRunner.js` | 474 |
| `parseDesignMd` | Function | `skills/impeccable/scripts/design-parser.mjs` | 803 |
| `acceptCli` | Function | `skills/impeccable/scripts/live-accept.mjs` | 25 |
| `findProjectRoot` | Function | `skills/impeccable/scripts/cleanup-deprecated.mjs` | 74 |
| `loadLock` | Function | `skills/impeccable/scripts/cleanup-deprecated.mjs` | 95 |
| `isImpeccableSkill` | Function | `skills/impeccable/scripts/cleanup-deprecated.mjs` | 113 |
| `buildTargetNames` | Function | `skills/impeccable/scripts/cleanup-deprecated.mjs` | 141 |
| `findSkillsDirs` | Function | `skills/impeccable/scripts/cleanup-deprecated.mjs` | 154 |
| `removeDeprecatedSkills` | Function | `skills/impeccable/scripts/cleanup-deprecated.mjs` | 171 |
| `cleanSkillsLock` | Function | `skills/impeccable/scripts/cleanup-deprecated.mjs` | 220 |
| `cleanup` | Function | `skills/impeccable/scripts/cleanup-deprecated.mjs` | 260 |
| `wrapCli` | Function | `skills/impeccable/scripts/live-wrap.mjs` | 19 |
| `injectCli` | Function | `skills/impeccable/scripts/live-inject.mjs` | 34 |
| `resolveFiles` | Function | `skills/impeccable/scripts/live-inject.mjs` | 129 |
| `isExcluded` | Function | `skills/impeccable/scripts/live-inject.mjs` | 135 |
| `isGlob` | Function | `skills/impeccable/scripts/live-inject.mjs` | 136 |
| `isGeneratedFile` | Function | `skills/impeccable/scripts/is-generated.mjs` | 32 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `Main → Resolve` | cross_community | 8 |
| `HandleKeyDown → HideActionPicker` | cross_community | 7 |
| `HandleKeyDown → BarPaletteForTheme` | cross_community | 7 |
| `HandleKeyDown → DetectPageTheme` | cross_community | 7 |
| `HandleServerLost → HideActionPicker` | cross_community | 7 |
| `HandleServerLost → BarPaletteForTheme` | cross_community | 7 |
| `HandleKeyDown → El` | cross_community | 6 |
| `HandleKeyDown → ActionLabel` | cross_community | 6 |
| `HandleClick → HideActionPicker` | cross_community | 6 |
| `HandleServerLost → El` | cross_community | 6 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Routes | 2 calls |

## How to Explore

1. `context({name: "registerFileOpenRoutes"})` — see callers and callees
2. `query({search_query: "scripts"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
