import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FrictionFingerprint,
  Harness2Config,
  PiSessionContentPart,
  PiSessionEntry,
  SubagentInferenceEvent,
  TaskRecord,
  ToolInefficiencyEvent,
  ToolInvocationSummary,
  UserSteeringEvent,
} from "./types.js";
import { DEFAULT_HARNESS2_CONFIG } from "./config.js";

/**
 * Parses a raw `.jsonl` Pi session file into `PiSessionEntry[]`.
 */
export function parseSessionJsonl(jsonlContent: string): PiSessionEntry[] {
  const lines = jsonlContent.split(/\r?\n/);
  const entries: PiSessionEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as PiSessionEntry);
    } catch {
      // Ignore malformed lines
    }
  }
  return entries;
}

export function loadSessionJsonlFile(filePath: string): PiSessionEntry[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parseSessionJsonl(raw);
}

export function extractTextFromContent(
  content: string | PiSessionContentPart[] | undefined
): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
  }
  return "";
}

/**
 * High-precision bilingual (English + Chinese) patterns for Explicit Instruction-Compliance,
 * Omission, or Logical-Drift questions (Immediate Trigger = 1).
 * Grounded in real user session patterns (e.g. session_1 line 136, session_2 line 108).
 */
const INSTRUCTION_AUDIT_PATTERNS: RegExp[] = [
  /why\s+(didn't|did\s+not|aren't|are\s+not|don't|do\s+not)\s+you\s+(follow|use|read|obey|check|respect|include)/i,
  /you\s+(ignored|violated|skipped|forgot|missed|omitted)\s+(the\s+)?(instructions?|rules?|agents\.md|skill|guideline|assumption)/i,
  /did\s+you\s+(even\s+)?read\s+(agents\.md|the\s+instructions|the\s+prompt|the\s+skill)/i,
  /我发现你遗漏了.*为什么你判断/,
  /为什么你?(没有|没)(按照|遵循|遵守|使用|读取|看).*(指令|要求|规则|AGENTS\.md|技能|skill)/i,
  /你?(忽略|遗漏|漏掉|违反|无视)了.*为什么/,
  /发生了一些逻辑漂移.*是否出现了重大漂移/,
  /对比一下我的本意和你在.*中的表达.*是否出现了(重大)?漂移/,
];

/**
 * Bilingual (English + Chinese) patterns for User Steering & Corrections.
 * Grounded in real user session patterns (e.g. session_1 lines 90, 114, 120, 128; session_2 lines 30, 118).
 */
const CORRECTIVE_STEER_PATTERNS: RegExp[] = [
  /\b(no,\s*don't|stop\s+doing|stop\s+editing|instead\s+of\s+that|you\s+forgot\s+to|wrong\s+file|that's\s+incorrect|be\s+humble)\b/i,
  /不要添加这种|不要出现|不要引入/,
  /你现在的论述太\s*aggressive/i,
  /用语\s*AI-slop\s*严重|注意根据.*技能进行调整/i,
  /你的\s*fact\s*check\s*有一些缺陷/i,
  /你应该确认.*更加合适/,
  /你先清除刚才为了.*生成的.*脚本/,
  /把.*中对应的逻辑漂移修复/,
  /注意.*你应该更加的审慎，不应该赞同我的观点/,
  /只需要“.*”即可|不需要太多/,
];

/**
 * Soft error patterns in toolResult text when `isError` is false (exitCode 0)
 * because the script caught or printed the error to stdout/stderr.
 * Observed in session_1 lines 28, 68 and session_2 line 44.
 */
const SOFT_ERROR_OUTPUT_PATTERNS: RegExp[] = [
  /Traceback \(most recent call last\):/i,
  /SyntaxError:\s+/i,
  /TypeError\s*\[ERR_[A-Z0-9_]+\]:/i,
  /Error\s*\[ERR_[A-Z0-9_]+\]:/i,
  /UnicodeEncodeError:\s+'gbk'\s+codec/i,
  /Error querying https?:\/\//i,
  /Error:\s+The read operation timed out/i,
  /Command exited with code [1-9]/i,
  /warning:\s+Not a git repository/i,
];

export function isInstructionComplianceQuestion(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned || cleaned.startsWith("<skill ")) return false;
  return INSTRUCTION_AUDIT_PATTERNS.some((re) => re.test(cleaned));
}

