import * as fs from "node:fs";
import type {
  PiCommandContext,
  PiExtensionAPI,
  PiSessionEntry,
} from "./types.js";
import { loadHarness2Config } from "./config.js";
import {
  analyzeOrchestratorTranscript,
  loadSessionJsonlFile,
} from "./analyzer.js";
import {
  applyTaskRecordToState,
  evaluateTriggers,
  loadRecentTaskRecords,
  loadWorkspaceState,
  resetStateCounters,
  saveTaskRecord,
  saveWorkspaceState,
} from "./triggers.js";
import { generateHarnessProposal } from "./improver.js";
import { undoLatestProposal } from "./applier.js";
import {
  formatWorkspaceStatus,
  runGuidedProposalReview,
} from "./ui.js";

function resolveEntriesFromContext(ctx: PiCommandContext): PiSessionEntry[] {
  if (Array.isArray(ctx.entries) && ctx.entries.length > 0) {
    return ctx.entries;
  }
  if (ctx.sessionFile && fs.existsSync(ctx.sessionFile)) {
    return loadSessionJsonlFile(ctx.sessionFile);
  }
  return [];
}

/**
 * Executes a session recording + trigger check cycle.
 */
export async function handleRecordAndCheck(
  ctx: PiCommandContext,
  userNote?: string,
  isAutoHook = false
): Promise<void> {
  const workspaceDir = ctx.cwd ?? process.cwd();
  const config = loadHarness2Config(workspaceDir);
  const state = loadWorkspaceState(workspaceDir);
  const entries = resolveEntriesFromContext(ctx);

  const sessionId =
    ctx.sessionId ??
    entries.find((e) => e.type === "session")?.id ??
    "current-session";
  const startIndex = state.sessionCursors[sessionId] ?? 0;

  // If running in auto mode and no new entries exist, do nothing
  if (isAutoHook && entries.length <= startIndex && !userNote) {
    return;
  }

  const record = analyzeOrchestratorTranscript(entries, {
    sessionId,
    workspacePath: workspaceDir,
    startIndex,
    userNote,
    config,
  });

  saveTaskRecord(workspaceDir, record);
  applyTaskRecordToState(state, record, entries.length);
  saveWorkspaceState(workspaceDir, state);

  if (!isAutoHook) {
    ctx.ui.notify(
      `Recorded task (${record.recordId}): +${record.summary.userSteeringCount} steering, +${record.summary.inefficiencyScoreAdded} inefficiency score, +${record.summary.subagentRevisionCount} subagent revisions.`,
      "info"
    );
  }

  const triggerEval = evaluateTriggers(state, config, false);
  if (triggerEval.shouldPropose) {
    const recentRecords = loadRecentTaskRecords(workspaceDir, 5);
    const proposal = await generateHarnessProposal(
      workspaceDir,
      recentRecords.length > 0 ? recentRecords : [record],
      triggerEval,
      state,
      config,
      ctx
    );
    await runGuidedProposalReview(workspaceDir, proposal, state, ctx);
  }
}

/**
 * Main command router for `/harness2` (and alias `/harnees2`).
 */
export async function handleHarness2Command(
  rawArgs: string,
  ctx: PiCommandContext
): Promise<void> {
  const workspaceDir = ctx.cwd ?? process.cwd();
  const config = loadHarness2Config(workspaceDir);
  const trimmed = (rawArgs ?? "").trim();

  const [subcommand, ...restTokens] = trimmed.split(/\s+/);
  const restText = restTokens.join(" ").trim().replace(/^["']|["']$/g, "");

  if (!subcommand || subcommand === "record") {
    const note = subcommand === "record" ? restText || undefined : undefined;
    await handleRecordAndCheck(ctx, note, false);
    return;
  }

  if (subcommand === "status") {
    const state = loadWorkspaceState(workspaceDir);
    ctx.ui.notify(formatWorkspaceStatus(workspaceDir, state, config), "info");
    return;
  }

  if (subcommand === "propose") {
    const state = loadWorkspaceState(workspaceDir);
    let recentRecords = loadRecentTaskRecords(workspaceDir, 5);
    if (recentRecords.length === 0) {
      const entries = resolveEntriesFromContext(ctx);
      if (entries.length > 0) {
        const adHocRecord = analyzeOrchestratorTranscript(entries, {
          workspacePath: workspaceDir,
          config,
        });
        saveTaskRecord(workspaceDir, adHocRecord);
        recentRecords = [adHocRecord];
      }
    }
    const triggerEval = evaluateTriggers(state, config, true);
    const proposal = await generateHarnessProposal(
      workspaceDir,
      recentRecords,
      triggerEval,
      state,
      config,
      ctx,
      restText || undefined
    );
    await runGuidedProposalReview(workspaceDir, proposal, state, ctx);
    return;
  }

  if (subcommand === "undo") {
    const result = undoLatestProposal(workspaceDir);
    if (!result.reverted) {
      ctx.ui.notify("No applied Harness² backup found to undo.", "warning");
      return;
    }
    ctx.ui.notify(
      `Reverted backup ${result.backupId}! Restored: [${result.restoredFiles.join(", ")}], Removed created: [${result.deletedFiles.join(", ")}]. Run \`/reload\` to refresh Pi.`,
      "success"
    );
    return;
  }

  if (subcommand === "reset") {
    const state = loadWorkspaceState(workspaceDir);
    resetStateCounters(state);
    saveWorkspaceState(workspaceDir, state);
    ctx.ui.notify(
      "Reset workspace friction counters to 0 (historical `EXPERIENCE.md` preserved).",
      "info"
    );
    return;
  }

  // If user passed freeform text directly to `/harness2 "some note"`, treat as `record` with note
  await handleRecordAndCheck(
    ctx,
    trimmed.replace(/^["']|["']$/g, ""),
    false
  );
}

/**
 * Default Pi Coding Agent extension export.
 */
export default function registerHarness2Extension(pi: PiExtensionAPI): void {
  const commandSpec = {
    description:
      "Record workspace task friction and propose Harness² improvements to AGENTS.md, skills, subagents, and extensions (subcommands: record, status, propose, undo, reset)",
    handler: async (args: string, ctx: PiCommandContext) => {
      await handleHarness2Command(args, ctx);
    },
  };

  pi.registerCommand("harness2", commandSpec);
  pi.registerCommand("harnees2", commandSpec);

  // Passive recording hook when `harness2.recordMode` is set to `"auto"`
  pi.on("agent_before_settle", async (_event: unknown, ctx: PiCommandContext) => {
    const workspaceDir = ctx?.cwd ?? process.cwd();
    const config = loadHarness2Config(workspaceDir);
    if (config.recordMode === "auto") {
      await handleRecordAndCheck(ctx, undefined, true);
    }
  });
}
