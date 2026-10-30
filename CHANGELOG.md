# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-10-29

### Fixed
- **Snooze & Compaction Lifecycle Hardening**:
  - Added `snoozedAtInstructionQuestions` watermark to `WorkspaceHarnessState` and `snoozeProposalForOneSession` helper in `src/triggers.ts` so snoozing a proposal triggered by `EXPLICIT_INSTRUCTION_AUDIT` properly suppresses re-prompting for 1 session unless a new instruction compliance question occurs.
  - Updated `session_before_compact` hook in `src/index.ts` to pass `skipReview = true`, preventing background auto-recording during context compaction from blocking on an interactive TUI menu.
- **Strict Cycle Boundary Scoping & Undo Restoration**:
  - Removed the fallback in `loadRecentTaskRecords` (`src/triggers.ts`) that returned old-cycle records when `cycleRecords.length === 0`, ensuring `/harness2 propose` in a fresh cycle records the active session rather than re-proposing already-resolved issues.
  - Added `previousLastProposalAppliedAt` to `BackupManifest` (`src/types.ts`, `src/applier.ts`) so `/harness2 undo` restores the prior cycle boundary timestamp alongside `previousCounters`.
- **Stage 1 Retry Deduplication & Proposal Safety**:
  - Fixed `buildSessionDigest` (`src/analyzer.ts`) to treat empty `stopReason: "aborted"` assistant turns immediately preceding a duplicate user resend as network/stream retries (`networkRetriesIgnored`), restoring 100% pass rate on `IT-REAL-01 & IT-REAL-02` while preserving intentional user repetitions (`UT-DIG-02`).
  - Added `validateTargetPath` filtering inside `normalizeHarnessProposal` (`src/improver.ts`), null-safe field checks in `formatProposalPreview` (`src/ui.ts`), and `try/catch` error handling around `applyHarnessProposal` in `runGuidedProposalReview` (`src/ui.ts`).

## [0.3.1] - 2026-10-29

### Fixed
- **Execution Lifecycle & Non-blocking Shutdown**:
  - Resolved issue where auto-mode proposal review was attempted during `session_shutdown`, causing prompts to be lost when Pi exited.
  - Added `skipReview` flag to `handleRecordAndCheck` during `session_shutdown`, ensuring task records and state counters persist cleanly without blocking shutdown.
  - Deferred pending proposal review to the next `session_start` event, notifying the user with interactive choices ("Review improvement proposal now" or "Snooze for 1 session").
  - Fixed proposal synthesis crash: `undefined is not an object (evaluating 'proposal.experienceEntry.evidenceQuotes.map')` by introducing explicit JSON schema definitions in `buildReflectionPrompt` and adding runtime normalization (`normalizeHarnessProposal`) with defensive fallbacks.
  - Added null-safe property access in `src/ui.ts` (`formatProposalCard`) and `src/applier.ts` (`appendExperienceEntry`) for `evidenceQuotes`, `fileOperations`, and `situation`.

### Added
- **Cycle Boundary Scoping & Prioritization**:
  - Added `lastProposalAppliedAt` timestamp to `WorkspaceHarnessState` to scope task records to the current active improvement cycle, preventing previously resolved friction issues from polluting subsequent proposal generation.
  - Updated `loadRecentTaskRecords` to support `sinceTimestamp` filtering and prioritize records containing friction events (`userSteeringCount > 0`, `inefficiencyScoreAdded > 0`, or `subagentRevisionCount > 0`) over neutral / smooth runs.
  - Unified record loading behavior across auto mode and manual `/harness2` invocations so both inspect up to 10 recent scoped records within the active cycle.

### Tests
- Added unit and integration tests covering proposal schema normalization, evidence quote fallback extraction, startup review / snooze workflows, and cycle boundary filtering.
