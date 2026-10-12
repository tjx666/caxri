import type { ServerEvent } from '@caxri/protocol';

/**
 * Runtime events another subscriber owns, so the Workbench store has nothing to update for them. Listing them keeps
 * `subscribeWorkbenchEvents`' `assertNever` exhaustive: a new event must be handled there or named here.
 *
 * - `agent.permissionAutoAllowChanged` (issue caxri#1295) goes to `subscribeRuntimeQueryInvalidation` in
 *   `queries/invalidation.ts`, which refreshes the Session row menu's `session.permissionAutoAllowStatus` read.
 * - `gitReview.changed` (issue caxri#1294) likewise refreshes `gitReview.list` and `gitReview.pending`.
 * - `agentChat.patch` and `agentChat.taskPatch` update cached snapshots through `subscribeAgentChatPatches`.
 * - `commanderInbox.changed` goes to `subscribeRuntimeQueryInvalidation`, which refreshes the `commander.inbox.list` read
 *   behind the status bar's "Needs you" chip; the Agent Commander window re-reads its own Inbox in
 *   `useAgentCommander`.
 * - `agentCommander.inboxRequested` is sent only to the Agent Commander window, whose `useAgentCommander` opens its
 *   Inbox.
 * - `subscribeUnsavedEditorRequests` answers `editor.unsavedRequest`, and `subscribeExternalDocumentSync` handles
 *   `externalDocument.changed`.
 * - `environment.changed` and `environment.connectionReused` go to `subscribeEnvironment` in `stores/environment.ts`.
 */
const WORKBENCH_IGNORED_EVENTS = [
    'agent.dispatch.changed',
    'agent.message.held',
    'agent.message.receipt',
    'agent.messaging.changed',
    'agent.permissionAutoAllowChanged',
    'agentChat.patch',
    'agentChat.taskPatch',
    'agentCommander.inboxRequested',
    'agentHooks.changed',
    'agentTranscript.changed',
    'commanderInbox.changed',
    'editor.unsavedRequest',
    'environment.changed',
    'environment.connectionReused',
    'externalDocument.changed',
    'files.changed',
    'files.operationChanged',
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
