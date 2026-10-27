import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_HARNESS2_CONFIG,
  loadHarness2Config,
  resolveImproverModel,
} from "../src/config.js";
import {
  analyzeOrchestratorTranscript,
  loadSessionJsonlFile,
} from "../src/analyzer.js";
import {
  applyTaskRecordToState,
  createInitialWorkspaceState,
  evaluateTriggers,
  loadWorkspaceState,
  saveWorkspaceState,
} from "../src/triggers.js";
import {
  UnauthorizedTargetPathError,
  applyHarnessProposal,
  undoLatestProposal,
  validateTargetPath,
} from "../src/applier.js";
import { generateHarnessProposal } from "../src/improver.js";
import {
  MENU_OPTION_APPLY,
  MENU_OPTION_DISMISS,
  MENU_OPTION_PREVIEW,
} from "../src/ui.js";
import registerHarness2Extension from "../src/index.js";
import type {
  HarnessProposal,
  PiCommandContext,
  PiExtensionAPI,
  PiSessionEntry,
} from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-harness2-${prefix}-`));
}

describe("1. Configuration & Model Resolution (UT-CFG)", () => {
  it("UT-CFG-01: returns default config when no settings.json files exist", () => {
    const tmpGlobal = makeTempDir("global-empty");
    const tmpWorkspace = makeTempDir("ws-empty");
    const cfg = loadHarness2Config(tmpWorkspace, tmpGlobal);

    assert.equal(cfg.recordMode, "manual");
    assert.equal(cfg.model, null);
    assert.equal(cfg.thresholds.userSteeringCount, 3);
    assert.equal(cfg.thresholds.instructionViolationQuery, 1);
    assert.equal(cfg.thresholds.inefficiencyScore, 3);
    assert.equal(cfg.thresholds.recurringFingerprintCount, 2);
    assert.equal(cfg.thresholds.subagentRevisions, 2);
  });

  it("UT-CFG-02: inherits global settings from ~/.pi/agent/settings.json", () => {
    const tmpGlobal = makeTempDir("global-cfg");
    const tmpWorkspace = makeTempDir("ws-cfg");
    fs.writeFileSync(
      path.join(tmpGlobal, "settings.json"),
      JSON.stringify({
        harness2: {
          recordMode: "auto",
          model: "google/gemini-3.5-flash",
          thresholds: { userSteeringCount: 4 },
        },
      }),
      "utf-8"
    );

    const cfg = loadHarness2Config(tmpWorkspace, tmpGlobal);
    assert.equal(cfg.recordMode, "auto");
    assert.equal(cfg.model, "google/gemini-3.5-flash");
    assert.equal(cfg.thresholds.userSteeringCount, 4);
    assert.equal(cfg.thresholds.inefficiencyScore, 3);
  });

  it("UT-CFG-03: project-level .pi/settings.json overrides global settings & model falls back cleanly", () => {
    const tmpGlobal = makeTempDir("global-override");
    const tmpWorkspace = makeTempDir("ws-override");
    fs.mkdirSync(path.join(tmpWorkspace, ".pi"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpGlobal, "settings.json"),
      JSON.stringify({
        harness2: {
          recordMode: "auto",
          model: "google/gemini-3.5-flash",
          thresholds: { userSteeringCount: 5, inefficiencyScore: 6 },
        },
      }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(tmpWorkspace, ".pi", "settings.json"),
      JSON.stringify({
        harness2: {
          recordMode: "manual",
          model: null,
          thresholds: { userSteeringCount: 2 },
        },
      }),
      "utf-8"
    );

    const cfg = loadHarness2Config(tmpWorkspace, tmpGlobal);
    assert.equal(cfg.recordMode, "manual");
    assert.equal(cfg.model, null);
    assert.equal(cfg.thresholds.userSteeringCount, 2);
    assert.equal(cfg.thresholds.inefficiencyScore, 6);
    assert.equal(
      resolveImproverModel(cfg, "antigravity/gemini-3.8-flash"),
      "antigravity/gemini-3.8-flash"
    );
  });
});

describe("2. Orchestrator Transcript Analyzer (UT-ANA)", () => {
  it("UT-ANA-01: counts user steering across tool rejections and bilingual corrective messages", () => {
    const entries: PiSessionEntry[] = [
      { type: "session", id: "sess-1", cwd: "/mock/ws" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "rm -rf ./data" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "bash was not approved by user" }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "No, don't delete data! Instead of that, read the summary." }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "scene01 不要添加这种主标题，用语AI-slop严重，注意根据 unslop技能进行调整。" }],
        },
      },
    ];

    const record = analyzeOrchestratorTranscript(entries);
    assert.equal(record.summary.userSteeringCount, 3);
    assert.equal(record.steeringEvents[0].eventType, "tool_rejection");
    assert.equal(record.steeringEvents[1].eventType, "corrective_steer");
    assert.equal(record.steeringEvents[2].eventType, "corrective_steer");
  });

  it("UT-ANA-02: detects explicit instruction-compliance / omission / logical-drift questions in English & Chinese", () => {
    const entries: PiSessionEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Why didn't you follow the instructions in AGENTS.md about using uv?" }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "我发现你遗漏了很重要的有关假设的讨论。文章的潜在假设是大语言模型也会促进直接与大语言模型相关的技能需求。我已经手动添加了。为什么你判断它不重要？",
            },
          ],
        },
      },
    ];

    const record = analyzeOrchestratorTranscript(entries);
    assert.equal(record.summary.hasInstructionComplianceQuestion, true);
    assert.equal(record.summary.instructionComplianceQuestionCount, 2);
  });

  it("UT-ANA-03 & UT-ANA-04: distinguishes multi-step trial-and-error chains (+3) from clean multi-step execution (0)", () => {
    const cleanEntries: PiSessionEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "const x = 1;" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "PASS" }],
        },
      },
    ];
    const cleanRec = analyzeOrchestratorTranscript(cleanEntries);
    assert.equal(cleanRec.summary.inefficiencyEventCount, 0);
    assert.equal(cleanRec.summary.inefficiencyScoreAdded, 0);

    const chainEntries: PiSessionEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "e1", name: "bash", arguments: { command: "node -e \"import pptxgen from 'pptxgenjs'\"" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "e1",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pptxgenjs'" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "e2", name: "bash", arguments: { command: "ls .agents/skills/node_modules" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "e2",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "ls: cannot access: No such file or directory\nCommand exited with code 2" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "e3", name: "bash", arguments: { command: "cd .agents/skills/tools && node build.mjs" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "e3",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "Successfully generated deck.pptx" }],
        },
      },
    ];

    const chainRec = analyzeOrchestratorTranscript(chainEntries);
    assert.equal(chainRec.summary.inefficiencyEventCount, 1);
    assert.equal(chainRec.inefficiencyEvents[0].classification, "multi_step_chain");
    assert.equal(chainRec.inefficiencyEvents[0].scoreWeight, 3);
    assert.equal(chainRec.inefficiencyEvents[0].fingerprint, "node_esm_module_resolution");
  });

  it("UT-ANA-05 & UT-ANA-06: infers subagent instruction issues from orchestrator file revisions and corrective subagent_message calls", () => {
    const entries: PiSessionEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "sub-1",
              name: "subagent",
              arguments: { agent: "worker", name: "auth-worker", cli: "pi", task: "Implement src/auth.ts" },
            },
            {
              type: "toolCall",
              id: "sub-2",
              name: "subagent",
              arguments: { agent: "scout", name: "lit-scout", cli: "claude", task: "Summarize papers" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "sub-1",
          toolName: "subagent",
          isError: false,
          content: [{ type: "text", text: "Finished src/auth.ts" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "ed-1", name: "edit", arguments: { path: "src/auth.ts" } },
            {
              type: "toolCall",
              id: "msg-1",
              name: "subagent_message",
              arguments: { name: "lit-scout", message: "You missed the methodology section, please fix." },
            },
            {
              type: "toolCall",
              id: "msg-2",
              name: "subagent_message",
              arguments: { name: "lit-scout", message: "Also redo the table in markdown." },
            },
          ],
        },
      },
    ];

    const record = analyzeOrchestratorTranscript(entries);
    assert.equal(record.summary.subagentRevisionCount, 2);
    const workerEv = record.subagentEvents.find((s) => s.subagentName === "auth-worker");
    const scoutEv = record.subagentEvents.find((s) => s.subagentName === "lit-scout");
    assert.equal(workerEv?.outcomeSignal, "orchestrator_revised_files");
    assert.deepEqual(workerEv?.revisedFiles, ["src/auth.ts"]);
    assert.equal(scoutEv?.outcomeSignal, "multiple_corrective_messages");
  });

  it("UT-ANA-07: idempotent incremental recording via startIndex cursor prevents double counting", () => {
    const entries: PiSessionEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "No, don't do that! Wrong file." }],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Stop editing that module." }],
        },
      },
    ];

    const firstPass = analyzeOrchestratorTranscript(entries.slice(0, 1), { startIndex: 0 });
    assert.equal(firstPass.summary.userSteeringCount, 1);

    const secondPass = analyzeOrchestratorTranscript(entries, { startIndex: 1 });
    assert.equal(secondPass.summary.userSteeringCount, 1);
  });

  it("UT-ANA-08: records single-occurrence friction per task (1 error -> 1 fix) with +1 score and fingerprint", () => {
    const singleOccurrenceEntries: PiSessionEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "py1",
              name: "bash",
              arguments: { command: "python -c \"print(open('paper.md', encoding='utf-8').read())\"" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "py1",
          toolName: "bash",
          isError: true,
          content: [
            {
              type: "text",
              text: "UnicodeEncodeError: 'gbk' codec can't encode character '\\xe4' in position 23",
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "py2",
              name: "bash",
              arguments: {
                command:
                  "python -c \"import sys; sys.stdout.reconfigure(encoding='utf-8'); print(open('paper.md', encoding='utf-8').read())\"",
              },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "py2",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "Paper contents..." }],
        },
      },
    ];

    const record = analyzeOrchestratorTranscript(singleOccurrenceEntries);
    assert.equal(record.summary.inefficiencyEventCount, 1);
    assert.equal(record.inefficiencyEvents[0].classification, "single_retry_recovery");
    assert.equal(record.inefficiencyEvents[0].scoreWeight, 1);
    assert.equal(record.inefficiencyEvents[0].fingerprint, "python_stdout_encoding_gbk");
  });

  it("UT-ANA-09: ignores duplicate user messages resent after provider stopReason=error and context_edit", () => {
    const entries: PiSessionEntry[] = [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "不要添加这种主标题，请修改第一页" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [],
        },
      },
      {
        type: "context_edit",
        targetId: "123",
      },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "aborted",
          content: [],
        },
      },
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "不要添加这种主标题，请修改第一页" }],
        },
      },
    ];

    const record = analyzeOrchestratorTranscript(entries);
    assert.equal(record.summary.userSteeringCount, 1);
    assert.equal(record.summary.networkRetriesIgnored, 1);
  });
});

describe("3. Cross-Task Trigger Evaluation (UT-TRG)", () => {
  it("UT-TRG-01: triggers when single user steering events accumulate to 3 across 3 tasks", () => {
    const state = createInitialWorkspaceState();
    const cfg = DEFAULT_HARNESS2_CONFIG;

    for (let taskNum = 1; taskNum <= 3; taskNum++) {
      const rec = analyzeOrchestratorTranscript(
        [
          {
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "No, don't do that! Wrong file." }],
            },
          },
        ],
        { sessionId: `sess-${taskNum}` }
      );
      applyTaskRecordToState(state, rec, 1);
      const evalRes = evaluateTriggers(state, cfg);
      if (taskNum < 3) {
        assert.equal(evalRes.shouldPropose, false);
      } else {
        assert.equal(evalRes.shouldPropose, true);
        assert.ok(evalRes.reasons.includes("USER_STEERING_THRESHOLD"));
      }
    }
  });

  it("UT-TRG-02: triggers immediately on a single explicit instruction-compliance question", () => {
    const state = createInitialWorkspaceState();
    const rec = analyzeOrchestratorTranscript([
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Why didn't you follow the rules in AGENTS.md?" }],
        },
      },
    ]);
    applyTaskRecordToState(state, rec, 1);
    const evalRes = evaluateTriggers(state, DEFAULT_HARNESS2_CONFIG);
    assert.equal(evalRes.shouldPropose, true);
    assert.ok(evalRes.reasons.includes("EXPLICIT_INSTRUCTION_AUDIT"));
  });

  it("UT-TRG-03: triggers when a single-occurrence tool friction (+1) repeats across 2 tasks (fingerprint match) or 3 tasks (score >= 3)", () => {
    const state = createInitialWorkspaceState();
    const makeSingleGbkTask = (sessId: string) =>
      analyzeOrchestratorTranscript(
        [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "python -c 'print(1)'" } }],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "t1",
              toolName: "bash",
              isError: true,
              content: [{ type: "text", text: "UnicodeEncodeError: 'gbk' codec can't encode" }],
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "python -c \"sys.stdout.reconfigure(encoding='utf-8')\"" } }],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "t2",
              toolName: "bash",
              isError: false,
              content: [{ type: "text", text: "ok" }],
            },
          },
        ],
        { sessionId: sessId }
      );

    const rec1 = makeSingleGbkTask("task-1");
    applyTaskRecordToState(state, rec1, 4);
    assert.equal(state.counters.cumulativeInefficiencyScore, 1);
    assert.equal(state.counters.fingerprintCounts.python_stdout_encoding_gbk, 1);
    assert.equal(evaluateTriggers(state, DEFAULT_HARNESS2_CONFIG).shouldPropose, false);

    const rec2 = makeSingleGbkTask("task-2");
    applyTaskRecordToState(state, rec2, 4);
    assert.equal(state.counters.cumulativeInefficiencyScore, 2);
    assert.equal(state.counters.fingerprintCounts.python_stdout_encoding_gbk, 2);
    const eval2 = evaluateTriggers(state, DEFAULT_HARNESS2_CONFIG);
    assert.equal(eval2.shouldPropose, true);
    assert.ok(eval2.reasons.includes("RECURRING_FINGERPRINT_THRESHOLD"));
  });
});

describe("4. Atomic File Applier, Path Safety & Undo (UT-APP)", () => {
  it("UT-APP-01: blocks path traversal and unauthorized application source files", () => {
    const ws = makeTempDir("ws-security");
    assert.throws(() => validateTargetPath(ws, "../../etc/passwd"), UnauthorizedTargetPathError);
    assert.throws(() => validateTargetPath(ws, "src/index.ts"), UnauthorizedTargetPathError);
    assert.equal(validateTargetPath(ws, "AGENTS.md"), "AGENTS.md");
    assert.equal(validateTargetPath(ws, ".pi/skills/my-skill/SKILL.md"), ".pi/skills/my-skill/SKILL.md");
    assert.equal(validateTargetPath(ws, ".agents/skills/my-skill/SKILL.md"), ".agents/skills/my-skill/SKILL.md");
    assert.equal(validateTargetPath(ws, ".pi/agents/scout.md"), ".pi/agents/scout.md");
    assert.equal(validateTargetPath(ws, ".pi/extensions/guard.ts"), ".pi/extensions/guard.ts");
  });

  it("UT-APP-02: creates atomic backup on apply and restores byte-for-byte on /harness2 undo", () => {
    const ws = makeTempDir("ws-undo");
    const originalAgents = "# Original AGENTS.md\nKeep it minimal.\n";
    fs.writeFileSync(path.join(ws, "AGENTS.md"), originalAgents, "utf-8");

    const state = loadWorkspaceState(ws);
    state.counters.cumulativeUserSteering = 3;
    saveWorkspaceState(ws, state);

    const proposal: HarnessProposal = {
      proposalId: "prop-test-1",
      createdAt: "2026-10-26T00:00:00.000Z",
      modelUsed: "test-model",
      triggerReasons: ["USER_STEERING_THRESHOLD"],
      diagnosisSummary: "Test proposal",
      experienceEntry: {
        situation: "3 user steers",
        evidenceQuotes: ["Quote 1"],
        lessonLearned: "Lesson 1",
      },
      fileOperations: [
        {
          targetPath: "AGENTS.md",
          operation: "update",
          componentType: "agents_md",
          rationale: "Update rules",
          fullNewContent: "# Original AGENTS.md\nKeep it minimal.\n\n## New Section\n- Rule A\n",
        },
        {
          targetPath: ".pi/skills/csv-helper/SKILL.md",
          operation: "create",
          componentType: "skill",
          rationale: "New skill",
          fullNewContent: "---\nname: csv-helper\ndescription: test\n---\n# Body\n",
        },
      ],
    };

    applyHarnessProposal(ws, proposal);
    assert.ok(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf-8").includes("## New Section"));
    assert.ok(fs.existsSync(path.join(ws, ".pi/skills/csv-helper/SKILL.md")));
    assert.ok(fs.existsSync(path.join(ws, ".pi/harness2/EXPERIENCE.md")));
    assert.equal(loadWorkspaceState(ws).counters.cumulativeUserSteering, 0);

    const undoRes = undoLatestProposal(ws);
    assert.equal(undoRes.reverted, true);
    assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf-8"), originalAgents);
    assert.equal(fs.existsSync(path.join(ws, ".pi/skills/csv-helper/SKILL.md")), false);
    assert.equal(loadWorkspaceState(ws).counters.cumulativeUserSteering, 3);
  });
});

describe("5. End-to-End Integration & Real Session Verification (IT-CMD / IT-REAL)", () => {
  it("IT-CMD-01 & IT-CMD-02: executes /harness2 record -> Preview -> Apply -> Undo via ExtensionAPI", async () => {
    const ws = makeTempDir("ws-e2e");
    const commands = new Map<string, (args: string, ctx: PiCommandContext) => Promise<void>>();
    const hooks = new Map<string, (ev: unknown, ctx: PiCommandContext) => Promise<unknown>>();

    const mockPi: PiExtensionAPI = {
      registerCommand(name, cfg) {
        commands.set(name, cfg.handler);
      },
      on(ev, handler) {
        hooks.set(ev, handler);
      },
    };

    registerHarness2Extension(mockPi);
    assert.ok(commands.has("harness2"));
    assert.ok(commands.has("harnees2"));

    const notifications: string[] = [];
    let selectCallCount = 0;

    const ctx: PiCommandContext = {
      cwd: ws,
      sessionId: "sess-e2e-1",
      model: "antigravity/gemini-3.8-flash",
      entries: [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Why didn't you follow the instructions in AGENTS.md about rm -rf?" }],
          },
        },
      ],
      ui: {
        notify(msg) {
          notifications.push(msg);
        },
        async select() {
          selectCallCount += 1;
          return selectCallCount === 1 ? MENU_OPTION_PREVIEW : MENU_OPTION_APPLY;
        },
        async confirm() {
          return true;
        },
      },
    };

    const handler = commands.get("harness2")!;
    await handler("record", ctx);

    assert.equal(selectCallCount, 2);
    assert.ok(fs.existsSync(path.join(ws, "AGENTS.md")));
    assert.ok(fs.existsSync(path.join(ws, ".pi/extensions/workspace-guardrail.ts")));

    await handler("undo", ctx);
    assert.equal(fs.existsSync(path.join(ws, ".pi/extensions/workspace-guardrail.ts")), false);
  });

  it("IT-CMD-03 & IT-AUTO-01: supports Dismiss flow and passive auto-recording on agent_before_settle", async () => {
    const ws = makeTempDir("ws-auto");
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "settings.json"),
      JSON.stringify({ harness2: { recordMode: "auto" } }),
      "utf-8"
    );

    const hooks = new Map<string, (ev: unknown, ctx: PiCommandContext) => Promise<unknown>>();
    const mockPi: PiExtensionAPI = {
      registerCommand() {},
      on(ev, handler) {
        hooks.set(ev, handler);
      },
    };
    registerHarness2Extension(mockPi);

    let dismissed = false;
    const ctx: PiCommandContext = {
      cwd: ws,
      sessionId: "sess-auto-1",
      entries: [
        {
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "Why didn't you follow instructions?" }],
          },
        },
      ],
      ui: {
        notify() {},
        async select() {
          dismissed = true;
          return MENU_OPTION_DISMISS;
        },
        async confirm() {
          return true;
        },
      },
    };

    const settleHook = hooks.get("agent_before_settle")!;
    await settleHook({}, ctx);

    assert.equal(dismissed, true);
    const expContent = fs.readFileSync(path.join(ws, ".pi/harness2/EXPERIENCE.md"), "utf-8");
    assert.ok(expContent.includes("[DISMISSED]"));
  });

  it("IT-REAL-01 & IT-REAL-02: accurately analyzes bundled real-session fixture and full session_1/session_2 logs", async () => {
    const cwdFixturePath = path.resolve(
      process.cwd(),
      "test/fixtures/real-sessions-sample.jsonl"
    );
    const localFixturePath = path.resolve(
      __dirname,
      "fixtures/real-sessions-sample.jsonl"
    );
    const activeFixturePath = fs.existsSync(cwdFixturePath)
      ? cwdFixturePath
      : localFixturePath;

    const sampleEntries = loadSessionJsonlFile(activeFixturePath);
    const sampleRec = analyzeOrchestratorTranscript(sampleEntries);
    assert.equal(sampleRec.summary.hasInstructionComplianceQuestion, true);
    assert.ok(
      sampleRec.inefficiencyEvents.some((e) => e.fingerprint === "temp_script_sprawl")
    );
    assert.ok(
      sampleRec.inefficiencyEvents.some(
        (e) => e.fingerprint === "python_stdout_encoding_gbk" && e.classification === "single_retry_recovery"
      )
    );

    const session1Path = "/working_dir/c_26e9df1852e75c3d/downloads/session_1.jsonl";
    const session2Path = "/working_dir/c_26e9df1852e75c3d/downloads/session_2.jsonl";
    if (!fs.existsSync(session1Path) || !fs.existsSync(session2Path)) {
      return;
    }

    const entries1 = loadSessionJsonlFile(session1Path);
    const rec1 = analyzeOrchestratorTranscript(entries1);
    assert.equal(rec1.summary.hasInstructionComplianceQuestion, true);
    assert.ok(rec1.summary.userSteeringCount >= 4);
    assert.ok(rec1.summary.networkRetriesIgnored >= 1);
    assert.ok(
      rec1.inefficiencyEvents.some((e) => e.fingerprint === "temp_script_sprawl")
    );
    assert.ok(
      rec1.inefficiencyEvents.some((e) => e.fingerprint === "python_stdout_encoding_gbk")
    );

    const entries2 = loadSessionJsonlFile(session2Path);
    const rec2 = analyzeOrchestratorTranscript(entries2);
    assert.equal(rec2.summary.hasInstructionComplianceQuestion, true);
    assert.ok(rec2.summary.networkRetriesIgnored >= 1);
    assert.ok(
      rec2.inefficiencyEvents.some((e) => e.fingerprint === "node_esm_module_resolution")
    );

    const ws = makeTempDir("ws-real-synth");
    fs.mkdirSync(path.join(ws, ".agents", "skills"), { recursive: true });
    const state = createInitialWorkspaceState();
    applyTaskRecordToState(state, rec1, entries1.length);
    applyTaskRecordToState(state, rec2, entries2.length);
    const trig = evaluateTriggers(state, DEFAULT_HARNESS2_CONFIG);
    assert.equal(trig.shouldPropose, true);

    const proposal = await generateHarnessProposal(
      ws,
      [rec1, rec2],
      trig,
      state,
      DEFAULT_HARNESS2_CONFIG
    );
    assert.ok(proposal.fileOperations.some((op) => op.targetPath === "AGENTS.md"));
    assert.ok(
      proposal.fileOperations.some((op) => op.targetPath.startsWith(".agents/skills/"))
    );
  });
});
