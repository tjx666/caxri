import type {
    BootstrapState,
    ServerEvent,
    SessionRecord,
    SessionState,
    TerminalRecord,
} from '@caxri/protocol';
import { assertNever } from '@caxri/protocol';
import { isEqual } from 'es-toolkit';

import {
    mergeExternalEditorTabs,
    recordExternalEditorState,
    stripExternalEditorTabs,
} from '../features/editor/external-editor-state';
import { gpuIncidentBudget } from '../features/gpu/gpu-incident-budget';
import { gpuRecoveryNotificationCoordinator } from '../features/gpu/gpu-recovery-notifications';
import { beginRendererPerformanceRequest } from '../features/renderer-performance/controller';
import { reportTerminalOutputRecovery } from '../features/terminal/terminal-output-recovery-notice';
import { reportTerminalResourceAlert } from '../features/terminal/terminal-resource-alerts';
import {
    dismissWorkbenchRootCandidate,
    showWorkbenchRootCandidate,
} from '../features/workbench/workbench-root-prompt-store';
import { caxri } from '../lib/caxri';
import { createStore } from '../lib/store';
import { reportAutomaticNamingNotices } from './automatic-naming-notice';
import { recordNotification, syncNotificationSettings } from './notifications';
import { mergeStructurally } from './structural-sharing';
import { describeFailure, isCancelledRequest, pushToast } from './toasts';
import type { WorkbenchEventHandlers } from './workbench-event-handlers';
import { reportWorkbenchRootChange } from './workbench-root-notice';
import {
    applyPendingSessionPatches,
    isStaleSessionStateWrite,
    pendingSessionPatches,
    persistedSessionPatches,
    rebasedSessionState,
    sessionPatchAttempt,
    sessionPatchKey,
    sessionStateWriteChains,
    sessionStateWrites,
    settledSessionState,
} from './workbench-session-patches';
import { withPendingSessionTitles } from './workbench-session-titles';
import {
    acceptTerminalReads,
    applyFullTerminalSnapshot,
    beginTerminalRead,
    finishTerminalRead,
    replaceRequestedRecords,
} from './workbench-terminal-reads';

interface WorkbenchState {
    /**
     * The last Server snapshot, or `undefined` until the first `app.bootstrap` resolves.
     */
    bootstrap?: BootstrapState;
    /**
     * Bumped every time Server Core reports ready again and after a Desktop↔Server reconnect. Mounted Terminal panes
     * watch this to re-issue `terminal.attach`, because a Server restart drops attachment state — and a Server
     * connection outage drops live `terminal.output` bytes — that the pane cannot observe on its own.
     */
    attachEpoch: number;
    /**
     * Mirrors the native window's fullscreen state, pushed by Main via `window.fullScreen`.
     */
    isFullScreen: boolean;
    /**
     * Idempotent attach used on mount; joins an in-flight snapshot read instead of duplicating it.
     */
    initialize(): Promise<void>;
    /**
     * Re-reads the snapshot, coalescing concurrent callers into at most one follow-up read.
     */
    refresh(): Promise<void>;
    /**
     * Optimistically applies a Session layout/tab/secondarySidebar change and reports persistence.
     *
     * `onStaleWrite` fires only for the specific `CONFLICT` ("stale revision") outcome, and only when this write is
     * still the latest attempt — the one case a caller can safely retry against a refreshed snapshot, because nothing
     * about the write itself was wrong. It is a distinct signal from `onLatestFailure`, which never fires for this
     * outcome: a caller must not infer a stale-revision race from the optimistic layout alone, since a later command
     * that supersedes this attempt can leave the layout looking exactly like an unrelated genuine failure would.
     */
    patchSessionState(
        next: SessionState,
        failureLabel?: string,
        onLatestFailure?: () => void,
        failureMode?: SessionStateFailureMode,
        shouldReportFailure?: boolean,
        onStaleWrite?: () => void,
    ): Promise<boolean>;
}

type SessionStateFailureMode = 'retain' | 'rollback';

// Mutable module state is held in `.current` fields (not bare top-level `let`s) so writing to it
// from inside store actions satisfies unicorn/no-top-level-assignment-in-function.
const bootstrapRead = { inFlight: undefined as Promise<void> | undefined };
const queuedRead = { current: undefined as Promise<void> | undefined };
/**
 * Where every full snapshot read comes from. The Workbench window reads `app.bootstrap`. The Agent Commander window is
 * not admitted for that method, so its entry swaps in a Commander-scoped reader before the first render; shared code
 * that refreshes after a command (a Terminal pane's Restart, for instance) then converges on the scoped snapshot
 * instead of raising a denied request.
 */
