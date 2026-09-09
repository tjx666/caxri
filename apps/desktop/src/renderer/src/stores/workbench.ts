import type {
    BootstrapState,
    CommandId,
    EditorNavigationTarget,
    ServerEvent,
    SessionRecord,
    SessionState,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, assertNever } from '@caxri/protocol';
import { isEqual } from 'es-toolkit';
import { create } from 'zustand';

import {
    mergeExternalEditorTabs,
    recordExternalEditorState,
    stripExternalEditorTabs,
} from '../features/editor/external-editor-state';
import { gpuIncidentBudget } from '../features/gpu/gpu-incident-budget';
import { gpuRecoveryNotificationCoordinator } from '../features/gpu/gpu-recovery-notifications';
import { beginRendererPerformanceRequest } from '../features/renderer-performance/controller';
import {
    dismissWorkbenchRootCandidate,
    showWorkbenchRootCandidate,
} from '../features/workbench/workbench-root-prompt-store';
import { caxri } from '../lib/caxri';
import { openSettings } from './dialogs';
import { recordNotification, syncNotificationSettings } from './notifications';
import { mergeStructurally } from './structural-sharing';
import { describeFailure, pushToast } from './toasts';

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
     */
    patchSessionState(
        next: SessionState,
        failureLabel?: string,
        onLatestFailure?: () => void,
        failureMode?: SessionStateFailureMode,
        shouldReportFailure?: boolean,
    ): Promise<boolean>;
}

type SessionStateFailureMode = 'retain' | 'rollback';

// Mutable module state is held in `.current` fields (not bare top-level `let`s) so writing to it
// from inside store actions satisfies unicorn/no-top-level-assignment-in-function.
const bootstrapRead = { inFlight: undefined as Promise<void> | undefined };
const queuedRead = { current: undefined as Promise<void> | undefined };
const recordRefresh = { inFlight: undefined as Promise<void> | undefined };
const sessionSelectionConvergence = {
    pending: [] as Array<{ resolve: () => void }>,
};
const pendingSessionRecordIds = new Set<string>();
const pendingTerminalRecordIds = new Set<string>();
const configErrors = { reported: false };
const sessionPatchRevision = { current: 0 };
/**
 * Per-Terminal request ordering for the two read paths that can overlap: full `app.bootstrap` and targeted
 * `app.records`. One monotonic counter timestamps request issuance, while `appliedById` keeps the latest successfully
 * applied read for each affected Terminal. Entries retire as soon as no older request can still resolve, so deleted
 * Terminal IDs cannot accumulate as permanent tombstones.
 */
const terminalReads = {
    active: new Map<number, ReadonlySet<string>>(),
    appliedById: new Map<string, number>(),
    sent: 0,
};
/**
 * Monotonic count of `session.updateState` requests issued so far. Stamped on a write when it is _sent_, not when it
 * resolves: over a single serialized Server connection, any read issued after that point is guaranteed to observe the
 * write once it lands, regardless of which of the two responses comes back first. Comparing against resolution time
 * instead (as this used to) made a read whose response simply arrived first look "older" than a write it actually
 * postdated, so a `state.changed`-triggered refresh for an unrelated later mutation (e.g. closing a Terminal) could be
 * discarded in favor of a stale pre-mutation snapshot that never actually raced it.
 */
const sessionStateWrites = { sent: 0 };
const pendingSessionPatches = new Map<
    string,
    { revision: number; retained?: boolean; sendStamp: number; state: SessionState }
>();
/**
 * The latest Session state whose `session.updateState` completed, kept until a bootstrap read issued after the write
 * proves the Server snapshot includes it. `pendingSessionPatches` only shields the in-flight window; without this map a
 * snapshot read issued before the write but resolved after it would silently roll the UI back (observed as a Terminal
 * split collapsing right after the drop persisted).
 */
const persistedSessionPatches = new Map<string, { sendStamp: number; state: SessionState }>();

