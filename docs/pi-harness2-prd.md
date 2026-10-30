# Product Requirements Document (PRD): `pi-harness2` — Self-Improving Workspace Extension for Pi Coding Agent

- **Document Version:** 0.3.2  
- **Date:** October 29, 2026  
- **Target Platform:** [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi) (`v0.87.1+` / `v1.0+`)  
- **Subagent Integration:** Forked [interactive-subagents](https://drive.google.com/drive/folders/1HWVPXDBd5c3LWr3-lY_HbHZptSXzIem-) ([README.md](https://drive.google.com/file/d/1sasZ6hOROTiGDIkQeprSkj1mds_ba26T/view?usp=drivesdk), [CHANGELOG.md](https://drive.google.com/file/d/1lAnHliH7iUpMbioREtz8oAoOVBqhQTU_/view?usp=drivesdk), based on [HazAT/pi-interactive-subagents](https://github.com/hazat/pi-interactive-subagents))  
- **Conceptual Foundation:** [google-research/harness2](https://github.com/google-research/harness2) & [Harness²: Recursive Agent Harnessing for an Open World (arXiv:2610.14224)](https://arxiv.org/html/2610.14224v1)

## 1. Executive Summary & Product Vision

### 1.1 Problem Statement

In [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi), an agent's day-to-day effectiveness depends heavily on its local workspace setup—its `AGENTS.md` instructions, `.pi/skills/` (or `.agents/skills/`) workflows, `.pi/agents/` subagent definitions, and `.pi/extensions/` guardrails. When working across dedicated task-specific workspaces (such as grading automation, research data pipelines, slide/syllabus generation, or code maintenance), users frequently encounter repeated friction:

1. The agent takes a roundabout, trial-and-error sequence of tool calls or creates ad-hoc script sprawl before discovering the working command or script.  
2. The user has to repeatedly steer, interrupt, or ask why the agent ignored project instructions or drifted logically from the user's thesis.  
3. Delegated tasks to subagents via [interactive-subagents](https://drive.google.com/file/d/1sasZ6hOROTiGDIkQeprSkj1mds_ba26T/view?usp=drivesdk) return incomplete results that the main orchestrator session must manually revise or re-steer.

While Google Research's [Harness² framework](https://github.com/google-research/harness2) demonstrates that rewriting the 8 harness components around a frozen model significantly boosts task performance, its full benchmark pipeline runs expensive multi-rollout task-level recursion (`Propose–Probe–Compose`, costing $4k$ executions per task) and modifies the global executor harness. For an individual user who manually organizes distinct tasks into separate local workspaces, running multiple parallel rollouts per task is too slow, costly, and invasive.

### 1.2 Product Vision

`pi-harness2` is a lightweight, human-in-the-loop [Pi Coding Agent extension](https://pi.dev/docs/latest/extensions) that adapts **Harnessing-Level Recursion (`Reflect & Update`)** from the [Harness² paper](https://arxiv.org/html/2610.14224v1) strictly to a user's **local workspace setup**.

Instead of rerunning tasks in the background or altering `pi-coding-agent` core, `pi-harness2`:

1. **Records** main orchestrator session trajectories (manually via `/harness2` or `/harness2 record`, or automatically across `session_before_compact` and `session_shutdown` when configured to `"auto"`), restoring full uncompacted branch history across compaction boundaries.  
2. **Judges Semantically** via a Two-Stage Architecture (Deterministic Digest $\to$ AI Model Semantic Recorder) to detect friction and inefficiency patterns across sessions in that specific workspace—including single-occurrence tool errors (`+1`) with cross-task semantic fingerprinting, multi-step trial-and-error chains (`+3`), user steering corrections, explicit instruction-compliance/logical-drift audits, and post-subagent revisions.  
3. **Proposes** targeted, evidence-backed updates to the local workspace's configuration (`AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/skills/` or `.agents/skills/`, `.pi/agents/`, `.pi/extensions/`, and `.pi/harness2/EXPERIENCE.md`) scoped to the active improvement cycle (`lastProposalAppliedAt`).  
4. **Applies & Protects** changes through a beginner-friendly terminal menu (`Apply` / `Preview` / `Dismiss` / `Snooze`) backed by automatic snapshots and a one-step `/harness2 undo` rollback command.

## 2. Theoretical Grounding: Adapting Google Research's Harness² to Local Pi Workspaces

| Dimension | Google Research [Harness²](https://arxiv.org/html/2610.14224v1) | `pi-harness2` Workspace Extension (Our Adaptation) |
| :--- | :--- | :--- |
| **Task Grouping** | Open-world stream of mixed tasks | User manually separates distinct task types into dedicated local workspaces |
| **Task-Level Loop** | Multi-rollout `Propose–Probe–Compose` ($4k$ rollouts per task) | **Omitted** — zero extra rollouts during normal task execution; single natural task run |
| **Harnessing-Level Loop** | Distills trajectories into `EXPERIENCE.md` and reusable harness components | **Core Engine** — analyzes recorded orchestrator sessions via AI Model Judge and proposes workspace-local `.pi/` improvements once trigger criteria are met |
| **Session Scope** | Full executor & child traces | **Main orchestrator session only** — subagent issues are inferred when the orchestrator steers or revises subagent outputs |
| **Approval Model** | Autonomous agentic selector | **Human-in-the-loop Guided TUI** (`Apply` / `Preview` / `Dismiss` / `Snooze`) + `/harness2 undo` |

### 2.1 Mapping Harness²'s 8 Editable Components to Local Pi Files

Following the [Pi Configuration hierarchy](https://pi.dev/docs/latest/configuration) and the user's [interactive-subagents](https://drive.google.com/file/d/1sasZ6hOROTiGDIkQeprSkj1mds_ba26T/view?usp=drivesdk) specification, `pi-harness2` maps all eight editable components from [Harness² Section 2.1](https://arxiv.org/html/2610.14224v1) to workspace-local files:

| Harness² Component | Target Local File(s) in Workspace | Purpose & Triggering Signal |
| :--- | :--- | :--- |
| **1. System Prompt** | `AGENTS.md` / `.pi/APPEND_SYSTEM.md` | High-level project rules, directory conventions, and behavioral expectations. Updated when user steering or instruction-failure queries occur. |
| **2. Tool Guidance** | `AGENTS.md` (Tool Rules section) | Specific CLI flags, preferred tool sequences, and environment notes. |
| **3. Memory** | `.pi/harness2/EXPERIENCE.md` | Structured lesson library recording *Situation*, *Observed Evidence*, *Lesson Learned*, and *Targeted Files* across workspace sessions. |
| **4. Skills** | `.pi/skills/<skill-name>/SKILL.md` (or `.agents/skills/<skill-name>/SKILL.md`) | Reusable step-by-step workflows created when the agent takes a trial-and-error path or repeats a fingerprinted error across tasks. |
| **5. Scripts** | `.pi/skills/<skill-name>/scripts/*` | Deterministic helper scripts (Bash/Python/Node) bundled inside a skill to replace fragile multi-step bash chains or root script sprawl. |
| **6. Subagents** | `.pi/agents/<agent-name>.md` | Role profiles for [interactive-subagents](https://drive.google.com/file/d/1sasZ6hOROTiGDIkQeprSkj1mds_ba26T/view?usp=drivesdk) (`name`, `description`, `model`, `thinking`, `tools`, `session-mode`, `auto-exit`, `cli`). Updated when the orchestrator has to revise or repeatedly re-steer subagent output. |
| **7. Guardrails** | `.pi/extensions/<guardrail-name>.ts` | Project-level TypeScript extension hooks (`pi.on("tool_call", ...)` / `pi.on("user_bash", ...)`) that block known bad commands or require `ctx.ui.confirm`. |
| **8. Middleware Plugins** | `.pi/extensions/<plugin-name>.ts` | Project-level lifecycle hooks (e.g., `turn_end` checks or automatic linter/test reminders). |

## 3. Target User Persona & Non-Goals

### 3.1 Target User Persona

- **Profile:** Power user / academic educator (e.g., Business School Professor) who actively experiments with AI coding agents and custom subagents, organizes distinct workflows into dedicated project folders, and wants workspaces to self-improve over time without manually authoring complex TypeScript hooks or skill files from scratch.  
- **Needs:** Plain-English explanations of *why* a workspace modification is suggested, zero-friction approval in the terminal, and a foolproof `undo` button if a generated skill or guardrail causes unexpected behavior.

### 3.2 Explicit Non-Goals

- **No Modification of Pi Core:** The extension must never modify global `@earendil-works/pi-coding-agent` binaries or global `~/.pi/agent/` skills/prompts; all generated improvements live inside the current project workspace (`./AGENTS.md`, `./.pi/`, and `./.agents/skills/`).  
- **No Multi-Rollout Task Probing:** The extension will not spawn background duplicate executions of the user's task to A/B test prompts during a run.  
- **No Child Subagent Log Parsing (v1):** The extension will not parse external Herdr pane transcripts or `.parked`/`.exit` sidecar files directly; all subagent effectiveness signals are inferred from the main orchestrator session transcript (`subagent` calls, `subagent_message` follow-ups, `ask_question` turns, and orchestrator edits to files touched by the subagent).  
- **No Automatic Task Routing Across Workspaces:** The user manually separates tasks into workspaces.

## 4. Functional Requirements

### FR-1: Slash Command Interface (`/harness2`)

Registered via `pi.registerCommand("harness2", ...)` in the [Pi Extension API](https://pi.dev/docs/latest/extensions) (with alias `/harnees2` to gracefully handle typos):

- **`/harness2` or `/harness2 record [optional note]`**: Restores the full uncompacted main orchestrator session transcript, builds a token-bounded `SessionDigest`, invokes the Stage 2 AI Model Recorder to extract structured friction events into `.pi/harness2/records/`, updates workspace counters, and launches the proposal flow if any trigger threshold is met.  
- **`/harness2 status`**: Displays the current workspace's accumulated metrics (sessions since last proposal, User Steering count, Instruction Violation queries, Tool Inefficiency score, Recurring Fingerprints across tasks, Subagent Revision count, and active `recordMode`).  
- **`/harness2 propose [optional focus]`**: Forces an immediate reflection and improvement proposal using current-cycle records (or ad-hoc recording of unrecorded turns in the active session) even if thresholds haven't been crossed yet.  
- **`/harness2 undo`**: Restores the most recent workspace configuration backup from `.pi/harness2/backups/<timestamp>_<proposalId>/` (including prior counters and cycle boundary timestamp) and prompts the user to run `/reload`.  
- **`/harness2 reset`**: Resets current friction/inefficiency counters and advances `lastProposalAppliedAt` without deleting historical `EXPERIENCE.md` lessons.

### FR-2: Configurable Recording Mode (Manual vs. Auto) & Model Selection

Configuration is read by merging global settings (`~/.pi/agent/settings.json`) with project-local settings (`.pi/settings.json`), where **project-local settings take precedence**:

- **`harness2.recordMode`**:  
  - `"manual"` *(Default)*: Sessions are only recorded when the user runs `/harness2` or `/harness2 record`.  
  - `"auto"`: The extension hooks `session_before_compact` and `session_shutdown` (with `skipReview: true` so background recording never blocks compaction or exit) to incrementally record new turns via `state.sessionCursors[sessionId]`, and prompts the user at the next `session_start` when a trigger threshold has been reached.  
- **`harness2.model`**:  
  - Optional string (e.g., `"anthropic/claude-opus-4-8"` or `"google/gemini-2.5-flash"`).  
  - If omitted or unavailable, automatically falls back to the **currently active session model** (`ctx.model`).

### FR-3: Trigger Criteria & Friction/Inefficiency Detection

The extension evaluates the main orchestrator transcript after each recorded task and triggers an improvement proposal when **any** of the following five conditions are satisfied:

| Trigger Rule | Detection Logic (Main Orchestrator Transcript Only) | Default Threshold | Primary Suggested Target |
| :--- | :--- | :--- | :--- |
| **1. Explicit Instruction / Omission / Logical-Drift Audit** | Detects user messages explicitly questioning instruction compliance, omitted assumptions, or logical drift from the user's thesis. | **Count $\ge 1$** (Immediate trigger) | `AGENTS.md` restructure or `.pi/extensions/` hard guardrail |
| **2. User Steering & Corrections** | Counts turns where the user interrupts, rejects a tool confirmation, or sends a steering/correction message fixing the assistant's prior action. | **Count $\ge 3$** (across workspace records in current cycle) | `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, or `.pi/extensions/<guardrail>.ts` |
| **3. Cumulative Tool Inefficiency Score** | Multi-step trial-and-error chains ($\ge 3$ attempts) and root script sprawl ($\ge 3$ scripts) add `+3` points; single-occurrence error/recovery events add `+1` point. | **Score $\ge 3$** (configurable) | `.pi/skills/<name>/SKILL.md` (+ optional helper script in `scripts/`) |
| **4. Recurring Fingerprint Across Tasks** | Tracks normalized `snake_case` root-cause fingerprints across tasks so a single-occurrence error (`+1`) that repeats across tasks still triggers. | **Tasks $\ge 2$** with same fingerprint | `.pi/skills/<name>/SKILL.md` or `AGENTS.md` Tool Guidance |
| **5. Subagent Revision / Re-Steering** | Detects when a `subagent(...)` call completes and the orchestrator rewrites its files, sends $\ge 2$ corrective `subagent_message` steers, or handles a child error exit. | **Count $\ge 2$ revisions** (configurable) | `.pi/agents/<role>.md` frontmatter/prompt or `AGENTS.md` |

### FR-4: Evidence-Backed Reflection & Proposal Generation

When triggered, `pi-harness2` invokes the configured Improver Model (or active session model) with:

1. Up to 10 recent task records scoped to the current improvement cycle (`sinceTimestamp: state.lastProposalAppliedAt`), prioritizing records containing friction events over empty runs.  
2. The current workspace's `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/harness2/EXPERIENCE.md`, recurring fingerprint counts, previously dismissed proposal summaries, and existing assets in `skills/`, `.pi/agents/`, and `.pi/extensions/`.  
3. Runtime schema normalization (`normalizeHarnessProposal`) ensuring all required fields (`experienceEntry.evidenceQuotes`, validated `fileOperations`) are populated with safe fallbacks.

### FR-5: Guided Review, Auto-Backup, and One-Click Undo UX

Using [Pi's `ctx.ui` API](https://pi.dev/docs/latest/extensions):

1. **Proposal Summary Card:** Prints a clean summary in the terminal showing why the proposal triggered, observed evidence quotes, and the list of proposed file operations.  
2. **Interactive Selection (`ctx.ui.select`):**  
   - `1. Apply Changes (Auto-backup current files)`  
   - `2. Preview Exact File Changes / Diffs`  
   - `3. Dismiss Proposal (Log reason & reset counter)`  
   - `4. Snooze for 1 Session`  
3. **Safe Application & Backup:**  
   - Choosing **Apply** copies all affected files into `.pi/harness2/backups/<ISO-timestamp>_<proposalId>/` along with a `manifest.json`, writes the new/updated files, appends the new entry to `.pi/harness2/EXPERIENCE.md`, resets the workspace friction counters to `0`, records `lastProposalAppliedAt`, and notifies the user to run `/reload`.

## 5. User Experience Walkthroughs

### Scenario A: Turning Trial-and-Error Tool Usage or Recurring Single-Step Errors into a Workspace Skill

1. Across two sessions in a course-analytics workspace, the agent hits a Windows Python GBK `UnicodeEncodeError` once per session (`+1` point each, fingerprint `windows_python_gbk_encoding` count reaches `2`), or spends 4 bash calls rediscovering a UTF-8-SIG CSV normalization command (`+3` points).  
2. You run `/harness2 record` (or have `"recordMode": "auto"` enabled, which records on `session_shutdown` and prompts you on the next `session_start`).  
3. `pi-harness2` displays a proposal:  
   - **Diagnosis:** Recurring `windows_python_gbk_encoding` / CSV normalization friction across tasks.  
   - **Proposal:** Create `.pi/skills/grade-csv-normalizer/SKILL.md` with a bundled script `.pi/skills/grade-csv-normalizer/scripts/normalize.py` and reference it in `AGENTS.md`.  
4. You select **Apply Changes** and run `/reload`. Next time, the agent invokes the skill on the first try.

### Scenario B: Fixing Subagent Instructions Inferred from Orchestrator Revisions

1. In your research workspace, the main orchestrator spawns `subagent({ agent: "researcher", task: "Summarize the 3 PDF papers in ./papers" })`.  
2. When `researcher` returns its summary, the orchestrator notices missing methodology tables and has to send two `subagent_message` corrections and manually edit `summary.md`.  
3. On `/harness2 record`, the extension infers from the main session transcript that the `researcher` subagent profile lacked explicit output structure instructions.  
4. Once triggered, `pi-harness2` proposes creating/updating `.pi/agents/researcher.md` (which overrides the global profile per [interactive-subagents discovery rules](https://drive.google.com/file/d/1sasZ6hOROTiGDIkQeprSkj1mds_ba26T/view?usp=drivesdk)) with a tailored prompt and `tools` allowlist for your workspace.

### Scenario C: Immediate Trigger When Asking Why Instructions Were Ignored

1. You have a rule in `AGENTS.md` saying *"Never overwrite raw data files in `./data/raw/`."* The agent attempts to edit a file there, and you ask: *"Why didn't you follow instructions in AGENTS.md about `./data/raw/`?"*  
2. When the session is recorded, **Trigger Rule #1 (`EXPLICIT_INSTRUCTION_AUDIT`)** fires immediately.  
3. `pi-harness2` recognizes that a soft text rule in `AGENTS.md` was insufficient and proposes a lightweight project-level guardrail extension `.pi/extensions/protect-raw-data.ts` that intercepts `write`/`edit`/`bash` calls targeting `./data/raw/` and blocks them deterministically.

## 6. Success Metrics & Future Roadmap

### 6.1 Success Metrics

- **Reduction in Steering & Corrections:** Decrease in average user steering events per session within a workspace after applying 1–2 `pi-harness2` proposals.  
- **Reduction in Tool Calls per Task:** Fewer wasted exploratory `bash`/`edit` calls on recurring workspace tasks (mirroring [Harness²'s step-count reduction](https://arxiv.org/html/2610.14224v1)).  
- **Zero Unrecoverable Workspace Breakage:** 100% of applied proposals can be cleanly reverted via `/harness2 undo`.

### 6.2 Future Roadmap (v2+)

- **Optional Child Subagent Transcript Inspection:** Opt-in reading of child Pi session logs for deeper subagent diagnostics when orchestrator-level inference is insufficient.  
- **Cross-Workspace Lesson Export (`/harness2 export-skill`):** Allow promoting a battle-tested local `.pi/skills/` or `.pi/agents/` file to global `~/.pi/agent/` when the user wants it everywhere.