const snapshotSource = {
    read: (): Promise<BootstrapState> => caxri.request('app.bootstrap'),
};

export function configureWorkbenchSnapshotSource(read: () => Promise<BootstrapState>): void {
    snapshotSource.read = read;
}
const recordRefresh = { inFlight: undefined as Promise<void> | undefined };
/**
 * The `state.changed` reasons a Renderer command may wait for before it reports itself done. Only commands whose result
 * the user watches land — selection and the two reorder gestures — register here; everything else settles on the
 * ordinary refresh.
 */
const SESSION_COMMAND_CONVERGENCE_REASONS = [
    'session.select',
    'session.reorder',
    'session.reorderPinned',
] as const;

type SessionCommandConvergenceReason = (typeof SESSION_COMMAND_CONVERGENCE_REASONS)[number];

function isSessionCommandConvergenceReason(
    reason: string,
): reason is SessionCommandConvergenceReason {
    return (SESSION_COMMAND_CONVERGENCE_REASONS as readonly string[]).includes(reason);
}

const sessionCommandConvergence = {
    pending: [] as Array<{ reason: SessionCommandConvergenceReason; resolve: () => void }>,
};
const pendingSessionRecordIds = new Set<string>();
const pendingTerminalRecordIds = new Set<string>();
const configErrors = { reported: false };

