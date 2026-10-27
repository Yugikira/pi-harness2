import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FrictionFingerprint,
  Harness2Config,
  TaskRecord,
  TriggerEvaluationResult,
  TriggerReasonCode,
  WorkspaceHarnessState,
} from "./types.js";

export function getHarness2Dir(workspaceDir: string): string {
  return path.join(workspaceDir, ".pi", "harness2");
}

export function getStateFilePath(workspaceDir: string): string {
  return path.join(getHarness2Dir(workspaceDir), "state.json");
}

export function getRecordsDir(workspaceDir: string): string {
  return path.join(getHarness2Dir(workspaceDir), "records");
}

export function createInitialWorkspaceState(): WorkspaceHarnessState {
  return {
    schemaVersion: 1,
    lastUpdated: new Date().toISOString(),
    sessionCursors: {},
    counters: {
      sessionsSinceLastProposal: 0,
      cumulativeUserSteering: 0,
      cumulativeInstructionQuestions: 0,
      cumulativeInefficiencyScore: 0,
      cumulativeSubagentRevisions: 0,
      fingerprintCounts: {},
    },
    snoozeUntilSessionCount: 0,
    recentRecordIds: [],
    dismissedProposalSummaries: [],
  };
}

export function loadWorkspaceState(workspaceDir: string): WorkspaceHarnessState {
  const filePath = getStateFilePath(workspaceDir);
  try {
    if (!fs.existsSync(filePath)) {
      return createInitialWorkspaceState();
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as WorkspaceHarnessState;
    return {
      ...createInitialWorkspaceState(),
      ...parsed,
      counters: {
        ...createInitialWorkspaceState().counters,
        ...(parsed.counters ?? {}),
        fingerprintCounts: {
          ...(parsed.counters?.fingerprintCounts ?? {}),
        },
      },
      sessionCursors: { ...(parsed.sessionCursors ?? {}) },
    };
  } catch {
    return createInitialWorkspaceState();
  }
}

export function saveWorkspaceState(
  workspaceDir: string,
  state: WorkspaceHarnessState
): void {
  const dir = getHarness2Dir(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  state.lastUpdated = new Date().toISOString();
  fs.writeFileSync(getStateFilePath(workspaceDir), JSON.stringify(state, null, 2), "utf-8");
}

export function saveTaskRecord(workspaceDir: string, record: TaskRecord): string {
  const recordsDir = getRecordsDir(workspaceDir);
  fs.mkdirSync(recordsDir, { recursive: true });
  const safeTimestamp = record.timestamp.replace(/[:.]/g, "-");
  const filename = `${safeTimestamp}_${record.recordId}.json`;
  const fullPath = path.join(recordsDir, filename);
  fs.writeFileSync(fullPath, JSON.stringify(record, null, 2), "utf-8");
  return fullPath;
}

export function loadRecentTaskRecords(
  workspaceDir: string,
  limit = 10
): TaskRecord[] {
  const recordsDir = getRecordsDir(workspaceDir);
  if (!fs.existsSync(recordsDir)) return [];
  const files = fs
    .readdirSync(recordsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .slice(-limit);
  const records: TaskRecord[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(recordsDir, f), "utf-8");
      records.push(JSON.parse(raw) as TaskRecord);
    } catch {
      // Ignore corrupted record file
    }
  }
  return records;
}

/**
 * Updates `WorkspaceHarnessState` with a newly analyzed `TaskRecord`.
 * Notice how single-occurrence frictions (`scoreWeight: 1` or `1` steering event)
 * are always accumulated across tasks AND tracked per unique fingerprint per task.
 */
export function applyTaskRecordToState(
  state: WorkspaceHarnessState,
  record: TaskRecord,
  newCursorIndex: number
): WorkspaceHarnessState {
  const prevCursor = state.sessionCursors[record.sessionId];
  const isNewSession = prevCursor === undefined;

  state.sessionCursors[record.sessionId] = newCursorIndex;
  if (isNewSession) {
    state.counters.sessionsSinceLastProposal += 1;
  }

  state.counters.cumulativeUserSteering += record.summary.userSteeringCount;
  state.counters.cumulativeInstructionQuestions +=
    record.summary.instructionComplianceQuestionCount;
  state.counters.cumulativeInefficiencyScore +=
    record.summary.inefficiencyScoreAdded;
  state.counters.cumulativeSubagentRevisions +=
    record.summary.subagentRevisionCount;

  // Increment per-task fingerprint occurrences (deduplicated per task so 1 occurrence per task across 2 tasks = 2)
  const taskFingerprints = new Set<FrictionFingerprint>();
  for (const ev of record.inefficiencyEvents) {
    taskFingerprints.add(ev.fingerprint);
  }
  for (const fp of taskFingerprints) {
    state.counters.fingerprintCounts[fp] =
      (state.counters.fingerprintCounts[fp] ?? 0) + 1;
  }

  state.recentRecordIds.push(record.recordId);
  if (state.recentRecordIds.length > 20) {
    state.recentRecordIds = state.recentRecordIds.slice(-20);
  }

  return state;
}

/**
 * Evaluates whether the workspace's accumulated state crosses any trigger threshold.
 */
export function evaluateTriggers(
  state: WorkspaceHarnessState,
  config: Harness2Config,
  forcePropose = false
): TriggerEvaluationResult {
  const reasons: TriggerReasonCode[] = [];
  const humanReadableReasons: string[] = [];

  if (forcePropose) {
    reasons.push("MANUAL_FORCE_PROPOSE");
    humanReadableReasons.push("Manual `/harness2 propose` requested by user.");
  }

  // Respect snooze unless an explicit instruction violation query occurred or forcePropose is true
  const isSnoozed =
    !forcePropose &&
    state.snoozeUntilSessionCount > state.counters.sessionsSinceLastProposal &&
    state.counters.cumulativeInstructionQuestions <
      config.thresholds.instructionViolationQuery;

  if (isSnoozed) {
    return { shouldPropose: false, reasons: [], humanReadableReasons: [] };
  }

  // Rule 1: Explicit Instruction / Omission / Logical-Drift Question (Default >= 1, immediate)
  if (
    state.counters.cumulativeInstructionQuestions >=
    config.thresholds.instructionViolationQuery
  ) {
    reasons.push("EXPLICIT_INSTRUCTION_AUDIT");
    humanReadableReasons.push(
      `Detected ${state.counters.cumulativeInstructionQuestions} explicit instruction-compliance / logical-drift question(s) (threshold: ${config.thresholds.instructionViolationQuery}).`
    );
  }

  // Rule 2: User Steering & Corrections Count (Default >= 3)
  if (
    state.counters.cumulativeUserSteering >=
    config.thresholds.userSteeringCount
  ) {
    reasons.push("USER_STEERING_THRESHOLD");
    humanReadableReasons.push(
      `Accumulated ${state.counters.cumulativeUserSteering} user steering/correction events across tasks (threshold: ${config.thresholds.userSteeringCount}).`
    );
  }

  // Rule 3: Cumulative Tool Inefficiency Score (Default >= 3; captures both +3 chains and +1 single-occurrence errors)
  if (
    state.counters.cumulativeInefficiencyScore >=
    config.thresholds.inefficiencyScore
  ) {
    reasons.push("TOOL_INEFFICIENCY_SCORE_THRESHOLD");
    humanReadableReasons.push(
      `Accumulated tool inefficiency score of ${state.counters.cumulativeInefficiencyScore} (threshold: ${config.thresholds.inefficiencyScore}).`
    );
  }

  // Rule 4: Recurring Single-Occurrence Fingerprint Across Tasks (Default >= 2 tasks with same fingerprint)
  const recurringFingerprints: string[] = [];
  for (const [fp, count] of Object.entries(state.counters.fingerprintCounts)) {
    if ((count ?? 0) >= config.thresholds.recurringFingerprintCount) {
      recurringFingerprints.push(`${fp} (${count} tasks)`);
    }
  }
  if (recurringFingerprints.length > 0) {
    reasons.push("RECURRING_FINGERPRINT_THRESHOLD");
    humanReadableReasons.push(
      `Recurring friction pattern across multiple tasks: ${recurringFingerprints.join(", ")}.`
    );
  }

  // Rule 5: Inferred Subagent Revisions (Default >= 2)
  if (
    state.counters.cumulativeSubagentRevisions >=
    config.thresholds.subagentRevisions
  ) {
    reasons.push("SUBAGENT_REVISION_THRESHOLD");
    humanReadableReasons.push(
      `Detected ${state.counters.cumulativeSubagentRevisions} subagent runs requiring orchestrator file revisions or corrective steers (threshold: ${config.thresholds.subagentRevisions}).`
    );
  }

  return {
    shouldPropose: reasons.length > 0,
    reasons,
    humanReadableReasons,
  };
}

export function resetStateCounters(
  state: WorkspaceHarnessState
): WorkspaceHarnessState {
  state.counters = {
    sessionsSinceLastProposal: 0,
    cumulativeUserSteering: 0,
    cumulativeInstructionQuestions: 0,
    cumulativeInefficiencyScore: 0,
    cumulativeSubagentRevisions: 0,
    fingerprintCounts: {},
  };
  state.snoozeUntilSessionCount = 0;
  return state;
}