export function isCorrectiveSteerMessage(text: string): boolean {
  const cleaned = text.trim();
  if (!cleaned || cleaned.startsWith("<skill ")) return false;
  return CORRECTIVE_STEER_PATTERNS.some((re) => re.test(cleaned));
}

/**
 * Classifies a tool error/recovery into a normalized `FrictionFingerprint`
 * so single-occurrence frictions can be tracked across tasks.
 */
export function classifyFrictionFingerprint(
  invocations: ToolInvocationSummary[]
): FrictionFingerprint {
  const combinedText = invocations
    .map((inv) => `${inv.toolName} ${inv.inputSummary} ${inv.errorSnippet ?? ""}`)
    .join("\n");

  if (/UnicodeEncodeError:\s*'gbk'\s*codec|encoding=['"]utf-8['"]/i.test(combinedText)) {
    return "python_stdout_encoding_gbk";
  }
  if (/SyntaxError:\s*unterminated string literal|python3?\s+-c\s+/i.test(combinedText) && /SyntaxError/i.test(combinedText)) {
    return "python_inline_syntax_error";
  }
  if (/ERR_MODULE_NOT_FOUND|ERR_INVALID_MODULE_SPECIFIER|Cannot find package|node_modules/i.test(combinedText)) {
    return "node_esm_module_resolution";
  }
  if (/Not a git repository/i.test(combinedText)) {
    return "git_outside_repository";
  }
  if (/Usage:\s+node\s+|Usage:\s+python|unrecognized arguments|invalid option/i.test(combinedText)) {
    return "cli_usage_argument_error";
  }
  if (/Error querying https?:\/\/|timed out|api\.openalex\.org/i.test(combinedText)) {
    return "network_or_api_query_error";
  }
  if (invocations.some((i) => i.toolName === "edit" && (i.isHardError || i.isSoftError))) {
    return "edit_target_not_found";
  }
  return "general_command_failure";
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown> | undefined): {
  inputSummary: string;
  targetResource?: string;
} {
  if (!args) return { inputSummary: "" };
  if (toolName === "bash" || toolName === "safe_bash") {
    const cmd = typeof args.command === "string" ? args.command : JSON.stringify(args);
    return {
      inputSummary: cmd.length > 220 ? `${cmd.slice(0, 220)}...` : cmd,
      targetResource: extractBashTargetResource(cmd),
    };
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const p = typeof args.path === "string" ? args.path : "";
    return {
      inputSummary: p || JSON.stringify(args).slice(0, 120),
      targetResource: p ? path.posix.basename(p.replace(/\\/g, "/")) : undefined,
    };
  }
  if (toolName === "subagent" || toolName === "subagent_message") {
    return {
      inputSummary: JSON.stringify(args).slice(0, 200),
      targetResource: typeof args.name === "string" ? args.name : typeof args.agent === "string" ? args.agent : undefined,
    };
  }
  return { inputSummary: JSON.stringify(args).slice(0, 160) };
}

function extractBashTargetResource(command: string): string | undefined {
  const pyFileMatch = command.match(/\bpython3?\s+([A-Za-z0-9_./\\-]+\.py)\b/);
  if (pyFileMatch) return path.posix.basename(pyFileMatch[1].replace(/\\/g, "/"));
  const nodeFileMatch = command.match(/\bnode\s+([A-Za-z0-9_./\\-]+\.(?:mjs|cjs|js|ts))\b/);
  if (nodeFileMatch) return path.posix.basename(nodeFileMatch[1].replace(/\\/g, "/"));
  if (/api\.openalex\.org/i.test(command)) return "openalex_api";
  if (/pptxgenjs|export-pptx\.mjs|build-beautiful-deck\.mjs/i.test(command)) return "pptx_builder";
  if (/\bpython3?\s+-c\b/.test(command)) return "python_inline";
  return undefined;
}

/**
 * Checks if two user messages are near-duplicates (used to ignore network/provider retry resends).
 */
function isNearDuplicateUserPrompt(a: string, b: string): boolean {
  const normA = a.replace(/\s+/g, "").trim();
  const normB = b.replace(/\s+/g, "").trim();
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const shorter = normA.length < normB.length ? normA : normB;
  const longer = normA.length < normB.length ? normB : normA;
  if (shorter.length >= 15 && longer.startsWith(shorter.slice(0, Math.floor(shorter.length * 0.85)))) {
    return true;
  }
  return false;
}

export interface AnalyzeTranscriptOptions {
  sessionId?: string;
  workspacePath?: string;
  startIndex?: number;
  userNote?: string;
  config?: Harness2Config;
}

/**
 * Analyzes a main orchestrator session transcript (`PiSessionEntry[]`) and extracts:
 * 1. User steering & corrections (including single occurrences per task)
 * 2. Explicit instruction-compliance / omission / logical-drift queries (immediate trigger)
 * 3. Tool inefficiency events:
 *    - Tier 1 (`single_retry_recovery`, +1 pt): Single-occurrence error + fix in a task, tagged with a `FrictionFingerprint`
 *    - Tier 2 (`multi_step_chain`, +3 pts): >= minStepsForInefficientChain trial-and-error attempts
 *    - Tier 2 (`temp_script_sprawl`, +3 pts): >= 3 one-off helper scripts created in workspace root
 * 4. Subagent instruction problems inferred strictly from the main orchestrator transcript
 */
export function analyzeOrchestratorTranscript(
  entries: PiSessionEntry[],
  options: AnalyzeTranscriptOptions = {}
): TaskRecord {
  const config = options.config ?? DEFAULT_HARNESS2_CONFIG;
  const startIndex = options.startIndex ?? 0;

  let sessionId = options.sessionId ?? "unknown-session";
  let workspacePath = options.workspacePath ?? process.cwd();
  let modelId: string | undefined;

  for (const entry of entries) {
    if (entry.type === "session") {
      if (!options.sessionId && entry.id) sessionId = entry.id;
      if (!options.workspacePath && entry.cwd) workspacePath = entry.cwd;
    } else if (entry.type === "model_change" && entry.modelId) {
      modelId = entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId;
    }
  }

  const steeringEvents: UserSteeringEvent[] = [];
  const inefficiencyEvents: ToolInefficiencyEvent[] = [];
  const subagentEvents: SubagentInferenceEvent[] = [];

  // Track tool invocations in order
  const pendingToolCalls = new Map<
    string,
    { entryIndex: number; toolName: string; args: Record<string, unknown> }
  >();
  const completedInvocations: ToolInvocationSummary[] = [];
  const rootTempScriptsCreated: Array<{ entryIndex: number; scriptName: string }> = [];

  // Track active subagents spawned in the main orchestrator session
  interface TrackedSubagent {
    subagentName: string;
    agentProfile?: string;
    cliRunner: string;
    initialTaskPrompt: string;
    spawnEntryIndex: number;
    followUpMessages: string[];
    correctiveMessageCount: number;
    targetFilesMentioned: Set<string>;
    revisedFiles: Set<string>;
    hadChildErrorExit: boolean;
  }
  const trackedSubagents = new Map<string, TrackedSubagent>();

  let lastUserText = "";
  let recentProviderErrorOrContextEdit = false;
  let lastAssistantSummary = "initial turn";
  let networkRetriesIgnored = 0;
  let totalToolCalls = 0;

  for (let idx = startIndex; idx < entries.length; idx++) {
    const entry = entries[idx];
    if (!entry) continue;

    if (entry.type === "context_edit") {
      recentProviderErrorOrContextEdit = true;
      continue;
    }

    if (entry.type !== "message" || !entry.message) {
      continue;
    }

    const msg = entry.message;

    if (msg.role === "assistant") {
      if (msg.stopReason === "error") {
        recentProviderErrorOrContextEdit = true;
        continue;
      }
      if (msg.stopReason === "aborted" && recentProviderErrorOrContextEdit) {
        // Aborted turn right after a provider/network error is a connection recovery, not user disapproval
        continue;
      }

      const contentParts = Array.isArray(msg.content) ? msg.content : [];
      const toolCalls = contentParts.filter((p) => p.type === "toolCall" && p.name);
      const assistantText = extractTextFromContent(msg.content);

      if (toolCalls.length > 0) {
        totalToolCalls += toolCalls.length;
        lastAssistantSummary = toolCalls
          .map((tc) => `${tc.name}(${ summarizeToolArgs(tc.name!, tc.arguments).inputSummary.slice(0, 60) })`)
          .join(", ");
      } else if (assistantText) {
        lastAssistantSummary = assistantText.slice(0, 120);
      }

      for (const tc of toolCalls) {
        const tcName = tc.name!;
        const tcArgs = (tc.arguments ?? {}) as Record<string, unknown>;
        const tcId = tc.id ?? `${idx}-${tcName}`;
        pendingToolCalls.set(tcId, { entryIndex: idx, toolName: tcName, args: tcArgs });

        // Track temporary script creation in workspace root (e.g. search_literature.py, check_gpts.py)
        if (tcName === "write" && typeof tcArgs.path === "string") {
          const normalizedPath = tcArgs.path.replace(/\\/g, "/");
          if (
            !normalizedPath.includes("/") &&
            /\.(py|mjs|cjs|js|sh)$/i.test(normalizedPath)
          ) {
            rootTempScriptsCreated.push({ entryIndex: idx, scriptName: normalizedPath });
          }
        }

        // Track subagent spawns & follow-up messages in main orchestrator session
        if (tcName === "subagent") {
          const agentProfile = typeof tcArgs.agent === "string" ? tcArgs.agent : undefined;
          const cliRunner = typeof tcArgs.cli === "string" ? tcArgs.cli : "pi";
          const subagentName =
            typeof tcArgs.name === "string"
              ? tcArgs.name
              : agentProfile ?? cliRunner;
          const taskPrompt = typeof tcArgs.task === "string" ? tcArgs.task : "";
          const mentionedFiles = new Set<string>();
          const fileMatches = taskPrompt.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/g) ?? [];
          for (const fm of fileMatches) {
            mentionedFiles.add(path.posix.basename(fm.replace(/\\/g, "/")));
          }
          trackedSubagents.set(subagentName, {
            subagentName,
            agentProfile,
            cliRunner,
            initialTaskPrompt: taskPrompt,
            spawnEntryIndex: idx,
            followUpMessages: [],
            correctiveMessageCount: 0,
            targetFilesMentioned: mentionedFiles,
            revisedFiles: new Set<string>(),
            hadChildErrorExit: false,
          });
        } else if (tcName === "subagent_message") {
          const targetName = typeof tcArgs.name === "string" ? tcArgs.name : "";
          const messageText = typeof tcArgs.message === "string" ? tcArgs.message : "";
          const tracked = trackedSubagents.get(targetName);
          if (tracked && messageText) {
            tracked.followUpMessages.push(messageText);
            if (
              /\b(fix|missing|instead|redo|error|wrong|forgot|incomplete|revise)\b|修改|遗漏|不对|重写|补充|错误/i.test(
                messageText
              ) ||
              tracked.followUpMessages.length >= 2
            ) {
              tracked.correctiveMessageCount += 1;
            }
          }
        } else if (
          (tcName === "edit" || tcName === "write") &&
          typeof tcArgs.path === "string"
        ) {
          const editedBasename = path.posix.basename(tcArgs.path.replace(/\\/g, "/"));
          for (const tracked of trackedSubagents.values()) {
            if (
              idx > tracked.spawnEntryIndex &&
              tracked.targetFilesMentioned.has(editedBasename)
            ) {
              tracked.revisedFiles.add(tcArgs.path);
            }
          }
        }
      }
    } else if (msg.role === "toolResult") {
      const resultText = extractTextFromContent(msg.content);
      const tcId = msg.toolCallId ?? "";
      const pending = pendingToolCalls.get(tcId);
      const toolName = msg.toolName ?? pending?.toolName ?? "unknown";
      const args = pending?.args;
      const { inputSummary, targetResource } = summarizeToolArgs(toolName, args);

      const exitCode =
        typeof msg.details?.exitCode === "number" ? msg.details.exitCode : undefined;
      const isHardError =
        Boolean(msg.isError) || (exitCode !== undefined && exitCode !== 0);
      const isSoftError =
        !isHardError && SOFT_ERROR_OUTPUT_PATTERNS.some((re) => re.test(resultText));

      // Check if tool was rejected by user confirmation guardrail
      if (isHardError && /was not approved|rejected by user|user denied/i.test(resultText)) {
        steeringEvents.push({
          entryIndex: idx,
          eventType: "tool_rejection",
          userMessageQuote: resultText.slice(0, 200),
          precedingAssistantActionSummary: `${toolName}(${inputSummary.slice(0, 80)})`,
        });
      }

      // Check if subagent result reported child error exit
      if (
        (toolName === "subagent" || /subagent/i.test(resultText)) &&
        /stopReason:\s*"?error"?|\.exit\b.*error/i.test(resultText)
      ) {
        for (const tracked of trackedSubagents.values()) {
          tracked.hadChildErrorExit = true;
        }
      }

      completedInvocations.push({
        entryIndex: pending?.entryIndex ?? idx,
        toolCallId: tcId,
        toolName,
        inputSummary,
        targetResource,
        isHardError,
        isSoftError,
        exitCode,
        errorSnippet:
          isHardError || isSoftError ? resultText.slice(0, 240).trim() : undefined,
      });
    } else if (msg.role === "user") {
      const userText = extractTextFromContent(msg.content);
      if (!userText) continue;

      // Ignore skill expansion wrapper prompts at session start
      if (userText.trim().startsWith("<skill ")) {
        continue;
      }

      // Deduplicate network/provider error resends (observed in session_1 lines 106-108 and session_2 lines 108-116)
      if (
        (recentProviderErrorOrContextEdit || isNearDuplicateUserPrompt(userText, lastUserText)) &&
        isNearDuplicateUserPrompt(userText, lastUserText)
      ) {
        networkRetriesIgnored += 1;
        recentProviderErrorOrContextEdit = false;
        lastUserText = userText;
        continue;
      }

      // Ignore network-check ping messages right after provider errors
      if (
        recentProviderErrorOrContextEdit &&
        (/^(hi|hello|test|在吗)$/i.test(userText.trim()) ||
          /网络出现问题了|看你已经完成工作了/.test(userText))
      ) {
        networkRetriesIgnored += 1;
        recentProviderErrorOrContextEdit = false;
        lastUserText = userText;
        continue;
      }

      recentProviderErrorOrContextEdit = false;
      lastUserText = userText;

      // Check for Subagent notifications steered back as user/system XML messages
      if (/<task-notification>|Subagent\s+['"`]?([A-Za-z0-9_-]+)/i.test(userText)) {
        if (/stopReason:\s*"?error"?|failed with error/i.test(userText)) {
          for (const tracked of trackedSubagents.values()) {
            tracked.hadChildErrorExit = true;
          }
        }
        continue;
      }

      // 1. Check for Explicit Instruction-Compliance / Omission / Logical-Drift Questions
      if (isInstructionComplianceQuestion(userText)) {
        steeringEvents.push({
          entryIndex: idx,
          eventType: "instruction_compliance_question",
          userMessageQuote: userText.slice(0, 300),
          precedingAssistantActionSummary: lastAssistantSummary,
        });
      }
      // 2. Check for Corrective Steering Messages
      else if (isCorrectiveSteerMessage(userText)) {
        steeringEvents.push({
          entryIndex: idx,
          eventType: "corrective_steer",
          userMessageQuote: userText.slice(0, 300),
          precedingAssistantActionSummary: lastAssistantSummary,
        });
      }
    }
  }

  // Optional manual note passed via `/harness2 record "<note>"`
  if (options.userNote && options.userNote.trim().length > 0) {
    const note = options.userNote.trim();
    const isAudit = isInstructionComplianceQuestion(note);
    steeringEvents.push({
      entryIndex: entries.length,
      eventType: isAudit ? "instruction_compliance_question" : "corrective_steer",
      userMessageQuote: note,
      precedingAssistantActionSummary: "Manual note via /harness2 record",
    });
  }

  // Evaluate Tool Inefficiencies (Both Tier 1 Single-Occurrence Errors and Tier 2 Multi-Step Chains!)
  extractToolInefficiencyEvents(
    completedInvocations,
    rootTempScriptsCreated,
    config.minStepsForInefficientChain,
    inefficiencyEvents
  );

  // Evaluate Subagent Inference Events
  for (const tracked of trackedSubagents.values()) {
    if (tracked.revisedFiles.size > 0) {
      subagentEvents.push({
        subagentName: tracked.subagentName,
        agentProfile: tracked.agentProfile,
        cliRunner: tracked.cliRunner,
        initialTaskPrompt: tracked.initialTaskPrompt,
        outcomeSignal: "orchestrator_revised_files",
        followUpMessages: tracked.followUpMessages,
        revisedFiles: Array.from(tracked.revisedFiles),
      });
    } else if (tracked.correctiveMessageCount >= 1 && tracked.followUpMessages.length >= 2) {
      subagentEvents.push({
        subagentName: tracked.subagentName,
        agentProfile: tracked.agentProfile,
        cliRunner: tracked.cliRunner,
        initialTaskPrompt: tracked.initialTaskPrompt,
        outcomeSignal: "multiple_corrective_messages",
        followUpMessages: tracked.followUpMessages,
        revisedFiles: [],
      });
    } else if (tracked.hadChildErrorExit) {
      subagentEvents.push({
        subagentName: tracked.subagentName,
        agentProfile: tracked.agentProfile,
        cliRunner: tracked.cliRunner,
        initialTaskPrompt: tracked.initialTaskPrompt,
        outcomeSignal: "child_error_exit",
        followUpMessages: tracked.followUpMessages,
        revisedFiles: [],
      });
    }
  }

  const instructionQuestions = steeringEvents.filter(
    (e) => e.eventType === "instruction_compliance_question"
  );
  const inefficiencyScoreAdded = inefficiencyEvents.reduce(
    (sum, ev) => sum + ev.scoreWeight,
    0
  );

  return {
    recordId: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sessionId,
    timestamp: new Date().toISOString(),
    workspacePath,
    modelId,
    userNote: options.userNote,
    summary: {
      totalEntriesAnalyzed: Math.max(0, entries.length - startIndex),
      totalToolCalls,
      userSteeringCount: steeringEvents.length,
      instructionComplianceQuestionCount: instructionQuestions.length,
      hasInstructionComplianceQuestion: instructionQuestions.length > 0,
      inefficiencyEventCount: inefficiencyEvents.length,
      inefficiencyScoreAdded,
      subagentRevisionCount: subagentEvents.length,
      networkRetriesIgnored,
    },
    steeringEvents,
    inefficiencyEvents,
    subagentEvents,
  };
}

/**
 * Groups tool invocations into:
 * - `multi_step_chain` (+3 pts): >= minStepsForInefficientChain failed/exploratory calls before resolution
 * - `single_retry_recovery` (+1 pt): 1-2 failed calls followed by resolution (ensures single-occurrence frictions per task ARE recorded!)
 * - ` unresolved_error` (+1 pt): trailing tool error with no resolution
 * - `temp_script_sprawl` (+3 pts): >= 3 one-off scripts written in workspace root
 */
function extractToolInefficiencyEvents(
  invocations: ToolInvocationSummary[],
  rootTempScriptsCreated: Array<{ entryIndex: number; scriptName: string }>,
  minStepsForChain: number,
  outEvents: ToolInefficiencyEvent[]
): void {
  let i = 0;
  while (i < invocations.length) {
    const inv = invocations[i];
    if (!inv.isHardError && !inv.isSoftError) {
      i++;
      continue;
    }

    // Found the start of a friction sequence
    const chain: ToolInvocationSummary[] = [inv];
    let j = i + 1;
    let resolutionCmd: string | undefined;

    while (j < invocations.length) {
      const next = invocations[j];
      if (next.isHardError || next.isSoftError) {
        chain.push(next);
        j++;
        continue;
      }

      // If `next` is a read/write/ls/find discovery step between two errors in the same debugging loop, include it
      const lookahead = invocations[j + 1];
      if (
        lookahead &&
        (lookahead.isHardError || lookahead.isSoftError) &&
        (next.toolName === "write" ||
          next.toolName === "read" ||
          next.toolName === "edit" ||
          (next.toolName === "bash" && /\b(ls|find|pwd|cat|head)\b/.test(next.inputSummary)))
      ) {
        chain.push(next);
        j++;
        continue;
      }

      // `next` succeeded and ends the error loop
      if (next.toolName === "bash" || next.toolName === "safe_bash" || next.toolName === "edit" || next.toolName === "write") {
        resolutionCmd = `${next.toolName}: ${next.inputSummary}`;
        chain.push(next);
        j++;
      }
      break;
    }

    const errorCount = chain.filter((c) => c.isHardError || c.isSoftError).length;
    const fingerprint = classifyFrictionFingerprint(chain);
    const turnRange: [number, number] = [
      chain[0].entryIndex,
      chain[chain.length - 1].entryIndex,
    ];

    if (chain.length >= minStepsForChain && errorCount >= 2 && resolutionCmd) {
      outEvents.push({
        turnRange,
        classification: "multi_step_chain",
        scoreWeight: 3,
        fingerprint,
        toolsInvoked: chain,
        eventualResolutionCommand: resolutionCmd,
        description: `Multi-step trial-and-error chain (${chain.length} tool steps, ${errorCount} errors) on [${fingerprint}] resolved via \`${resolutionCmd.slice(0, 100)}\``,
      });
    } else if (resolutionCmd) {
      // Single-occurrence friction in this task! Recorded with scoreWeight = 1 and its fingerprint.
      outEvents.push({
        turnRange,
        classification: "single_retry_recovery",
        scoreWeight: 1,
        fingerprint,
        toolsInvoked: chain,
        eventualResolutionCommand: resolutionCmd,
        description: `Single-occurrence tool error & recovery on [${fingerprint}] resolved via \`${resolutionCmd.slice(0, 100)}\``,
      });
    } else {
      outEvents.push({
        turnRange,
        classification: "unresolved_error",
        scoreWeight: 1,
        fingerprint,
        toolsInvoked: chain,
        description: `Unresolved tool error on [${fingerprint}]: ${chain[0].errorSnippet?.slice(0, 100) ?? chain[0].inputSummary}`,
      });
    }

    i = j;
  }

  // Detect Temporary Script Sprawl (e.g. session_1 created 11 separate .py scripts in workspace root)
  const uniqueTempScripts = Array.from(
    new Set(rootTempScriptsCreated.map((s) => s.scriptName))
  );
  if (uniqueTempScripts.length >= 3) {
    const firstIdx = rootTempScriptsCreated[0].entryIndex;
    const lastIdx = rootTempScriptsCreated[rootTempScriptsCreated.length - 1].entryIndex;
    outEvents.push({
      turnRange: [firstIdx, lastIdx],
      classification: "temp_script_sprawl",
      scoreWeight: 3,
      fingerprint: "temp_script_sprawl",
      toolsInvoked: [],
      sprawlScriptsCreated: uniqueTempScripts,
      description: `Created ${uniqueTempScripts.length} ad-hoc scripts in workspace root (${uniqueTempScripts.slice(0, 5).join(", ")}${uniqueTempScripts.length > 5 ? ", ..." : ""}); candidate for a reusable Skill.`,
    });
  }
}