export const useWorkbenchStore = createStore<WorkbenchState>('workbench', (set, get) => ({
    bootstrap: undefined,
    attachEpoch: 0,
    isFullScreen: false,
    initialize: initializeWorkbench,
    refresh: refreshWorkbench,
    async patchSessionState(
        next,
        failureLabel = 'Session layout could not be saved',
        onLatestFailure,
        failureMode = 'rollback',
        shouldReportFailure = true,
        onStaleWrite,
    ) {
        const bootstrap = get().bootstrap;
        if (!bootstrap) return false;
        const previous = bootstrap.sessionStates.find(
            (state) =>
                state.sessionId === next.sessionId &&
                state.workbenchProjectId === next.workbenchProjectId,
        );
        /**
         * Async UI work may finish after a root switch. Never make that stale root visible or submit a write Server
         * must reject.
         */
        if (!previous) return false;
        const patchKey = sessionPatchKey(next);
        recordExternalEditorState(next);
        const durableNext = stripExternalEditorTabs(next);
        const durablePrevious = stripExternalEditorTabs(previous);
        set({
            bootstrap: {
                ...bootstrap,
                sessionStates: bootstrap.sessionStates.map((state) =>
                    state.sessionId === next.sessionId &&
                    state.workbenchProjectId === next.workbenchProjectId
                        ? next
                        : state,
                ),
            },
        });
        /**
         * External editor tabs are a Renderer overlay. Selection, opening, and closing therefore finish locally when
         * the durable state is unchanged, without issuing an update that could write their opaque resources to SQLite.
         */
        if (isEqual(durableNext, durablePrevious) && !isEqual(next, previous)) {
            const pending = pendingSessionPatches.get(patchKey);
            if (pending) pending.state = next;
            const persisted = persistedSessionPatches.get(patchKey);
            if (persisted) persisted.state = next;
            return true;
        }
        sessionPatchAttempt.current += 1;
        const attempt = sessionPatchAttempt.current;
        /**
         * Registered before this write waits its turn, with a stamp no read can postdate, so a bootstrap refresh that
         * lands while the write is still queued behind its predecessor cannot roll the optimistic layout back. The real
         * stamp replaces it the moment the request is actually sent.
         */
        const pendingEntry = { attempt, sendStamp: Infinity, state: next };
        pendingSessionPatches.set(patchKey, pendingEntry);
        const finish = (): void => {
            if (pendingSessionPatches.get(patchKey)?.attempt === attempt)
                pendingSessionPatches.delete(patchKey);
        };
        const { promise: chained, resolve: settleChain } = Promise.withResolvers<
            number | undefined
        >();
        const previousWrite = sessionStateWriteChains.get(patchKey);
        sessionStateWriteChains.set(patchKey, chained);
        let sendStamp = Infinity;
        try {
            /**
             * Awaited only when this Session actually has a write in flight, so the ordinary uncontended patch still
             * reaches the Server in the same microtask it always did.
             */
            const durableSend = previousWrite
                ? rebasedSessionState(durableNext, await previousWrite)
                : durableNext;
            /**
             * Stamped now, at send time, so a bootstrap read issued after this line — even one that resolves before
             * this request does — is correctly recognized as observing (or postdating) this write once it lands.
             */
            sessionStateWrites.sent += 1;
            sendStamp = sessionStateWrites.sent;
            pendingEntry.sendStamp = sendStamp;
            const settled = settledSessionState(
                next,
                await caxri.request('session.updateState', durableSend),
            );
            settleChain(settled.revision);
            if (pendingSessionPatches.get(patchKey)?.attempt === attempt) {
                persistedSessionPatches.set(patchKey, { sendStamp, state: settled });
                if (settled !== next) applySettledSessionState(settled);
            }
            finish();
            return true;
        } catch (error: unknown) {
            // A write that stored nothing has no revision to hand the next one, which then keeps the token it read.
            settleChain(undefined);
            // Only the latest pending attempt may roll back or report a failure: an older
            // request must not clobber or fault a newer optimistic write and its own outcome.
            const isLatestAttempt = pendingSessionPatches.get(patchKey)?.attempt === attempt;
            /**
             * A rejected stale write is the one failure whose `previous` is worthless: the Server row moved after this
             * writer read it, so restoring the state this write started from would put a layout on screen that the
             * Server never held, and `failureMode: 'retain'` would pin an equally stale optimistic copy over every
             * later snapshot. Drop both overlays for this Session and re-read instead, which is also the only outcome
             * that lets the losing change be re-derived against what actually won.
             */
            if (isStaleSessionStateWrite(error)) {
                finish();
                if (persistedSessionPatches.get(patchKey)?.sendStamp === sendStamp)
                    persistedSessionPatches.delete(patchKey);
                // This writer reports its own outcome now; the refreshed snapshot is what every later render reads.
                if (isLatestAttempt) {
                    // eslint-disable-next-line no-void -- intentional floating-promise discard
                    void refreshWorkbench();
                    onStaleWrite?.();
                }
                return false;
            }
            /**
             * A durable file move cannot safely restore its old path. Retaining the latest optimistic patch also
             * shields it from stale bootstrap reads until retry replaces this attempt and eventually persists it.
             */
            const isRetainLatest = isLatestAttempt && failureMode === 'retain';
            if (isRetainLatest) {
                const pending = pendingSessionPatches.get(patchKey);
                if (pending) pending.retained = true;
            } else {
                finish();
            }
            const visibleState = get().bootstrap?.sessionStates.find(
                (state) => state.sessionId === next.sessionId,
            );
            const isRootIsStillVisible =
                visibleState?.workbenchProjectId === next.workbenchProjectId;
            if (!isRetainLatest && isLatestAttempt && isRootIsStillVisible) {
                recordExternalEditorState(previous);
                set((current) => {
                    if (!current.bootstrap) return current;
                    return {
                        bootstrap: {
                            ...current.bootstrap,
                            sessionStates: current.bootstrap.sessionStates.map((state) =>
                                state.sessionId === next.sessionId &&
                                state.workbenchProjectId === next.workbenchProjectId
                                    ? previous
                                    : state,
                            ),
                        },
                    };
                });
            }
            if (isLatestAttempt && isRootIsStillVisible) onLatestFailure?.();
            // A cancelled write has nothing for the user to act on and usually arrives with no window left to show it
            // on; `tryCommand` applies the same rule to every other Renderer-initiated write.
            if (shouldReportFailure && isLatestAttempt && !isCancelledRequest(error))
                pushToast('error', describeFailure(error, failureLabel));
            return false;
        } finally {
            // Only the newest link owns the entry; an older one deleting it would let the next write skip the queue.
            if (sessionStateWriteChains.get(patchKey) === chained)
                sessionStateWriteChains.delete(patchKey);
        }
    },
}));

/**
 * Replaces one Session's visible state with the Server's canonical answer to a layout write.
 */
function applySettledSessionState(settled: SessionState): void {
    useWorkbenchStore.setState((current) => {
        if (!current.bootstrap) return current;
        return {
            bootstrap: {
                ...current.bootstrap,
                sessionStates: current.bootstrap.sessionStates.map((state) =>
                    state.sessionId === settled.sessionId &&
                    state.workbenchProjectId === settled.workbenchProjectId
                        ? settled
                        : state,
                ),
            },
        };
    });
}
/**
 * Dirtiness is no longer mirrored into the persisted Session state: an unsaved buffer lives only in the Renderer's
 * document cache, so a Server snapshot can be applied as is.
 */
