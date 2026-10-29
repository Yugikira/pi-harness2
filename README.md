# `pi-harness2` (v0.3.0) — Self-Improving Workspace Extension for Pi Coding Agent

`pi-harness2` is a human-in-the-loop extension for [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) inspired by Google Research's [Harness²: Recursive Agent Harnessing for an Open World (arXiv:2610.14224)](https://arxiv.org/html/2610.14224v1).

Instead of running expensive multi-rollout task-level recursion or modifying Pi core, `pi-harness2` adapts **Harnessing-Level Recursion (`Reflect & Update`)** strictly to your **local project workspace**:
- Observes main orchestrator session transcripts (manually via `/harness2` or automatically when `"recordMode": "auto"` is configured).
- Uses an AI Model Judge in Stage 2 to extract friction semantically—replacing brittle keyword/regex matching.
- Captures both single-occurrence frictions (`+1` atomic error/recovery) and multi-step trial-and-error chains (`+3`), accumulating them across sessions with semantic cross-task fingerprinting.
- Proposes targeted, evidence-backed updates to your workspace's `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/skills/` (or `.agents/skills/`), `.pi/agents/` ([`interactive-subagents`](https://github.com/hazat/pi-interactive-subagents) profiles), and `.pi/extensions/` (project-level guardrails).
- Protects your workspace with a Guided TUI (`Apply Changes`, `Preview Exact File Changes`, `Dismiss`, `Snooze`), automatic backups in `.pi/harness2/backups/`, and a one-step `/harness2 undo` rollback command.

---

## Two-Stage Architecture: Deterministic Digest $\to$ AI Model Semantic Recorder

