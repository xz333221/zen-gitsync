---
name: plugins
description: "Skill for the Plugins area of zen-gitsync. 3 symbols across 2 files."
---

# Plugins

3 symbols | 2 files | Cohesion: 100%

## When to Use

- Working with code in `src/`
- Understanding how getElementPlusLocale, setupElementPlus, elementPlusLocale work
- Modifying plugins-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/ui/client/src/plugins/elementPlus.ts` | getElementPlusLocale, setupElementPlus |
| `src/ui/client/src/stores/localeStore.ts` | elementPlusLocale |

## Entry Points

Start here when exploring this area:

- **`getElementPlusLocale`** (Function) — `src/ui/client/src/plugins/elementPlus.ts:27`
- **`setupElementPlus`** (Function) — `src/ui/client/src/plugins/elementPlus.ts:32`
- **`elementPlusLocale`** (Function) — `src/ui/client/src/stores/localeStore.ts:25`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getElementPlusLocale` | Function | `src/ui/client/src/plugins/elementPlus.ts` | 27 |
| `setupElementPlus` | Function | `src/ui/client/src/plugins/elementPlus.ts` | 32 |
| `elementPlusLocale` | Function | `src/ui/client/src/stores/localeStore.ts` | 25 |

## How to Explore

1. `context({name: "getElementPlusLocale"})` — see callers and callees
2. `query({search_query: "plugins"})` — find related execution flows
3. Read key files listed above for implementation details
4. `explain({target: "<file or symbol>"})` — persisted taint findings (source→sink data flows), when indexed with `--pdg`