function applySnapshot(
    state: BootstrapState,
    sessionReadStamp: number,
    terminalReadSequence: number,
): void {
    const patched = applyPendingSessionPatches(state, sessionReadStamp);
    const current = {
        ...patched,
        sessions: withPendingSessionTitles(patched.sessions),
        sessionStates: patched.sessionStates.map(mergeExternalEditorTabs),
    };
    syncNotificationSettings(current.settings);
    useWorkbenchStore.setState((previous) => {
        const terminals = applyFullTerminalSnapshot(
            previous.bootstrap?.terminals ?? [],
            current.terminals,
            terminalReadSequence,
        );
        return {
            bootstrap: mergeStructurally(previous.bootstrap, { ...current, terminals }),
        };
    });
    // After the store holds the snapshot, so the toast can name the Project and Session the notice belongs to.
    reportAutomaticNamingNotices(
        current.automaticNamingUnavailable,
        useWorkbenchStore.getState().bootstrap,
    );
    if (configErrors.reported) return;
    configErrors.reported = true;
    if (current.configurationErrors?.[0]) pushToast('error', current.configurationErrors[0]);
}

function applyRecordSnapshot(
    sessionIds: ReadonlySet<string>,
    terminalIds: ReadonlySet<string>,
    records: { sessions: SessionRecord[]; terminals: TerminalRecord[] },
    terminalReadSequence: number | undefined,
): void {
    useWorkbenchStore.setState((current) => {
        if (!current.bootstrap) return current;
        const acceptedTerminalIds =
            terminalReadSequence === undefined
                ? new Set<string>()
                : acceptTerminalReads(terminalIds, terminalReadSequence);
        const next = {
            ...current.bootstrap,
            sessions: replaceRequestedRecords(
                current.bootstrap.sessions,
                sessionIds,
                withPendingSessionTitles(records.sessions),
            ),
            terminals: replaceRequestedRecords(
                current.bootstrap.terminals,
                acceptedTerminalIds,
                records.terminals.filter((terminal) => acceptedTerminalIds.has(terminal.id)),
            ),
        };
        return { bootstrap: mergeStructurally(current.bootstrap, next) };
    });
}

async function runRecordRefresh(
    sessionIds: ReadonlySet<string>,
    terminalIds: ReadonlySet<string>,
): Promise<void> {
    const terminalReadSequence = terminalIds.size > 0 ? beginTerminalRead(terminalIds) : undefined;
    try {
        const records = await caxri.request('app.records', {
            sessionIds: [...sessionIds],
            terminalIds: [...terminalIds],
        });
        applyRecordSnapshot(sessionIds, terminalIds, records, terminalReadSequence);
    } catch {
        await refreshWorkbench();
    } finally {
        if (terminalReadSequence !== undefined) finishTerminalRead(terminalReadSequence);
        recordRefresh.inFlight = undefined;
        if (pendingSessionRecordIds.size > 0 || pendingTerminalRecordIds.size > 0)
            // Genuinely fire-and-forget: this kicks off the next coalesced refresh round, and
            // scheduleRecordRefresh() already catches its own failures internally.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void scheduleRecordRefresh();
    }
}

/**
 * Shows a Session title before the Server confirms it; see `workbench-session-titles.ts` for how snapshots keep it.
 */
export function showSessionTitle(sessionId: string, displayTitle: string): void {
    useWorkbenchStore.setState((current) => {
        if (!current.bootstrap) return current;
        return {
            bootstrap: {
                ...current.bootstrap,
                sessions: current.bootstrap.sessions.map((session) =>
                    session.id === sessionId ? { ...session, displayTitle } : session,
                ),
            },
        };
    });
}

function scheduleRecordRefresh(): Promise<void> {
    if (recordRefresh.inFlight) return recordRefresh.inFlight;
    if (!useWorkbenchStore.getState().bootstrap) return refreshWorkbench();
    const sessionIds = new Set(pendingSessionRecordIds);
    const terminalIds = new Set(pendingTerminalRecordIds);
    pendingSessionRecordIds.clear();
    pendingTerminalRecordIds.clear();
    recordRefresh.inFlight = runRecordRefresh(sessionIds, terminalIds);
    return recordRefresh.inFlight;
}

