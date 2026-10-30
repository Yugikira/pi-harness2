import type {
  Harness2Config,
  HarnessProposal,
  PiCommandContext,
  WorkspaceHarnessState,
} from "./types.js";
import {
  appendExperienceEntry,
  applyHarnessProposal,
} from "./applier.js";
import {
  resetStateCounters,
  saveWorkspaceState,
  snoozeProposalForOneSession,
} from "./triggers.js";

export const MENU_OPTION_APPLY = "1. Apply Changes (Auto-backup current files)";
export const MENU_OPTION_PREVIEW = "2. Preview Exact File Changes / Diffs";
export const MENU_OPTION_DISMISS = "3. Dismiss Proposal (Log reason & reset counter)";
export const MENU_OPTION_SNOOZE = "4. Snooze for 1 Session";

/**
 * Formats a concise, plain-English Proposal Card for the terminal.
 */
export function formatProposalCard(proposal: HarnessProposal): string {
  const situation =
    proposal.experienceEntry?.situation ||
    proposal.diagnosisSummary ||
    "Workspace friction threshold met";
  const evidenceQuotes = Array.isArray(proposal.experienceEntry?.evidenceQuotes)
    ? proposal.experienceEntry.evidenceQuotes
    : [];
  const fileOperations = Array.isArray(proposal.fileOperations)
    ? proposal.fileOperations
    : [];

  const lines = [
    "╭─ Harness² Workspace Improvement Proposal ─────────────────────────╮",
    `  Proposal ID: ${proposal.proposalId} (Model: ${proposal.modelUsed})`,
    `  Why this triggered: ${situation}`,
    "",
    "  Observed Evidence:",
    ...(evidenceQuotes.length > 0
      ? evidenceQuotes.map((q) => `    • ${q}`)
      : ["    • (Extracted from recent task friction events)"]),
    "",
    "  Proposed Workspace Modifications:",
    ...fileOperations.map(
      (op) => `    • [${(op.operation || "UPDATE").toUpperCase()}] ${op.targetPath} — ${op.rationale}`
    ),
    "╰───────────────────────────────────────────────────────────────────╯",
  ];
  return lines.join("\n");
}

/**
 * Formats the full file preview for all proposed operations.
 */
export function formatProposalPreview(proposal: HarnessProposal): string {
  const fileOperations = Array.isArray(proposal.fileOperations)
    ? proposal.fileOperations
    : [];
  return fileOperations
    .map((op) =>
      [
        `=== [${(op.operation || "UPDATE").toUpperCase()}] ${op.targetPath} (${op.componentType || "skill"}) ===`,
        `Rationale: ${op.rationale || "Workspace improvement"}`,
        "-------------------------------------------------------------------",
        (op.fullNewContent || "").trimEnd(),
        "===================================================================",
      ].join("\n")
    )
    .join("\n\n");
}

/**
 * Formats the `/harness2 status` dashboard output.
 */
export function formatWorkspaceStatus(
  workspaceDir: string,
  state: WorkspaceHarnessState,
  config: Harness2Config
): string {
  const fps = Object.entries(state.counters.fingerprintCounts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");

  return [
    `Harness² Workspace Status (${workspaceDir})`,
    `  • Record Mode: ${config.recordMode} | Improver Model: ${config.model ?? "active-session-model (fallback)"}`,
    `  • Sessions since last proposal: ${state.counters.sessionsSinceLastProposal}`,
    `  • User Steering & Corrections: ${state.counters.cumulativeUserSteering} / ${config.thresholds.userSteeringCount}`,
    `  • Explicit Instruction Violation Queries: ${state.counters.cumulativeInstructionQuestions} / ${config.thresholds.instructionViolationQuery} (immediate trigger)`,
    `  • Tool Inefficiency Score: ${state.counters.cumulativeInefficiencyScore} / ${config.thresholds.inefficiencyScore}`,
    `  • Recurring Fingerprints across Tasks (threshold ${config.thresholds.recurringFingerprintCount}): ${fps || "none"}`,
    `  • Inferred Subagent Revisions: ${state.counters.cumulativeSubagentRevisions} / ${config.thresholds.subagentRevisions}`,
  ].join("\n");
}

/**
 * Runs the interactive Guided TUI flow (`Apply` / `Preview` / `Dismiss` / `Snooze`).
 */
export async function runGuidedProposalReview(
  workspaceDir: string,
  proposal: HarnessProposal,
  state: WorkspaceHarnessState,
  ctx: PiCommandContext
): Promise<"applied" | "dismissed" | "snoozed" | "cancelled"> {
  ctx.ui.notify(formatProposalCard(proposal), "info");

  while (true) {
    const choice = await ctx.ui.select(
      "Harness² Workspace Improvement Proposal — Choose an action:",
      [
        MENU_OPTION_APPLY,
        MENU_OPTION_PREVIEW,
        MENU_OPTION_DISMISS,
        MENU_OPTION_SNOOZE,
      ]
    );

    if (!choice) {
      return "cancelled";
    }

    if (choice === MENU_OPTION_PREVIEW || choice.startsWith("2.")) {
      ctx.ui.notify(formatProposalPreview(proposal), "info");
      continue;
    }

    if (choice === MENU_OPTION_APPLY || choice.startsWith("1.")) {
      try {
        const { backupDir } = applyHarnessProposal(workspaceDir, proposal);
        ctx.ui.notify(
          `Applied ${proposal.fileOperations.length} workspace improvement(s)! Backup saved to ${backupDir}. Run \`/reload\` to activate new skills/agents/extensions, or \`/harness2 undo\` to revert.`,
          "success"
        );
        return "applied";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to apply proposal: ${msg}`, "error");
        return "cancelled";
      }
    }

    if (choice === MENU_OPTION_DISMISS || choice.startsWith("3.")) {
      appendExperienceEntry(workspaceDir, proposal, "DISMISSED");
      state.dismissedProposalSummaries.push(proposal.diagnosisSummary);
      resetStateCounters(state);
      saveWorkspaceState(workspaceDir, state);
      ctx.ui.notify(
        "Proposal dismissed. Friction counters reset and dismissal logged in `.pi/harness2/EXPERIENCE.md`.",
        "info"
      );
      return "dismissed";
    }

    if (choice === MENU_OPTION_SNOOZE || choice.startsWith("4.")) {
      snoozeProposalForOneSession(state);
      saveWorkspaceState(workspaceDir, state);
      ctx.ui.notify("Proposal snoozed for 1 session.", "info");
      return "snoozed";
    }
  }
}
