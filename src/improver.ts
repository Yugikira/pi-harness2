import * as fs from "node:fs";
import * as path from "node:path";
import type {
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

  const experiencePath = path.join(workspaceDir, ".pi", "harness2", "EXPERIENCE.md");
  const existingExperience = fs.existsSync(experiencePath)
    ? fs.readFileSync(experiencePath, "utf-8").slice(-2000)
    : "(No prior EXPERIENCE.md entries)";

  const skillsBaseDir = resolveWorkspaceSkillsBaseDir(workspaceDir);

  return [
    "You are the Harness² Workspace Improver for `@earendil-works/pi-coding-agent`.",
    "Analyze the LLM-recorded orchestrator task evidence below and propose concrete, minimal workspace configuration improvements.",
    `Target Skills Directory in this workspace: \`${skillsBaseDir}\``,
    "Allowed target paths: `AGENTS.md`, `.pi/APPEND_SYSTEM.md`, `" +
      skillsBaseDir +
      "/<skill-name>/SKILL.md`, `.pi/agents/<agent-name>.md`, `.pi/extensions/<guardrail-name>.ts`.",
    focusHint ? `User Focus Hint: ${focusHint}` : "",
    "",
    "### Trigger Reasons",
    ...triggerResult.humanReadableReasons.map((r) => `- ${r}`),
    "",
    "### Existing AGENTS.md",
    "```markdown",
    existingAgentsMd,
    "```",
    "",
    "### Existing EXPERIENCE.md (Recent Lessons)",
    "```markdown",
    existingExperience,
    "```",
    "",
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
    "Return ONLY a valid JSON object matching the `HarnessProposal` interface (`diagnosisSummary`, `experienceEntry`, `fileOperations`).",
  ]
    .filter(Boolean)
    .join("\n");
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
        if (
          parsed &&
          Array.isArray(parsed.fileOperations) &&
          parsed.fileOperations.length > 0 &&
          parsed.diagnosisSummary
        ) {
          return {
            ...parsed,
            proposalId: parsed.proposalId || `prop-${Date.now()}`,
            createdAt: new Date().toISOString(),
            modelUsed: llmResult.modelUsed,
            triggerReasons: triggerResult.reasons,
          };
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

  const allSteering = records.flatMap((r) => r.steeringEvents);
  const allInefficiencies = records.flatMap((r) => r.inefficiencyEvents);
  const allSubagents = records.flatMap((r) => r.subagentEvents);

  // 1. Handle Tool InefficiencyEvents -> Generate Skill(s)
  for (const ev of allInefficiencies.slice(-2)) {
    evidenceQuotes.push(ev.description);
    const skillSlug = (ev.fingerprint || "workflow-helper")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
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
    const roleName = subEv.agentProfile ?? subEv.subagentName ?? "worker";
    evidenceQuotes.push(
      `Subagent '${subEv.subagentName}' (${subEv.outcomeSignal}): ${subEv.revisedFiles.join(", ") || subEv.followUpMessages.join(" | ")}`
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
    instructionQuestions.some((q) => /rm\s+-rf|overwrite|raw\s+data|删除|覆盖/i.test(q.userMessageQuote))
  ) {
    const q = instructionQuestions[0];
    evidenceQuotes.push(`User instruction audit: "${q.userMessageQuote}"`);
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
    evidenceQuotes.push(`User (${steer.eventType}): "${steer.userMessageQuote.slice(0, 140)}"`);
    newRules.push(
      `- **Recorded Workspace Guideline (${steer.eventType})**: ${steer.rationale ?? steer.userMessageQuote.replace(/\r?\n/g, " ").slice(0, 140)}`
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

  const deduplicatedRules = Array.from(new Set(newRules));
  const sectionHeader = "\n\n## Harness² Self-Improvement Guidelines\n";
  const updatedAgentsMd = existingAgentsContent.includes("## Harness² Self-Improvement Guidelines")
    ? `${existingAgentsContent.trimEnd()}\n${deduplicatedRules.join("\n")}\n`
    : `${existingAgentsContent.trimEnd()}${sectionHeader}${deduplicatedRules.join("\n")}\n`;

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