function sessionPatchKey(state: Pick<SessionState, 'sessionId' | 'workbenchProjectId'>): string {
    return `${state.sessionId}\0${state.workbenchProjectId}`;
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
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
        sessionPatchRevision.current += 1;
        const revision = sessionPatchRevision.current;
        /**
         * Stamped now, at send time, so a bootstrap read issued after this line — even one that resolves before this
         * request does — is correctly recognized as observing (or postdating) this write once it lands.
         */
        sessionStateWrites.sent += 1;
        const sendStamp = sessionStateWrites.sent;
        pendingSessionPatches.set(patchKey, { revision, sendStamp, state: next });
        const finish = (): void => {
            if (pendingSessionPatches.get(patchKey)?.revision === revision)
                pendingSessionPatches.delete(patchKey);
        };
        try {
            const settled = settledSessionState(
                next,
                await caxri.request('session.updateState', durableNext),
            );
            if (pendingSessionPatches.get(patchKey)?.revision === revision) {
                persistedSessionPatches.set(patchKey, { sendStamp, state: settled });
                if (settled !== next) applySettledSessionState(settled);
            }
            finish();
            return true;
        } catch (error: unknown) {
            // Only the latest pending revision for this Session may roll back: an older
            // request's failure must not clobber a newer optimistic write (or the newer
            // write's own later success/failure) that has since superseded it.
            const isLatestRevision = pendingSessionPatches.get(patchKey)?.revision === revision;
            /**
             * A durable file move cannot safely restore its old path. Retaining the latest optimistic patch also
             * shields it from stale bootstrap reads until retry replaces this revision and eventually persists it.
             */
            const isRetainLatest = isLatestRevision && failureMode === 'retain';
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
            if (!isRetainLatest && isLatestRevision && isRootIsStillVisible) {
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
            if (isLatestRevision && isRootIsStillVisible) onLatestFailure?.();
            if (shouldReportFailure) pushToast('error', describeFailure(error, failureLabel));
            return false;
        }
    },
}));

/**
 * What the Workbench must show once `session.updateState` resolves.
 *
 * The Server answers with the state it actually stored, which can differ from what was sent: a layout that still
 * carried a Terminal closed while this write was being assembled comes back pruned. Showing the answer rather than the
 * optimistic copy is what stops that tab from lingering as a blank pane, because {@link persistedSessionPatches} would
 * otherwise re-apply the stale layout over every later snapshot.
 *
 * The answer is treated as untrusted input for the same reason snapshots are: a write that the Server confirmed must
 * never be rolled back, or reported as failed, merely because its response body could not be read.
 */
function settledSessionState(sent: SessionState, answer: unknown): SessionState {
    const stored = answer as SessionState | undefined;
    if (
        stored?.sessionId !== sent.sessionId ||
        stored.workbenchProjectId !== sent.workbenchProjectId
    )
        return sent;
    const visible = mergeExternalEditorTabs(stored);
    return isEqual(visible.paneLayout, sent.paneLayout) ? sent : visible;
}

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
 * A bootstrap read started before `session.updateState` can resolve after the optimistic Renderer write. Preserve the
 * latest unacknowledged Session state so that stale Server snapshots cannot make a just-selected tab or layout visibly
 * jump backwards.
 */
function applyPendingSessionPatches(state: BootstrapState, readStamp: number): BootstrapState {
    // A read issued after a write was sent observes it once it lands (Server serializes requests in
    // arrival order), so the snapshot is authoritative for that Session again and the persisted overlay
    // can retire.
    for (const [key, entry] of persistedSessionPatches)
        if (entry.sendStamp <= readStamp) persistedSessionPatches.delete(key);
    if (pendingSessionPatches.size === 0 && persistedSessionPatches.size === 0) return state;
    const sessionStates = state.sessionStates.map((sessionState) => {
        const key = sessionPatchKey(sessionState);
        const pending = pendingSessionPatches.get(key);
        if (pending && (pending.retained || pending.sendStamp > readStamp)) return pending.state;
        const persisted = persistedSessionPatches.get(key);
        if (persisted && persisted.sendStamp > readStamp) return persisted.state;
        return sessionState;
    });
    return { ...state, sessionStates };
}