function applyStateChange(
    payload: Extract<ServerEvent, { event: 'state.changed' }>['payload'],
): Promise<void> {
    if (payload.kind === 'full') return refreshWorkbench();
    for (const sessionId of payload.sessionIds) pendingSessionRecordIds.add(sessionId);
    for (const terminalId of payload.terminalIds) pendingTerminalRecordIds.add(terminalId);
    return scheduleRecordRefresh();
}

/**
 * Registers before a Session command is sent, then resolves after that command's event-driven snapshot finishes. The
 * queue preserves the Runtime's serialized command order even while Preload is replaying buffered events, and keeps the
 * command path from scheduling a duplicate `app.bootstrap`.
 */
export function registerSessionCommandConvergence(reason: SessionCommandConvergenceReason): {
    cancel: () => void;
    promise: Promise<void>;
} {
    const completion = Promise.withResolvers<void>();
    const pending = { reason, resolve: completion.resolve };
    sessionCommandConvergence.pending.push(pending);
    return {
        cancel: () => {
            const index = sessionCommandConvergence.pending.indexOf(pending);
            if (index !== -1) sessionCommandConvergence.pending.splice(index, 1);
        },
        promise: completion.promise,
    };
}

function resolveNextSessionCommandConvergence(
    reason: SessionCommandConvergenceReason,
    refresh: Promise<void>,
): void {
    const index = sessionCommandConvergence.pending.findIndex(
        (pending) => pending.reason === reason,
    );
    if (index === -1) return;
    const pending = sessionCommandConvergence.pending.splice(index, 1).at(0);
    if (!pending) return;
    // Fire-and-forget: both outcomes release the command; refreshWorkbench reports its own failure to the user.
    // eslint-disable-next-line no-void -- the registered command owns the completion promise, not this continuation
    void refresh.then(() => pending.resolve()).catch(() => pending.resolve());
}

async function runLoadBootstrap(): Promise<void> {
    const terminalReadSequence = beginTerminalRead();
    const finishPerformanceRequest = beginRendererPerformanceRequest('app.bootstrap');
    try {
        const readStamp = sessionStateWrites.sent;
        const state = await snapshotSource.read();
        finishPerformanceRequest();
        applySnapshot(state, readStamp, terminalReadSequence);
    } catch (error: unknown) {
        finishPerformanceRequest();
        // Quit refuses every queued Renderer request, so the last `state.changed` before the window closes lands here
        // as a cancellation. Reporting it raised "Unable to attach to the Runtime" over an application that is already
        // gone; `tryCommand` and `shouldToastQueryError` apply the same rule to the other two failure funnels.
        if (!isCancelledRequest(error))
            pushToast('error', describeFailure(error, 'Unable to attach to the Runtime'));
    } finally {
        finishTerminalRead(terminalReadSequence);
        bootstrapRead.inFlight = undefined;
    }
}

function loadBootstrap(): Promise<void> {
    bootstrapRead.inFlight = runLoadBootstrap();
    return bootstrapRead.inFlight;
}

/**
 * Single-flight snapshot read. A caller that arrives while a read is already in flight cannot reuse it — its own
 * mutation may not be reflected there — so every such caller shares one follow-up read instead of issuing a burst of
 * `app.bootstrap` requests. React StrictMode's double mount therefore never doubles the Server work, and neither does a
 * burst of `state.changed` events.
 */
export function initializeWorkbench(): Promise<void> {
    return bootstrapRead.inFlight ?? loadBootstrap();
}

async function runQueuedRefresh(waitFor: Promise<void>): Promise<void> {
    await waitFor;
    queuedRead.current = undefined;
    return bootstrapRead.inFlight ?? loadBootstrap();
}

export function refreshWorkbench(): Promise<void> {
    if (!bootstrapRead.inFlight) return loadBootstrap();
    queuedRead.current ??= runQueuedRefresh(bootstrapRead.inFlight);
    return queuedRead.current;
}

