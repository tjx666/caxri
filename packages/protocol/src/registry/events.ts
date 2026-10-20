import { z } from 'zod';

import { agentChatPatchSchema } from '../agent/agent-chat-contract.js';
import { agentChatTaskPatchSchema } from '../agent/agent-chat-task-contract.js';
import { agentDispatchReceiptSchema } from '../agent/agent-dispatch-contract.js';
import { agentEndpointSummarySchema } from '../agent/agent-endpoint-contract.js';
import {
    agentHeldMessageSchema,
    agentMessageReceiptSchema,
} from '../agent/agent-inbox-contract.js';
import { agentProviderSchema } from '../agent/agents.js';
import { configurationSourceSchema as configSourceSchema } from '../configuration/configuration-contract.js';
import { environmentStateSchema, sshDestinationSchema } from '../desktop/ssh-host-contract.js';
import { commandIdSchema } from '../domain/commands.js';
import {
    agentHookHealthMapSchema,
    fileChangeSchema,
    permissionAutoAllowStatusSchema,
    runtimeStatusSchema,
} from '../domain/domain.js';
import { editorNavigationTargetSchema } from '../domain/editor.js';
import { fileWatchLimitAlertSchema } from '../domain/file-watch.js';
import { identifierSchema, pathSchema } from '../domain/identifiers.js';
import { lowCostSandboxFailureReasonSchema } from '../domain/low-cost-generation.js';
import { settingsTargetSchema } from '../domain/settings-target.js';
import { terminalResourceAlertSchema } from '../domain/terminal-resources.js';
import { updateStateSchema } from '../domain/update-state.js';
import {
    extensionIdSchema,
    extensionViewChangeSchema,
    extensionViewEventContextSchema,
    extensionViewEventIdSchema,
    viewIdSchema,
} from '../domain/views.js';

const configChangedSchema = z.object({
    source: configSourceSchema,
    error: z.string().optional(),
});

/**
 * One watcher event must stay inside the durable protocol envelope. Producers share this bound so an in-process burst
 * cannot create an event that only fails after it reaches the recovery journal.
 */
export const MAX_FILE_CHANGES_PER_EVENT = 512;

const fullStateChangeReasonSchema = z.enum([
    'project.create',
    'project.delete',
    'project.hide',
    'project.reorder',
    'project.setIcon',
    'project.setChatDefault',
    'session.create',
    'session.select',
    'session.archive',
    'session.reorder',
    'session.reorderPinned',
    'session.setPinned',
    'session.unarchive',
    'session.detach',
    'session.resume',
    'session.delete',
    'session.workbenchRoot',
    'terminal.create',
    'terminal.close',
    'terminal.moveToNewSession',
    'unknown',
]);

/**
 * Why the whole workbench view has to be re-read. Exported because handlers that announce one are spread across several
 * modules, and the Renderer's command convergence matches on the exact string.
 */
export type FullStateChangeReason = z.infer<typeof fullStateChangeReasonSchema>;

const stateChangeRecordIdsSchema = z.array(identifierSchema).max(64).default([]);

const stateChangedShapeSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('full'), reason: fullStateChangeReasonSchema }),
    z.object({
        kind: z.literal('records'),
        sessionIds: stateChangeRecordIdsSchema,
        terminalIds: stateChangeRecordIdsSchema,
    }),
]);

function normalizeStateChangedPayload(value: unknown): unknown {
    if (
        typeof value === 'object' &&
        value !== null &&
        'kind' in value &&
        (value.kind === 'full' || value.kind === 'records')
    ) {
        return value;
    }
    /**
     * Future event scopes must converge safely until this client knows how to patch them.
     */
    return { kind: 'full', reason: 'unknown' };
}

const stateChangedPayloadSchema = z.preprocess(
    normalizeStateChangedPayload,
    stateChangedShapeSchema,
);

/**
 * Every payload the Runtime may push to Main and the Renderer, keyed by its wire event name.
 */
