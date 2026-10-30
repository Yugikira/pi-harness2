import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BackupManifest,
  HarnessProposal,
  WorkspaceHarnessState,
} from "./types.js";
import {
  getHarness2Dir,
  loadWorkspaceState,
  resetStateCounters,
  saveWorkspaceState,
} from "./triggers.js";

export class UnauthorizedTargetPathError extends Error {
  constructor(targetPath: string) {
    super(
      `Unauthorized harness target path "${targetPath}". Only AGENTS.md, .pi/**, and .agents/skills/** inside the workspace may be modified.`
    );
    this.name = "UnauthorizedTargetPathError";
  }
}

const ALLOWED_PATH_PATTERNS: RegExp[] = [
  /^AGENTS\.md$/i,
  /^AGENTS\.override\.md$/i,
  /^\.pi\/APPEND_SYSTEM\.md$/i,
  /^\.pi\/SYSTEM\.md$/i,
  /^\.pi\/skills\/[A-Za-z0-9_./-]+$/,
  /^\.agents\/skills\/[A-Za-z0-9_./-]+$/,
  /^\.pi\/agents\/[A-Za-z0-9_.-]+\.md$/,
  /^\.pi\/extensions\/[A-Za-z0-9_.-]+\.ts$/,
  /^\.pi\/harness2\/[A-Za-z0-9_./-]+$/,
];

/**
 * Validates that `targetPath` stays strictly inside `workspaceDir` and matches
 * allowed local harness configuration locations.
 */
export function validateTargetPath(workspaceDir: string, targetPath: string): string {
  const normalizedRel = targetPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    normalizedRel.includes("..") ||
    path.isAbsolute(targetPath) ||
    /^[A-Za-z]:/.test(targetPath)
  ) {
    throw new UnauthorizedTargetPathError(targetPath);
  }

  const isAllowed = ALLOWED_PATH_PATTERNS.some((re) => re.test(normalizedRel));
  if (!isAllowed) {
    throw new UnauthorizedTargetPathError(targetPath);
  }

  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolvedTarget = path.resolve(workspaceDir, normalizedRel);
  if (!resolvedTarget.startsWith(resolvedWorkspace + path.sep) && resolvedTarget !== resolvedWorkspace) {
    throw new UnauthorizedTargetPathError(targetPath);
  }

  return normalizedRel;
}

export function getBackupsDir(workspaceDir: string): string {
  return path.join(getHarness2Dir(workspaceDir), "backups");
}

export function getExperienceFilePath(workspaceDir: string): string {
  return path.join(getHarness2Dir(workspaceDir), "EXPERIENCE.md");
}

/**
 * Atomically backs up affected files, writes all `proposal.fileOperations`,
 * appends the lesson to `.pi/harness2/EXPERIENCE.md`, and resets workspace counters.
 */