function beginTerminalRead(terminalIds: ReadonlySet<string> = new Set()): number {
    terminalReads.sent += 1;
    terminalReads.active.set(terminalReads.sent, new Set(terminalIds));
    return terminalReads.sent;
}

function finishTerminalRead(readSequence: number): void {
    terminalReads.active.delete(readSequence);
    const oldestActiveSequence = Math.min(...terminalReads.active.keys());
    for (const [terminalId, appliedSequence] of terminalReads.appliedById)
        if (oldestActiveSequence >= appliedSequence) terminalReads.appliedById.delete(terminalId);
}

function isCurrentTerminalRead(terminalId: string, readSequence: number): boolean {
    return (terminalReads.appliedById.get(terminalId) ?? -1) <= readSequence;
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
    if (configErrors.reported) return;
    configErrors.reported = true;
    if (current.configurationErrors?.[0]) pushToast('error', current.configurationErrors[0]);
}

function replaceRequestedRecords<Record extends { id: string }>(
    current: readonly Record[],
    requestedIds: ReadonlySet<string>,
    updates: readonly Record[],
): Record[] {
    const updatesById = new Map(updates.map((record) => [record.id, record]));
    const currentIds = new Set(current.map((record) => record.id));
    return [
        ...current.flatMap((record) => {
            if (!requestedIds.has(record.id)) return [record];
            const update = updatesById.get(record.id);
            return update ? [update] : [];
        }),
        ...updates.filter((record) => !currentIds.has(record.id)),
    ];
}

/**
 * Applies every Terminal in a full snapshot except IDs already covered by a newer successful targeted read. The current
 * record (or its absence) is preserved for those IDs, so an older bootstrap cannot roll `dead` back to `running` or
 * resurrect a targeted deletion.
 */
function applyFullTerminalSnapshot(
    current: readonly TerminalRecord[],
    incoming: readonly TerminalRecord[],
    readSequence: number,
): TerminalRecord[] {
    const currentIds = new Set(current.map((terminal) => terminal.id));
    const candidateIds = new Set([
        ...currentIds,
        ...incoming.map((terminal) => terminal.id),
        ...terminalReads.appliedById.keys(),
    ]);
    for (const terminalIds of terminalReads.active.values())
        for (const terminalId of terminalIds) candidateIds.add(terminalId);
    const authoritativeIds = new Set<string>();
    for (const terminalId of candidateIds) {
        if (!isCurrentTerminalRead(terminalId, readSequence)) continue;
        authoritativeIds.add(terminalId);
        terminalReads.appliedById.set(terminalId, readSequence);
    }
    const safeIncoming = incoming.filter(
        (terminal) => authoritativeIds.has(terminal.id) || currentIds.has(terminal.id),
    );
    return replaceRequestedRecords(current, authoritativeIds, safeIncoming);
}

