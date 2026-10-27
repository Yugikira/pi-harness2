# `pi-harness2` — Self-Improving Workspace Extension for Pi Coding Agent

`pi-harness2` is a lightweight, human-in-the-loop extension for [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) inspired by Google Research's [Harness²: Recursive Agent Harnessing for an Open World (arXiv:2610.14224)](https://arxiv.org/html/2610.14224v1).

Instead of running expensive multi-rollout task-level recursion (`Propose–Probe–Compose`) or modifying Pi core, `pi-harness2` adapts **Harnessing-Level Recursion (`Reflect & Update`)** strictly to your **local project workspace**:
- Records main orchestrator session transcripts (manually via `/harness2` / `/harness2 record`, or automatically when `"recordMode": "auto"` is configured).
- Captures **both single-occurrence-per-task frictions** (`+1` atomic error/recovery or steering event) and **multi-step trial-and-error tool chains** (`+3` chain score), accumulating them across sessions with cross-task fingerprinting.
- Proposes targeted, evidence-backed updates to your workspace's `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `.pi/skills/` (or `.agents/skills/`), `.pi/agents/` ([`interactive-subagents`](https://github.com/hazat/pi-interactive-subagents) role profiles), and `.pi/extensions/` (project-level guardrails).
- Protects your workspace with a Guided TUI (`Apply Changes` / `Preview Exact Changes` / `Dismiss` / `Snooze`), automatic backups in `.pi/harness2/backups/`, and a one-step `/harness2 undo` command.

## Installation

Copy this folder into your global Pi extensions directory (or project `.pi/extensions/pi-harness2`):

```bash
mkdir -p ~/.pi/agent/extensions/pi-harness2
cp -r * ~/.pi/agent/extensions/pi-harness2/
```

Then run `/reload` inside Pi.

## Slash Commands

| Command | Description |
| :--- | :--- |
| `/harness2` or `/harness2 record [note]` | Analyze the current main orchestrator session, save a `TaskRecord`, update workspace friction counters, and launch the Guided Proposal UI if a threshold is met. |
| `/harness2 status` | Show current workspace friction counters, recurring error fingerprints, and active configuration. |
| `/harness2 propose [focus]` | Force an immediate workspace improvement proposal from recorded history even if counters are below threshold. |
| `/harness2 undo` | Revert the most recently applied proposal from `.pi/harness2/backups/` in one step. |
| `/harness2 reset` | Reset cumulative workspace counters to `0` while keeping `.pi/harness2/EXPERIENCE.md`. |

*(Note: `/harnees2` is also registered as a convenience alias.)*

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

## How Single-Occurrence vs. Multi-Step Frictions Are Recorded

1. **Every friction event is recorded**, even if it only happens **once** in a task:
   - **Single User Steer / Correction**: Adds `+1` to `cumulativeUserSteering` (triggers at `3`).
   - **Explicit Instruction / Omission / Logical-Drift Question**: Adds `+1` to `cumulativeInstructionQuestions` (triggers **immediately** at `1`).
   - **Single-Step Tool Error + Fix (`1 fail -> 1 fix`)**: Recorded as a `single_retry_recovery` event (`+1` inefficiency point) with a normalized **fingerprint** (e.g., `python_stdout_encoding_gbk`, `node_esm_module_resolution`, `git_outside_repo`, `openalex_api_query`). If the same fingerprint occurs once in Task 1 and once in Task 2 (`recurringFingerprintCount >= 2`), or total inefficiency points reach `3` across tasks, a proposal is triggered!
   - **Multi-Step Trial-and-Error Chain (`>= 3` attempts in one task)** or **Temporary Script Sprawl (`>= 3` ad-hoc scripts written in root)**: Recorded as `+3` inefficiency points, immediately reaching the default `inefficiencyScore` threshold of `3` to propose a reusable Skill.

## Running the Test Suite

```bash
npm test
```