export function applyHarnessProposal(
  workspaceDir: string,
  proposal: HarnessProposal
): { backupDir: string; manifest: BackupManifest } {
  // 1. Validate all paths upfront before touching the filesystem
  const validatedOps = proposal.fileOperations.map((op) => ({
    ...op,
    normalizedPath: validateTargetPath(workspaceDir, op.targetPath),
  }));

  const state = loadWorkspaceState(workspaceDir);
  const safeTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupId = `${safeTimestamp}_${proposal.proposalId}`;
  const backupDir = path.join(getBackupsDir(workspaceDir), backupId);
  const backupFilesDir = path.join(backupDir, "files");
  fs.mkdirSync(backupFilesDir, { recursive: true });

  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];

  // 2. Snapshot existing files before modifying
  for (const op of validatedOps) {
    const absPath = path.join(workspaceDir, op.normalizedPath);
    if (fs.existsSync(absPath)) {
      updatedFiles.push(op.normalizedPath);
      const backupCopyPath = path.join(backupFilesDir, op.normalizedPath);
      fs.mkdirSync(path.dirname(backupCopyPath), { recursive: true });
      fs.copyFileSync(absPath, backupCopyPath);
    } else {
      createdFiles.push(op.normalizedPath);
    }
  }

  // Also back up EXPERIENCE.md if it exists
  const expPath = getExperienceFilePath(workspaceDir);
  const expRelPath = ".pi/harness2/EXPERIENCE.md";
  if (fs.existsSync(expPath)) {
    updatedFiles.push(expRelPath);
    const backupExpPath = path.join(backupFilesDir, expRelPath);
    fs.mkdirSync(path.dirname(backupExpPath), { recursive: true });
    fs.copyFileSync(expPath, backupExpPath);
  } else {
    createdFiles.push(expRelPath);
  }

  const manifest: BackupManifest = {
    backupId,
    proposalId: proposal.proposalId,
    createdAt: new Date().toISOString(),
    reverted: false,
    createdFiles,
    updatedFiles,
    previousCounters: JSON.parse(JSON.stringify(state.counters)),
    previousLastProposalAppliedAt: state.lastProposalAppliedAt,
  };

  fs.writeFileSync(
    path.join(backupDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  // 3. Write proposed file operations
  for (const op of validatedOps) {
    const absPath = path.join(workspaceDir, op.normalizedPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, op.fullNewContent, "utf-8");
  }

  // 4. Append lesson to `.pi/harness2/EXPERIENCE.md`
  appendExperienceEntry(workspaceDir, proposal, "APPLIED");

  // 5. Save proposal record and reset state counters
  const proposalsDir = path.join(getHarness2Dir(workspaceDir), "proposals");
  fs.mkdirSync(proposalsDir, { recursive: true });
  fs.writeFileSync(
    path.join(proposalsDir, `${proposal.proposalId}.json`),
    JSON.stringify({ ...proposal, status: "applied", backupId }, null, 2),
    "utf-8"
  );

  resetStateCounters(state);
  saveWorkspaceState(workspaceDir, state);

  return { backupDir, manifest };
}

export function appendExperienceEntry(
  workspaceDir: string,
  proposal: HarnessProposal,
  status: "APPLIED" | "DISMISSED"
): void {
  const expPath = getExperienceFilePath(workspaceDir);
  fs.mkdirSync(path.dirname(expPath), { recursive: true });

  const existing = fs.existsSync(expPath)
    ? fs.readFileSync(expPath, "utf-8")
    : "# Harness² Workspace Experience Library (`EXPERIENCE.md`)\n\n";

  const situation =
    proposal.experienceEntry?.situation ||
    proposal.diagnosisSummary ||
    "Workspace friction threshold met";
  const evidenceQuotes = Array.isArray(proposal.experienceEntry?.evidenceQuotes)
    ? proposal.experienceEntry.evidenceQuotes
    : [];
  const lessonLearned =
    proposal.experienceEntry?.lessonLearned ||
    proposal.diagnosisSummary ||
    "Codified improvements into workspace configuration.";
  const fileOperations = Array.isArray(proposal.fileOperations)
    ? proposal.fileOperations
    : [];

  const entryBlock = [
    `## [${status}] ${proposal.createdAt} (${proposal.proposalId})`,
    `- **Triggers:** ${proposal.triggerReasons.join(", ")}`,
    `- **Situation:** ${situation}`,
    `- **Evidence:**`,
    ...(evidenceQuotes.length > 0
      ? evidenceQuotes.map((q) => `  - ${q}`)
      : ["  - (Extracted from recorded task evidence)"]),
    `- **Lesson Learned:** ${lessonLearned}`,
    `- **Files Targeted:** ${fileOperations.map((f) => `\`${f.targetPath}\``).join(", ")}`,
    "",
  ].join("\n");

  fs.writeFileSync(expPath, `${existing.trimEnd()}\n\n${entryBlock}\n`, "utf-8");
}

/**
 * Reverts the most recent un-reverted backup from `.pi/harness2/backups/` (`/harness2 undo`).
 */
export function undoLatestProposal(workspaceDir: string): {
  reverted: boolean;
  backupId?: string;
  restoredFiles: string[];
  deletedFiles: string[];
} {
  const backupsDir = getBackupsDir(workspaceDir);
  if (!fs.existsSync(backupsDir)) {
    return { reverted: false, restoredFiles: [], deletedFiles: [] };
  }

  const dirs = fs
    .readdirSync(backupsDir)
    .filter((d: string) => fs.statSync(path.join(backupsDir, d)).isDirectory())
    .sort()
    .reverse();

  for (const dirName of dirs) {
    const manifestPath = path.join(backupsDir, dirName, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, "utf-8")
    ) as BackupManifest;
    if (manifest.reverted) continue;

    const backupFilesDir = path.join(backupsDir, dirName, "files");
    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];

    // Restore updated files byte-for-byte
    for (const relPath of manifest.updatedFiles) {
      const srcCopy = path.join(backupFilesDir, relPath);
      const destPath = path.join(workspaceDir, relPath);
      if (fs.existsSync(srcCopy)) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcCopy, destPath);
        restoredFiles.push(relPath);
      }
    }

    // Delete newly created files
    for (const relPath of manifest.createdFiles) {
      const destPath = path.join(workspaceDir, relPath);
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
        deletedFiles.push(relPath);
        // Clean up empty parent skill directory if applicable
        const parentDir = path.dirname(destPath);
        try {
          if (fs.readdirSync(parentDir).length === 0) {
            fs.rmdirSync(parentDir);
          }
        } catch {
          // Ignore non-empty parent dirs
        }
      }
    }

    manifest.reverted = true;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    // Restore previous counters and cycle boundary timestamp
    const state = loadWorkspaceState(workspaceDir);
    state.counters = manifest.previousCounters;
    state.lastProposalAppliedAt = manifest.previousLastProposalAppliedAt;
    saveWorkspaceState(workspaceDir, state);

    return {
      reverted: true,
      backupId: manifest.backupId,
      restoredFiles,
      deletedFiles,
    };
  }

  return { reverted: false, restoredFiles: [], deletedFiles: [] };
}
