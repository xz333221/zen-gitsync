<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **zen-gitsync** (6460 symbols, 13528 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/zen-gitsync/context` | Codebase overview, check index freshness |
| `gitnexus://repo/zen-gitsync/clusters` | All functional areas |
| `gitnexus://repo/zen-gitsync/processes` | All execution flows |
| `gitnexus://repo/zen-gitsync/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |
| Work in the Components area (470 symbols) | `.claude/skills/generated/components/SKILL.md` |
| Work in the Scripts area (431 symbols) | `.claude/skills/generated/scripts/SKILL.md` |
| Work in the Routes area (88 symbols) | `.claude/skills/generated/routes/SKILL.md` |
| Work in the Stores area (85 symbols) | `.claude/skills/generated/stores/SKILL.md` |
| Work in the Views area (66 symbols) | `.claude/skills/generated/views/SKILL.md` |
| Work in the Workbench area (62 symbols) | `.claude/skills/generated/workbench/SKILL.md` |
| Work in the Flow area (61 symbols) | `.claude/skills/generated/flow/SKILL.md` |
| Work in the Cli area (40 symbols) | `.claude/skills/generated/cli/SKILL.md` |
| Work in the Server area (32 symbols) | `.claude/skills/generated/server/SKILL.md` |
| Work in the Composables area (32 symbols) | `.claude/skills/generated/composables/SKILL.md` |
| Work in the Buttons area (22 symbols) | `.claude/skills/generated/buttons/SKILL.md` |
| Work in the Cluster_280 area (14 symbols) | `.claude/skills/generated/cluster-280/SKILL.md` |
| Work in the Middleware area (12 symbols) | `.claude/skills/generated/middleware/SKILL.md` |
| Work in the Git area (12 symbols) | `.claude/skills/generated/git/SKILL.md` |
| Work in the Cluster_74 area (9 symbols) | `.claude/skills/generated/cluster-74/SKILL.md` |
| Work in the Cluster_76 area (9 symbols) | `.claude/skills/generated/cluster-76/SKILL.md` |
| Work in the Cluster_82 area (9 symbols) | `.claude/skills/generated/cluster-82/SKILL.md` |
| Work in the Cluster_281 area (7 symbols) | `.claude/skills/generated/cluster-281/SKILL.md` |
| Work in the Socket area (4 symbols) | `.claude/skills/generated/socket/SKILL.md` |
| Work in the Plugins area (3 symbols) | `.claude/skills/generated/plugins/SKILL.md` |

<!-- gitnexus:end -->
