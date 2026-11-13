import type { ServerEvent } from '@caxri/protocol';

/**
 * Runtime events another subscriber owns, so the Workbench store has nothing to update for them. Listing them keeps
 * `subscribeWorkbenchEvents`' `assertNever` exhaustive: a new event must be handled there or named here.
 *
 * - `agent.permissionAutoAllowChanged` (issue caxri#1295) goes to `subscribeRuntimeQueryInvalidation` in
 *   `queries/invalidation.ts`, which refreshes the Session row menu's `session.permissionAutoAllowStatus` read.
 * - `agent.recapChanged` goes to `subscribeRuntimeQueryInvalidation`, which refreshes the Activity excerpts of the
 *   Session whose Chat got a new away recap.
 * - `terminal.sessionSignalsChanged` goes to `subscribeRuntimeQueryInvalidation`, which writes the snapshot into the
 *   `terminal.sessionSignals` read behind the sidebar's heat and Keychain markers.
 * - `session.airplaneModeChanged` goes to `subscribeRuntimeQueryInvalidation`, which writes the state into the
 *   `session.airplaneModeStatus` read behind the Airplane Mode dialog.
 * - `gitReview.changed` (issue caxri#1294) likewise refreshes `gitReview.list` and `gitReview.pending`.
 * - `agentChat.patch` and `agentChat.taskPatch` update cached snapshots through `subscribeAgentChatPatches`.
 * - `botInbox.changed` goes to `subscribeRuntimeQueryInvalidation`, which refreshes the `bot.inbox.list` read behind the
 *   status bar's "Needs you" chip; the Caxri Bot window re-reads its own Inbox in `useCaxriBot`.
 * - `caxriBot.inboxRequested` and `caxriBot.commandPaletteRequested` are sent only to Caxri Bot window, whose
 *   `useCaxriBot` opens its Inbox or its Command Palette.
 * - `subscribeUnsavedEditorRequests` answers `editor.unsavedRequest`, and `subscribeExternalDocumentSync` handles
 *   `externalDocument.changed`.
 * - `sshHost.preferencesChanged` goes to `subscribeHostPreferences` in `host-preferences.ts`.
 * - `sshHost.environmentsChanged` and `environment.connectionReused` go to `subscribeEnvironment` in
 *   `stores/environment.ts`, and `subscribeWorkbenchEnvironments` re-reads the Workbench from its store. An SSH Host's
 *   own `environment.changed` is superseded by that list.
 * - `files.watchLimitAlert` goes to `subscribeFileWatchLimitAlerts` in `features/ssh-host/file-watch-limit-alert.ts`.
 * - `claudeWindow.changed` goes to `subscribeRuntimeQueryInvalidation`, which refreshes the Claude 5-hour windows card's
 *   `claudeWindow.status` read.
 * - `agentSecrets.changed` goes to `subscribeRuntimeQueryInvalidation`, which refreshes the Settings secret list and the
 *   secret request cards.
 * - `benchmark.changed` goes to `useBenchmarkEvents` in `features/benchmark/benchmark-queries.ts`, which refreshes the
 *   Benchmark tab's run list and the changed run.
 * - `agent.delegation.progress` goes to `subscribeRuntimeQueryInvalidation`, which writes the step hint into the cached
 *   Delegated Sessions feed (issue #3572); the rest of the feed refreshes on the `state.changed` push of the delegated
 *   Session (`queries/invalidation-delegation-feed.ts`).
 * - `agent.delegation.questionChanged` carries ids only. `subscribeRuntimeQueryInvalidation` refreshes the Delegated
 *   Sessions feed and the changed task's `agent.delegation.questionDetail` read on it
 *   (`queries/invalidation-delegation-feed.ts`).
 * - `agent.delegation.approval` carries ids and a closed state only. `subscribeRuntimeQueryInvalidation` refreshes the
 *   Delegated Sessions feed and task-state reads on it (`queries/invalidation-delegation-feed.ts`).
 * - `desktop.shareReceived` goes to `subscribeShareRequests` in `features/share/share-request-store.ts`, which opens the
 *   Send to Session picker.
 */
const WORKBENCH_IGNORED_EVENTS = [
    'agent.delegation.approval',
    'agent.delegation.progress',
    'agent.delegation.questionChanged',
    'agent.dispatch.changed',
    'agent.message.held',
    'agent.message.receipt',
    'agent.messaging.changed',
    'agent.permissionAutoAllowChanged',
    'agent.recapChanged',
    'session.airplaneModeChanged',
    'terminal.sessionSignalsChanged',
    'agentChat.patch',
    'agentChat.taskPatch',
    'caxriBot.commandPaletteRequested',
    'caxriBot.inboxRequested',
    'agentHooks.changed',
    'agentSecrets.changed',
    'agentTranscript.changed',
    'benchmark.changed',
    'claudeWindow.changed',
    'botInbox.changed',
    'desktop.shareReceived',
    'editor.unsavedRequest',
    'environment.changed',
    'environment.connectionReused',
    'sshHost.environmentsChanged',
    'sshHost.preferencesChanged',
    'externalDocument.changed',
    'files.changed',
    'files.operationChanged',
    'files.watchLimitAlert',
    'git.changed',
    'gitReview.changed',
    'projectStatus.changed',
    'sessionPullRequests.changed',
    'terminal.exit',
    'terminal.output',
    'terminal.sizeOwnership',
    'updates.state',
    'viewContainers.catalogChanged',
    'viewContainers.treeChanged',
    'viewContainers.viewChanged',
] as const satisfies ReadonlyArray<ServerEvent['event']>;

type WorkbenchIgnoredEvent = Extract<
    ServerEvent,
    { event: (typeof WORKBENCH_IGNORED_EVENTS)[number] }
>;

const ignored = new Set<ServerEvent['event']>(WORKBENCH_IGNORED_EVENTS);

export function isWorkbenchIgnoredEvent(event: ServerEvent): event is WorkbenchIgnoredEvent {
    return ignored.has(event.event);
}
