import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Harness2Config } from "./types.js";

export const DEFAULT_HARNESS2_CONFIG: Harness2Config = {
  recordMode: "manual",
  model: null,
  thresholds: {
    userSteeringCount: 3,
    instructionViolationQuery: 1,
    inefficiencyScore: 3,
    recurringFingerprintCount: 2,
    subagentRevisions: 2,
  },
  minStepsForInefficientChain: 3,
};

/**
 * Resolves the global Pi agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`).
 */
export function getGlobalAgentDir(overrideAgentDir?: string): string {
  if (overrideAgentDir) {
    return overrideAgentDir;
  }
  if (process.env.PI_CODING_AGENT_DIR) {
    return process.env.PI_CODING_AGENT_DIR;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

function readJsonFileSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function extractHarness2Section(settingsObj: Record<string, unknown> | null): Partial<Harness2Config> {
  if (!settingsObj) {
    return {};
  }
  const section = settingsObj.harness2;
  if (!section || typeof section !== "object") {
    return {};
  }
  return section as Partial<Harness2Config>;
}

/**
 * Loads and merges `harness2` configuration from global `<agent-dir>/settings.json`
 * and project-local `<workspace>/.pi/settings.json`.
 * Project-level settings take strict precedence over global settings.
 */
export function loadHarness2Config(
  workspaceDir: string,
  overrideGlobalAgentDir?: string
): Harness2Config {
  const globalDir = getGlobalAgentDir(overrideGlobalAgentDir);
  const globalSettingsPath = path.join(globalDir, "settings.json");
  const projectSettingsPath = path.join(workspaceDir, ".pi", "settings.json");

  const globalPartial = extractHarness2Section(readJsonFileSafe(globalSettingsPath));
  const projectPartial = extractHarness2Section(readJsonFileSafe(projectSettingsPath));

  const mergedThresholds = {
    ...DEFAULT_HARNESS2_CONFIG.thresholds,
    ...(globalPartial.thresholds ?? {}),
    ...(projectPartial.thresholds ?? {}),
  };

  const rawRecordMode = projectPartial.recordMode ?? globalPartial.recordMode ?? DEFAULT_HARNESS2_CONFIG.recordMode;
  const recordMode: "manual" | "auto" = rawRecordMode === "auto" ? "auto" : "manual";

  const rawModel =
    projectPartial.model !== undefined
      ? projectPartial.model
      : globalPartial.model !== undefined
        ? globalPartial.model
        : DEFAULT_HARNESS2_CONFIG.model;

  const model = typeof rawModel === "string" && rawModel.trim().length > 0 ? rawModel.trim() : null;

  const minSteps =
    typeof projectPartial.minStepsForInefficientChain === "number"
      ? projectPartial.minStepsForInefficientChain
      : typeof globalPartial.minStepsForInefficientChain === "number"
        ? globalPartial.minStepsForInefficientChain
        : DEFAULT_HARNESS2_CONFIG.minStepsForInefficientChain;

  return {
    recordMode,
    model,
    thresholds: {
      userSteeringCount: Math.max(1, Number(mergedThresholds.userSteeringCount) || 3),
      instructionViolationQuery: Math.max(1, Number(mergedThresholds.instructionViolationQuery) || 1),
      inefficiencyScore: Math.max(1, Number(mergedThresholds.inefficiencyScore) || 3),
      recurringFingerprintCount: Math.max(1, Number(mergedThresholds.recurringFingerprintCount) || 2),
      subagentRevisions: Math.max(1, Number(mergedThresholds.subagentRevisions) || 2),
    },
    minStepsForInefficientChain: Math.max(2, minSteps),
  };
}

/**
 * Resolves the model ID to use for reflection and proposal generation.
 * Uses configured `harness2.model` if present; otherwise falls back to active session model.
 */
export function resolveImproverModel(
  config: Harness2Config,
  activeSessionModel?: string
): string {
  if (config.model && config.model.trim().length > 0) {
    return config.model.trim();
  }
  if (activeSessionModel && activeSessionModel.trim().length > 0) {
    return activeSessionModel.trim();
  }
  return "default-session-model";
}
