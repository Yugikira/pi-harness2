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
 * Builds the contrastive Harness² reflection prompt for an LLM improver session.
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
    "Analyze the recorded orchestrator task evidence below and propose concrete, minimal workspace configuration improvements.",
    `Target Skills Directory in this workspace: \`${skillsBaseDir}\``,
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
        summary: r.summary,
        steeringEvents: r.steeringEvents,
        inefficiencyEvents: r.inefficiencyEvents,
        subagentEvents: r.subagentEvents,
      })),
      null,
      2
    ),
    "",
    "Return a valid JSON object matching the `HarnessProposal` interface.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Generates an evidence-backed `HarnessProposal` from accumulated `TaskRecord`s.
 * If `ctx.sendMessage` is available and returns valid JSON, uses the LLM response;
 * otherwise synthesizes a deterministic, grounded proposal directly from the recorded evidence.
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
  const modelUsed = resolveImproverModel(config, ctx?.model);

  if (ctx?.sendMessage) {
    try {
      const prompt = buildReflectionPrompt(
        workspaceDir,
        records,
        triggerResult,
        state,
        focusHint
      );
      const llmResponse = await ctx.sendMessage(prompt, { model: modelUsed });
      const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
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
            modelUsed,
            triggerReasons: triggerResult.reasons,
          };
        }
      }
    } catch {
      // Fall back to deterministic synthesis when LLM call fails or is unavailable
    }
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
 * Deterministic evidence-based proposal synthesizer.
 * Inspects recorded steering events, tool inefficiency fingerprints, temp script sprawl,
 * and subagent revisions to generate ready-to-apply workspace files (`AGENTS.md`, `.pi/skills/`, `.pi/agents/`, `.pi/extensions/`).
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

  // 1. Handle Tool Inefficiency & Temp Script Sprawl -> Generate Skill(s) & Tool Guidance
  const hasOpenAlexOrSprawl = allInefficiencies.some(
    (e) =>
      e.fingerprint === "temp_script_sprawl" ||
      e.fingerprint === "network_or_api_query_error"
  );
  const hasPptxResolutionError = allInefficiencies.some(
    (e) =>
      e.fingerprint === "node_esm_module_resolution" ||
      e.toolsInvoked.some((t) => /pptxgenjs|export-pptx/i.test(t.inputSummary))
  );
  const hasGbkEncodingError = allInefficiencies.some(
    (e) => e.fingerprint === "python_stdout_encoding_gbk"
  );

  if (hasOpenAlexOrSprawl) {
    const sprawlEv = allInefficiencies.find(
      (e) => e.fingerprint === "temp_script_sprawl"
    );
    if (sprawlEv) {
      evidenceQuotes.push(sprawlEv.description);
    }
    lessons.push(
      "Avoid creating multiple one-off Python scripts in the workspace root for literature searches; use a single reusable CLI skill with UTF-8 stdout encoding."
    );
    fileOperations.push({
      targetPath: `${skillsBase}/literature-search/SKILL.md`,
      operation: "create",
      componentType: "skill",
      rationale:
        "Replaces ad-hoc root Python scripts and failed OpenAlex filter queries with a single reusable skill.",
      fullNewContent: [
        "---",
        "name: literature-search",
        "description: Query OpenAlex API for academic literature with proper UTF-8 encoding and clean temporary file handling.",
        "---",
        "",
        "# OpenAlex Literature Search Skill",
        "",
        "## Rules",
        "1. **Never** litter the workspace root with temporary `search_*.py` scripts.",
        "2. Always configure UTF-8 output on Windows (`sys.stdout.reconfigure(encoding='utf-8')`).",
        "3. Use the bundled helper script or clean up any scratch file immediately after execution.",
        "",
        "## Working Command Pattern",
        "```bash",
        "python -c \"import sys, urllib.request, urllib.parse, json; sys.stdout.reconfigure(encoding='utf-8'); url='https://api.openalex.org/works?per_page=5&sort=cited_by_count:desc&search=' + urllib.parse.quote('YOUR_QUERY'); print(json.dumps(json.loads(urllib.request.urlopen(url, timeout=15).read()), ensure_ascii=False)[:2000])\"",
        "```",
        "",
      ].join("\n"),
    });
  }

  if (hasPptxResolutionError) {
    const pptxEv = allInefficiencies.find(
      (e) => e.fingerprint === "node_esm_module_resolution"
    );
    if (pptxEv) {
      evidenceQuotes.push(pptxEv.description);
    }
    lessons.push(
      "When running ESM presentation scripts that depend on local node_modules, pass an absolute output path (`$PWD/deck.pptx`) and resolve modules from the skill's `tools/` directory."
    );
    fileOperations.push({
      targetPath: `${skillsBase}/pptx-builder-helper/SKILL.md`,
      operation: "create",
      componentType: "skill",
      rationale:
        "Encapsulates the working ESM module resolution and absolute output path recipe for `pptxgenjs` / `export-pptx.mjs`.",
      fullNewContent: [
        "---",
        "name: pptx-builder-helper",
        "description: Build PowerPoint (.pptx) decks cleanly using the presentation-deck-builder tools without ESM module resolution or relative path errors.",
        "---",
        "",
        "# PPTX Builder Execution Guide",
        "",
        "## Verified Commands",
        "- To export from `deck.json`:",
        "  ```bash",
        "  node .agents/skills/teach-skills/presentation-deck-builder/tools/export-pptx.mjs --input deck.json --output \"$PWD/deck.pptx\"",
        "  ```",
        "- When running custom `pptxgenjs` builder scripts located inside `.agents/skills/teach-skills/presentation-deck-builder/tools/`, always pass `\"$PWD/deck.pptx\"` as the output path rather than `../../../../deck.pptx` so the output lands in the workspace root.",
        "",
      ].join("\n"),
    });
  }

  if (
    !hasOpenAlexOrSprawl &&
    !hasPptxResolutionError &&
    allInefficiencies.length > 0
  ) {
    const topEv = allInefficiencies[allInefficiencies.length - 1];
    evidenceQuotes.push(topEv.description);
    const workingCmd =
      topEv.eventualResolutionCommand ??
      topEv.toolsInvoked[topEv.toolsInvoked.length - 1]?.inputSummary ??
      "echo 'Verified workflow'";
    const skillSlug = topEv.fingerprint.replace(/_/g, "-");
    lessons.push(
      `Standardize [${topEv.fingerprint}] workflow into a skill so the agent uses \`${workingCmd}\` on the first attempt.`
    );
    fileOperations.push({
      targetPath: `${skillsBase}/${skillSlug}/SKILL.md`,
      operation: "create",
      componentType: "skill",
      rationale: `Extracted from recorded tool inefficiency (${topEv.classification}) on [${topEv.fingerprint}].`,
      fullNewContent: [
        "---",
        `name: ${skillSlug}`,
        `description: Verified workflow to avoid ${topEv.fingerprint} errors in this workspace.`,
        "---",
        "",
        `# ${skillSlug} Workflow`,
        "",
        "## Observed Issue",
        topEv.description,
        "",
        "## Verified Resolution Command",
        "```bash",
        workingCmd,
        "```",
        "",
      ].join("\n"),
    });
  }

  // 2. Handle Subagent Revisions -> Generate/Update `.pi/agents/<role>.md` Profile
  if (allSubagents.length > 0) {
    const subEv = allSubagents[allSubagents.length - 1];
    const roleName = subEv.agentProfile ?? subEv.subagentName ?? "worker";
    evidenceQuotes.push(
      `Subagent '${subEv.subagentName}' (${subEv.outcomeSignal}): ${subEv.revisedFiles.join(", ") || subEv.followUpMessages.join(" | ")}`
    );
    lessons.push(
      `Refine subagent profile '.pi/agents/${roleName}.md' with explicit deliverable verification and scope constraints so the orchestrator does not need to rewrite its output.`
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

  // 3. Handle Explicit Instruction-Violation Queries -> Add Project-Level Guardrail Extension if destructive/command violation
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

  // 4. Always Update or Create `AGENTS.md` with Distilled Workspace Rules (Steering + Encoding + Domain Fidelity)
  const agentsMdPath = path.join(workspaceDir, "AGENTS.md");
  const existingAgentsContent = fs.existsSync(agentsMdPath)
    ? fs.readFileSync(agentsMdPath, "utf-8")
    : "# Workspace Agent Instructions (AGENTS.md)\n";

  const newRules: string[] = [];
  if (hasGbkEncodingError) {
    newRules.push(
      "- **Windows Python UTF-8 Output**: Always include `import sys; sys.stdout.reconfigure(encoding='utf-8')` when running inline `python -c` or scripts on Windows to avoid `gbk` `UnicodeEncodeError`."
    );
  }
  for (const steer of allSteering.slice(-4)) {
    evidenceQuotes.push(`User (${steer.eventType}): "${steer.userMessageQuote.slice(0, 140)}"`);
    if (/遗漏|潜在假设|逻辑漂移/.test(steer.userMessageQuote)) {
      newRules.push(
        "- **Strict Premise & Thesis Fidelity**: Before generating or revising `commentary.md`, `deck.pptx`, or `lecture-notes.md`, explicitly cross-check every core premise (e.g., incremental impact of LLMs over prior RPA/automation vs. direct LLM skill demand inversion) so no discussed hypothesis is omitted or drifts."
      );
    } else if (/不要添加这种主标题|be humble|AI-slop/i.test(steer.userMessageQuote)) {
      newRules.push(
        "- **Academic Tone & Slide Titles**: Use the paper title directly as the Slide 1 main title (avoid self-congratulatory labels like '特邀学术点评'), maintain a humble scholarly tone, and eliminate AI-slop phrasing."
      );
    } else if (/清除.*python脚本/.test(steer.userMessageQuote)) {
      newRules.push(
        "- **Workspace Hygiene**: Never leave temporary one-off `.py` helper scripts in the project root after completing literature or data lookups."
      );
    } else {
      newRules.push(
        `- **Recorded User Preference**: Respect user guidance — "${steer.userMessageQuote.replace(/\r?\n/g, " ").slice(0, 120)}"`
      );
    }
  }

  if (focusHint) {
    newRules.push(`- **User Focus Rule**: ${focusHint}`);
  }

  const deduplicatedRules = Array.from(new Set(newRules));
  if (deduplicatedRules.length > 0 || fileOperations.length === 0) {
    if (deduplicatedRules.length === 0) {
      deduplicatedRules.push(
        "- **Workspace Verification**: Verify command flags and file paths before executing multi-step tool chains."
      );
    }
    const sectionHeader = "\n\n## Harness² Self-Improvement Guidelines\n";
    const updatedAgentsMd = existingAgentsContent.includes("## Harness² Self-Improvement Guidelines")
      ? `${existingAgentsContent.trimEnd()}\n${deduplicatedRules.join("\n")}\n`
      : `${existingAgentsContent.trimEnd()}${sectionHeader}${deduplicatedRules.join("\n")}\n`;

    fileOperations.push({
      targetPath: "AGENTS.md",
      operation: fs.existsSync(agentsMdPath) ? "update" : "create",
      componentType: "agents_md",
      rationale:
        "Codifies recurring user steering corrections, domain premises, and environment rules directly into project-root `AGENTS.md`.",
      fullNewContent: updatedAgentsMd,
    });
  }

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
        "Codified user corrections and tool workflow improvements into workspace configuration.",
    },
    fileOperations,
  };
}
