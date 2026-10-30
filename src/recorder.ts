import type {
  Harness2Config,
  PiCommandContext,
  PiModelDescriptor,
  PiSessionEntry,
  SessionDigest,
  SubagentInferenceEvent,
  TaskRecord,
  ToolInefficiencyEvent,
  UserSteeringEvent,
} from "./types.js";
import { DEFAULT_HARNESS2_CONFIG, resolveImproverModel } from "./config.js";
import { buildSessionDigest } from "./analyzer.js";

/**
 * Builds the Stage 2 AI Model Recorder prompt.
 * Follows Google Research's Harness² philosophy: instead of hardcoded regexes,
 * the AI model reads the condensed `SessionDigest` and applies the user's recording rules semantically.
 */
export function buildRecorderPrompt(
  digest: SessionDigest,
  existingFingerprints: string[],
  config: Harness2Config,
  userNote?: string
): string {
  return [
    "You are the Harness² Session Recorder for `@earendil-works/pi-coding-agent`.",
    "Read the condensed orchestrator session digest below and extract structured friction events according to the recording rules.",
    "Do NOT rely on surface keywords alone — evaluate the actual semantic interaction between the User, the Assistant, and its Tools.",
    "",
    "### Recording Rules Rubric",
    "1. **User Steering & Corrections (`steeringEvents` with `eventType: 'corrective_steer' | 'tool_rejection' | 'interruption'`)**:",
    "   - Record any turn where the user corrects the agent's output, pushes back on tone/style/scope, points out a factual flaw, rejects a tool confirmation, asks the agent to clean up temporary clutter it left behind, or passes an explicit user note to `/harness2 record`.",
    "2. **Explicit Instruction-Compliance / Omission / Logical-Drift Questions (`steeringEvents` with `eventType: 'instruction_compliance_question'`)**:",
    "   - Record any turn where the user explicitly asks WHY the agent ignored instructions, omitted a key premise/hypothesis, or drifted logically from the user's intended thesis (e.g., asking if major logical drift occurred or why an important assumption was left out).",
    "3. **Tool Inefficiencies (`inefficiencyEvents`)**:",
    "   - **Every tool friction must be recorded, even if it occurred only ONCE in this task**:",
    "     - `single_retry_recovery` (`scoreWeight: 1`): A single tool error, encoding issue, wrong flag, or soft error (even with `exit=0`) that the agent fixed in 1–2 steps.",
    `     - \`multi_step_chain\` (\`scoreWeight: 3\`): A roundabout trial-and-error sequence of >= ${config.minStepsForInefficientChain} tool calls (such as hunting for \`node_modules\`, debugging ESM imports, writing to a wrong relative path \`../../../../\`, or repeatedly tweaking API query syntax) before succeeding.`,
    "     - `temp_script_sprawl` (`scoreWeight: 3`): Creating >= 3 separate one-off scripts in the workspace root for ad-hoc queries instead of using a single clean skill/script.",
    "     - `unresolved_error` (`scoreWeight: 1`): A tool failure that was never resolved.",
    "   - **Semantic Fingerprinting (`fingerprint`)**: Assign a concise `snake_case` identifier to each inefficiency event describing the root cause.",
    existingFingerprints.length > 0
      ? `   - **IMPORTANT — Reuse Existing Workspace Fingerprints When Applicable**: If an issue matches one of these previously recorded workspace fingerprints, reuse the exact string so cross-task counting increments properly: ${JSON.stringify(existingFingerprints)}`
      : "   - Coin a clear `snake_case` fingerprint for each distinct root cause (e.g., `windows_python_gbk_encoding`, `node_esm_module_resolution`, `temp_script_sprawl`).",
    "4. **Subagent Revisions (`subagentEvents`)**:",
    "   - Inspect only the main orchestrator transcript: record when the orchestrator had to edit/rewrite files produced by a `subagent(...)` call (`orchestrator_revised_files`), sent multiple corrective `subagent_message` steers (`multiple_corrective_messages`), or received a child error exit (`child_error_exit`).",
    "",
    userNote ? `### Explicit User Note Passed to \`/harness2 record\`\n"${userNote}"\n` : "",
    "### Mechanical Session Facts (Pre-Extracted from AST)",
    JSON.stringify(
      {
        totalEntriesAnalyzed: digest.totalEntriesAnalyzed,
        totalToolCalls: digest.totalToolCalls,
        compactionEntriesRestored: digest.mechanicalFacts.compactionEntriesRestored,
        networkRetriesIgnored: digest.mechanicalFacts.networkRetriesIgnored,
        filesRead: digest.mechanicalFacts.filesRead,
        filesWritten: digest.mechanicalFacts.filesWritten,
        filesEdited: digest.mechanicalFacts.filesEdited,
        rootScriptsCreated: digest.mechanicalFacts.rootScriptsCreated,
        failedToolCallsCount: digest.mechanicalFacts.failedToolCalls.length,
        subagentInteractions: digest.mechanicalFacts.subagentInteractions,
      },
      null,
      2
    ),
    "",
    "### Condensed Session Transcript",
    "<session_digest>",
    digest.serializedTranscript || "(No transcript entries)",
    "</session_digest>",
    "",
    "### Output Format",
    "Respond ONLY with a valid JSON object matching this exact schema:",
    "```json",
    JSON.stringify(
      {
        steeringEvents: [
          {
            entryIndex: 0,
            eventType: "corrective_steer",
            userMessageQuote: "exact quote from user",
            precedingAssistantActionSummary: "what the assistant did right before",
            rationale: "why this represents user steering or instruction audit",
          },
        ],
        inefficiencyEvents: [
          {
            turnRange: [0, 1],
            classification: "single_retry_recovery",
            scoreWeight: 1,
            fingerprint: "snake_case_root_cause",
            eventualResolutionCommand: "working command that resolved it",
            sprawlScriptsCreated: [],
            description: "concise explanation of the inefficiency and how it was resolved",
          },
        ],
        subagentEvents: [
          {
            subagentName: "worker",
            agentProfile: "worker",
            cliRunner: "pi",
            initialTaskPrompt: "task given to subagent",
            outcomeSignal: "orchestrator_revised_files",
            followUpMessages: [],
            revisedFiles: ["file.ts"],
          },
        ],
      },
      null,
      2
    ),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Invokes the AI model in Pi using `ctx.modelRegistry.complete` (the official pattern from Pi's
 * `custom-compaction.ts`), or falls back to `ctx.completePrompt` / `ctx.sendMessage`.
 */
export async function callPiModel(
  prompt: string,
  config: Harness2Config,
  ctx?: PiCommandContext
): Promise<{ text: string; modelUsed: string } | null> {
  const activeModelId =
    typeof ctx?.model === "string"
      ? ctx.model
      : ctx?.model?.id
        ? ctx.model.provider
          ? `${ctx.model.provider}/${ctx.model.id}`
          : ctx.model.id
        : undefined;
  const targetModelStr = resolveImproverModel(config, activeModelId);

  // 1. Primary path: `ctx.modelRegistry.complete(...)` (Pi's native extension LLM API)
  if (ctx?.modelRegistry?.complete) {
    let modelObj: PiModelDescriptor | string | undefined;
    if (config.model && ctx.modelRegistry.find) {
      const parts = config.model.split("/");
      if (parts.length >= 2) {
        modelObj = ctx.modelRegistry.find(parts[0], parts.slice(1).join("/"));
      }
    }
    if (!modelObj && ctx.model && typeof ctx.model === "object") {
      modelObj = ctx.model;
    }
    if (!modelObj && activeModelId && ctx.modelRegistry.find) {
      const parts = activeModelId.split("/");
      if (parts.length >= 2) {
        modelObj = ctx.modelRegistry.find(parts[0], parts.slice(1).join("/"));
      }
    }
    modelObj = modelObj ?? targetModelStr;

    const response = await ctx.modelRegistry.complete(
      modelObj,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        maxTokens: 4096,
        signal: ctx.signal,
        cacheRetention: "none",
        sessionId: `harness2-${Date.now()}`,
      }
    );

    const text = (response.content ?? [])
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n")
      .trim();

    if (text) {
      return { text, modelUsed: targetModelStr };
    }
  }

  // 2. Secondary path: `ctx.completePrompt` or `ctx.sendMessage`
  if (ctx?.completePrompt) {
    const text = await ctx.completePrompt(prompt, { model: targetModelStr });
    if (text && text.trim()) return { text: text.trim(), modelUsed: targetModelStr };
  }
  if (ctx?.sendMessage) {
    const text = await ctx.sendMessage(prompt, { model: targetModelStr });
    if (text && text.trim()) return { text: text.trim(), modelUsed: targetModelStr };
  }

  return null;
}

function parseJsonFromLlmOutput(rawText: string): Record<string, unknown> | null {
  const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : rawText;
  const braceMatch = candidate.match(/\{[\s\S]*\}/);
  if (!braceMatch) return null;
  try {
    return JSON.parse(braceMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface RecordSessionOptions {
  sessionId?: string;
  workspacePath?: string;
  startIndex?: number;
  userNote?: string;
  existingFingerprints?: string[];
  config?: Harness2Config;
}

/**
 * Stage 2 Entry Point: Builds the uncompacted `SessionDigest` and asks the AI Model
 * to semantically decide what conflicts, steering, and inefficiencies should be recorded.
 * Falls back to mechanical AST facts only when no LLM provider is connected.
 */
export async function recordSessionWithModel(
  entries: PiSessionEntry[],
  options: RecordSessionOptions = {},
  ctx?: PiCommandContext
): Promise<{ record: TaskRecord; digest: SessionDigest }> {
  const config = options.config ?? DEFAULT_HARNESS2_CONFIG;
  const digest = buildSessionDigest(entries, {
    sessionId: options.sessionId,
    workspacePath: options.workspacePath,
    startIndex: options.startIndex,
    config,
  });

  if (digest.totalEntriesAnalyzed === 0 && !options.userNote) {
    return {
      record: buildRecordFromMechanicalFacts(digest, config, options.userNote),
      digest,
    };
  }

  const prompt = buildRecorderPrompt(
    digest,
    options.existingFingerprints ?? [],
    config,
    options.userNote
  );

  try {
    const llmResult = await callPiModel(prompt, config, ctx);
    if (llmResult) {
      const parsed = parseJsonFromLlmOutput(llmResult.text);

      if (parsed) {
        const rawSteering = Array.isArray(parsed.steeringEvents)
          ? parsed.steeringEvents
          : [];
        const steeringEvents: UserSteeringEvent[] = rawSteering
          .filter((ev): ev is Record<string, unknown> => Boolean(ev && typeof ev === "object"))
          .map((ev) => {
            const rawType = typeof ev.eventType === "string" ? ev.eventType : "";
            const eventType: UserSteeringEvent["eventType"] =
              rawType === "interruption" ||
              rawType === "tool_rejection" ||
              rawType === "corrective_steer" ||
              rawType === "instruction_compliance_question"
                ? rawType
                : "corrective_steer";
            const quote =
              typeof ev.userMessageQuote === "string"
                ? ev.userMessageQuote
                : typeof ev.quote === "string"
                  ? ev.quote
                  : typeof ev.message === "string"
                    ? ev.message
                    : "";
            return {
              entryIndex: typeof ev.entryIndex === "number" ? ev.entryIndex : 0,
              eventType,
              userMessageQuote: quote,
              precedingAssistantActionSummary:
                typeof ev.precedingAssistantActionSummary === "string"
                  ? ev.precedingAssistantActionSummary
                  : "Assistant action",
              rationale: typeof ev.rationale === "string" ? ev.rationale : undefined,
            };
          });

        if (options.userNote && options.userNote.trim() && steeringEvents.length === 0) {
          steeringEvents.push({
            entryIndex: digest.endIndex,
            eventType: "corrective_steer",
            userMessageQuote: options.userNote.trim(),
            precedingAssistantActionSummary: "Manual note passed to /harness2 record",
          });
        }

        const rawInefficiencies = Array.isArray(parsed.inefficiencyEvents)
          ? parsed.inefficiencyEvents
          : [];
        const inefficiencyEvents: ToolInefficiencyEvent[] = rawInefficiencies
          .filter((ev): ev is Record<string, unknown> => Boolean(ev && typeof ev === "object"))
          .map((ev) => {
            const rawClass = typeof ev.classification === "string" ? ev.classification : "";
            const classification: ToolInefficiencyEvent["classification"] =
              rawClass === "single_retry_recovery" ||
              rawClass === "multi_step_chain" ||
              rawClass === "temp_script_sprawl" ||
              rawClass === "unresolved_error"
                ? rawClass
                : "single_retry_recovery";
            const defaultWeight =
              classification === "multi_step_chain" || classification === "temp_script_sprawl"
                ? 3
                : 1;
            const scoreWeight =
              typeof ev.scoreWeight === "number" &&
              Number.isFinite(ev.scoreWeight) &&
              ev.scoreWeight > 0
                ? ev.scoreWeight
                : defaultWeight;
            const rawFp = typeof ev.fingerprint === "string" ? ev.fingerprint : "";
            const fingerprint =
              rawFp
                .toLowerCase()
                .replace(/[^a-z0-9_]+/g, "_")
                .replace(/^_+|_+$/g, "") || "general_tool_inefficiency";
            const turnRange: [number, number] =
              Array.isArray(ev.turnRange) &&
              typeof ev.turnRange[0] === "number" &&
              typeof ev.turnRange[1] === "number"
                ? [ev.turnRange[0], ev.turnRange[1]]
                : [0, 0];

            return {
              turnRange,
              classification,
              scoreWeight,
              fingerprint,
              toolsInvoked: Array.isArray(ev.toolsInvoked)
                ? (ev.toolsInvoked as ToolInefficiencyEvent["toolsInvoked"])
                : [],
              eventualResolutionCommand:
                typeof ev.eventualResolutionCommand === "string"
                  ? ev.eventualResolutionCommand
                  : undefined,
              sprawlScriptsCreated: Array.isArray(ev.sprawlScriptsCreated)
                ? ev.sprawlScriptsCreated.map(String)
                : undefined,
              description:
                typeof ev.description === "string" && ev.description.trim()
                  ? ev.description.trim()
                  : "LLM-identified tool inefficiency",
            };
          });

        const rawSubagents = Array.isArray(parsed.subagentEvents)
          ? parsed.subagentEvents
          : [];
        const subagentEvents: SubagentInferenceEvent[] = rawSubagents
          .filter((ev): ev is Record<string, unknown> => Boolean(ev && typeof ev === "object"))
          .map((ev) => {
            const rawSignal = typeof ev.outcomeSignal === "string" ? ev.outcomeSignal : "";
            const outcomeSignal: SubagentInferenceEvent["outcomeSignal"] =
              rawSignal === "orchestrator_revised_files" ||
              rawSignal === "multiple_corrective_messages" ||
              rawSignal === "child_error_exit"
                ? rawSignal
                : "orchestrator_revised_files";
            return {
              subagentName:
                typeof ev.subagentName === "string" && ev.subagentName.trim()
                  ? ev.subagentName.trim()
                  : "worker",
              agentProfile:
                typeof ev.agentProfile === "string" && ev.agentProfile.trim()
                  ? ev.agentProfile.trim()
                  : undefined,
              cliRunner:
                typeof ev.cliRunner === "string" && ev.cliRunner.trim()
                  ? ev.cliRunner.trim()
                  : "pi",
              initialTaskPrompt:
                typeof ev.initialTaskPrompt === "string" ? ev.initialTaskPrompt : "",
              outcomeSignal,
              followUpMessages: Array.isArray(ev.followUpMessages)
                ? ev.followUpMessages.map(String)
                : [],
              revisedFiles: Array.isArray(ev.revisedFiles)
                ? ev.revisedFiles.map(String)
                : [],
            };
          });

        const instructionQuestions = steeringEvents.filter(
          (e) => e.eventType === "instruction_compliance_question"
        );
        const inefficiencyScoreAdded = inefficiencyEvents.reduce(
          (sum, ev) => sum + ev.scoreWeight,
          0
        );

        const record: TaskRecord = {
          recordId: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          sessionId: digest.sessionId,
          timestamp: new Date().toISOString(),
          workspacePath: digest.workspacePath,
          modelId: llmResult.modelUsed,
          recordedBy: "llm_judge",
          userNote: options.userNote,
          summary: {
            totalEntriesAnalyzed: digest.totalEntriesAnalyzed,
            totalToolCalls: digest.totalToolCalls,
            userSteeringCount: steeringEvents.length,
            instructionComplianceQuestionCount: instructionQuestions.length,
            hasInstructionComplianceQuestion: instructionQuestions.length > 0,
            inefficiencyEventCount: inefficiencyEvents.length,
            inefficiencyScoreAdded,
            subagentRevisionCount: subagentEvents.length,
            networkRetriesIgnored: digest.mechanicalFacts.networkRetriesIgnored,
            compactionEntriesRestored:
              digest.mechanicalFacts.compactionEntriesRestored,
          },
          steeringEvents,
          inefficiencyEvents,
          subagentEvents,
        };

        return { record, digest };
      }
    }
  } catch {
    // Fall back to mechanical facts if LLM call fails
  }

  const fallbackRecord = buildRecordFromMechanicalFacts(
    digest,
    config,
    options.userNote
  );
  return { record: fallbackRecord, digest };
}

/**
 * Offline / Fallback mechanical record builder used when no LLM provider is connected.
 * Relies on structural AST signals extracted in Stage 1 (`failedToolCalls`, `rootScriptsCreated`,
 * `subagentInteractions`, and explicit `userNote`).
 */
export function buildRecordFromMechanicalFacts(
  digest: SessionDigest,
  config: Harness2Config = DEFAULT_HARNESS2_CONFIG,
  userNote?: string
): TaskRecord {
  const steeringEvents: UserSteeringEvent[] = [];
  const inefficiencyEvents: ToolInefficiencyEvent[] = [];
  const subagentEvents: SubagentInferenceEvent[] = [];

  for (const failed of digest.mechanicalFacts.failedToolCalls) {
    if (/was not approved|rejected by user|user denied/i.test(failed.outputPreview ?? "")) {
      steeringEvents.push({
        entryIndex: failed.entryIndex,
        eventType: "tool_rejection",
        userMessageQuote: failed.outputPreview ?? "Tool call rejected by user",
        precedingAssistantActionSummary: `${failed.toolName}(${failed.inputSummary})`,
      });
    }
  }

  if (userNote && userNote.trim()) {
    steeringEvents.push({
      entryIndex: digest.endIndex,
      eventType: "corrective_steer",
      userMessageQuote: userNote.trim(),
      precedingAssistantActionSummary: "Manual note passed to /harness2 record",
    });
  }

  const invocations = digest.mechanicalFacts.allToolInvocations;
  let i = 0;
  while (i < invocations.length) {
    const inv = invocations[i];
    if (!inv.isHardError) {
      i++;
      continue;
    }

    const chain = [inv];
    let j = i + 1;
    let resolutionCmd: string | undefined;

    while (j < invocations.length) {
      const next = invocations[j];
      if (next.isHardError) {
        chain.push(next);
        j++;
        continue;
      }
      const lookahead = invocations[j + 1];
      if (
        lookahead &&
        lookahead.isHardError &&
        (next.toolName === "write" ||
          next.toolName === "read" ||
          next.toolName === "edit" ||
          next.toolName === "bash")
      ) {
        chain.push(next);
        j++;
        continue;
      }
      resolutionCmd = `${next.toolName}: ${next.inputSummary}`;
      chain.push(next);
      j++;
      break;
    }

    const errorCount = chain.filter((c) => c.isHardError).length;
    const fp =
      chain.find((c) => c.targetResource)?.targetResource ??
      `${inv.toolName}_error_recovery`;
    const turnRange: [number, number] = [
      chain[0].entryIndex,
      chain[chain.length - 1].entryIndex,
    ];

    if (
      chain.length >= config.minStepsForInefficientChain &&
      errorCount >= 2 &&
      resolutionCmd
    ) {
      inefficiencyEvents.push({
        turnRange,
        classification: "multi_step_chain",
        scoreWeight: 3,
        fingerprint: fp,
        toolsInvoked: chain,
        eventualResolutionCommand: resolutionCmd,
        description: `Multi-step error recovery chain (${chain.length} calls) on [${fp}]`,
      });
    } else if (resolutionCmd) {
      inefficiencyEvents.push({
        turnRange,
        classification: "single_retry_recovery",
        scoreWeight: 1,
        fingerprint: fp,
        toolsInvoked: chain,
        eventualResolutionCommand: resolutionCmd,
        description: `Single-occurrence error & recovery on [${fp}]`,
      });
    } else {
      inefficiencyEvents.push({
        turnRange,
        classification: "unresolved_error",
        scoreWeight: 1,
        fingerprint: fp,
        toolsInvoked: chain,
        description: `Unresolved tool error on [${fp}]`,
      });
    }

    i = j;
  }

  if (digest.mechanicalFacts.rootScriptsCreated.length >= 3) {
    inefficiencyEvents.push({
      turnRange: [digest.startIndex, digest.endIndex],
      classification: "temp_script_sprawl",
      scoreWeight: 3,
      fingerprint: "temp_script_sprawl",
      toolsInvoked: [],
      sprawlScriptsCreated: digest.mechanicalFacts.rootScriptsCreated,
      description: `Created ${digest.mechanicalFacts.rootScriptsCreated.length} temporary scripts in workspace root (${digest.mechanicalFacts.rootScriptsCreated.slice(0, 4).join(", ")})`,
    });
  }

  for (const sub of digest.mechanicalFacts.subagentInteractions) {
    if (sub.orchestratorEditedSameFiles.length > 0) {
      subagentEvents.push({
        subagentName: sub.subagentName,
        agentProfile: sub.agentProfile,
        cliRunner: sub.cliRunner,
        initialTaskPrompt: sub.initialTaskPrompt,
        outcomeSignal: "orchestrator_revised_files",
        followUpMessages: sub.followUpMessages,
        revisedFiles: sub.orchestratorEditedSameFiles,
      });
    } else if (sub.followUpMessages.length >= 2) {
      subagentEvents.push({
        subagentName: sub.subagentName,
        agentProfile: sub.agentProfile,
        cliRunner: sub.cliRunner,
        initialTaskPrompt: sub.initialTaskPrompt,
        outcomeSignal: "multiple_corrective_messages",
        followUpMessages: sub.followUpMessages,
        revisedFiles: [],
      });
    } else if (sub.hadChildErrorExit) {
      subagentEvents.push({
        subagentName: sub.subagentName,
        agentProfile: sub.agentProfile,
        cliRunner: sub.cliRunner,
        initialTaskPrompt: sub.initialTaskPrompt,
        outcomeSignal: "child_error_exit",
        followUpMessages: sub.followUpMessages,
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
    sessionId: digest.sessionId,
    timestamp: new Date().toISOString(),
    workspacePath: digest.workspacePath,
    modelId: digest.modelId,
    recordedBy: "mechanical_fallback",
    userNote,
    summary: {
      totalEntriesAnalyzed: digest.totalEntriesAnalyzed,
      totalToolCalls: digest.totalToolCalls,
      userSteeringCount: steeringEvents.length,
      instructionComplianceQuestionCount: instructionQuestions.length,
      hasInstructionComplianceQuestion: instructionQuestions.length > 0,
      inefficiencyEventCount: inefficiencyEvents.length,
      inefficiencyScoreAdded,
      subagentRevisionCount: subagentEvents.length,
      networkRetriesIgnored: digest.mechanicalFacts.networkRetriesIgnored,
      compactionEntriesRestored:
        digest.mechanicalFacts.compactionEntriesRestored,
    },
    steeringEvents,
    inefficiencyEvents,
    subagentEvents,
  };
}