export const serverEventPayloads = {
    'viewContainers.catalogChanged': z.object({
        revision: z.number().int().nonnegative(),
        extensionId: extensionIdSchema.optional(),
    }),
    'viewContainers.treeChanged': z.object({
        viewId: viewIdSchema,
        eventId: extensionViewEventIdSchema,
        extensionGeneration: z.number().int().nonnegative(),
        context: extensionViewEventContextSchema,
        handles: z.array(z.string().min(1).max(512)).max(1_000).optional(),
    }),
    'viewContainers.viewChanged': z.object({
        viewId: viewIdSchema,
        eventId: extensionViewEventIdSchema,
        extensionGeneration: z.number().int().nonnegative(),
        context: extensionViewEventContextSchema,
        change: extensionViewChangeSchema,
    }),
    'runtime.status': z.object({
        status: runtimeStatusSchema.exclude(['starting']),
        restartCount: z.number(),
    }),
    'state.changed': stateChangedPayloadSchema,
    'agentTranscript.changed': z.object({ terminalId: identifierSchema }),
    /**
     * Incremental Agent Chat projection change. Content-bearing and boot-scoped, so it is transient like Terminal
     * output.
     */
    'agentChat.patch': agentChatPatchSchema,
    /**
     * Incremental change to one task's projection (a subagent's conversation or a background shell's output), transient
     * for the same reason.
     */
    'agentChat.taskPatch': agentChatTaskPatchSchema,
    'terminal.output': z.object({
        terminalId: identifierSchema,
        data: z.string(),
        droppedBytes: z.number().optional(),
    }),
    'terminal.sizeOwnership': z.object({
        terminalId: identifierSchema,
        owner: z.enum(['desktop', 'mobile']),
        cols: z.number().int().positive().max(10_000),
        rows: z.number().int().positive().max(10_000),
    }),
    /**
     * One-shot, content-free feedback for a provider output recovery attempt.
     */
    'terminal.outputRecovery': z.object({
        terminalId: identifierSchema,
        provider: agentProviderSchema,
        status: z.enum(['recovered', 'rate-limited']),
    }),
    /**
     * A running Terminal's process tree crossed, or fell back below, the shared resource alert thresholds.
     */
    'terminal.resourceAlert': terminalResourceAlertSchema,
    'terminal.exit': z.object({
        terminalId: identifierSchema,
        exitCode: z.number(),
        signal: z.number().optional(),
    }),
    /**
     * A native file watch on the Server's machine fell back to polling because of a kernel limit, or no longer does.
     */
    'files.watchLimitAlert': fileWatchLimitAlertSchema,
    'files.changed': z.object({
        sessionId: identifierSchema,
        /**
         * Stable Project scope lets inactive Sessions sharing this root converge their caches.
         */
        workbenchProjectId: identifierSchema,
        changes: z.array(fileChangeSchema).max(MAX_FILE_CHANGES_PER_EVENT),
        overflow: z.boolean(),
        gitIgnoreRulesChanged: z.literal(true).optional(),
    }),
    /**
     * Mutation invalidation deliberately omits paths and mutation input. A Renderer resolves the opaque id through the
     * Session-scoped operation API, so another selected Project never receives a foreign journal record.
     */
    'files.operationChanged': z.object({
        operationId: identifierSchema,
        sessionId: identifierSchema,
        workbenchProjectId: identifierSchema.optional(),
    }),
    /**
     * Repository-identity invalidation signal: every Session whose Git projection includes one of the listed
     * repositories must refetch. Payload carries opaque repository ids only, never a `.git` path or repository
     * content.
     */
    'git.changed': z.object({
        sessionIds: z.array(identifierSchema).max(1_024),
        repositoryIds: z.array(identifierSchema).max(256),
        scope: z.enum(['status', 'topology']),
    }),
    /**
     * One-shot invalidation after a background Project Status refresh replaces its Runtime cache. The Renderer
     * invalidates both `projectStatus.summary` (the Status panel) and `projectStatus.overview` (the status bar) for
     * this Session, so the two converge in the same Server refresh instead of the status bar waiting out its own poll
     * (issue caxri#1310).
     */
    'projectStatus.changed': z.object({ sessionId: identifierSchema }),
    /**
     * One-shot delivery-failure alert: a CI check or a Vercel deployment just transitioned into failure. The payload is
     * deliberately identity-only (repository, branch, the failing item's name, and its public provider URL) so a system
     * notification can be composed without any build log, diff, or credential crossing the process boundary. Emitted
     * once per transition; the Runtime owns deduplication, not the notification layer.
     */
    'projectStatus.alert': z.object({
        sessionId: identifierSchema,
        kind: z.enum(['check', 'deployment']),
        repository: z.string().min(1).max(256),
        branch: z.string().min(1).max(512),
        /**
         * Failing check name (already `workflow / job` where GitHub reports both), or the deployment environment.
         */
        name: z.string().min(1).max(512),
        url: z.url().optional(),
    }),
    /**
     * One-shot invalidation after a background sweep changed the discovered pull request of at least one Session. The
     * Renderer also invalidates `projectStatus.overview` for every listed Session: `SessionPullRequestService` and
     * `ProjectStatusService` share one `GitHubPullRequestStore`, so the overview's pull-request field normally answers
     * from the record this sweep just wrote (issue caxri#1310).
     */
    'sessionPullRequests.changed': z.object({ sessionIds: z.array(identifierSchema).max(1_024) }),
    /**
     * Content-free: the Commander Inbox items that were added, updated, replied to, or closed. Readers re-read
     * `commander.inbox.list`.
     */
    'commanderInbox.changed': z.object({ itemIds: z.array(identifierSchema).max(64) }),
    /**
     * A Benchmark run changed; Clients re-read it. `kind` is `progress` for live step counts, which change nothing the
     * history list shows, and `transition` for a status change, a new or removed run; only a transition needs the list
     * re-read. An absent `kind` means `transition`.
     */
    'benchmark.changed': z.object({
        runId: identifierSchema,
        kind: z.enum(['progress', 'transition']).optional(),
    }),
    /**
     * One-shot invalidation after the Server-owned review comment store changed for one Session + repository. The
     * payload is deliberately identity-only, never comment text: see the diagnostics privacy rule in `AGENTS.md`.
     */
    'gitReview.changed': z.object({
        sessionId: identifierSchema,
        repositoryId: identifierSchema,
    }),
    /**
     * One-shot prompt with a display-only path; authorization still accepts only the opaque candidate ID.
     */
    'workbench.candidate': z.object({
        candidateId: identifierSchema,
        sessionId: identifierSchema,
        rootPath: pathSchema,
    }),
    /**
     * One-shot UI coordination layered over the durable `state.changed` convergence event.
     *
     * `reason` carries who caused the switch, not only which authorization step ran, because re-rooting a Session
     * re-roots the Files tree, Source Control, Project Status and the Editor at once:
     *
     * - `selected` / `authorized`: the user switched roots through the picker, the candidate prompt, or Main's
     *   confirmation. Nothing needs to be announced; they already know.
     * - `followed`, an Agent entered a proven linked worktree and `workbench.newWorktreeBehavior` allowed Caxri to move
     *   the Session with it. The user did not ask for this, and the only other cue is the folder name in the status
     *   bar, so the Renderer owes them a notice with an undo. Keeping this distinct from `selected` / `authorized` is
     *   the entire reason the Renderer can tell "you did this" from "an Agent did this": collapsing these values back
     *   into one silently restores that gap.
     * - `fallback`: Caxri returned the Session to its own Project after the active worktree became unusable.
     *
     * `followed` is deliberately not a fourth spelling of the authorization step. Both steps (selecting an already
     * authorized Project, or registering one first) happen on the user's path _and_ on the Agent's, so the step alone
     * can never identify the origin. Server keeps the two apart internally (`commitSelection` takes an explicit
     * `origin` and logs both), and only collapses them here, where the Renderer needs one decision.
     *
     * Both non-user reasons carry their destination title because the Renderer cannot resolve it yet: the destination
     * Project may have been registered by this very change, and the snapshot refresh has not landed when this event
     * arrives.
     */
    'workbench.changed': z.object({
        sessionId: identifierSchema,
        workbenchProjectId: identifierSchema,
        reason: z.enum(['selected', 'authorized', 'followed', 'fallback']),
        followedProjectTitle: z.string().min(1).max(1_024).optional(),
        returnedProjectTitle: z.string().min(1).max(1_024).optional(),
    }),
    'settings.changed': configChangedSchema,
    'agentHooks.changed': agentHookHealthMapSchema,
    /**
     * Sender-only status metadata. The message body is deliberately not representable here.
     */
    'agent.message.receipt': agentMessageReceiptSchema,
    /**
     * Desktop-only approval projection with a bounded, inert plain-text preview.
     */
    'agent.message.held': agentHeldMessageSchema,
    /**
     * Volatile generation health; clients refresh `agent.list` for the current peer set.
     */
    'agent.messaging.changed': agentEndpointSummarySchema,
    /**
     * Durable, body-free lifecycle evidence for an explicit Agent dispatch.
     */
    'agent.dispatch.changed': agentDispatchReceiptSchema,
    'keybindings.changed': configChangedSchema,
    'theme.changed': configChangedSchema,
    'updates.state': updateStateSchema,
    /**
     * Main-originated connection state of the receiving window's environment, including a pending OpenSSH prompt;
     * `environment.get` reads the same value.
     */
    'environment.changed': environmentStateSchema,
    /**
     * Main focused this SSH Host window for a connect to `destination`, another spelling or `~/.ssh/config` alias that
     * resolves to the same account, instead of opening a second window.
     */
    'environment.connectionReused': z.object({ destination: sshDestinationSchema }),
    /**
     * Main-originated resync signal after the Desktop↔Host connection dropped and re-attached (observed in production
     * on macOS sleep/wake). Transient events sent during the outage, PTY output above all, were never delivered and are
     * not replayable, so the Renderer must re-attach mounted Terminal panes to Runtime's authoritative screen snapshot
     * and refresh converged state. The fields mirror the `server_connection.reconnected` structured log line so a stuck
     * report can be correlated across the Renderer and Main.
     */
    'host.connectionChanged': z.discriminatedUnion('status', [
        z.object({
            status: z.literal('reconnected'),
            downtimeMs: z.number().nonnegative(),
            attempt: z.number().int().positive(),
            isHostReplaced: z.boolean(),
        }),
        z.object({ status: z.literal('replaced') }),
    ]),
    /**
     * One native window entered or left macOS fullscreen. Durable delivery reaches every Renderer, so `window` names
     * the window whose state this is: each Renderer applies only its own, since the Workbench, the Agent Commander
     * window, and the Benchmark window go fullscreen independently.
     */
    'window.fullScreen': z.object({
        window: z.enum(['workbench', 'agentCommander', 'benchmark']),
        isFullScreen: z.boolean(),
    }),
    /**
     * Main saw another app change an external document the Workbench has open (see `externalDocument.watch`). The
     * Renderer reads it again through `externalDocument.read` and applies the same disk-wins rule as a Project file.
     */
    'externalDocument.changed': z.object({ documentId: identifierSchema }),
    /**
     * Main-originated, one-shot question about the Workbench's unsaved Editor buffers before quitting or closing the
     * window (issue caxri#1631). Dirty buffers live only in the Renderer's document cache, so Main asks for a
     * content-free summary (`inspect`), asks the Renderer to write them through the Editor's own save path (`saveAll`),
     * or to reveal the first one after the user cancels (`reveal`). The Renderer answers `inspect` and `saveAll`
     * through `editor.unsavedReply` with the same `requestId`.
     */
    'editor.unsavedRequest': z.object({
        requestId: z.string().min(1).max(64),
        action: z.enum(['inspect', 'saveAll', 'reveal']),
    }),
    /**
     * Main's accepted native notification decision, without Agent transcript or notification body.
     */
    'agent.notification': z.object({
        sessionId: identifierSchema,
        attentionKind: z.enum(['waiting', 'completed']),
    }),
    /**
     * One content-free notice per blocked automatic-naming launch; the Server owns deduplication.
     */
    'agent.automaticNamingUnavailable': z.object({
        sessionId: identifierSchema,
        /**
         * The launch the notice belongs to. It is the same key `BootstrapState.automaticNamingUnavailable` replays
         * under, so a client that already showed this notice live can recognize the replayed copy.
         */
        launchId: identifierSchema,
        reason: lowCostSandboxFailureReasonSchema,
    }),
    /**
     * Fires whenever the Session-scoped "Always allow in this Session" grant (issue caxri#1295) is enabled or revoked,
     * so Desktop and every paired mobile device update their indicator live without polling. Content-free: no tool
     * name, request content, or reason beyond the boolean state and grant timestamp. Transient, a client that
     * reconnects gets the current state from `session.permissionAutoAllowStatus` / `mobile.attention.list`'s
     * `autoAllow` field instead of a replayed event.
     */
    'agent.permissionAutoAllowChanged': permissionAutoAllowStatusSchema.extend({
        sessionId: identifierSchema,
    }),
    /**
     * Main-originated, content-free request after Chromium restarts the GPU process. Every mounted Terminal handles
     * this independently so background panes discard invalid WebGL contexts without touching their PTY lifecycle.
     */
    'gpu.recoveryRequested': z.object({ correlationId: z.uuid() }),
    /**
     * `focusEditor` is the opening caller's intent, forwarded unchanged from `desktop.openFile`; see that method for
     * why the same event can legitimately want the keyboard in the editor or want it left alone.
     */
    'desktop.openRequested': z.object({
        sessionId: identifierSchema,
        kind: z.enum(['file', 'directory']),
        path: pathSchema.optional(),
        location: editorNavigationTargetSchema.optional(),
        focusEditor: z.boolean().optional(),
    }),
    /**
     * `viaAccelerator` distinguishes a native menu item fired by its keyboard accelerator from one fired by an actual
     * mouse/touch click, so the Renderer can apply the editable-focus shortcut policy only to the accelerator path (see
     * `commands/execute.ts#runCommand`).
     */
    'command.execute': z.object({
        command: commandIdSchema,
        viaAccelerator: z.boolean().optional(),
    }),
    /**
     * Main-originated request to open Settings scrolled to one specific row. `command.execute` cannot carry this: its
     * `CommandId` bus is zero-argument by design (menu items and keyboard shortcuts), so a companion window's targeted
     * Settings hand-off (see `agentCommander.openSettings`) gets its own event instead of growing a payload onto every
     * command.
     */
    'settings.openRequested': z.object({ target: settingsTargetSchema }),
    /**
     * Main-originated, Commander-window-only request to open its Inbox and focus the first open item, sent after
     * `agentCommander.open` with `target: 'inbox'` raised the window. Main holds it until a newly opened window's
     * Renderer subscribes to events, so a window the request itself opened still receives it.
     */
    'agentCommander.inboxRequested': z.object({}),
    /**
     * Main-originated, Commander-window-only request to open the window's own Command Palette. The native menu owns the
     * `commandPalette.open` accelerator, so the chord never reaches the focused Commander Renderer as a keydown; Main
     * sends this to that window instead of dropping the shortcut or raising the Workbench.
     */
    'agentCommander.commandPaletteRequested': z.object({}),
} as const;

