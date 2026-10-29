# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  - Updated `loadRecentTaskRecords` to support `sinceTimestamp` filtering and prioritize records with `frictionLevel: "medium" | "high"` over neutral / smooth runs.
  - Unified record loading behavior across auto mode and manual `/harness2` invocations so both inspect up to 10 recent scoped records within the active cycle.

### Tests
- Added unit and integration tests covering proposal schema normalization, evidence quote fallback extraction, startup review / snooze workflows, and cycle boundary filtering.