Instead of relying on brittle regexes to guess what constitutes conflict or inefficiency, `pi-harness2` v0.3.0 mirrors Google Research's [Harness²](https://github.com/google-research/harness2) and [Pi's Compaction architecture](https://pi.dev/docs/latest/compaction):

1. **Stage 1 — Full Uncompacted Branch Restoration & Token-Bounded Digest (`src/analyzer.ts`)**:
   - Restores **all raw messages across the session** (even messages that were compacted earlier in the session!) by reading `ctx.sessionManager.getBranch()` or the raw `.jsonl` session file on disk and bridging transparently across `type: "compaction"` markers.
   - Filters out `context_edit` retracted turns and network/provider `stopReason: "error"` duplicate user retries (while preserving intentional user prompt repetitions).
   - Strips `<thinking>` blocks, `<skill>` XML wrappers, and multi-megabyte base64 `image` blobs (compressing a 3.7 MB raw `.jsonl` session log down to a ~15–25 KB high-signal text digest) while mechanically extracting AST-level file facts (`filesRead`, `filesWritten`, `filesEdited`, `rootScriptsCreated`, `failedToolCalls`, `subagentInteractions`).
2. **Stage 2 — AI Model Semantic Judge & Recorder (`src/recorder.ts`)**:
   - Passes the condensed `SessionDigest`, your recording rubric, and existing workspace fingerprints from `.pi/harness2/state.json` to your configured model (or active session model) via `ctx.modelRegistry.complete(..., { cacheRetention: "none" })`.
   - The AI model semantically identifies **User Steering & Corrections**, **Explicit Instruction-Compliance / Omission / Logical-Drift Questions**, **Tool Inefficiencies** (both `+1` single-occurrence hiccups and `+3` multi-step trial-and-error chains or script sprawl, even when exit codes are `0`), and **Subagent Revisions**, reusing existing workspace fingerprints when a pattern repeats across tasks.
   - Includes an offline fallback (`buildRecordFromMechanicalFacts`) using deterministic AST facts if no LLM provider is reachable.
3. **Stage 3 — Workspace Improvement Proposals & One-Click Undo (`src/improver.ts`, `src/applier.ts`, `src/ui.ts`)**:
   - Once any trigger threshold in `.pi/harness2/state.json` is met, synthesizes targeted changes to `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/skills/` (or `.agents/skills/`), `.pi/agents/` ([`interactive-subagents`](https://github.com/hazat/pi-interactive-subagents) profiles), and `.pi/extensions/` guardrails.
   - Presents a Guided TUI (`Apply Changes`, `Preview Exact File Changes`, `Dismiss`, `Snooze`) with automatic backups in `.pi/harness2/backups/` and a one-step `/harness2 undo` rollback command.

---

## Installation

### As a standard Pi package
```bash
pi install git@github.com:Yugikira/pi-harness2.git
```

### Manual Installation
Copy or clone this directory into your global Pi extensions directory (or project `.pi/extensions/pi-harness2`):

```bash
mkdir -p ~/.pi/agent/extensions/pi-harness2
cp -r * ~/.pi/agent/extensions/pi-harness2/
```

Then reload Pi by running `/reload` in your active session.

---

## Slash Commands

| Command | Description |
| :--- | :--- |
| `/harness2` or `/harness2 record [note]` | Analyze the current main orchestrator session, record friction events via the AI Model Judge, update workspace counters, and launch the Guided Proposal UI if a threshold is met. |
| `/harness2 status` | Show current workspace friction counters, recurring error fingerprints, and active configuration. |
| `/harness2 propose [focus]` | Force an immediate workspace improvement proposal from recorded history even if counters are below threshold. |
| `/harness2 undo` | Revert the most recently applied proposal from `.pi/harness2/backups/` in one step. |
| `/harness2 reset` | Reset cumulative workspace counters to `0` while keeping `.pi/harness2/EXPERIENCE.md`. |

*(Note: `/harnees2` is also registered as a convenience alias for typos.)*

---

## Configuration (`settings.json`)

Configure globally in `~/.pi/agent/settings.json` or per-project in `<workspace>/.pi/settings.json` (project settings override global settings):

```json
{
  "harness2": {
    "recordMode": "manual",
    "model": null,
    "thresholds": {
      "userSteeringCount": 3,
      "instructionViolationQuery": 1,
      "inefficiencyScore": 3,
      "recurringFingerprintCount": 2,
      "subagentRevisions": 2
    },
    "minStepsForInefficientChain": 3
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `recordMode` | `"manual" \| "auto"` | `"manual"` | When `"manual"`, records only when running `/harness2` or `/harness2 record`. When `"auto"`, automatically hooks `session_before_compact` and `session_shutdown`. |
| `model` | `string \| null` | `null` | Optional model ID for the Stage 2 Recorder and Stage 3 Improver (e.g. `"google/gemini-2.5-flash"`). When `null`, falls back to the active session model (`ctx.model`). |
| `thresholds.userSteeringCount` | `number` | `3` | Number of user steering/correction events across tasks to trigger a proposal. |
| `thresholds.instructionViolationQuery` | `number` | `1` | Number of explicit instruction-violation / omission / logical-drift questions to trigger (default: 1, immediate trigger). |
| `thresholds.inefficiencyScore` | `number` | `3` | Cumulative tool inefficiency points across tasks (multi-step chains and script sprawl add `+3`; single retries/errors add `+1`). |
| `thresholds.recurringFingerprintCount` | `number` | `2` | Triggers a proposal when the exact same error fingerprint repeats across $\ge 2$ tasks, even if total score hasn't reached 3. |
| `thresholds.subagentRevisions` | `number` | `2` | Number of inferred subagent runs requiring orchestrator rewrites or corrective messages to trigger. |
| `minStepsForInefficientChain` | `number` | `3` | Minimum consecutive exploratory/failed tool calls on an objective to classify as a multi-step chain (`+3` points). |

---

## How Single-Occurrence vs. Multi-Step Frictions Are Recorded

1. **Every friction event is recorded**, even if it only happens **once** in a task:
   - **Single User Steer / Correction**: Adds `+1` to `cumulativeUserSteering` (triggers at `3`).
   - **Explicit Instruction / Omission / Logical-Drift Question**: Adds `+1` to `cumulativeInstructionQuestions` (triggers **immediately** at `1`).
   - **Single-Step Tool Error + Fix (`1 fail -> 1 fix`)**: Recorded as a `single_retry_recovery` event (`+1` inefficiency point) with a normalized snake_case **fingerprint** (e.g., `windows_python_gbk_encoding`, `node_esm_module_resolution`, `git_outside_repo`). If the same fingerprint occurs once in Task 1 and once in Task 2 (`recurringFingerprintCount >= 2`), or total inefficiency points reach `3` across tasks, a proposal is triggered!
   - **Multi-Step Trial-and-Error Chain ($\ge 3$ attempts in one task)** or **Temporary Script Sprawl ($\ge 3$ ad-hoc scripts written in root)**: Recorded as `+3` inefficiency points, immediately reaching the default `inefficiencyScore` threshold of `3` to propose a reusable Skill.
   - **Subagent Revisions**: When the orchestrator rewrites child deliverables, sends $\ge 2$ corrective `subagent_message` steers, or handles child error exits, it adds `+1` to `cumulativeSubagentRevisions` (triggers at `2`).

---

## Guided TUI & Workspace Safety

When a threshold is met or `/harness2 propose` is run, `pi-harness2` displays an interactive review menu:
- `1. Apply Changes (Auto-backup current files)`: Automatically creates an exact snapshot in `.pi/harness2/backups/<timestamp>_<proposalId>/`, applies the proposed files, logs the lesson in `.pi/harness2/EXPERIENCE.md`, and resets workspace friction counters.
- `2. Preview Exact File Changes / Diffs`: Displays the full content and rationale for each proposed file modification.
- `3. Dismiss Proposal (Log reason & reset counter)`: Discards the proposal, logs the dismissal in `EXPERIENCE.md`, and resets counters.
- `4. Snooze for 1 Session`: Postpones the proposal for 1 session.

### One-Step Rollback (`/harness2 undo`)
If an applied proposal causes unwanted behavior, run `/harness2 undo`. It restores modified files byte-for-byte from the backup manifest, removes newly created files, and restores previous counters.

---

## Unified Session-End & Pre-Compaction Lifecycle

- **Manual Mode (`"recordMode": "manual"`, default)**: Run `/harness2` or `/harness2 record [note]` at the end of a session. Because `resolveFullUncompactedEntries()` reads the raw session branch/file, any messages compacted earlier during the session are automatically restored and included in the digest!
- **Auto Mode (`"recordMode": "auto"`)**: Automatically hooks both `session_before_compact` and `session_shutdown`, advancing a per-session cursor (`state.sessionCursors[sessionId]`) so every turn is recorded once without losing pre-compaction context or double-counting.

---

## Running the Test Suite

```bash
npm test
```
