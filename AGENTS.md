# pi-harness2

Self-improving local workspace extension for Pi Coding Agent inspired by Google Research's Harness2.

## Layout

- `src/index.ts` — Extension entry point and `/harness2` command handlers (`pi.extensions`).
- `src/analyzer.ts` — Stage 1: restores full uncompacted session branch and builds a token-bounded digest.
- `src/recorder.ts` — Stage 2: AI semantic judge + deterministic offline AST fallback.
- `src/triggers.ts` — Workspace state, thresholds, and recurring fingerprint tracking (`.pi/harness2/state.json`).
- `src/improver.ts`, `src/applier.ts`, `src/ui.ts` — Stage 3: proposal synthesis, guided TUI review, backups (`.pi/harness2/backups/`), and `/harness2 undo`.
- `src/types.ts` — Local Pi SDK type definitions (no runtime SDK dependency).
- `test/` + `scripts/run-tests.mjs` — Zero-dependency test runner.

## Commands (`pnpm`)

```bash
pnpm install
pnpm test
pnpm run test:smoke
pnpm run typecheck
```

## Invariants

- **Human-in-the-loop & reversible:** Never apply workspace edits without explicit approval in the Guided TUI and backup creation in `.pi/harness2/backups/`.
- **Zero runtime dependencies:** Keep runtime `dependencies` empty (`peerDependencies` are optional).
- **Preserve full history:** Stage 1 must bridge across `compaction` entries rather than analyzing only post-compaction messages.
