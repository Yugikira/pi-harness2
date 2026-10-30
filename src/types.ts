/**
 * Core TypeScript interfaces and Pi Extension API types for `pi-harness2` v0.3.3.
 * Implements a Two-Stage (Deterministic Uncompacted Digest -> AI Model Semantic Recorder) architecture.
 */

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
   * "auto": automatically records before compaction (`session_before_compact`) and at session end (`session_shutdown`).
   */
  recordMode: "manual" | "auto";
  /**
   * Optional model ID for semantic recording and proposal synthesis (e.g. "google/gemini-2.5-flash" or "anthropic/claude-opus-4-8").
   * Falls back to the active session model (`ctx.model`) when null/undefined.
   */
  model: string | null;
  /**
   * Trigger thresholds for the workspace.
   */
  thresholds: Harness2Thresholds;
  /**
   * Minimum consecutive failed/exploratory tool calls on the same objective
   * required to classify a sequence as a multi-step chain (+3 points) vs. single-step retry (+1 point).
   */
  minStepsForInefficientChain: number;
}

/**
 * Semantic snake_case identifier assigned by the AI Recorder (or fallback digest)
 * to group recurring friction patterns across tasks (e.g. "windows_python_gbk_encoding",
 * "node_esm_module_resolution", "openalex_root_script_sprawl", "thesis_premise_drift").
 */
export type FrictionFingerprint = string;

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

export interface ToolInefficiencyEvent {
  turnRange: [number, number];
  /**
   * - "single_retry_recovery": 1 error/hiccup followed by a fix (+1 point). Ensures frictions occurring once per task are recorded!
   * - "multi_step_chain": >= minStepsForInefficientChain trial-and-error or redundant attempts before resolution (+3 points).
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

/**
 * Stage 1 Output: Deterministic, token-bounded digest of the uncompacted session transcript
 * ready to be judged by the AI Model in Stage 2 (`src/recorder.ts`).
 */
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
  /**
   * Compact, human- and LLM-readable transcript serialized in Pi's `serializeConversation` format
   * (`[Entry #N | User]`, `[Entry #N | Assistant]`, `[Entry #N | ToolCall]`, `[Entry #N | ToolResult]`),
   * with `<thinking>` blocks, `<skill>` wrappers, and base64 images stripped.
   */
  serializedTranscript: string;
  mechanicalFacts: MechanicalSessionFacts;
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
  /** Value of cumulativeInstructionQuestions when the user last snoozed a proposal, so already-seen instruction audits respect snooze */
  snoozedAtInstructionQuestions?: number;
  recentRecordIds: string[];
  dismissedProposalSummaries: string[];
}

export type TriggerReasonCode =
  | "USER_STEERING_THRESHOLD"
  | "EXPLICIT_INSTRUCTION_AUDIT"
  | "TOOL_INEFFICIENCY_SCORE_THRESHOLD"
  | "RECURRING_FINGERPRINT_THRESHOLD"
  | "SUBAGENT_REVISION_THRESHOLD"
  | "MANUAL_FORCE_PROPOSE";

export interface TriggerEvaluationResult {
  shouldPropose: boolean;
  reasons: TriggerReasonCode[];
  humanReadableReasons: string[];
}

export type EditableComponentType =
  | "agents_md"
  | "append_system"
  | "skill"
  | "script"
  | "subagent"
  | "guardrail_extension";

export interface ProposedFileOperation {
  targetPath: string;
  operation: "create" | "update";
  componentType: EditableComponentType;
  rationale: string;
  fullNewContent: string;
}

export interface HarnessProposal {
  proposalId: string;
  createdAt: string;
  modelUsed: string;
  triggerReasons: TriggerReasonCode[];
  diagnosisSummary: string;
  experienceEntry: {
    situation: string;
    evidenceQuotes: string[];
    lessonLearned: string;
  };
  fileOperations: ProposedFileOperation[];
}

export interface BackupManifest {
  backupId: string;
  proposalId: string;
  createdAt: string;
  reverted: boolean;
  createdFiles: string[];
  updatedFiles: string[];
  previousCounters: WorkspaceHarnessState["counters"];
  previousLastProposalAppliedAt?: string;
}

/**
 * Pi SessionEntry JSONL format (v3) including CompactionEntry and ContextEditEntry.
 */
export interface PiSessionContentPart {
  type: "text" | "thinking" | "toolCall" | "image";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface PiSessionMessage {
  role: "system" | "user" | "assistant" | "toolResult";
  content: string | PiSessionContentPart[];
  stopReason?: "toolUse" | "stop" | "aborted" | "error" | string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: {
    exitCode?: number;
    [key: string]: unknown;
  };
  timestamp?: number;
}

export interface PiSessionEntry {
  type:
    | "session"
    | "model_change"
    | "thinking_level_change"
    | "message"
    | "context_edit"
    | "compaction"
    | "branch_summary"
    | string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  version?: number;
  cwd?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  targetId?: string;
  replacement?: unknown;
  summary?: string;
  firstKeptEntryId?: string;
  message?: PiSessionMessage;
}

/**
 * Pi ExtensionAPI & ModelRegistry interfaces matching `@earendil-works/pi-coding-agent`.
 */
export interface PiModelDescriptor {
  id: string;
  provider?: string;
}

export interface PiModelCompletionResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: Record<string, unknown>;
}

export interface PiModelRegistry {
  find(provider: string, modelId: string): PiModelDescriptor | undefined;
  complete(
    model: PiModelDescriptor | string,
    request: {
      messages: Array<{
        role: "user" | "assistant" | "system";
        content: Array<{ type: "text"; text: string }> | string;
        timestamp?: number;
      }>;
    },
    options?: {
      maxTokens?: number;
      signal?: AbortSignal;
      cacheRetention?: "none" | "default" | string;
      sessionId?: string;
    }
  ): Promise<PiModelCompletionResponse>;
}

export interface PiSessionManager {
  getBranch?(): PiSessionEntry[];
  getEntries?(): PiSessionEntry[];
  getSessionFile?(): string | undefined;
  getSessionId?(): string | undefined;
}

export interface PiUIContext {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

export interface PiCommandContext {
  cwd?: string;
  sessionId?: string;
  model?: string | PiModelDescriptor;
  entries?: PiSessionEntry[];
  sessionFile?: string;
  sessionManager?: PiSessionManager;
  modelRegistry?: PiModelRegistry;
  signal?: AbortSignal;
  ui: PiUIContext;
  sendMessage?(prompt: string, options?: { model?: string }): Promise<string>;
  completePrompt?(prompt: string, options?: { model?: string }): Promise<string>;
}

export interface PiSessionBeforeCompactEvent {
  preparation?: {
    messagesToSummarize?: unknown[];
    turnPrefixMessages?: unknown[];
    firstKeptEntryId?: string;
    tokensBefore?: number;
  };
  branchEntries?: PiSessionEntry[];
  reason?: "manual" | "threshold" | "overflow" | string;
  signal?: AbortSignal;
}

export interface PiExtensionAPI {
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void>;
    }
  ): void;
  on(
    event:
      | "session_before_compact"
      | "session_shutdown"
      | "agent_settled"
      | "agent_before_settle"
      | "turn_end"
      | "session_start"
      | string,
    handler: (eventData: any, ctx: PiCommandContext) => Promise<unknown>
  ): void;
}