function applyRecordSnapshot(
    sessionIds: ReadonlySet<string>,
    terminalIds: ReadonlySet<string>,
    records: { sessions: SessionRecord[]; terminals: TerminalRecord[] },
    terminalReadSequence: number | undefined,
): void {
    useWorkbenchStore.setState((current) => {
        if (!current.bootstrap) return current;
        const acceptedTerminalIds = new Set(
            terminalReadSequence === undefined
                ? []
                : [...terminalIds].filter((terminalId) =>
                      isCurrentTerminalRead(terminalId, terminalReadSequence),
                  ),
        );
        if (terminalReadSequence !== undefined)
            for (const terminalId of acceptedTerminalIds)
                terminalReads.appliedById.set(terminalId, terminalReadSequence);
        const next = {
            ...current.bootstrap,
            sessions: replaceRequestedRecords(
                current.bootstrap.sessions,
                sessionIds,
                records.sessions,
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
 * Registers before `session.select` is sent, then resolves after that command's event-driven snapshot finishes. The
 * queue preserves the Runtime's serialized selection order even while Preload is replaying buffered events, and keeps
 * the command path from scheduling a duplicate `app.bootstrap`.
 */
export function registerSessionSelectionConvergence(): {
    cancel: () => void;
    promise: Promise<void>;
} {
    const completion = Promise.withResolvers<void>();
    const pending = { resolve: completion.resolve };
    sessionSelectionConvergence.pending.push(pending);
    return {
        cancel: () => {
            const index = sessionSelectionConvergence.pending.indexOf(pending);
            if (index !== -1) sessionSelectionConvergence.pending.splice(index, 1);
        },
        promise: completion.promise,
    };
}

function resolveNextSessionSelectionConvergence(refresh: Promise<void>): void {
    const pending = sessionSelectionConvergence.pending.shift();
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
        const state = await caxri.request('app.bootstrap');
        finishPerformanceRequest();
        applySnapshot(state, readStamp, terminalReadSequence);
    } catch (error: unknown) {
        finishPerformanceRequest();
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

export function patchSessionState(
    next: SessionState,
    failureLabel?: string,
    onLatestFailure?: () => void,
): void {
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

export interface WorkbenchEventHandlers {
    /**
     * Runs a command id pushed by the native menu, honouring the modal guard. `wasViaAccelerator` forwards whether the
     * menu item fired from its keyboard accelerator rather than a mouse/touch click, so the caller can apply the
     * editable-focus shortcut policy only to the accelerator path.
     */
    onCommand(command: CommandId, wasViaAccelerator: boolean): void;
    /**
     * Applies an authenticated Server open request after Main redeemed its one-use target.
     */
    onDesktopOpen(sessionId: string, path?: string, location?: EditorNavigationTarget): void;
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
                if (event.payload.kind === 'full' && event.payload.reason === 'session.select') {
                    resolveNextSessionSelectionConvergence(refresh);
                }
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
                handlers.onDesktopOpen(
                    event.payload.sessionId,
                    event.payload.path,
                    event.payload.location,
                );
                return;
            case 'workbench.candidate':
                showWorkbenchRootCandidate(event.payload);
                return;
            case 'workbench.changed':
                dismissWorkbenchRootCandidate(event.payload.sessionId);
                if (event.payload.reason === 'fallback' && event.payload.returnedProjectTitle)
                    pushToast(
                        'info',
                        `The active worktree is no longer available. Returned to ${event.payload.returnedProjectTitle}.`,
                        {
                            type: 'worktree-fallback',
                            projectId: event.payload.workbenchProjectId,
                            projectTitle: event.payload.returnedProjectTitle,
                        },
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
            case 'terminal.outputRecovery': {
                const providerName = agentProviderCatalog[event.payload.provider].displayName;
                if (event.payload.status === 'recovered')
                    pushToast(
                        'success',
                        `Sent Esc and continue to ${providerName} after a matched recovery rule.`,
                        {
                            type: 'agent-recovery',
                            action: { label: 'Open Settings', onSelect: openSettings },
                        },
                    );
                else
                    pushToast(
                        'error',
                        `Automatic recovery paused for ${providerName} after 3 attempts in 10 minutes.`,
                        { action: { label: 'Open Settings', onSelect: openSettings } },
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
                    projectId: event.payload.repository,
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
            case 'agentTranscript.changed':
            case 'agentHooks.changed':
            case 'files.changed':
            case 'files.operationChanged':
            case 'git.changed':
            case 'projectStatus.changed':
            case 'sessionPullRequests.changed':
            case 'terminal.exit':
            case 'terminal.output':
            case 'updates.state':
                return;
            default:
                return assertNever(event, 'Unhandled workbench Runtime event');
        }
    });
}
