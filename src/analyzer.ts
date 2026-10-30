import * as fs from "node:fs";
import * as path from "node:path";
import type {
  Harness2Config,
  MechanicalSessionFacts,
  PiCommandContext,
  PiSessionContentPart,
  PiSessionEntry,
  SessionDigest,
  ToolInvocationSummary,
} from "./types.js";

/**
 * Parses a raw `.jsonl` Pi session file into `PiSessionEntry[]`.
 * In Pi, `.jsonl` files retain ALL raw messages before and after `compaction` entries.
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

/**
 * Restores the full uncompacted session entry stream from `ctx` or `eventBranchEntries`.
 * Because Pi's `SessionManager.getBranch()` and on-disk `.jsonl` files never delete
 * compacted messages (compaction only appends a `type: "compaction"` entry for live LLM context),
 * reading the raw branch or `.jsonl` file restores 100% of pre-compaction messages!
 */
export function resolveFullUncompactedEntries(
  ctx: PiCommandContext,
  eventBranchEntries?: PiSessionEntry[]
): PiSessionEntry[] {
  if (Array.isArray(eventBranchEntries) && eventBranchEntries.length > 0) {
    return eventBranchEntries;
  }
  if (ctx.sessionManager?.getBranch) {
    const branch = ctx.sessionManager.getBranch();
    if (Array.isArray(branch) && branch.length > 0) {
      return branch;
    }
  }
  if (ctx.sessionManager?.getEntries) {
    const allEntries = ctx.sessionManager.getEntries();
    if (Array.isArray(allEntries) && allEntries.length > 0) {
      return allEntries;
    }
  }
  const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? ctx.sessionFile;
  if (sessionFile && fs.existsSync(sessionFile)) {
    return loadSessionJsonlFile(sessionFile);
  }
  if (Array.isArray(ctx.entries) && ctx.entries.length > 0) {
    return ctx.entries;
  }
  return [];
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

function truncateMiddle(text: string, maxChars: number): string {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (cleaned.length <= maxChars) return cleaned;
  const half = Math.floor((maxChars - 40) / 2);
  const omitted = cleaned.length - half * 2;
  return `${cleaned.slice(0, half)}\n...[+${omitted} chars truncated]...\n${cleaned.slice(-half)}`;
}

function summarizeToolCallArgs(
  toolName: string,
  args: Record<string, unknown> | undefined
): { inputSummary: string; targetResource?: string } {
  if (!args) return { inputSummary: "" };

  if (toolName === "bash" || toolName === "safe_bash") {
    const cmd = typeof args.command === "string" ? args.command : JSON.stringify(args);
    return {
      inputSummary: truncateMiddle(cmd, 240),
      targetResource: extractBashTargetResource(cmd),
    };
  }

  if (toolName === "write") {
    const p = typeof args.path === "string" ? args.path : "";
    const contentLen = typeof args.content === "string" ? args.content.length : 0;
    return {
      inputSummary: `path="${p}" (${contentLen} chars)`,
      targetResource: p ? path.posix.basename(p.replace(/\\/g, "/")) : undefined,
    };
  }

  if (toolName === "edit") {
    const p = typeof args.path === "string" ? args.path : "";
    const editsCount = Array.isArray(args.edits) ? args.edits.length : 1;
    return {
      inputSummary: `path="${p}" (${editsCount} edit block(s))`,
      targetResource: p ? path.posix.basename(p.replace(/\\/g, "/")) : undefined,
    };
  }

  if (toolName === "read") {
    const p = typeof args.path === "string" ? args.path : "";
    const offset = args.offset !== undefined ? `, offset=${args.offset}` : "";
    const limit = args.limit !== undefined ? `, limit=${args.limit}` : "";
    return {
      inputSummary: `path="${p}"${offset}${limit}`,
      targetResource: p ? path.posix.basename(p.replace(/\\/g, "/")) : undefined,
    };
  }

  if (toolName === "subagent" || toolName === "subagent_message") {
    const target =
      typeof args.name === "string"
        ? args.name
        : typeof args.agent === "string"
          ? args.agent
          : undefined;
    return {
      inputSummary: truncateMiddle(JSON.stringify(args), 240),
      targetResource: target,
    };
  }

  return { inputSummary: truncateMiddle(JSON.stringify(args), 200) };
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

function isNearDuplicateUserPrompt(a: string, b: string): boolean {
  const normA = a.replace(/\s+/g, "").trim();
  const normB = b.replace(/\s+/g, "").trim();
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  const shorter = normA.length < normB.length ? normA : normB;
  const longer = normA.length < normB.length ? normB : normA;
  if (
    shorter.length >= 15 &&
    longer.startsWith(shorter.slice(0, Math.floor(shorter.length * 0.85)))
  ) {
    return true;
  }
  return false;
}

export interface BuildDigestOptions {
  sessionId?: string;
  workspacePath?: string;
  startIndex?: number;
  maxToolResultChars?: number;
  maxAssistantTextChars?: number;
  config?: Harness2Config;
}

/**
 * Stage 1: Deterministic Transcript Digest Builder (`buildSessionDigest`).
 *
 * Inspired by Google Research's Harness² trajectory pre-processor and Pi's `serializeConversation()`:
 * 1. Restores all raw messages across the session (bridging across `type: "compaction"` entries so compacted messages are never lost).
 * 2. Filters out `context_edit` retracted turns and network/provider `stopReason: "error"` or empty `stopReason: "aborted"` duplicate user retries.
 * 3. Strips `<thinking>` blocks, `<skill>` system prompt injections, and multi-megabyte base64 `image` blobs.
 * 4. Produces a compact `serializedTranscript` (~15–25 KB even for 3.7 MB raw `.jsonl` sessions) plus `MechanicalSessionFacts`
 *    so Stage 2 (`recordSessionWithModel` in `src/recorder.ts`) can ask the AI model to semantically judge all frictions.
 */
export function buildSessionDigest(
  entries: PiSessionEntry[],
  options: BuildDigestOptions = {}
): SessionDigest {
  const startIndex = options.startIndex ?? 0;
  const maxToolResultChars = options.maxToolResultChars ?? 500;
  const maxAssistantTextChars = options.maxAssistantTextChars ?? 450;

  let sessionId = options.sessionId ?? "unknown-session";
  let workspacePath = options.workspacePath ?? process.cwd();
  let modelId: string | undefined;

  const retractedEntryIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "session") {
      if (!options.sessionId && entry.id) sessionId = entry.id;
      if (!options.workspacePath && entry.cwd) workspacePath = entry.cwd;
    } else if (entry.type === "model_change" && entry.modelId) {
      modelId = entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId;
    } else if (
      entry.type === "context_edit" &&
      entry.targetId &&
      entry.replacement === null
    ) {
      retractedEntryIds.add(entry.targetId);
    }
  }

  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const filesEdited = new Set<string>();
  const rootScriptsCreated = new Set<string>();
  const failedToolCalls: ToolInvocationSummary[] = [];
  const allToolInvocations: ToolInvocationSummary[] = [];

  interface SubagentTracker {
    subagentName: string;
    agentProfile?: string;
    cliRunner: string;
    spawnEntryIndex: number;
    initialTaskPrompt: string;
    followUpMessages: string[];
    targetFilesMentioned: Set<string>;
    orchestratorEditedSameFiles: Set<string>;
    hadChildErrorExit: boolean;
  }
  const trackedSubagents = new Map<string, SubagentTracker>();
  const pendingToolCalls = new Map<
    string,
    { entryIndex: number; toolName: string; args: Record<string, unknown> }
  >();

  const transcriptLines: string[] = [];
  let compactionEntriesRestored = 0;
  let networkRetriesIgnored = 0;
  let totalToolCalls = 0;
  let lastUserText = "";
  let recentProviderErrorOrContextEdit = false;

  for (let idx = startIndex; idx < entries.length; idx++) {
    const entry = entries[idx];
    if (!entry) continue;

    if (entry.type === "compaction") {
      compactionEntriesRestored += 1;
      transcriptLines.push(
        `[Entry #${idx} | SystemCompactionMarker]: (Compaction boundary bridged — raw pre-compaction messages preserved)`
      );
      continue;
    }

    if (entry.type === "context_edit") {
      recentProviderErrorOrContextEdit = true;
      continue;
    }

    if (entry.id && retractedEntryIds.has(entry.id)) {
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

      const contentParts = Array.isArray(msg.content) ? msg.content : [];
      const toolCalls = contentParts.filter((p) => p.type === "toolCall" && p.name);
      const assistantText = extractTextFromContent(msg.content);

      if (msg.stopReason === "aborted" && !assistantText && toolCalls.length === 0) {
        recentProviderErrorOrContextEdit = true;
        continue;
      }

      if (msg.stopReason === "aborted" && recentProviderErrorOrContextEdit) {
        continue;
      }

      if (assistantText || toolCalls.length > 0) {
        recentProviderErrorOrContextEdit = false;
      }

      if (assistantText) {
        transcriptLines.push(
          `[Entry #${idx} | Assistant]: ${truncateMiddle(assistantText, maxAssistantTextChars)}`
        );
      }

      if (toolCalls.length > 0) {
        totalToolCalls += toolCalls.length;
        const callSummaries: string[] = [];

        for (const tc of toolCalls) {
          const tcName = tc.name!;
          const tcArgs = (tc.arguments ?? {}) as Record<string, unknown>;
          const tcId = tc.id ?? `${idx}-${tcName}`;
          pendingToolCalls.set(tcId, { entryIndex: idx, toolName: tcName, args: tcArgs });

          const { inputSummary } = summarizeToolCallArgs(tcName, tcArgs);
          callSummaries.push(`${tcName}(${inputSummary})`);

          if (tcName === "read" && typeof tcArgs.path === "string") {
            filesRead.add(tcArgs.path);
          } else if (tcName === "write" && typeof tcArgs.path === "string") {
            filesWritten.add(tcArgs.path);
            const normPath = tcArgs.path.replace(/\\/g, "/");
            if (!normPath.includes("/") && /\.(py|mjs|cjs|js|sh)$/i.test(normPath)) {
              rootScriptsCreated.add(normPath);
            }
          } else if (tcName === "edit" && typeof tcArgs.path === "string") {
            filesEdited.add(tcArgs.path);
          }

          if (tcName === "subagent") {
            const agentProfile = typeof tcArgs.agent === "string" ? tcArgs.agent : undefined;
            const cliRunner = typeof tcArgs.cli === "string" ? tcArgs.cli : "pi";
            const subagentName =
              typeof tcArgs.name === "string"
                ? tcArgs.name
                : agentProfile ?? cliRunner;
            const taskPrompt = typeof tcArgs.task === "string" ? tcArgs.task : "";
            const mentioned = new Set<string>();
            const fileMatches = taskPrompt.match(/[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/g) ?? [];
            for (const fm of fileMatches) {
              mentioned.add(path.posix.basename(fm.replace(/\\/g, "/")));
            }
            trackedSubagents.set(subagentName, {
              subagentName,
              agentProfile,
              cliRunner,
              spawnEntryIndex: idx,
              initialTaskPrompt: taskPrompt,
              followUpMessages: [],
              targetFilesMentioned: mentioned,
              orchestratorEditedSameFiles: new Set<string>(),
              hadChildErrorExit: false,
            });
          } else if (tcName === "subagent_message") {
            const targetName = typeof tcArgs.name === "string" ? tcArgs.name : "";
            const messageText = typeof tcArgs.message === "string" ? tcArgs.message : "";
            const tracked = trackedSubagents.get(targetName);
            if (tracked && messageText) {
              tracked.followUpMessages.push(messageText);
            }
          } else if (
            (tcName === "edit" || tcName === "write") &&
            typeof tcArgs.path === "string"
          ) {
            const basename = path.posix.basename(tcArgs.path.replace(/\\/g, "/"));
            for (const tracked of trackedSubagents.values()) {
              if (
                idx > tracked.spawnEntryIndex &&
                tracked.targetFilesMentioned.has(basename)
              ) {
                tracked.orchestratorEditedSameFiles.add(tcArgs.path);
              }
            }
          }
        }

        transcriptLines.push(`[Entry #${idx} | ToolCalls]: ${callSummaries.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const resultText = extractTextFromContent(msg.content);
      const tcId = msg.toolCallId ?? "";
      const pending = pendingToolCalls.get(tcId);
      const toolName = msg.toolName ?? pending?.toolName ?? "unknown";
      const args = pending?.args;
      const { inputSummary, targetResource } = summarizeToolCallArgs(toolName, args);

      const exitCode =
        typeof msg.details?.exitCode === "number" ? msg.details.exitCode : undefined;
      const isHardError =
        Boolean(msg.isError) || (exitCode !== undefined && exitCode !== 0);

      const hasImages =
        Array.isArray(msg.content) &&
        msg.content.some((part) => part && part.type === "image");

      const effectiveLimit =
        toolName === "read" && !isHardError ? 140 : maxToolResultChars;

      const preview = resultText
        ? truncateMiddle(resultText, effectiveLimit)
        : hasImages
          ? "[Binary image content omitted from text digest]"
          : "(empty output)";

      const invocation: ToolInvocationSummary = {
        entryIndex: pending?.entryIndex ?? idx,
        toolCallId: tcId,
        toolName,
        inputSummary,
        targetResource,
        isHardError,
        exitCode,
        outputPreview: preview,
      };

      allToolInvocations.push(invocation);
      if (isHardError) {
        failedToolCalls.push(invocation);
      }

      if (
        (toolName === "subagent" || /subagent/i.test(resultText)) &&
        /stopReason:\s*"?error"?|\.exit\b.*error/i.test(resultText)
      ) {
        for (const tracked of trackedSubagents.values()) {
          tracked.hadChildErrorExit = true;
        }
      }

      const statusTag = isHardError
        ? `ERROR${exitCode !== undefined ? ` exit=${exitCode}` : ""}`
        : "OK";
      transcriptLines.push(
        `[Entry #${idx} | ToolResult (${toolName}, ${statusTag})]: ${preview}`
      );
    } else if (msg.role === "user") {
      const userText = extractTextFromContent(msg.content);
      if (!userText) continue;

      if (userText.trim().startsWith("<skill ")) {
        const skillMatch = userText.match(/<skill\s+name="([^"]+)"/);
        transcriptLines.push(
          `[Entry #${idx} | SkillLoaded]: Loaded skill "${skillMatch?.[1] ?? "unknown"}"`
        );
        continue;
      }

      if (
        recentProviderErrorOrContextEdit &&
        isNearDuplicateUserPrompt(userText, lastUserText)
      ) {
        networkRetriesIgnored += 1;
        recentProviderErrorOrContextEdit = false;
        lastUserText = userText;
        continue;
      }

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

      transcriptLines.push(`[Entry #${idx} | User]: ${userText.trim()}`);
    }
  }

  const subagentInteractions = Array.from(trackedSubagents.values()).map((t) => ({
    subagentName: t.subagentName,
    agentProfile: t.agentProfile,
    cliRunner: t.cliRunner,
    spawnEntryIndex: t.spawnEntryIndex,
    initialTaskPrompt: t.initialTaskPrompt,
    followUpMessages: t.followUpMessages,
    orchestratorEditedSameFiles: Array.from(t.orchestratorEditedSameFiles),
    hadChildErrorExit: t.hadChildErrorExit,
  }));

  return {
    sessionId,
    workspacePath,
    modelId,
    startIndex,
    endIndex: entries.length,
    totalEntriesAnalyzed: Math.max(0, entries.length - startIndex),
    totalToolCalls,
    serializedTranscript: transcriptLines.join("\n"),
    mechanicalFacts: {
      filesRead: Array.from(filesRead),
      filesWritten: Array.from(filesWritten),
      filesEdited: Array.from(filesEdited),
      rootScriptsCreated: Array.from(rootScriptsCreated),
      failedToolCalls,
      allToolInvocations,
      subagentInteractions,
      compactionEntriesRestored,
      networkRetriesIgnored,
    },
  };
}