type ServerEventName = keyof typeof serverEventPayloads;

type ServerEventPayload<E extends ServerEventName> = z.infer<(typeof serverEventPayloads)[E]>;

/**
 * Discriminated union so `onEvent` listeners narrow `payload` from `event` alone.
 */
export type ServerEvent = {
    [E in ServerEventName]: { event: E; payload: ServerEventPayload<E> };
}[ServerEventName];

/**
 * Per-event `{ event, payload }` schema, keyed the same way as `serverEventPayloads`.
 */
type ServerEventSchemaMap = {
    [E in ServerEventName]: z.ZodObject<{
        event: z.ZodLiteral<E>;
        payload: (typeof serverEventPayloads)[E];
    }>;
};

/**
 * `serverEventSchema` is derived from `serverEventPayloads` instead of listing the event names a second time, so a new
 * entry only needs to be added once (to `serverEventPayloads`) to be both a valid payload and a validated member of the
 * discriminated union. `Object.keys`/`.map` can't distribute a generic per array element, so the per-event schema map
 * is built once and cast to `ServerEventSchemaMap` (itself derived from `ServerEventName`, not a hand-listed union) to
 * restore the precise per-event literal types that `z.discriminatedUnion` needs for narrowing.
 */
const serverEventSchemas = Object.fromEntries(
    (Object.keys(serverEventPayloads) as ServerEventName[]).map((event) => [
        event,
        z.object({ event: z.literal(event), payload: serverEventPayloads[event] }),
    ]),
) as ServerEventSchemaMap;

const serverEventSchemaList = Object.values(serverEventSchemas) as [
    ServerEventSchemaMap[ServerEventName],
    ...Array<ServerEventSchemaMap[ServerEventName]>,
];

export const serverEventSchema = z.discriminatedUnion('event', serverEventSchemaList);