/**
 * Drops a fire-and-forget patch that would persist the state Server already holds.
 *
 * UI-driven patches are frequently re-entered with no change at all: restoring focus to a Terminal that is already the
 * active tab re-runs `selectTab`, which rebuilds the layout object and therefore never compares equal by reference.
 * Sending that write costs a `session.updateState` round trip and a SQLite write per focus change, and — worse — it
 * turns an ordinary focus restoration into a failure surface. The Terminal regains focus exactly when a dialog or
 * command palette closes, which is also when the Session behind it may have just been deleted or the application may
 * have started quitting, so the no-op write came back `NOT_FOUND` or `CANCELLED` and raised an "Unable to activate
 * Terminal" notification over a Session the user deliberately removed.
 *
 * `persistSessionState` deliberately keeps the opposite rule: a durable workflow re-persists an already-applied
 * optimistic state on purpose (see `remapOpenEditorsInSession`), so it must still issue the write.
 */
function isSessionStatePersisted(next: SessionState): boolean {
    const previous = useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find(
            (state) =>
                state.sessionId === next.sessionId &&
                state.workbenchProjectId === next.workbenchProjectId,
        );
    return previous !== undefined && isEqual(previous, next);
}

export function patchSessionState(
    next: SessionState,
    failureLabel?: string,
    onLatestFailure?: () => void,
): void {
    if (isSessionStatePersisted(next)) return;
    // Fire-and-forget: the store method already funnels every failure into a toast internally and
    // never rejects, so this synchronous-looking wrapper never needs to await the outcome.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void useWorkbenchStore.getState().patchSessionState(next, failureLabel, onLatestFailure);
}

/**
 * Allows durable workflows to wait until an optimistic Session-state patch reaches Server. `retainOnFailure` pins a
 * target-path state that would be unsafe to roll back after disk mutation.
 */
export function persistSessionState(
    next: SessionState,
    options: {
        failureLabel?: string;
        reportFailure?: boolean;
        retainOnFailure?: boolean;
    } = {},
): Promise<boolean> {
    return useWorkbenchStore
        .getState()
        .patchSessionState(
            next,
            options.failureLabel,
            undefined,
            options.retainOnFailure ? 'retain' : 'rollback',
            options.reportFailure,
        );
}

/**
 * Reads the root this Session is currently showing. Called synchronously while handling `workbench.changed` it still
 * observes the pre-change snapshot, because the `state.changed` emitted alongside it only schedules a refresh.
 */
function currentWorkbenchProjectId(sessionId: string): string | undefined {
    return useWorkbenchStore
        .getState()
        .bootstrap?.sessions.find((session) => session.id === sessionId)?.workbenchProjectId;
}

/**
 * The single `onEvent` subscription for Server-driven workbench state. Every listener that used to live inside App's
 * mount effect dispatches into this store instead. Unhandled events must be listed as explicit no-ops so a new Server
 * event fails compile instead of disappearing.
 */
