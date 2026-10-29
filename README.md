# `pi-harness2` (v0.3.0) — Self-Improving Workspace Extension for Pi Coding Agent

`pi-harness2` is a human-in-the-loop extension for [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) inspired by Google Research's [Harness²: Recursive Agent Harnessing for an Open World (arXiv:2610.14224)](https://arxiv.org/html/2610.14224v1).

## Two-Stage Architecture: Deterministic Digest $\to$ AI Model Semantic Recorder

Instead of relying on brittle regexes to guess what constitutes conflict or inefficiency, `pi-harness2` v0.3.0 mirrors Google Research's [Harness²](https://github.com/google-research/harness2) and [Pi's Compaction architecture](https://pi.dev/docs/latest/compaction):

1. **Stage 1 — Full Uncompacted Branch Restoration & Token-Bounded Digest (`src/analyzer.ts`)**:
   - Restores **all raw messages across the session** (even messages that were compacted earlier in the session!) by reading `ctx.sessionManager.getBranch()` or the raw `.jsonl` session file on disk and bridging transparently across `type: "compaction"` markers.
   - Filters out `context_edit` retracted turns and network/provider `stopReason: "error"` duplicate retries.
   - Strips `<thinking>` blocks, `<skill>` XML wrappers, and multi-megabyte base64 `image` blobs (compressing a 3.7 MB raw `.jsonl` session log down to a ~12 KB high-signal text digest) while mechanically extracting file operations (`filesRead`, `filesWritten`, `filesEdited`, `rootScriptsCreated`, `failedToolCalls`, `subagentInteractions`).
2. **Stage 2 — AI Model Semantic Judge & Recorder (`src/recorder.ts`)**:
   - Passes the condensed `SessionDigest`, your recording rubric, and existing workspace fingerprints from `.pi/harness2/state.json` to your configured model (or active session model) via `ctx.modelRegistry.complete(..., { cacheRetention: "none" })`.
   - The AI model semantically identifies **User Steering & Corrections**, **Explicit Instruction-Compliance / Omission / Logical-Drift Questions**, **Tool Inefficiencies** (both `+1` single-occurrence hiccups and `+3` multi-step trial-and-error chains or script sprawl, even when exit codes are `0`), and **Subagent Revisions**, reusing existing workspace fingerprints when a pattern repeats across tasks.
3. **Stage 3 — Workspace Improvement Proposals & One-Click Undo (`src/improver.ts`, `src/applier.ts`, `src/ui.ts`)**:
   - Once any trigger threshold in `.pi/harness2/state.json` is met, synthesizes targeted changes to `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/skills/` (or `.agents/skills/`), `.pi/agents/` ([`interactive-subagents`](https://github.com/hazat/pi-interactive-subagents) profiles), and `.pi/extensions/` guardrails.
   - Presents a Guided TUI (`Apply Changes`, `Preview Exact File Changes`, `Dismiss`, `Snooze`) with automatic backups in `.pi/harness2/backups/` and a one-step `/harness2 undo` rollback command.

## Unified Session-End & Pre-Compaction Lifecycle

- **Manual Mode (`"recordMode": "manual"`, default)**: Run `/harness2` or `/harness2 record [note]` at the end of a session. Because `resolveFullUncompactedEntries()` reads the raw session branch/file, any messages compacted earlier during the session are automatically restored and included in the digest!
- **Auto Mode (`"recordMode": "auto"`)**: Automatically hooks both `session_before_compact` and `session_shutdown`, advancing a per-session cursor (`state.sessionCursors[sessionId]`) so every turn is recorded once without losing pre-compaction context.

## Running the Test Suite

```bash
npm test
```
