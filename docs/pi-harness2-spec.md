# Technical & Test Specification: `pi-harness2` Workspace Self-Improvement Extension

- **Document Version:** 0.3.3  
- **Date:** October 29, 2026  
- **Companion Document:** `pi-harness2-prd.md`  
- **Host Runtime:** [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi) (`Node.js >= 22.19`, TypeScript Extension API)  
- **Target Subagent System:** Forked [interactive-subagents](https://drive.google.com/drive/folders/1HWVPXDBd5c3LWr3-lY_HbHZptSXzIem-) ([README.md](https://drive.google.com/file/d/1sasZ6hOROTiGDIkQeprSkj1mds_ba26T/view?usp=drivesdk), [CHANGELOG.md](https://drive.google.com/file/d/1lAnHliH7iUpMbioREtz8oAoOVBqhQTU_/view?usp=drivesdk))  
- **Reference Architecture:** [google-research/harness2](https://github.com/google-research/harness2) ([arXiv:2610.14224](https://arxiv.org/html/2610.14224v1))

---

## 1. System Architecture & Directory Layout

### 1.1 Extension Package Layout

`pi-harness2` can be installed globally (`~/.pi/agent/extensions/pi-harness2/`) or as a standard [Pi package](https://pi.dev/docs/latest/packages):

```
pi-harness2/
├── package.json                  # Manifest & optional peerDependencies
├── tsconfig.json
├── CHANGELOG.md                  # Release history
├── index.ts                      # Re-export entrypoint for Pi package loaders
├── scripts/
│   └── run-tests.mjs             # Zero-dependency test runner using node:test
├── src/
│   ├── index.ts                  # Extension entry point: register commands & lifecycle hooks
│   ├── config.ts                 # Merges ~/.pi/agent/settings.json and <cwd>/.pi/settings.json
│   ├── analyzer.ts               # Stage 1: Uncompacted branch restoration & deterministic SessionDigest builder
│   ├── recorder.ts               # Stage 2: AI Model Semantic Recorder (callPiModel & mechanical fallback)
│   ├── triggers.ts               # Evaluates trigger thresholds & cycle boundaries against WorkspaceHarnessState
│   ├── improver.ts               # LLM reflection, schema normalization & proposal synthesis
│   ├── applier.ts                # Atomic file writer, backup manager, and /harness2 undo engine
│   ├── ui.ts                     # Guided TUI proposal cards, diff previewer, and ctx.ui menus
│   └── types.ts                  # TypeScript interfaces matching Pi Extension API & schemas
├── test/
│   ├── fixtures/
│   │   └── real-sessions-sample.jsonl # Sample real session transcript fixture
│   └── harness2.test.ts          # Comprehensive unit & integration test suite (17 test cases)
└── docs/
    ├── pi-harness2-prd.md        # Product Requirements Document
    └── pi-harness2-spec.md       # Technical & Test Specification (this document)
```

### 1.2 Target Local Workspace State Layout

Inside any user workspace (`<cwd>`), `pi-harness2` reads and writes to `.pi/harness2/` and modifies standard project-level Pi configuration files per the [Pi Configuration specification](https://pi.dev/docs/latest/configuration):

```
<workspace-root>/
├── AGENTS.md                                 # Project instructions & subagent delegation rules (Editable by pi-harness2)
└── .pi/
    ├── settings.json                         # Optional workspace-level overrides for harness2
    ├── APPEND_SYSTEM.md                      # Optional system prompt additions (Editable by pi-harness2)
    ├── skills/                               # Workspace-specific skills (Created/Edited by pi-harness2)
    │   └── <skill-name>/
    │       ├── SKILL.md
    │       └── scripts/
    ├── agents/                               # Workspace-specific interactive-subagents profiles (Created/Edited by pi-harness2)
    │   └── <agent-name>.md
    ├── extensions/                           # Workspace-specific guardrail extensions (Created/Edited by pi-harness2)
    │   └── <guardrail-name>.ts
    └── harness2/                             # Internal state managed by pi-harness2
        ├── state.json                        # Cumulative counters, cycle boundary, snooze watermarks, per-session cursors
        ├── EXPERIENCE.md                     # Harness² persistent lesson log (human & LLM readable)
        ├── records/
        │   └── <YYYYMMDD-HHMMSS>_<recordId>.json # Structured TaskRecord snapshots
        └── backups/
            └── <ISO-timestamp>_<proposalId>/
                ├── manifest.json             # List of created vs. modified files, prior counters, and prior cycle boundary
                └── files/                    # Exact copies of modified files prior to apply
```

### 1.3 Package Manifest Contract (`package.json`)

Following the peer-dependency best practice established in [interactive-subagents CHANGELOG v3.8.1](https://drive.google.com/file/d/1lAnHliH7iUpMbioREtz8oAoOVBqhQTU_/view?usp=drivesdk) and [Pi Packages docs](https://pi.dev/docs/latest/packages), host-provided packages must be marked `optional: true` in `peerDependenciesMeta` to prevent duplicate installation of the Pi runtime:

```json
{
  "name": "pi-harness2",
  "version": "0.3.2",
  "type": "module",
  "main": "./index.ts",
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "peerDependenciesMeta": {
    "@earendil-works/pi-coding-agent": { "optional": true },
    "@earendil-works/pi-ai": { "optional": true },
    "@earendil-works/pi-tui": { "optional": true },
    "typebox": { "optional": true }
  }
}
```

---

## 2. Data Models & Configuration Schemas

### 2.1 Configuration Schema (`settings.json`)

`src/config.ts` resolves settings by reading `<agent-dir>/settings.json` (default `~/.pi/agent/settings.json` or `$PI_CODING_AGENT_DIR/settings.json`) and deep-merging `<cwd>/.pi/settings.json` on top:

```typescript
export interface Harness2Thresholds {
  /** Number of user steering / correction events across tasks to trigger a proposal (Default: 3) */
  userSteeringCount: number;
  /** Number of explicit instruction-violation / omission / logical-drift questions to trigger (Default: 1, immediate) */
  instructionViolationQuery: number;
  /** Cumulative tool inefficiency score across tasks to trigger a skill/tool proposal (Default: 3) */
  inefficiencyScore: number;
  /** Number of tasks in which the exact same single-occurrence error fingerprint repeats to trigger (Default: 2) */
  recurringFingerprintCount: number;
  /** Number of inferred subagent revision/re-steering events across tasks to trigger (Default: 2) */
  subagentRevisions: number;
}

export interface Harness2Config {
  /**
   * "manual" (default): only records when user runs `/harness2` or `/harness2 record`.
   * "auto": automatically records before compaction (`session_before_compact`), at session end (`session_shutdown`),
   * and prompts for pending proposal review at the start of the next session (`session_start`).
   */
  recordMode: "manual" | "auto";
  /**
   * Optional model ID for semantic recording and proposal synthesis (e.g. "google/gemini-2.5-flash").
   * Falls back to the active session model (`ctx.model`) when null/undefined.
   */
  model: string | null;
  /** Trigger thresholds for the workspace */
  thresholds: Harness2Thresholds;
  /**
   * Minimum consecutive failed/exploratory tool calls on the same objective
   * required to classify a sequence as a multi-step chain (+3 points) vs. single-step retry (+1 point).
   */
  minStepsForInefficientChain: number; // Default: 3
}
```

### 2.2 Stage 1 Output: Session Digest & Mechanical Facts

`src/analyzer.ts` deterministically condenses raw entries into a token-bounded `SessionDigest`:

```typescript
export interface ToolInvocationSummary {
  entryIndex: number;
  toolCallId?: string;
  toolName: string;
  inputSummary: string;
  targetResource?: string;
  isHardError: boolean;
  exitCode?: number;
  outputPreview?: string;
}

export interface MechanicalSessionFacts {
  filesRead: string[];
  filesWritten: string[];
  filesEdited: string[];
  rootScriptsCreated: string[];
  failedToolCalls: ToolInvocationSummary[];
  allToolInvocations: ToolInvocationSummary[];
  subagentInteractions: Array<{
    subagentName: string;
    agentProfile?: string;
    cliRunner: string;
    spawnEntryIndex: number;
    initialTaskPrompt: string;
    followUpMessages: string[];
    orchestratorEditedSameFiles: string[];
    hadChildErrorExit: boolean;
  }>;
  compactionEntriesRestored: number;
  networkRetriesIgnored: number;
}

export interface SessionDigest {
  sessionId: string;
  workspacePath: string;
  modelId?: string;
  startIndex: number;
  endIndex: number;
  totalEntriesAnalyzed: number;
  totalToolCalls: number;
  serializedTranscript: string;
  mechanicalFacts: MechanicalSessionFacts;
}
```

### 2.3 Stage 2 Output: Task Record Schema (`.pi/harness2/records/<id>.json`)

The AI Model Judge (or mechanical fallback) outputs a structured `TaskRecord`:

```typescript
export type FrictionFingerprint = string;

export interface ToolInefficiencyEvent {
  turnRange: [number, number];
  /**
   * - "single_retry_recovery": 1 error/hiccup followed by a fix (+1 point).
   * - "multi_step_chain": >= minStepsForInefficientChain trial-and-error attempts (+3 points).
   * - "temp_script_sprawl": >= 3 ad-hoc one-off scripts written in workspace root (+3 points).
   * - "unresolved_error": tool error or dead-end with no successful resolution (+1 point).
   */
  classification:
    | "single_retry_recovery"
    | "multi_step_chain"
    | "temp_script_sprawl"
    | "unresolved_error";
  scoreWeight: number;
  fingerprint: FrictionFingerprint;
  toolsInvoked: ToolInvocationSummary[];
  eventualResolutionCommand?: string;
  sprawlScriptsCreated?: string[];
  description: string;
}

export interface UserSteeringEvent {
  entryIndex: number;
  eventType:
    | "interruption"
    | "tool_rejection"
    | "corrective_steer"
    | "instruction_compliance_question";
  userMessageQuote: string;
  precedingAssistantActionSummary: string;
  rationale?: string;
}

export interface SubagentInferenceEvent {
  subagentName: string;
  agentProfile?: string;
  cliRunner: "pi" | "agy" | "claude" | "codex" | "grok" | "opencode" | string;
  initialTaskPrompt: string;
  outcomeSignal:
    | "orchestrator_revised_files"
    | "multiple_corrective_messages"
    | "child_error_exit";
  followUpMessages: string[];
  revisedFiles: string[];
}

export interface TaskRecord {
  recordId: string;
  sessionId: string;
  timestamp: string;
  workspacePath: string;
  modelId?: string;
  recordedBy: "llm_judge" | "mechanical_fallback";
  userNote?: string;
  summary: {
    totalEntriesAnalyzed: number;
    totalToolCalls: number;
    userSteeringCount: number;
    instructionComplianceQuestionCount: number;
    hasInstructionComplianceQuestion: boolean;
    inefficiencyEventCount: number;
    inefficiencyScoreAdded: number;
    subagentRevisionCount: number;
    networkRetriesIgnored: number;
    compactionEntriesRestored?: number;
  };
  steeringEvents: UserSteeringEvent[];
  inefficiencyEvents: ToolInefficiencyEvent[];
  subagentEvents: SubagentInferenceEvent[];
}
```

### 2.4 Workspace State Schema (`.pi/harness2/state.json`)

Tracks cumulative counters, active cycle boundary, snooze watermarks, and per-session cursors to avoid duplicate counting:

```typescript
export interface WorkspaceHarnessState {
  schemaVersion: 1;
  lastUpdated: string;
  /** ISO timestamp of the last applied, dismissed, or reset proposal, defining the boundary of the current friction cycle */
  lastProposalAppliedAt?: string;
  /** Map of sessionId -> last analyzed raw entry index for idempotent incremental recording */
  sessionCursors: Record<string, number>;
  counters: {
    sessionsSinceLastProposal: number;
    cumulativeUserSteering: number;
    cumulativeInstructionQuestions: number;
    cumulativeInefficiencyScore: number;
    cumulativeSubagentRevisions: number;
    /** Tracks how many tasks encountered each specific semantic FrictionFingerprint */
    fingerprintCounts: Record<string, number>;
  };
  snoozeUntilSessionCount: number;
  /** Value of cumulativeInstructionQuestions when the user last snoozed a proposal */
  snoozedAtInstructionQuestions?: number;
  recentRecordIds: string[];
  dismissedProposalSummaries: string[];
}
```

---

## 3. Two-Stage Friction Extraction Architecture

```
 Raw Session (disk / branch)
             │
             ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Stage 1: Deterministic Digest (src/analyzer.ts)             │
 │  • Full branch restoration across compaction boundaries    │
 │  • Strip <thinking>, images, and skill injections          │
 │  • Deduplicate provider errors, empty aborts & retractions │
 │  • Extract MechanicalSessionFacts via AST                  │
 └───────────────────────────┬─────────────────────────────────┘
                             │ SessionDigest (~15-25 KB)
                             ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Stage 2: AI Model Semantic Recorder (src/recorder.ts)       │
 │  • Invokes ctx.modelRegistry.complete (cacheRetention: none)│
 │  • Evaluates prompt rubric semantically (no keyword regex)  │
 │  • Discovers snake_case fingerprints & reuses prior ones    │
 │  • Mechanical fallback when offline / no model connected    │
 └───────────────────────────┬─────────────────────────────────┘
                             │ TaskRecord
                             ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Stage 3: Workspace State, Triggers & Proposals              │
 │  • Update .pi/harness2/state.json                           │
 │  • Evaluate thresholds (Rule 1-5 in src/triggers.ts)        │
 │  • Normalize & validate proposal (src/improver.ts)          │
 │  • Launch Guided TUI Proposal Flow (src/ui.ts, applier.ts)  │
 └─────────────────────────────────────────────────────────────┘
```

### 3.1 Stage 1: Deterministic Transcript Digest (`src/analyzer.ts`)

Per requirement, `src/analyzer.ts` inspects **only the main orchestrator session** and never reads external Herdr pane files:

1. **Uncompacted Branch Restoration (`resolveFullUncompactedEntries`)**:
   Reads `ctx.sessionManager.getBranch()` or the raw `.jsonl` session file from disk. In Pi's session format, compaction only appends a `type: "compaction"` entry to the JSONL log; earlier messages are never erased from disk. `resolveFullUncompactedEntries` recovers 100% of pre-compaction messages.
2. **Denoising & Token Compression**:
   - Omits `<thinking>` internal blocks.
   - Replaces multi-megabyte base64 `image` parts with `[Binary image content omitted from text digest]`.
   - Filters out retracted assistant turns (`context_edit` with `replacement: null`).
   - Discards duplicate user retry prompts when immediately preceded by a provider `stopReason: "error"`, `context_edit`, or an empty `stopReason: "aborted"` turn. Intentional repeated user messages after normal assistant responses are preserved.
   - Strips `<skill>` system prompt injection tags.
   - Result: A 3.7 MB raw `.jsonl` session log is reduced to a concise ~15–25 KB digest.
3. **Mechanical AST Facts Extraction**:
   - `filesRead`, `filesWritten`, `filesEdited`: Recorded from tool call arguments.
   - `rootScriptsCreated`: Flags one-off scripts created in the workspace root (e.g. `script.py`, `helper.mjs`).
   - `failedToolCalls` and `allToolInvocations`: Recorded from tool results (`isError: true` or `exitCode !== 0`).
   - `subagentInteractions`: Tracks `subagent` tool calls, target files mentioned, follow-up `subagent_message` calls, subsequent orchestrator edits to subagent-created files, and child error exits.

### 3.2 Stage 2: AI Model Semantic Recorder (`src/recorder.ts`)

Instead of hardcoded regular expressions, an AI Model judges the interaction semantically using Pi's native model registry:

1. **Model Invocation (`callPiModel`)**:
   Invokes `ctx.modelRegistry.complete` with `{ cacheRetention: "none", sessionId: ... }`. If `modelRegistry` is unavailable, it gracefully falls back to `ctx.completePrompt` or `ctx.sendMessage`.
2. **Recording Rules Rubric**:
   - **User Steering & Corrections (`steeringEvents`)**: Identifies turns where the user corrects the agent's tone, scope, factual errors, tool selections, or clutter left behind.
   - **Instruction Compliance / Omission / Logical-Drift Questions (`instruction_compliance_question`)**: Identifies turns where the user asks why instructions or rules in `AGENTS.md` were ignored, or questions why a key hypothesis/premise was omitted or drifted logically.
   - **Tool Inefficiencies (`inefficiencyEvents`)**:
     - `single_retry_recovery` (`scoreWeight: 1`): An atomic tool error or flag mistake fixed in 1–2 steps.
     - `multi_step_chain` (`scoreWeight: 3`): A sequence of $\ge 3$ trial-and-error attempts before succeeding.
     - `temp_script_sprawl` (`scoreWeight: 3`): Creating $\ge 3$ one-off scripts in the workspace root.
     - `unresolved_error` (`scoreWeight: 1`): An unresolved tool failure.
   - **Semantic Fingerprinting**: The model assigns a concise `snake_case` root-cause identifier to each inefficiency event (e.g., `windows_python_gbk_encoding`, `node_esm_module_resolution`). When provided existing workspace fingerprints in the prompt, the model reuses the exact string to track cross-task occurrences.
   - **Subagent Revisions (`subagentEvents`)**: Identifies when the orchestrator had to rewrite subagent deliverables, send multiple corrective `subagent_message` steers, or handled child error exits.
3. **Offline / Fallback Builder (`buildRecordFromMechanicalFacts`)**:
   If the LLM call fails or no provider is connected, falls back to deterministic AST facts extracted in Stage 1 without crashing.

---

## 4. Trigger Rules, Improvement Synthesis & Rollback

### 4.1 Trigger Rules (`src/triggers.ts`)

`evaluateTriggers(state, config)` checks the accumulated state against 5 rules:

| Rule | Trigger Reason Code | Default Threshold | Description |
| :--- | :--- | :---: | :--- |
| **Rule 1** | `EXPLICIT_INSTRUCTION_AUDIT` | $\ge 1$ (Immediate) | Fired immediately when user asks why instructions/rules were ignored or points out logical omission/drift. |
| **Rule 2** | `USER_STEERING_THRESHOLD` | $\ge 3$ | Fired when accumulated user corrections reach threshold across tasks. |
| **Rule 3** | `TOOL_INEFFICIENCY_SCORE_THRESHOLD` | $\ge 3$ | Fired when cumulative tool inefficiency points reach threshold (e.g. one `+3` chain/sprawl or three `+1` retries). |
| **Rule 4** | `RECURRING_FINGERPRINT_THRESHOLD` | $\ge 2$ tasks | Fired when the exact same single-occurrence error fingerprint occurs in $\ge 2$ distinct tasks. |
| **Rule 5** | `SUBAGENT_REVISION_THRESHOLD` | $\ge 2$ | Fired when $\ge 2$ subagent runs required orchestrator rewrites or corrective steers. |

### 4.2 Reflection & Proposal Synthesis (`src/improver.ts`)

Once triggered, `generateHarnessProposal` calls `callPiModel` with up to 10 recent `TaskRecord`s scoped to the active improvement cycle (`sinceTimestamp: state.lastProposalAppliedAt`), prioritizing records containing friction events over empty runs, along with existing `AGENTS.md` and `EXPERIENCE.md`.

`normalizeHarnessProposal` validates the returned JSON object, populates fallback `evidenceQuotes` from the recorded task evidence if omitted by the LLM, and validates all target modification paths via `validateTargetPath`:
- `AGENTS.md` or `AGENTS.override.md`
- `.pi/APPEND_SYSTEM.md` or `.pi/SYSTEM.md`
- `.pi/skills/<skill-name>/SKILL.md` (or `.agents/skills/<skill-name>/SKILL.md`)
- `.pi/agents/<agent-name>.md`
- `.pi/extensions/<guardrail-name>.ts`

If offline, `synthesizeDeterministicProposal` provides safe baseline proposals from the recorded evidence.

### 4.3 Atomic Applier, Backup & Undo Engine (`src/applier.ts`)

1. **Path Safety (`validateTargetPath`)**:
   Blocks path traversal (`..`), absolute paths, and any file outside allowed workspace configuration locations. Modifying application source files (e.g. `src/index.ts`) throws `UnauthorizedTargetPathError`.
2. **Atomic Backup**:
   Before modifying or creating files, copies existing versions into `.pi/harness2/backups/<timestamp>_<proposalId>/files/` and writes `manifest.json` (storing `previousCounters` and `previousLastProposalAppliedAt`).
3. **One-Step Undo (`undoLatestProposal`)**:
   Restores modified files byte-for-byte from the latest backup manifest, deletes files created by the proposal, restores previous counters and `lastProposalAppliedAt`, and marks the backup reverted.

### 4.4 Guided TUI Review (`src/ui.ts`)

Presents an interactive proposal card to the user:
- `1. Apply Changes (Auto-backup current files)`: Executes atomic apply, logs to `EXPERIENCE.md`, resets counters, sets `lastProposalAppliedAt`, and notifies user.
- `2. Preview Exact File Changes / Diffs`: Displays full content and rationale of each proposed change.
- `3. Dismiss Proposal (Log reason & reset counter)`: Appends dismissal to `EXPERIENCE.md`, resets counters, and sets `lastProposalAppliedAt`.
- `4. Snooze for 1 Session`: Postpones proposal for 1 session via `snoozeProposalForOneSession(state)`.

---

## 5. Host Lifecycle Hooks & CLI Commands (`src/index.ts`)

### 5.1 Lifecycle Hooks

- **Pre-Compaction Hook (`session_before_compact`)**:
  When `recordMode: "auto"`, reads `event.branchEntries` before Pi compacts the context, recording new turns since `state.sessionCursors[sessionId]` with `skipReview: true` so compaction is never blocked by an interactive menu.
- **Session Shutdown Hook (`session_shutdown`)**:
  When `recordMode: "auto"`, reads remaining turns from the session branch/file and records them at session close with `skipReview: true`.
- **Next-Session Proposal Prompt Hook (`session_start`)**:
  When starting a new session in `recordMode: "auto"`, evaluates triggers against accumulated state and prompts the user with interactive choices (`1. Review improvement proposal now` or `2. Not now (snooze for 1 session)`).
- **Per-Session Cursor (`state.sessionCursors`)**:
  Ensures that entries recorded during `session_before_compact` are never double-counted when `session_shutdown` or `/harness2 record` runs later.

### 5.2 Slash Commands

- `/harness2` or `/harness2 record [note]`: Record orchestrator transcript, evaluate triggers, and launch proposal review.
- `/harness2 status`: Show active counters, recurring fingerprints, and configuration.
- `/harness2 propose [focus]`: Force immediate proposal synthesis from current-cycle records (or ad-hoc recording of the active session) even if counters are below threshold.
- `/harness2 undo`: Roll back the most recently applied proposal in one step.
- `/harness2 reset`: Reset workspace friction counters to 0 and advance `lastProposalAppliedAt` while keeping `EXPERIENCE.md`.
- `harnees2`: Registered alias for command convenience.

---

## 6. Test Specification & Verification Matrix

The test suite is executed with `npm test` (`node scripts/run-tests.mjs`), requiring zero external dependencies:

| Test ID | Suite | Requirement Verified |
| :--- | :--- | :--- |
| **UT-CFG-01** | Config | Returns default config when no `settings.json` exists |
| **UT-CFG-02** | Config | Inherits global settings from `~/.pi/agent/settings.json` |
| **UT-CFG-03** | Config | Project `.pi/settings.json` overrides global settings; model resolves cleanly |
| **UT-DIG-01** | Stage 1 Digest | Restores pre-compaction messages across `compaction` entries; strips thinking and images |
| **UT-DIG-02** | Stage 1 Digest | Ignores `context_edit` retracted turns, provider error retries, and empty aborted retries; preserves intentional repeats |
| **UT-DIG-03** | Stage 1 Digest | Extracts mechanical facts: root script sprawl, failed tool calls, subagent file revisions |
| **UT-REC-01** | Stage 2 Recorder | Calls `ctx.modelRegistry.complete` with `SessionDigest` and parses LLM semantic judgment |
| **UT-TRG-01 & 03** | Stage 2 Triggers | Accumulates single-occurrence frictions (+1) and triggers on recurring fingerprint across tasks |
| **UT-APP-01** | Applier Safety | Blocks path traversal (`..`) and unauthorized target source paths |
| **UT-APP-02** | Applier Undo | Creates atomic backup on apply and restores workspace byte-for-byte (including `lastProposalAppliedAt`) on `/harness2 undo` |
| **IT-CMD-01 & 02** | E2E Command | Executes `/harness2 record` with LLM Judge $\to$ Preview $\to$ Apply $\to$ Undo |
| **IT-AUTO-01** | Auto Hooks | Hooks `session_before_compact` and `session_shutdown` in auto mode without double-counting or blocking compaction |
| **IT-REAL-01 & 02** | Real Logs | Compresses real 3.7 MB session logs into compact digests and feeds LLM Judge |
| **UT-NORM-01** | Normalization | Normalizes partial LLM proposals, backfills `evidenceQuotes`, filters unauthorized paths, and renders cards/previews safely |
| **UT-NORM-02** | Prioritization | Prioritizes task records containing friction events over empty session records |
| **IT-AUTO-02** | Startup & Snooze | Prompts user on `session_start`, respects snooze even for instruction audits, and re-prompts on new violation or next session |
| **UT-NORM-03** | Cycle Scoping | Strictly scopes `loadRecentTaskRecords` to `lastProposalAppliedAt` without leaking old-cycle records |
