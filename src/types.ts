/**
 * Core TypeScript interfaces and Pi Extension API types for `pi-harness2`.
 * Compatible with `@earendil-works/pi-coding-agent` v0.87+ / v1.0+.
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
   * "auto": passively records completed sessions on `agent_before_settle` / session exit.
   */
  recordMode: "manual" | "auto";
  /**
   * Optional model ID for reflection and proposal synthesis (e.g. "anthropic/claude-opus-4-8").
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

export type FrictionFingerprint =
  | "python_stdout_encoding_gbk"
  | "python_inline_syntax_error"
  | "node_esm_module_resolution"
  | "cli_usage_argument_error"
  | "git_outside_repository"
  | "network_or_api_query_error"
  | "edit_target_not_found"
  | "wrong_relative_output_path"
  | "temp_script_sprawl"
  | "general_command_failure";

export interface ToolInvocationSummary {
  entryIndex: number;
  toolCallId?: string;
  toolName: string;
  inputSummary: string;
  targetResource?: string;
  isHardError: boolean;
  isSoftError: boolean;
  exitCode?: number;
  errorSnippet?: string;
}

export interface ToolInefficiencyEvent {
  turnRange: [number, number];
  /**
   * - "single_retry_recovery": 1 error/failure followed by a fix (+1 point). Ensures frictions occurring once per task are recorded!
   * - "multi_step_chain": >= minStepsForInefficientChain attempts before resolution (+3 points).
   * - "temp_script_sprawl": >= 3 ad-hoc one-off scripts written in workspace root (+3 points).
   * - "unresolved_error": tool error at end of task with no successful resolution (+1 point).
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
  };
  steeringEvents: UserSteeringEvent[];
  inefficiencyEvents: ToolInefficiencyEvent[];
  subagentEvents: SubagentInferenceEvent[];
}

export interface WorkspaceHarnessState {
  schemaVersion: 1;
  lastUpdated: string;
  /** Map of sessionId -> last analyzed entry index for idempotent incremental recording */
  sessionCursors: Record<string, number>;
  counters: {
    sessionsSinceLastProposal: number;
    cumulativeUserSteering: number;
    cumulativeInstructionQuestions: number;
    cumulativeInefficiencyScore: number;
    cumulativeSubagentRevisions: number;
    /** Tracks how many tasks encountered each specific FrictionFingerprint */
    fingerprintCounts: Partial<Record<FrictionFingerprint, number>>;
  };
  snoozeUntilSessionCount: number;
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
  /** Path relative to workspace root (e.g. "AGENTS.md", ".pi/skills/openalex/SKILL.md", ".pi/agents/scout.md") */
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
}

/**
 * Pi SessionEntry JSONL format (v3) as observed in Pi Coding Agent session logs.
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
  type: "session" | "model_change" | "thinking_level_change" | "message" | "context_edit" | string;
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
  message?: PiSessionMessage;
}

/**
 * Minimal subset of `@earendil-works/pi-coding-agent` ExtensionAPI used by `pi-harness2`.
 */
export interface PiUIContext {
  notify(message: string, level?: "info" | "warning" | "error" | "success"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
}

export interface PiCommandContext {
  cwd?: string;
  sessionId?: string;
  model?: string;
  entries?: PiSessionEntry[];
  sessionFile?: string;
  ui: PiUIContext;
  sendMessage?(prompt: string, options?: { model?: string }): Promise<string>;
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
    event: "agent_before_settle" | "turn_end" | "session_start" | string,
    handler: (eventData: unknown, ctx: PiCommandContext) => Promise<unknown>
  ): void;
}