export function subscribeWorkbenchEvents(handlers: WorkbenchEventHandlers): () => void {
    return caxri.onEvent((event) => {
        switch (event.event) {
            case 'state.changed': {
                const refresh = applyStateChange(event.payload);
                if (
                    event.payload.kind === 'full' &&
                    isSessionCommandConvergenceReason(event.payload.reason)
                )
                    resolveNextSessionCommandConvergence(event.payload.reason, refresh);
                // Fire-and-forget: applyStateChange() catches its own Server request failures.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void refresh;
                return;
            }
            case 'runtime.status': {
                const payload = event.payload;
                if (payload.status === 'ready') {
                    useWorkbenchStore.setState((current) => ({
                        attachEpoch: current.attachEpoch + 1,
                    }));
                    /**
                     * Runtime readiness alone does not mean restored PTYs accept input yet. Keep the visible status
                     * non-ready until one bootstrap snapshot replaces stale pre-restart Terminal records; otherwise a
                     * pane can still look running and silently discard keystrokes before its replacement PTY exists.
                     */
                    // Fire-and-forget: refreshWorkbench() catches its own Server request failures.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                    void refreshWorkbench();
                    return;
                }
                useWorkbenchStore.setState((current) =>
                    current.bootstrap
                        ? { bootstrap: { ...current.bootstrap, runtime: payload } }
                        : current,
                );
                return;
            }
            case 'host.connectionChanged': {
                if (event.payload.status === 'replaced') {
                    pushToast(
                        'error',
                        'Another Caxri window took over this profile. Continue in the other window.',
                    );
                    return;
                }
                /**
                 * PTY output sent while the Desktop↔Server socket was down (observed on macOS sleep/wake) was dropped
                 * without replay: without a forced re-attach every backgrounded Terminal pane would stay frozen at the
                 * last byte received before the outage. Refresh converged state too — durable recovery may have been
                 * reset when a replacement Server took over.
                 */
                useWorkbenchStore.setState((current) => ({
                    attachEpoch: current.attachEpoch + 1,
                }));
                // Fire-and-forget: refreshWorkbench() catches its own Server request failures.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void refreshWorkbench();
                return;
            }
            case 'settings.changed':
            case 'keybindings.changed':
            case 'theme.changed':
                if (event.payload.error) pushToast('error', event.payload.error);
                // Fire-and-forget: refreshWorkbench() catches its own Server request failures.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                else void refreshWorkbench();
                return;
            case 'command.execute':
                handlers.onCommand(event.payload.command, event.payload.viaAccelerator === true);
                return;
            case 'desktop.openRequested':
                handlers.onDesktopOpen(event.payload.sessionId, event.payload.path, {
                    ...(event.payload.location && { location: event.payload.location }),
                    ...(event.payload.focusEditor && { focusEditor: true }),
                });
                return;
            case 'settings.openRequested':
                handlers.onSettingsTarget(event.payload.target);
                return;
            case 'workbench.candidate':
                showWorkbenchRootCandidate(event.payload);
                return;
            case 'workbench.changed':
                dismissWorkbenchRootCandidate(event.payload.sessionId);
                reportWorkbenchRootChange(
                    event.payload,
                    currentWorkbenchProjectId(event.payload.sessionId),
                );
                return;
            case 'window.fullScreen':
                useWorkbenchStore.setState({ isFullScreen: event.payload.isFullScreen });
                return;
            case 'gpu.recoveryRequested':
                gpuIncidentBudget.recordIncident(event.payload.correlationId);
                gpuRecoveryNotificationCoordinator.notifyGpuProcessRecovery(
                    event.payload.correlationId,
                );
                return;
            case 'terminal.outputRecovery':
                reportTerminalOutputRecovery(event.payload);
                return;
            case 'terminal.resourceAlert':
                reportTerminalResourceAlert(event.payload);
                return;
            case 'agent.automaticNamingUnavailable': {
                reportAutomaticNamingNotices(
                    [event.payload],
                    useWorkbenchStore.getState().bootstrap,
                );
                return;
            }
            case 'agent.notification': {
                const bootstrap = useWorkbenchStore.getState().bootstrap;
                const session = bootstrap?.sessions.find(
                    (item) => item.id === event.payload.sessionId,
                );
                recordNotification({
                    kind: 'info',
                    message: `${session?.displayTitle ?? 'Agent'} ${event.payload.attentionKind === 'waiting' ? 'is waiting for your input.' : 'completed a turn.'}`,
                    projectId: session?.projectId,
                    projectTitle: bootstrap?.projects.find((item) => item.id === session?.projectId)
                        ?.displayTitle,
                });
                return;
            }
            case 'projectStatus.alert':
                recordNotification({
                    kind: 'error',
                    message:
                        event.payload.kind === 'check'
                            ? `CI failed: ${event.payload.name}`
                            : `${event.payload.name} deployment failed`,
                    projectId: `${event.payload.repository}:${event.payload.branch}`,
                    projectTitle: `${event.payload.repository} · ${event.payload.branch}`,
                });
                return;
            case 'agent.dispatch.changed':
            case 'viewContainers.catalogChanged':
            case 'viewContainers.treeChanged':
            case 'viewContainers.viewChanged':
            case 'agent.message.held':
            case 'agent.message.receipt':
            case 'agent.messaging.changed':
            case 'agent.permissionAutoAllowChanged':
            case 'agentTranscript.changed':
            case 'agentHooks.changed':
            case 'files.changed':
            case 'files.operationChanged':
            case 'git.changed':
            case 'gitReview.changed':
            case 'projectStatus.changed':
            case 'sessionPullRequests.changed':
            case 'terminal.exit':
            case 'terminal.output':
            case 'terminal.sizeOwnership':
            case 'updates.state':
                // `agent.permissionAutoAllowChanged` (issue caxri#1295) is handled by
                // `subscribeRuntimeQueryInvalidation` in `queries/invalidation.ts`, which refreshes the Session row
                // menu's `session.permissionAutoAllowStatus` read; this store has no bootstrap state to update for it.
                // `gitReview.changed` (issue caxri#1294) is handled the same way, refreshing `gitReview.list` and
                // `gitReview.pending` reads instead.
                return;
            default:
                return assertNever(event, 'Unhandled workbench Runtime event');
        }
    });
}
