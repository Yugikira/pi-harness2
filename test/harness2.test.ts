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
  buildSessionDigest,
  loadSessionJsonlFile,
  resolveFullUncompactedEntries,
} from "../src/analyzer.js";
import {
  buildRecordFromMechanicalFacts,
  buildRecorderPrompt,
  recordSessionWithModel,
} from "../src/recorder.js";
import {
  applyTaskRecordToState,
  createInitialWorkspaceState,
  evaluateTriggers,
  loadWorkspaceState,
  saveWorkspaceState,
} from "../src/triggers.js";
import {
  UnauthorizedTargetPathError,
  appendExperienceEntry,
  applyHarnessProposal,
  undoLatestProposal,
  validateTargetPath,
} from "../src/applier.js";
import {
  generateHarnessProposal,
  normalizeHarnessProposal,
} from "../src/improver.js";
import {
  MENU_OPTION_APPLY,
  MENU_OPTION_DISMISS,
  MENU_OPTION_PREVIEW,
  formatProposalCard,
} from "../src/ui.js";
import {
  loadRecentTaskRecords,
  saveTaskRecord,
} from "../src/triggers.js";
import registerHarness2Extension from "../src/index.js";
import type {
  HarnessProposal,
  PiCommandContext,
  PiExtensionAPI,
  PiModelRegistry,
  PiSessionEntry,
} from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-harness2-${prefix}-`));
}

/**
 * Helper to create a mock `PiModelRegistry` that inspects the prompt (including `<session_digest>`)
 * and returns a structured JSON response simulating the AI Model Judge.
 */
function createMockModelRegistry(
  customResponder?: (promptText: string, modelId: string) => Record<string, unknown>
): { registry: PiModelRegistry; promptsReceived: string[]; modelsCalled: string[] } {
  const promptsReceived: string[] = [];
  const modelsCalled: string[] = [];

  const registry: PiModelRegistry = {
    find(provider, modelId) {
      return { id: modelId, provider };
    },
    async complete(model, request) {
      const mId = typeof model === "string" ? model : `${model.provider ?? "mock"}/${model.id}`;
      modelsCalled.push(mId);
      const firstMsg = request.messages[0];
      const promptText =
        typeof firstMsg.content === "string"
          ? firstMsg.content
          : firstMsg.content.map((c) => c.text).join("\n");
      promptsReceived.push(promptText);

      const responseObj = customResponder
        ? customResponder(promptText, mId)
        : {
            steeringEvents: [],
            inefficiencyEvents: [],
            subagentEvents: [],
          };

      return {
        content: [
          {
            type: "text",
            text: "```json\n" + JSON.stringify(responseObj, null, 2) + "\n```",
          },
        ],
        usage: { inputTokens: 500, outputTokens: 200 },
      };
    },
  };

  return { registry, promptsReceived, modelsCalled };
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
          model: "google/gemini-2.5-flash",
          thresholds: { userSteeringCount: 4 },
        },
      }),
      "utf-8"
    );

    const cfg = loadHarness2Config(tmpWorkspace, tmpGlobal);
    assert.equal(cfg.recordMode, "auto");
    assert.equal(cfg.model, "google/gemini-2.5-flash");
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
          model: "google/gemini-2.5-flash",
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

describe("2. Stage 1 — Uncompacted Session Digest & Mechanical Facts (UT-DIG)", () => {
  it("UT-DIG-01: restores pre-compaction messages across type='compaction' entries and strips thinking/images", () => {
    const entries: PiSessionEntry[] = [
      { type: "session", id: "sess-compact-1", cwd: "/mock/ws" },
      {
        type: "message",
        id: "m1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Pre-compaction instruction: analyze paper.md" }],
        },
      },
      {
        type: "message",
        id: "m2",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Very long internal reasoning that should be stripped..." },
            { type: "toolCall", id: "tc-1", name: "read", arguments: { path: "paper.md" } },
          ],
        },
      },
      {
        type: "message",
        id: "m3",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "read",
          isError: false,
          content: [
            { type: "image", text: "base64-mega-blob" },
            { type: "text", text: "Paper contents..." },
          ],
        },
      },
      // Compaction entry inserted mid-session by Pi
      {
        type: "compaction",
        id: "cmp-1",
        firstKeptEntryId: "m4",
        summary: "Summarized m1..m3",
      },
      {
        type: "message",
        id: "m4",
        message: {
          role: "user",
          content: [{ type: "text", text: "Post-compaction: why did you omit the second assumption?" }],
        },
      },
    ];

    const ctx: PiCommandContext = {
      sessionManager: {
        getBranch() {
          return entries;
        },
      },
      ui: {
        notify() {},
        async select() {
          return undefined;
        },
        async confirm() {
          return true;
        },
      },
    };

    const resolved = resolveFullUncompactedEntries(ctx);
    assert.equal(resolved.length, 6);

    const digest = buildSessionDigest(resolved);
    assert.equal(digest.mechanicalFacts.compactionEntriesRestored, 1);
    assert.deepEqual(digest.mechanicalFacts.filesRead, ["paper.md"]);
    assert.ok(digest.serializedTranscript.includes("Pre-compaction instruction: analyze paper.md"));
    assert.ok(digest.serializedTranscript.includes("Post-compaction: why did you omit the second assumption?"));
    assert.ok(!digest.serializedTranscript.includes("Very long internal reasoning"));
  });

  it("UT-DIG-02: ignores context_edit retracted turns and provider stopReason=error duplicate user resends, while preserving intentional repetition", () => {
    const entries: PiSessionEntry[] = [
      {
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please fix slide 3 logical drift." }],
        },
      },
      {
        type: "message",
        id: "a1-err",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [],
        },
      },
      {
        type: "context_edit",
        targetId: "a1-err",
        replacement: null,
      },
      {
        type: "message",
        id: "u2-retry",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please fix slide 3 logical drift." }],
        },
      },
    ];

    const digest = buildSessionDigest(entries);
    assert.equal(digest.mechanicalFacts.networkRetriesIgnored, 1);
    const matches = digest.serializedTranscript.match(/Please fix slide 3 logical drift/g) ?? [];
    assert.equal(matches.length, 1);

    // Verify intentional user repetitions without provider errors are preserved
    const intentionalRepeatEntries: PiSessionEntry[] = [
      {
        type: "message",
        id: "u1-normal",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please fix slide 3 logical drift." }],
        },
      },
      {
        type: "message",
        id: "a1-normal",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I made some edits." }],
        },
      },
      {
        type: "message",
        id: "u2-repeat",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please fix slide 3 logical drift." }],
        },
      },
    ];

    const intentionalDigest = buildSessionDigest(intentionalRepeatEntries);
    assert.equal(intentionalDigest.mechanicalFacts.networkRetriesIgnored, 0);
    const repeatMatches =
      intentionalDigest.serializedTranscript.match(/Please fix slide 3 logical drift/g) ?? [];
    assert.equal(repeatMatches.length, 2);
  });

  it("UT-DIG-03: extracts mechanical facts for root script sprawl, failed tool calls, and subagent file revisions", () => {
    const entries: PiSessionEntry[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "w1", name: "write", arguments: { path: "s1.py", content: "1" } },
            { type: "toolCall", id: "w2", name: "write", arguments: { path: "s2.py", content: "2" } },
            { type: "toolCall", id: "w3", name: "write", arguments: { path: "s3.py", content: "3" } },
            {
              type: "toolCall",
              id: "sub1",
              name: "subagent",
              arguments: { agent: "worker", name: "auth-worker", cli: "pi", task: "Write src/auth.ts" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "sub1",
          toolName: "subagent",
          isError: false,
          content: [{ type: "text", text: "Completed src/auth.ts" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "ed1", name: "edit", arguments: { path: "src/auth.ts", edits: [] } },
          ],
        },
      },
    ];

    const digest = buildSessionDigest(entries);
    assert.deepEqual(digest.mechanicalFacts.rootScriptsCreated, ["s1.py", "s2.py", "s3.py"]);
    assert.equal(digest.mechanicalFacts.subagentInteractions.length, 1);
    assert.deepEqual(
      digest.mechanicalFacts.subagentInteractions[0].orchestratorEditedSameFiles,
      ["src/auth.ts"]
    );
  });
});

describe("3. Stage 2 — AI Model Semantic Recorder & Cross-Task Fingerprinting (UT-REC / UT-TRG)", () => {
  it("UT-REC-01: calls ctx.modelRegistry.complete with SessionDigest and parses LLM semantic judgment", async () => {
    const entries: PiSessionEntry[] = [
      { type: "session", id: "sess-llm-1", cwd: "/mock/ws" },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "Your slide 3 subtly inverted my argument about incremental RPA impact vs direct LLM skill demand.",
            },
          ],
        },
      },
    ];

    const { registry, promptsReceived } = createMockModelRegistry(() => ({
      steeringEvents: [
        {
          entryIndex: 1,
          eventType: "instruction_compliance_question",
          userMessageQuote:
            "Your slide 3 subtly inverted my argument about incremental RPA impact vs direct LLM skill demand.",
          precedingAssistantActionSummary: "Generated deck.pptx",
          rationale: "User identified semantic logical drift from core research thesis.",
        },
      ],
      inefficiencyEvents: [
        {
          turnRange: [1, 2],
          classification: "single_retry_recovery",
          scoreWeight: 1,
          fingerprint: "windows_python_gbk_encoding",
          eventualResolutionCommand: "sys.stdout.reconfigure(encoding='utf-8')",
          description: "Hit GBK encoding error once and recovered via utf-8 reconfigure.",
        },
      ],
      subagentEvents: [],
    }));

    const ctx: PiCommandContext = {
      model: "google/gemini-2.5-flash",
      modelRegistry: registry,
      ui: {
        notify() {},
        async select() {
          return undefined;
        },
        async confirm() {
          return true;
        },
      },
    };

    const { record } = await recordSessionWithModel(
      entries,
      { existingFingerprints: ["windows_python_gbk_encoding"] },
      ctx
    );

    assert.equal(promptsReceived.length, 1);
    assert.ok(promptsReceived[0].includes("<session_digest>"));
    assert.ok(promptsReceived[0].includes("windows_python_gbk_encoding"));
    assert.equal(record.recordedBy, "llm_judge");
    assert.equal(record.summary.hasInstructionComplianceQuestion, true);
    assert.equal(record.summary.inefficiencyScoreAdded, 1);
    assert.equal(record.inefficiencyEvents[0].fingerprint, "windows_python_gbk_encoding");
  });

  it("UT-TRG-01 & UT-TRG-03: accumulates LLM-judged single-occurrence frictions and triggers on recurring fingerprint", async () => {
    const state = createInitialWorkspaceState();
    const { registry } = createMockModelRegistry(() => ({
      steeringEvents: [],
      inefficiencyEvents: [
        {
          turnRange: [1, 2],
          classification: "single_retry_recovery",
          scoreWeight: 1,
          fingerprint: "custom_stata_flag_error",
          eventualResolutionCommand: "stata-mp -b do analysis.do",
          description: "Used wrong batch flag once before finding -b.",
        },
      ],
      subagentEvents: [],
    }));

    const ctx: PiCommandContext = {
      model: "google/gemini-2.5-flash",
      modelRegistry: registry,
      ui: {
        notify() {},
        async select() {
          return undefined;
        },
        async confirm() {
          return true;
        },
      },
    };

    // Task 1: single occurrence (+1 score, fingerprint count = 1)
    const { record: r1 } = await recordSessionWithModel(
      [{ type: "session", id: "t1" }],
      { sessionId: "t1" },
      ctx
    );
    applyTaskRecordToState(state, r1, 1);
    assert.equal(state.counters.fingerprintCounts.custom_stata_flag_error, 1);
    assert.equal(evaluateTriggers(state, DEFAULT_HARNESS2_CONFIG).shouldPropose, false);

    // Task 2: same single-occurrence friction repeats (+1 score, fingerprint count = 2) -> triggers!
    const { record: r2 } = await recordSessionWithModel(
      [{ type: "session", id: "t2" }],
      { sessionId: "t2", existingFingerprints: Object.keys(state.counters.fingerprintCounts) },
      ctx
    );
    applyTaskRecordToState(state, r2, 1);
    assert.equal(state.counters.fingerprintCounts.custom_stata_flag_error, 2);
    const trig = evaluateTriggers(state, DEFAULT_HARNESS2_CONFIG);
    assert.equal(trig.shouldPropose, true);
    assert.ok(trig.reasons.includes("RECURRING_FINGERPRINT_THRESHOLD"));
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
      createdAt: "2026-10-28T00:00:00.000Z",
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

    const undoRes = undoLatestProposal(ws);
    assert.equal(undoRes.reverted, true);
    assert.equal(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf-8"), originalAgents);
    assert.equal(fs.existsSync(path.join(ws, ".pi/skills/csv-helper/SKILL.md")), false);
    assert.equal(loadWorkspaceState(ws).counters.cumulativeUserSteering, 3);
  });
});

describe("5. End-to-End Integration, Compaction Hooks & Real Session Logs (IT-CMD / IT-REAL)", () => {
  it("IT-CMD-01 & IT-CMD-02: executes /harness2 record with LLM Judge -> Preview -> Apply -> Undo", async () => {
    const ws = makeTempDir("ws-e2e");
    const commands = new Map<string, (args: string, ctx: PiCommandContext) => Promise<void>>();
    const hooks = new Map<string, (ev: any, ctx: PiCommandContext) => Promise<unknown>>();

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
    assert.ok(hooks.has("session_before_compact"));
    assert.ok(hooks.has("session_shutdown"));

    let callIdx = 0;
    const { registry } = createMockModelRegistry(() => {
      callIdx += 1;
      if (callIdx === 1) {
        // Call 1: Stage 2 Recorder LLM output
        return {
          steeringEvents: [
            {
              entryIndex: 1,
              eventType: "instruction_compliance_question",
              userMessageQuote: "Why didn't you follow the instructions in AGENTS.md about rm -rf?",
              precedingAssistantActionSummary: "ran bash rm -rf",
              rationale: "User audited instruction violation on destructive command.",
            },
          ],
          inefficiencyEvents: [],
          subagentEvents: [],
        };
      }
      // Call 2: Stage 3 Improver LLM output
      return {
        proposalId: "prop-llm-e2e",
        diagnosisSummary: "Add guardrail and AGENTS.md rule for rm -rf",
        experienceEntry: {
          situation: "Agent attempted rm -rf despite AGENTS.md rule",
          evidenceQuotes: ["Why didn't you follow the instructions in AGENTS.md about rm -rf?"],
          lessonLearned: "Enforce destructive command check via project-level extension.",
        },
        fileOperations: [
          {
            targetPath: "AGENTS.md",
            operation: "create",
            componentType: "agents_md",
            rationale: "Document safe cleanup policy",
            fullNewContent: "# AGENTS.md\n- Never run rm -rf without confirmation.\n",
          },
          {
            targetPath: ".pi/extensions/workspace-guardrail.ts",
            operation: "create",
            componentType: "guardrail_extension",
            rationale: "Intercept rm -rf in tool_call",
            fullNewContent: "// Guardrail extension\nexport default function () {}\n",
          },
        ],
      };
    });

    let selectCallCount = 0;
    const ctx: PiCommandContext = {
      cwd: ws,
      sessionId: "sess-e2e-1",
      model: "antigravity/gemini-3.8-flash",
      modelRegistry: registry,
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
        notify() {},
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

  it("IT-AUTO-01: hooks session_before_compact and session_shutdown in auto mode without double-counting", async () => {
    const ws = makeTempDir("ws-auto");
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "settings.json"),
      JSON.stringify({ harness2: { recordMode: "auto" } }),
      "utf-8"
    );

    const hooks = new Map<string, (ev: any, ctx: PiCommandContext) => Promise<unknown>>();
    const mockPi: PiExtensionAPI = {
      registerCommand() {},
      on(ev, handler) {
        hooks.set(ev, handler);
      },
    };
    registerHarness2Extension(mockPi);

    const { registry, promptsReceived } = createMockModelRegistry(() => ({
      steeringEvents: [
        {
          entryIndex: 1,
          eventType: "corrective_steer",
          userMessageQuote: "Please use UTF-8",
          precedingAssistantActionSummary: "ran script",
        },
      ],
      inefficiencyEvents: [],
      subagentEvents: [],
    }));

    const branchEntries: PiSessionEntry[] = [
      { type: "session", id: "sess-auto-compact" },
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Please use UTF-8" }] },
      },
    ];

    const ctx: PiCommandContext = {
      cwd: ws,
      sessionId: "sess-auto-compact",
      modelRegistry: registry,
      sessionManager: {
        getBranch() {
          return branchEntries;
        },
      },
      ui: {
        notify() {},
        async select() {
          return MENU_OPTION_DISMISS;
        },
        async confirm() {
          return true;
        },
      },
    };

    // 1. Trigger `session_before_compact` -> records entries 0..2
    const beforeCompact = hooks.get("session_before_compact")!;
    await beforeCompact({ branchEntries }, ctx);
    assert.equal(promptsReceived.length, 1);
    assert.equal(loadWorkspaceState(ws).counters.cumulativeUserSteering, 1);

    // 2. Trigger `session_shutdown` with no new entries -> cursor is already at 2, so 0 new LLM calls!
    const onShutdown = hooks.get("session_shutdown")!;
    await onShutdown({}, ctx);
    assert.equal(promptsReceived.length, 1);

    // 3. Append a post-compaction entry and trigger `session_shutdown` -> records only the new slice!
    branchEntries.push(
      { type: "compaction", id: "cmp-1", firstKeptEntryId: "m-post" },
      {
        type: "message",
        id: "m-post",
        message: { role: "user", content: [{ type: "text", text: "Another steer after compaction" }] },
      }
    );
    await onShutdown({}, ctx);
    assert.equal(promptsReceived.length, 2);
    assert.equal(loadWorkspaceState(ws).counters.cumulativeUserSteering, 2);
  });

  it("IT-REAL-01 & IT-REAL-02: compresses 3.7MB real session_1/session_2 logs into compact digests and feeds LLM Judge", async () => {
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
    const sampleDigest = buildSessionDigest(sampleEntries);
    assert.ok(sampleDigest.mechanicalFacts.rootScriptsCreated.length >= 3);
    assert.ok(sampleDigest.mechanicalFacts.failedToolCalls.length >= 1);

    const session1Path = "/working_dir/c_26e9df1852e75c3d/downloads/session_1.jsonl";
    const session2Path = "/working_dir/c_26e9df1852e75c3d/downloads/session_2.jsonl";
    if (!fs.existsSync(session1Path) || !fs.existsSync(session2Path)) {
      return;
    }

    const entries1 = loadSessionJsonlFile(session1Path);
    const digest1 = buildSessionDigest(entries1);
    // Verify 790KB session_1 is compressed to a compact text digest (< 40KB) with all 11 root scripts captured
    assert.ok(digest1.serializedTranscript.length < 40000);
    assert.ok(digest1.mechanicalFacts.rootScriptsCreated.length >= 10);
    assert.ok(digest1.mechanicalFacts.networkRetriesIgnored >= 1);

    const entries2 = loadSessionJsonlFile(session2Path);
    const digest2 = buildSessionDigest(entries2);
    // Verify 3.7MB session_2 (with 3MB base64 images) is compressed to < 30KB while preserving dialogue & tool errors!
    assert.ok(
      digest2.serializedTranscript.length < 30000,
      `Expected digest2 < 30KB, got ${digest2.serializedTranscript.length} chars`
    );
    assert.ok(digest2.serializedTranscript.includes("逻辑漂移"));
    assert.ok(digest2.mechanicalFacts.failedToolCalls.length >= 3);

    // Feed real session_1 and session_2 digests into the LLM Recorder pipeline
    const { registry, promptsReceived } = createMockModelRegistry((promptText) => {
      const isSession1 = promptText.includes("search_literature.py");
      if (isSession1) {
        return {
          steeringEvents: [
            {
              entryIndex: 136,
              eventType: "instruction_compliance_question",
              userMessageQuote: "我发现你遗漏了很重要的有关假设的讨论...为什么你判断它不重要？",
              precedingAssistantActionSummary: "Generated commentary.md",
              rationale: "User questioned why a core hypothesis from the discussion was omitted.",
            },
          ],
          inefficiencyEvents: [
            {
              turnRange: [19, 65],
              classification: "temp_script_sprawl",
              scoreWeight: 3,
              fingerprint: "openalex_root_script_sprawl",
              sprawlScriptsCreated: digest1.mechanicalFacts.rootScriptsCreated,
              description: "Created 11 temporary Python scripts in workspace root to query OpenAlex.",
            },
            {
              turnRange: [101, 103],
              classification: "single_retry_recovery",
              scoreWeight: 1,
              fingerprint: "windows_python_gbk_encoding",
              eventualResolutionCommand: "sys.stdout.reconfigure(encoding='utf-8')",
              description: "Hit GBK UnicodeEncodeError once and fixed with utf-8 stdout reconfigure.",
            },
          ],
          subagentEvents: [],
        };
      }
      return {
        steeringEvents: [
          {
            entryIndex: 108,
            eventType: "instruction_compliance_question",
            userMessageQuote: "我发现你仍然发生了一些逻辑漂移...是否出现了重大漂移？",
            precedingAssistantActionSummary: "Generated deck.pptx",
            rationale: "User audited logical drift between thesis and slide text.",
          },
        ],
        inefficiencyEvents: [
          {
            turnRange: [77, 96],
            classification: "multi_step_chain",
            scoreWeight: 3,
            fingerprint: "pptxgenjs_esm_and_path_resolution",
            eventualResolutionCommand:
              "node .agents/skills/teach-skills/presentation-deck-builder/tools/build-beautiful-deck.mjs \"$PWD/deck.pptx\"",
            description: "Fumbled with pptxgenjs node_modules resolution and ../../../../deck.pptx relative path.",
          },
        ],
        subagentEvents: [],
      };
    });

    const mockCtx: PiCommandContext = {
      model: "antigravity/gemini-3.8-flash",
      modelRegistry: registry,
      ui: {
        notify() {},
        async select() {
          return undefined;
        },
        async confirm() {
          return true;
        },
      },
    };

    const { record: r1 } = await recordSessionWithModel(entries1, {}, mockCtx);
    const { record: r2 } = await recordSessionWithModel(
      entries2,
      { existingFingerprints: r1.inefficiencyEvents.map((e) => e.fingerprint) },
      mockCtx
    );

    assert.equal(promptsReceived.length, 2);
    assert.equal(r1.recordedBy, "llm_judge");
    assert.equal(r2.recordedBy, "llm_judge");
    assert.equal(r1.summary.inefficiencyScoreAdded, 4);
    assert.equal(r2.summary.inefficiencyScoreAdded, 3);
  });
});

describe("6. Proposal Normalization, Safe Card Rendering & Next-Session Startup Hook", () => {
  it("UT-NORM-01: normalizes LLM proposal missing experienceEntry or evidenceQuotes without throwing", () => {
    const rawProposalWithoutExp = {
      diagnosisSummary: "Standardize literature queries into reusable skill",
      fileOperations: [
        {
          targetPath: ".pi/skills/literature-search/SKILL.md",
          operation: "create",
          componentType: "skill",
          rationale: "Replaces temporary scripts with reusable skill",
          fullNewContent: "# Literature Search Skill",
        },
      ],
    };

    const triggerResult = {
      shouldPropose: true,
      reasons: ["TOOL_INEFFICIENCY_SCORE_THRESHOLD"],
      humanReadableReasons: ["Accumulated tool inefficiency score of 3."],
    };

    const mockRecords = [
      {
        recordId: "rec-1",
        sessionId: "sess-1",
        timestamp: new Date().toISOString(),
        workspacePath: "/mock/ws",
        recordedBy: "llm_judge",
        summary: {
          totalEntriesAnalyzed: 5,
          totalToolCalls: 3,
          userSteeringCount: 1,
          instructionComplianceQuestionCount: 0,
          hasInstructionComplianceQuestion: false,
          inefficiencyEventCount: 1,
          inefficiencyScoreAdded: 3,
          subagentRevisionCount: 0,
          networkRetriesIgnored: 0,
        },
        steeringEvents: [
          {
            entryIndex: 2,
            eventType: "corrective_steer",
            userMessageQuote: "Do not create scripts in the root directory!",
            precedingAssistantActionSummary: "bash(python search.py)",
          },
        ],
        inefficiencyEvents: [
          {
            turnRange: [1, 4],
            classification: "temp_script_sprawl",
            scoreWeight: 3,
            fingerprint: "temp_script_sprawl",
            toolsInvoked: [],
            description: "Created 3 ad-hoc Python scripts in root.",
          },
        ],
        subagentEvents: [],
      },
    ];

    const normalized = normalizeHarnessProposal(
      rawProposalWithoutExp,
      mockRecords,
      triggerResult,
      "google/gemini-2.5-flash"
    );

    assert.ok(normalized);
    assert.equal(normalized.modelUsed, "google/gemini-2.5-flash");
    assert.ok(normalized.experienceEntry);
    assert.ok(Array.isArray(normalized.experienceEntry.evidenceQuotes));
    assert.ok(normalized.experienceEntry.evidenceQuotes.length > 0);
    assert.ok(
      normalized.experienceEntry.evidenceQuotes.some(
        (q) => q.includes("temp_script_sprawl") || q.includes("root directory")
      )
    );
    assert.equal(normalized.fileOperations.length, 1);

    // Verify formatProposalCard renders safely without throwing undefined is not an object
    const cardText = formatProposalCard(normalized);
    assert.ok(cardText.includes("Proposal ID:"));
    assert.ok(cardText.includes("Observed Evidence:"));

    // Verify raw malformed proposal also does not crash formatProposalCard
    const rawPartialProposal = {
      proposalId: "prop-raw-test",
      createdAt: new Date().toISOString(),
      modelUsed: "test-model",
      triggerReasons: ["MANUAL_FORCE_PROPOSE"],
      diagnosisSummary: "Raw partial test",
      fileOperations: [],
    };
    const safeCard = formatProposalCard(rawPartialProposal);
    assert.ok(safeCard.includes("prop-raw-test"));

    const ws = makeTempDir("ws-exp-test");
    // Verify appendExperienceEntry also executes without throwing
    appendExperienceEntry(ws, normalized, "APPLIED");
    const expContent = fs.readFileSync(
      path.join(ws, ".pi", "harness2", "EXPERIENCE.md"),
      "utf-8"
    );
    assert.ok(expContent.includes("[APPLIED]"));
  });

  it("UT-NORM-02: loadRecentTaskRecords prioritizes friction records over empty session records", () => {
    const ws = makeTempDir("ws-prioritize-records");

    // Save 2 records with real friction
    for (let i = 1; i <= 2; i++) {
      saveTaskRecord(ws, {
        recordId: `rec-friction-${i}`,
        sessionId: `sess-${i}`,
        timestamp: `2026-10-29T10:0${i}:00.000Z`,
        workspacePath: ws,
        recordedBy: "llm_judge",
        summary: {
          totalEntriesAnalyzed: 10,
          totalToolCalls: 5,
          userSteeringCount: 1,
          instructionComplianceQuestionCount: 0,
          hasInstructionComplianceQuestion: false,
          inefficiencyEventCount: 1,
          inefficiencyScoreAdded: 1,
          subagentRevisionCount: 0,
          networkRetriesIgnored: 0,
        },
        steeringEvents: [
          {
            entryIndex: 1,
            eventType: "corrective_steer",
            userMessageQuote: `Steering quote ${i}`,
            precedingAssistantActionSummary: "action",
          },
        ],
        inefficiencyEvents: [
          {
            turnRange: [1, 2],
            classification: "single_retry_recovery",
            scoreWeight: 1,
            fingerprint: "python_encoding",
            toolsInvoked: [],
            description: `Tool error ${i}`,
          },
        ],
        subagentEvents: [],
      });
    }

    // Now save 5 empty session records (e.g. user started Pi and quit without doing anything)
    for (let i = 3; i <= 7; i++) {
      saveTaskRecord(ws, {
        recordId: `rec-empty-${i}`,
        sessionId: `sess-${i}`,
        timestamp: `2026-10-29T11:0${i}:00.000Z`,
        workspacePath: ws,
        recordedBy: "mechanical_fallback",
        summary: {
          totalEntriesAnalyzed: 1,
          totalToolCalls: 0,
          userSteeringCount: 0,
          instructionComplianceQuestionCount: 0,
          hasInstructionComplianceQuestion: false,
          inefficiencyEventCount: 0,
          inefficiencyScoreAdded: 0,
          subagentRevisionCount: 0,
          networkRetriesIgnored: 0,
        },
        steeringEvents: [],
        inefficiencyEvents: [],
        subagentEvents: [],
      });
    }

    const loaded = loadRecentTaskRecords(ws, 5);
    // Should prioritize the friction-containing records
    assert.ok(loaded.some((r) => r.recordId.startsWith("rec-friction-")));
    assert.ok(loaded.some((r) => r.steeringEvents.length > 0));
  });

  it("IT-AUTO-02: next-session startup prompts user when prior threshold met and handles review/snooze", async () => {
    const ws = makeTempDir("ws-session-start");
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "settings.json"),
      JSON.stringify({ harness2: { recordMode: "auto" } }),
      "utf-8"
    );

    // Seed state with friction crossing instruction violation threshold
    const state = createInitialWorkspaceState();
    state.counters.cumulativeInstructionQuestions = 1;
    saveWorkspaceState(ws, state);

    // Save a real task record with instruction audit
    saveTaskRecord(ws, {
      recordId: "rec-prior-1",
      sessionId: "sess-prior",
      timestamp: new Date().toISOString(),
      workspacePath: ws,
      recordedBy: "llm_judge",
      summary: {
        totalEntriesAnalyzed: 5,
        totalToolCalls: 2,
        userSteeringCount: 0,
        instructionComplianceQuestionCount: 1,
        hasInstructionComplianceQuestion: true,
        inefficiencyEventCount: 0,
        inefficiencyScoreAdded: 0,
        subagentRevisionCount: 0,
        networkRetriesIgnored: 0,
      },
      steeringEvents: [
        {
          entryIndex: 1,
          eventType: "instruction_compliance_question",
          userMessageQuote: "Why did you ignore the rule in AGENTS.md?",
          precedingAssistantActionSummary: "rm -rf data",
        },
      ],
      inefficiencyEvents: [],
      subagentEvents: [],
    });

    const hooks = new Map();
    const mockPi = {
      registerCommand() {},
      on(ev, handler) {
        hooks.set(ev, handler);
      },
    };
    registerHarness2Extension(mockPi);

    // Scenario 1: User starts session and selects "Not now (snooze for 1 session)"
    let selectPromptText = "";
    const ctxSnooze = {
      cwd: ws,
      sessionId: "sess-new-1",
      ui: {
        notify() {},
        async select(prompt, options) {
          selectPromptText = prompt;
          return "2. Not now (snooze for 1 session)";
        },
        async confirm() {
          return true;
        },
      },
    };

    const sessionStartHook = hooks.get("session_start");
    assert.ok(sessionStartHook);

    await sessionStartHook({}, ctxSnooze);
    assert.ok(selectPromptText.includes("Harness² detected recurring workspace friction"));
    const snoozedState = loadWorkspaceState(ws);
    assert.equal(snoozedState.snoozeUntilSessionCount, 1);

    // Scenario 2: User starts session and selects "1. Review improvement proposal now"
    // Reset snooze count for test
    snoozedState.snoozeUntilSessionCount = 0;
    saveWorkspaceState(ws, snoozedState);

    let proposalReviewed = false;
    const ctxReview = {
      cwd: ws,
      sessionId: "sess-new-2",
      ui: {
        notify() {},
        async select(prompt, options) {
          if (prompt.includes("Review improvement proposal now")) {
            return "1. Review improvement proposal now";
          }
          if (prompt.includes("Choose an action")) {
            proposalReviewed = true;
            return MENU_OPTION_DISMISS;
          }
          return undefined;
        },
        async confirm() {
          return true;
        },
      },
    };

    await sessionStartHook({}, ctxReview);
    assert.equal(proposalReviewed, true);
  });

  it("UT-NORM-03: loadRecentTaskRecords scopes to current cycle when sinceTimestamp / lastProposalAppliedAt is set", () => {
    const ws = makeTempDir("ws-cycle-boundary");

    // Old cycle: record created at 10:00
    saveTaskRecord(ws, {
      recordId: "rec-old-1",
      sessionId: "sess-old-1",
      timestamp: "2026-10-29T10:00:00.000Z",
      workspacePath: ws,
      recordedBy: "llm_judge",
      summary: {
        totalEntriesAnalyzed: 5,
        totalToolCalls: 2,
        userSteeringCount: 1,
        instructionComplianceQuestionCount: 0,
        hasInstructionComplianceQuestion: false,
        inefficiencyEventCount: 0,
        inefficiencyScoreAdded: 0,
        subagentRevisionCount: 0,
        networkRetriesIgnored: 0,
      },
      steeringEvents: [
        {
          entryIndex: 1,
          eventType: "corrective_steer",
          userMessageQuote: "Old issue that was already solved",
          precedingAssistantActionSummary: "action",
        },
      ],
      inefficiencyEvents: [],
      subagentEvents: [],
    });

    // Proposal was applied at 10:10
    const proposalAppliedAt = "2026-10-29T10:10:00.000Z";

    // New cycle: record created at 10:20
    saveTaskRecord(ws, {
      recordId: "rec-new-1",
      sessionId: "sess-new-1",
      timestamp: "2026-10-29T10:20:00.000Z",
      workspacePath: ws,
      recordedBy: "llm_judge",
      summary: {
        totalEntriesAnalyzed: 5,
        totalToolCalls: 2,
        userSteeringCount: 0,
        instructionComplianceQuestionCount: 1,
        hasInstructionComplianceQuestion: true,
        inefficiencyEventCount: 0,
        inefficiencyScoreAdded: 0,
        subagentRevisionCount: 0,
        networkRetriesIgnored: 0,
      },
      steeringEvents: [
        {
          entryIndex: 1,
          eventType: "instruction_compliance_question",
          userMessageQuote: "Brand new issue in new cycle",
          precedingAssistantActionSummary: "action",
        },
      ],
      inefficiencyEvents: [],
      subagentEvents: [],
    });

    // Without cycle boundary: returns both
    const allRecords = loadRecentTaskRecords(ws, 10);
    assert.equal(allRecords.length, 2);

    // With cycle boundary: only returns new cycle records after 10:10
    const currentCycleRecords = loadRecentTaskRecords(ws, 10, proposalAppliedAt);
    assert.equal(currentCycleRecords.length, 1);
    assert.equal(currentCycleRecords[0].recordId, "rec-new-1");
    assert.equal(
      currentCycleRecords[0].steeringEvents[0].userMessageQuote,
      "Brand new issue in new cycle"
    );
  });
});
