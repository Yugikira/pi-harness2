import * as fs from "node:fs";
import * as path from "node:path";
import type {
  EditableComponentType,
  Harness2Config,
  HarnessProposal,
  PiCommandContext,
  ProposedFileOperation,
  TaskRecord,
  TriggerEvaluationResult,
  WorkspaceHarnessState,
} from "./types.js";
import { resolveImproverModel } from "./config.js";
import { callPiModel } from "./recorder.js";
import { validateTargetPath } from "./applier.js";

/**
 * Detects whether the workspace already uses `.agents/skills` (as in session_2.jsonl)
 * or defaults to `.pi/skills`.
 */
export function resolveWorkspaceSkillsBaseDir(workspaceDir: string): string {
  const dotAgentsSkills = path.join(workspaceDir, ".agents", "skills");
  const dotPiSkills = path.join(workspaceDir, ".pi", "skills");
  if (fs.existsSync(dotAgentsSkills) && !fs.existsSync(dotPiSkills)) {
    return ".agents/skills";
  }
  return ".pi/skills";
}

function listWorkspaceAssetsSafe(dirPath: string): string[] {
  try {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath).slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * Builds the contrastive Harness² reflection prompt for the Improver LLM.
 */
export function buildReflectionPrompt(
  workspaceDir: string,
  records: TaskRecord[],
  triggerResult: TriggerEvaluationResult,
  state: WorkspaceHarnessState,
  focusHint?: string
): string {
  const agentsMdPath = path.join(workspaceDir, "AGENTS.md");
  const existingAgentsMd = fs.existsSync(agentsMdPath)
    ? fs.readFileSync(agentsMdPath, "utf-8").slice(0, 3000)
    : "(No AGENTS.md present yet)";

  const appendSystemPath = path.join(workspaceDir, ".pi", "APPEND_SYSTEM.md");
  const existingAppendSystem = fs.existsSync(appendSystemPath)
    ? fs.readFileSync(appendSystemPath, "utf-8").slice(0, 1500)
    : "(No .pi/APPEND_SYSTEM.md present yet)";

  const experiencePath = path.join(workspaceDir, ".pi", "harness2", "EXPERIENCE.md");
  const existingExperience = fs.existsSync(experiencePath)
    ? fs.readFileSync(experiencePath, "utf-8").slice(-2000)
    : "(No prior EXPERIENCE.md entries)";

  const skillsBaseDir = resolveWorkspaceSkillsBaseDir(workspaceDir);
  const existingSkills = listWorkspaceAssetsSafe(path.join(workspaceDir, skillsBaseDir));
  const existingAgents = listWorkspaceAssetsSafe(path.join(workspaceDir, ".pi", "agents"));
  const existingExtensions = listWorkspaceAssetsSafe(path.join(workspaceDir, ".pi", "extensions"));

  const fingerprintSummary = Object.entries(state.counters?.fingerprintCounts ?? {})
    .map(([fp, count]) => `${fp} (${count} task(s))`)
    .join(", ");

  const dismissedSection =
    state.dismissedProposalSummaries && state.dismissedProposalSummaries.length > 0
      ? [
          "### Previously Dismissed Proposals (Avoid repeating these)",
          ...state.dismissedProposalSummaries.slice(-5).map((s) => `- ${s}`),
          "",
        ].join("\n")
      : "";

  return [
    "You are the Harness² Workspace Improver for `@earendil-works/pi-coding-agent`.",
    "Analyze the LLM-recorded orchestrator task evidence below and propose concrete, minimal workspace configuration improvements.",
    `Target Skills Directory in this workspace: \`${skillsBaseDir}\``,
    "Allowed target paths: `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `" +
      skillsBaseDir +
      "/<skill-name>/SKILL.md`, `" +
      skillsBaseDir +
      "/<skill-name>/scripts/<script-name>`, `.pi/agents/<agent-name>.md`, `.pi/extensions/<guardrail-name>.ts`.",
    focusHint ? `User Focus Hint: ${focusHint}` : "",
    "",
    "### Trigger Reasons",
    ...triggerResult.humanReadableReasons.map((r) => `- ${r}`),
    fingerprintSummary ? `- Workspace Fingerprint Counts: ${fingerprintSummary}` : "",
    "",
    "### Existing Workspace Assets",
    `- Skills (${skillsBaseDir}): ${existingSkills.length > 0 ? existingSkills.join(", ") : "(none)"}`,
    `- Subagents (.pi/agents): ${existingAgents.length > 0 ? existingAgents.join(", ") : "(none)"}`,
    `- Guardrail Extensions (.pi/extensions): ${existingExtensions.length > 0 ? existingExtensions.join(", ") : "(none)"}`,
    "",
    "### Existing AGENTS.md",
    "```markdown",
    existingAgentsMd,
    "```",
    "",
    "### Existing .pi/APPEND_SYSTEM.md",
    "```markdown",
    existingAppendSystem,
    "```",
    "",
    "### Existing EXPERIENCE.md (Recent Lessons)",
    "```markdown",
    existingExperience,
    "```",
    "",
    dismissedSection,
    "### Recorded Task Evidence",
    JSON.stringify(
      records.map((r) => ({
        recordId: r.recordId,
        recordedBy: r.recordedBy,
        summary: r.summary,
        steeringEvents: r.steeringEvents,
        inefficiencyEvents: r.inefficiencyEvents,
        subagentEvents: r.subagentEvents,
      })),
      null,
      2
    ),
    "",
    "### Output Format",
    "Return ONLY a valid JSON object matching this exact schema:",
    "```json",
    JSON.stringify(
      {
        diagnosisSummary: "Concise summary of why this improvement is proposed",
        experienceEntry: {
          situation: "Context of what triggered this proposal",
          evidenceQuotes: [
            "Exact quote or description of observed friction 1",
            "Exact quote or description of observed friction 2",
          ],
          lessonLearned: "Clear guideline or lesson to prevent future recurrence",
        },
        fileOperations: [
          {
            targetPath: `${skillsBaseDir}/example-skill/SKILL.md`,
            operation: "create",
            componentType: "skill",
            rationale: "Why this file is created or updated",
            fullNewContent: "---\nname: example-skill\ndescription: ...\n---\n...",
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
 * Normalizes and validates an LLM-generated or partial proposal object,
 * ensuring all required fields (especially experienceEntry.evidenceQuotes)
 * are present, well-formed, and safely populated with fallbacks from recorded task evidence.
 * Also filters out any unauthorized target paths so applying the proposal cannot crash.
 */
export function normalizeHarnessProposal(
  raw: Partial<HarnessProposal> | Record<string, unknown> | null | undefined,
  records: TaskRecord[],
  triggerResult: TriggerEvaluationResult,
  modelUsed: string,
  workspaceDir?: string
): HarnessProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const rawObj = raw as Record<string, unknown>;

  const rawOps = Array.isArray(rawObj.fileOperations) ? rawObj.fileOperations : [];
  if (rawOps.length === 0) return null;

  const baseWs = workspaceDir ?? process.cwd();
  const fileOperations: ProposedFileOperation[] = [];
  for (const item of rawOps) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    if (
      typeof op.targetPath === "string" &&
      op.targetPath.trim() &&
      typeof op.fullNewContent === "string" &&
      op.fullNewContent.trim()
    ) {
      try {
        const safePath = validateTargetPath(baseWs, op.targetPath.trim());
        const rawComp = typeof op.componentType === "string" ? op.componentType : "";
        const componentType: EditableComponentType =
          rawComp === "agents_md" ||
          rawComp === "append_system" ||
          rawComp === "skill" ||
          rawComp === "script" ||
          rawComp === "subagent" ||
          rawComp === "guardrail_extension"
            ? rawComp
            : "skill";
        fileOperations.push({
          targetPath: safePath,
          operation: op.operation === "update" ? "update" : "create",
          componentType,
          rationale:
            typeof op.rationale === "string" && op.rationale.trim()
              ? op.rationale.trim()
              : "Workspace improvement based on recorded evidence.",
          fullNewContent: op.fullNewContent,
        });
      } catch {
        // Skip unauthorized or malformed target paths
      }
    }
  }

  if (fileOperations.length === 0) return null;

  // Extract fallback evidence quotes from records in case LLM omitted them
  const fallbackQuotes: string[] = [];
  for (const r of records) {
    for (const s of r.steeringEvents || []) {
      if (s.userMessageQuote) {
        fallbackQuotes.push(`User (${s.eventType}): "${s.userMessageQuote.slice(0, 140)}"`);
      }
    }
    for (const ineff of r.inefficiencyEvents || []) {
      if (ineff.description) {
        fallbackQuotes.push(ineff.description);
      }
    }
    for (const sub of r.subagentEvents || []) {
      fallbackQuotes.push(`Subagent '${sub.subagentName}': ${sub.outcomeSignal}`);
    }
  }

  const rawExp = rawObj.experienceEntry;
  let situation = triggerResult.humanReadableReasons.join("; ") || "Workspace friction threshold met.";
  let evidenceQuotes: string[] = fallbackQuotes.slice(0, 6);
  let lessonLearned =
    (typeof rawObj.diagnosisSummary === "string" && rawObj.diagnosisSummary.trim()) ||
    "Codified user corrections and tool workflow improvements into workspace configuration.";

  if (rawExp && typeof rawExp === "object") {
    const objExp = rawExp as Record<string, unknown>;
    if (typeof objExp.situation === "string" && objExp.situation.trim()) {
      situation = objExp.situation.trim();
    }
    if (Array.isArray(objExp.evidenceQuotes) && objExp.evidenceQuotes.length > 0) {
      evidenceQuotes = objExp.evidenceQuotes
        .map((q: unknown) => (typeof q === "string" ? q.trim() : String(q)))
        .filter(Boolean);
    }
    if (typeof objExp.lessonLearned === "string" && objExp.lessonLearned.trim()) {
      lessonLearned = objExp.lessonLearned.trim();
    }
  } else if (typeof rawExp === "string" && rawExp.trim()) {
    lessonLearned = rawExp.trim();
  }

  const diagnosisSummary =
    typeof rawObj.diagnosisSummary === "string" && rawObj.diagnosisSummary.trim()
      ? rawObj.diagnosisSummary.trim()
      : `Triggered by: ${situation}`;

  return {
    proposalId:
      typeof rawObj.proposalId === "string" && rawObj.proposalId.trim()
        ? rawObj.proposalId.trim()
        : `prop-${Date.now()}`,
    createdAt:
      typeof rawObj.createdAt === "string" && rawObj.createdAt.trim()
        ? rawObj.createdAt.trim()
        : new Date().toISOString(),
    modelUsed,
    triggerReasons: triggerResult.reasons,
    diagnosisSummary,
    experienceEntry: {
      situation,
      evidenceQuotes,
      lessonLearned,
    },
    fileOperations,
  };
}

/**
 * Generates an evidence-backed `HarnessProposal` from accumulated `TaskRecord`s
 * using `callPiModel` (`ctx.modelRegistry.complete` / `ctx.completePrompt` / `ctx.sendMessage`),
 * falling back to deterministic synthesis when offline.
 */
export async function generateHarnessProposal(
  workspaceDir: string,
  records: TaskRecord[],
  triggerResult: TriggerEvaluationResult,
  state: WorkspaceHarnessState,
  config: Harness2Config,
  ctx?: PiCommandContext,
  focusHint?: string
): Promise<HarnessProposal> {
  const activeModelId =
    typeof ctx?.model === "string" ? ctx.model : ctx?.model?.id;
  const modelUsed = resolveImproverModel(config, activeModelId);

  try {
    const prompt = buildReflectionPrompt(
      workspaceDir,
      records,
      triggerResult,
      state,
      focusHint
    );
    const llmResult = await callPiModel(prompt, config, ctx);
    if (llmResult) {
      const fencedMatch = llmResult.text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      const candidate = fencedMatch ? fencedMatch[1] : llmResult.text;
      const jsonMatch = candidate.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as HarnessProposal;
        const normalized = normalizeHarnessProposal(
          parsed,
          records,
          triggerResult,
          llmResult.modelUsed,
          workspaceDir
        );
        if (normalized) {
          return normalized;
        }
      }
    }
  } catch {
    // Fall back to deterministic synthesis when offline
  }

  return synthesizeDeterministicProposal(
    workspaceDir,
    records,
    triggerResult,
    modelUsed,
    focusHint
  );
}

/**
 * Offline fallback synthesizer used when no live LLM is connected during unit tests.
 */
export function synthesizeDeterministicProposal(
  workspaceDir: string,
  records: TaskRecord[],
  triggerResult: TriggerEvaluationResult,
  modelUsed: string,
  focusHint?: string
): HarnessProposal {
  const proposalId = `prop-${Date.now()}`;
  const skillsBase = resolveWorkspaceSkillsBaseDir(workspaceDir);
  const fileOperations: ProposedFileOperation[] = [];
  const evidenceQuotes: string[] = [];
  const lessons: string[] = [];

  const allSteering = records.flatMap((r) => r.steeringEvents ?? []);
  const allInefficiencies = records.flatMap((r) => r.inefficiencyEvents ?? []);
  const allSubagents = records.flatMap((r) => r.subagentEvents ?? []);

  // 1. Handle Tool InefficiencyEvents -> Generate Skill(s)
  for (const ev of allInefficiencies.slice(-2)) {
    evidenceQuotes.push(ev.description);
    const skillSlug =
      (ev.fingerprint || "workflow-helper")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "workflow-helper";
    const workingCmd =
      ev.eventualResolutionCommand ??
      (ev.sprawlScriptsCreated?.length
        ? `# Consolidate scripts: ${ev.sprawlScriptsCreated.join(", ")}`
        : "echo 'Verified workflow'");

    lessons.push(
      `Standardize [${ev.fingerprint}] into \`${skillsBase}/${skillSlug}/SKILL.md\` to prevent repeated ${ev.classification}.`
    );

    if (!fileOperations.some((op) => op.targetPath === `${skillsBase}/${skillSlug}/SKILL.md`)) {
      fileOperations.push({
        targetPath: `${skillsBase}/${skillSlug}/SKILL.md`,
        operation: "create",
        componentType: "skill",
        rationale: `Extracted from recorded tool inefficiency (${ev.classification}) on [${ev.fingerprint}].`,
        fullNewContent: [
          "---",
          `name: ${skillSlug}`,
          `description: Workspace skill addressing ${ev.fingerprint} (${ev.classification}).`,
          "---",
          "",
          `# ${skillSlug}`,
          "",
          "## Observed Issue",
          ev.description,
          "",
          "## Verified Resolution",
          "```bash",
          workingCmd,
          "```",
          "",
        ].join("\n"),
      });
    }
  }

  // 2. Handle Subagent Revisions -> Generate/Update `.pi/agents/<role>.md`
  if (allSubagents.length > 0) {
    const subEv = allSubagents[allSubagents.length - 1];
    const rawRoleName = subEv.agentProfile ?? subEv.subagentName ?? "worker";
    const roleName =
      rawRoleName.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
    const revisedList = Array.isArray(subEv.revisedFiles) ? subEv.revisedFiles : [];
    const followUpList = Array.isArray(subEv.followUpMessages) ? subEv.followUpMessages : [];
    evidenceQuotes.push(
      `Subagent '${subEv.subagentName}' (${subEv.outcomeSignal}): ${revisedList.join(", ") || followUpList.join(" | ")}`
    );
    lessons.push(
      `Refine subagent profile '.pi/agents/${roleName}.md' with explicit deliverable verification.`
    );
    fileOperations.push({
      targetPath: `.pi/agents/${roleName}.md`,
      operation: fs.existsSync(path.join(workspaceDir, ".pi", "agents", `${roleName}.md`))
        ? "update"
        : "create",
      componentType: "subagent",
      rationale: `Addresses ${subEv.outcomeSignal} observed after spawning subagent '${subEv.subagentName}'.`,
      fullNewContent: [
        "---",
        `name: ${roleName}`,
        `description: Workspace-tuned ${roleName} subagent profile with strict output verification`,
        "thinking: medium",
        "tools: read, edit, write, safe_bash, web_search",
        "session-mode: lineage-only",
        "auto-exit: true",
        `cli: ${subEv.cliRunner || "pi"}`,
        "---",
        "",
        `You are the workspace-specialized **${roleName}** subagent.`,
        "",
        "## Mandatory Deliverable Checklist",
        "1. Read `AGENTS.md` in the workspace root before making any changes.",
        "2. Verify all file modifications and run any relevant checks before finishing your turn.",
        "3. If requirements are ambiguous, call `ask_question` rather than guessing.",
        "",
      ].join("\n"),
    });
  }

  // 3. Handle Destructive Command Violations -> Project-level Guardrail Extension
  const instructionQuestions = allSteering.filter(
    (s) => s.eventType === "instruction_compliance_question"
  );
  if (
    instructionQuestions.length > 0 &&
    instructionQuestions.some((q) =>
      /rm\s+-rf|overwrite|raw\s+data|删除|覆盖/i.test(q.userMessageQuote ?? "")
    )
  ) {
    const q = instructionQuestions[0];
    evidenceQuotes.push(`User instruction audit: "${q.userMessageQuote ?? ""}"`);
    const extHeader = "export default function (pi" + ": ExtensionAPI) {";
    const hookHeader = '  pi.on("tool_call", async (event' + ": any, ctx" + ": any) => {";
    fileOperations.push({
      targetPath: ".pi/extensions/workspace-guardrail.ts",
      operation: "create",
      componentType: "guardrail_extension",
      rationale:
        "Enforces deterministic confirmation before destructive bash or file overwrite operations flagged by the user.",
      fullNewContent: [
        'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
        "",
        extHeader,
        hookHeader,
        '    if (event.toolName === "bash" && /rm\\s+-rf/i.test(String(event.input?.command ?? ""))) {',
        '      const ok = await ctx.ui.confirm("Workspace Guardrail", `Allow destructive command: ${event.input?.command}?`);',
        '      if (!ok) return { block: true, reason: "Blocked by .pi/extensions/workspace-guardrail.ts" };',
        "    }",
        "  });",
        "}",
        "",
      ].join("\n"),
    });
  }

  // 4. Update or Create `AGENTS.md`
  const agentsMdPath = path.join(workspaceDir, "AGENTS.md");
  const existingAgentsContent = fs.existsSync(agentsMdPath)
    ? fs.readFileSync(agentsMdPath, "utf-8")
    : "# Workspace Agent Instructions (AGENTS.md)\n";

  const newRules: string[] = [];
  for (const steer of allSteering.slice(-4)) {
    const quoteText = steer.userMessageQuote ?? "";
    evidenceQuotes.push(`User (${steer.eventType}): "${quoteText.slice(0, 140)}"`);
    newRules.push(
      `- **Recorded Workspace Guideline (${steer.eventType})**: ${steer.rationale ?? quoteText.replace(/\r?\n/g, " ").slice(0, 140)}`
    );
  }
  if (focusHint) {
    newRules.push(`- **User Focus Rule**: ${focusHint}`);
  }
  if (newRules.length === 0) {
    newRules.push(
      "- **Workspace Verification**: Follow generated workspace skills and verify tool arguments before execution."
    );
  }

  const deduplicatedRules = Array.from(new Set(newRules)).filter(
    (rule) => !existingAgentsContent.includes(rule)
  );
  const rulesToAppend =
    deduplicatedRules.length > 0 ? deduplicatedRules : [newRules[0]];
  const sectionHeader = "\n\n## Harness² Self-Improvement Guidelines\n";
  const updatedAgentsMd = existingAgentsContent.includes("## Harness² Self-Improvement Guidelines")
    ? `${existingAgentsContent.trimEnd()}\n${rulesToAppend.join("\n")}\n`
    : `${existingAgentsContent.trimEnd()}${sectionHeader}${rulesToAppend.join("\n")}\n`;

  fileOperations.push({
    targetPath: "AGENTS.md",
    operation: fs.existsSync(agentsMdPath) ? "update" : "create",
    componentType: "agents_md",
    rationale:
      "Codifies LLM-identified user steering corrections and domain rules into project-root `AGENTS.md`.",
    fullNewContent: updatedAgentsMd,
  });

  const diagnosisSummary = [
    `Triggered by: ${triggerResult.humanReadableReasons.join(" ")}`,
    `Proposed ${fileOperations.length} workspace update(s): ${fileOperations
      .map((op) => `[${op.operation.toUpperCase()}] ${op.targetPath}`)
      .join(", ")}.`,
  ].join("\n");

  return {
    proposalId,
    createdAt: new Date().toISOString(),
    modelUsed,
    triggerReasons: triggerResult.reasons,
    diagnosisSummary,
    experienceEntry: {
      situation: triggerResult.humanReadableReasons.join("; "),
      evidenceQuotes: evidenceQuotes.slice(0, 6),
      lessonLearned:
        lessons.join(" ") ||
        "Codified LLM-judged user corrections and tool workflow improvements into workspace configuration.",
    },
    fileOperations,
  };
}