import type {
  PiCommandContext,
  PiExtensionAPI,
  PiSessionBeforeCompactEvent,
  PiSessionEntry,
} from "./types.js";
import { loadHarness2Config } from "./config.js";
import {
  buildSessionDigest,
  loadSessionJsonlFile,
  parseSessionJsonl,
  resolveFullUncompactedEntries,
} from "./analyzer.js";
import {
  buildRecordFromMechanicalFacts,
  buildRecorderPrompt,
  callPiModel,
  recordSessionWithModel,
} from "./recorder.js";
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

export {
  buildSessionDigest,
  loadSessionJsonlFile,
  parseSessionJsonl,
  resolveFullUncompactedEntries,
  buildRecordFromMechanicalFacts,
  buildRecorderPrompt,
  callPiModel,
  recordSessionWithModel,
};

/**
 * Executes the Two-Stage Recording + Trigger Check cycle:
 * 1. Restores the full uncompacted session entry stream (via `resolveFullUncompactedEntries`),
 *    bridging across any `compaction` entries so pre-compaction messages are never lost.
 * 2. Condenses new turns since `state.sessionCursors[sessionId]` into a token-bounded `SessionDigest`.
 * 3. Calls the AI Model (`recordSessionWithModel` via `ctx.modelRegistry.complete`) to semantically
 *    judge conflicts, steering, and inefficiencies according to the recording rules.
 * 4. Updates `.pi/harness2/state.json` and launches the Guided Proposal UI if a threshold is met.
 */
export async function handleRecordAndCheck(
  ctx: PiCommandContext,
  userNote?: string,
  isAutoHook = false,
  eventBranchEntries?: PiSessionEntry[]
): Promise<void> {
  const workspaceDir = ctx.cwd ?? process.cwd();
  const config = loadHarness2Config(workspaceDir);
  const state = loadWorkspaceState(workspaceDir);
  const entries = resolveFullUncompactedEntries(ctx, eventBranchEntries);

  const sessionId =
    ctx.sessionId ??
    ctx.sessionManager?.getSessionId?.() ??
    entries.find((e) => e.type === "session")?.id ??
    "current-session";
  const startIndex = state.sessionCursors[sessionId] ?? 0;

  if (isAutoHook && entries.length <= startIndex && !userNote) {
    return;
  }

  const existingFingerprints = Object.keys(state.counters.fingerprintCounts);

  const { record } = await recordSessionWithModel(
    entries,
    {
      sessionId,
      workspacePath: workspaceDir,
      startIndex,
      userNote,
      existingFingerprints,
      config,
    },
    ctx
  );

  saveTaskRecord(workspaceDir, record);
  applyTaskRecordToState(state, record, entries.length);
  saveWorkspaceState(workspaceDir, state);

  const restoredNote =
    (record.summary.compactionEntriesRestored ?? 0) > 0
      ? ` (restored across ${record.summary.compactionEntriesRestored} compaction boundary/boundaries)`
      : "";

  if (!isAutoHook) {
    ctx.ui.notify(
      `Recorded task via ${record.recordedBy} (${record.recordId})${restoredNote}: +${record.summary.userSteeringCount} steering, +${record.summary.inefficiencyScoreAdded} inefficiency score, +${record.summary.subagentRevisionCount} subagent revisions.`,
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
      const entries = resolveFullUncompactedEntries(ctx);
      if (entries.length > 0) {
        const { record: adHocRecord } = await recordSessionWithModel(
          entries,
          {
            workspacePath: workspaceDir,
            existingFingerprints: Object.keys(state.counters.fingerprintCounts),
            config,
          },
          ctx
        );
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
      "Record workspace task friction via LLM semantic judge and propose Harness² improvements to AGENTS.md, skills, subagents, and extensions (subcommands: record, status, propose, undo, reset)",
    handler: async (args: string, ctx: PiCommandContext) => {
      await handleHarness2Command(args, ctx);
    },
  };

  pi.registerCommand("harness2", commandSpec);
  pi.registerCommand("harnees2", commandSpec);

  // 1. Pre-Compaction Hook (`session_before_compact`):
  // When `recordMode: "auto"` is active, records unrecorded turns using `event.branchEntries`
  // before compaction runs (without cancelling Pi's normal compaction).
  pi.on(
    "session_before_compact",
    async (event: PiSessionBeforeCompactEvent, ctx: PiCommandContext) => {
      const workspaceDir = ctx?.cwd ?? process.cwd();
      const config = loadHarness2Config(workspaceDir);
      if (config.recordMode === "auto") {
        await handleRecordAndCheck(ctx, undefined, true, event?.branchEntries);
      }
      return undefined;
    }
  );

  // 2. Unified Session-End Recording Hook (`session_shutdown`):
  // Because `resolveFullUncompactedEntries` reads `ctx.sessionManager.getBranch()` or the raw `.jsonl` file,
  // all pre- and post-compaction messages since the last cursor are restored and recorded at session end.
  pi.on("session_shutdown", async (_event: unknown, ctx: PiCommandContext) => {
    const workspaceDir = ctx?.cwd ?? process.cwd();
    const config = loadHarness2Config(workspaceDir);
    if (config.recordMode === "auto") {
      await handleRecordAndCheck(ctx, undefined, true);
    }
  });
}
