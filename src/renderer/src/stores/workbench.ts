import { reconcileEditorTabDirtiness, withoutEditorTabDirtiness } from '@shared/editor-state';
import { assertNever } from '@shared/ipc';
import type { RuntimeEvent } from '@shared/ipc/events';
import type {
    BootstrapState,
    CommandId,
    SessionRecord,
    SessionState,
    TerminalRecord,
} from '@shared/types';
import { create } from 'zustand';

import {
    dismissWorkbenchRootCandidate,
    showWorkbenchRootCandidate,
} from '../features/workbench/workbench-root-prompt-store';
import { caxri } from '../lib/caxri';
import { mergeStructurally } from './structural-sharing';
import { describeFailure, pushToast } from './toasts';

interface WorkbenchState {
    /**
     * The last Runtime snapshot, or `undefined` until the first `app.bootstrap` resolves.
     */
    bootstrap?: BootstrapState;
    /**
     * Bumped every time the Runtime reports ready again and after a Desktop↔Host reconnect. Mounted Terminal panes
     * watch this to re-issue `terminal.attach`, because a Runtime restart drops attachment state — and a Host
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
     * Optimistically applies a Session layout/tab/inspector change and reports persistence.
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
const pendingSessionRecordIds = new Set<string>();
const pendingTerminalRecordIds = new Set<string>();
const configErrors = { reported: false };
const sessionPatchRevision = { current: 0 };
const pendingSessionPatches = new Map<string, { revision: number; state: SessionState }>();
/**
 * Monotonic count of completed `session.updateState` writes. Each bootstrap read records the count before issuing the
 * request so `applyPendingSessionPatches` can tell whether the returned snapshot may predate a since-completed write.
 */
const sessionStateWrites = { completed: 0 };
/**
 * The latest Session state whose `session.updateState` completed, kept until a bootstrap read that started after the
 * write proves the Runtime snapshot includes it. `pendingSessionPatches` only shields the in-flight window; without
 * this map a snapshot read issued before the write but resolved after it would silently roll the UI back (observed as a
 * Terminal split collapsing right after the drop persisted).
 */
const persistedSessionPatches = new Map<string, { writeStamp: number; state: SessionState }>();

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
         * Async UI work may finish after a root switch. Never make that stale root visible or submit a write Runtime
         * must reject.
         */
        if (!previous) return false;
        sessionPatchRevision.current += 1;
        const revision = sessionPatchRevision.current;
        const patchKey = sessionPatchKey(next);
        pendingSessionPatches.set(patchKey, { revision, state: next });
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
        const finish = (): void => {
            if (pendingSessionPatches.get(patchKey)?.revision === revision)
                pendingSessionPatches.delete(patchKey);
        };
        try {
            await caxri.request('session.updateState', withoutEditorTabDirtiness(next));
            sessionStateWrites.completed += 1;
            if (pendingSessionPatches.get(patchKey)?.revision === revision)
                persistedSessionPatches.set(patchKey, {
                    writeStamp: sessionStateWrites.completed,
                    state: next,
                });
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
            if (!isRetainLatest) finish();
            const visibleState = get().bootstrap?.sessionStates.find(
                (state) => state.sessionId === next.sessionId,
            );
            const isRootIsStillVisible =
                visibleState?.workbenchProjectId === next.workbenchProjectId;
            if (!isRetainLatest && isLatestRevision && isRootIsStillVisible) {
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
 * A bootstrap read started before `session.updateState` can resolve after the optimistic Renderer write. Preserve the
 * latest unacknowledged Session state so that stale Runtime snapshots cannot make a just-selected tab or layout visibly
 * jump backwards.
 */
function applyPendingSessionPatches(state: BootstrapState, readStamp: number): BootstrapState {
    // A read issued after a write completed observes it (Runtime serializes both), so the snapshot
    // is authoritative for that Session again and the persisted overlay can retire.
    for (const [key, entry] of persistedSessionPatches)
        if (entry.writeStamp <= readStamp) persistedSessionPatches.delete(key);
    if (pendingSessionPatches.size === 0 && persistedSessionPatches.size === 0) return state;
    const sessionStates = state.sessionStates.map((sessionState) => {
        const key = sessionPatchKey(sessionState);
        return (
            pendingSessionPatches.get(key)?.state ??
            persistedSessionPatches.get(key)?.state ??
            sessionState
        );
    });
    return { ...state, sessionStates };
}

async function applySnapshot(state: BootstrapState, readStamp: number): Promise<void> {
    /**
     * Dynamic import avoids a static store cycle: `session-view` uses this module to persist UI state.
     */
    const { sessionViewScope, useSessionViewStore } = await import('./session-view');
    const documents = useSessionViewStore.getState().documents;
    const pending = applyPendingSessionPatches(state, readStamp);
    const current = {
        ...pending,
        sessionStates: pending.sessionStates.map((sessionState) =>
            reconcileEditorTabDirtiness(
                sessionState,
                documents[
                    sessionViewScope(sessionState.sessionId, sessionState.workbenchProjectId)
                ],
            ),
        ),
    };
    useWorkbenchStore.setState((previous) => ({
        bootstrap: mergeStructurally(previous.bootstrap, current),
    }));
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

function applyRecordSnapshot(
    sessionIds: ReadonlySet<string>,
    terminalIds: ReadonlySet<string>,
    records: { sessions: SessionRecord[]; terminals: TerminalRecord[] },
): void {
    useWorkbenchStore.setState((current) => {
        if (!current.bootstrap) return current;
        const next = {
            ...current.bootstrap,
            sessions: replaceRequestedRecords(
                current.bootstrap.sessions,
                sessionIds,
                records.sessions,
            ),
            terminals: replaceRequestedRecords(
                current.bootstrap.terminals,
                terminalIds,
                records.terminals,
            ),
        };
        return { bootstrap: mergeStructurally(current.bootstrap, next) };
    });
}

async function runRecordRefresh(
    sessionIds: ReadonlySet<string>,
    terminalIds: ReadonlySet<string>,
): Promise<void> {
    try {
        const records = await caxri.request('app.records', {
            sessionIds: [...sessionIds],
            terminalIds: [...terminalIds],
        });
        applyRecordSnapshot(sessionIds, terminalIds, records);
    } catch {
        await refreshWorkbench();
    } finally {
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
    payload: Extract<RuntimeEvent, { event: 'state.changed' }>['payload'],
): Promise<void> {
    if (payload.kind === 'full') return refreshWorkbench();
    for (const sessionId of payload.sessionIds) pendingSessionRecordIds.add(sessionId);
    for (const terminalId of payload.terminalIds) pendingTerminalRecordIds.add(terminalId);
    return scheduleRecordRefresh();
}

async function runLoadBootstrap(): Promise<void> {
    try {
        const readStamp = sessionStateWrites.completed;
        const state = await caxri.request('app.bootstrap');
        await applySnapshot(state, readStamp);
    } catch (error: unknown) {
        pushToast('error', describeFailure(error, 'Unable to attach to the Runtime'));
    } finally {
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
 * `app.bootstrap` requests. React StrictMode's double mount therefore never doubles the Runtime work, and neither does
 * a burst of `state.changed` events.
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
 * Allows durable workflows to wait until an optimistic Session-state patch reaches Runtime. `retainOnFailure` pins a
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
     * Applies an authenticated Host open request after Main redeemed its one-use target.
     */
    onDesktopOpen(sessionId: string, path?: string): void;
}

/**
 * The single `onEvent` subscription for Runtime-driven workbench state. Every listener that used to live inside App's
 * mount effect dispatches into this store instead. Unhandled events must be listed as explicit no-ops so a new Runtime
 * event fails compile instead of disappearing.
 */
export function subscribeWorkbenchEvents(handlers: WorkbenchEventHandlers): () => void {
    return caxri.onEvent((event) => {
        switch (event.event) {
            case 'state.changed':
                // Fire-and-forget: applyStateChange() catches its own Runtime request failures.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void applyStateChange(event.payload);
                return;
            case 'runtime.status': {
                const payload = event.payload;
                useWorkbenchStore.setState((current) =>
                    current.bootstrap
                        ? { bootstrap: { ...current.bootstrap, runtime: payload } }
                        : current,
                );
                if (payload.status === 'ready') {
                    useWorkbenchStore.setState((current) => ({
                        attachEpoch: current.attachEpoch + 1,
                    }));
                    // Fire-and-forget: refreshWorkbench() catches its own Runtime request failures.
                    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                    void refreshWorkbench();
                }
                return;
            }
            case 'host.connectionChanged': {
                /**
                 * PTY output sent while the Desktop↔Host socket was down (observed on macOS sleep/wake) was dropped
                 * without replay: without a forced re-attach every backgrounded Terminal pane would stay frozen at the
                 * last byte received before the outage. Refresh converged state too — durable recovery may have been
                 * reset when a replacement Host took over.
                 */
                useWorkbenchStore.setState((current) => ({
                    attachEpoch: current.attachEpoch + 1,
                }));
                // Fire-and-forget: refreshWorkbench() catches its own Runtime request failures.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void refreshWorkbench();
                return;
            }
            case 'settings.changed':
            case 'keybindings.changed':
            case 'theme.changed':
                if (event.payload.error) pushToast('error', event.payload.error);
                // Fire-and-forget: refreshWorkbench() catches its own Runtime request failures.
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                else void refreshWorkbench();
                return;
            case 'command.execute':
                handlers.onCommand(event.payload.command, event.payload.viaAccelerator === true);
                return;
            case 'desktop.openRequested':
                handlers.onDesktopOpen(event.payload.sessionId, event.payload.path);
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
                        { persist: true },
                    );
                return;
            case 'window.fullScreen':
                useWorkbenchStore.setState({ isFullScreen: event.payload.isFullScreen });
                return;
            case 'agent.dispatch.changed':
            case 'agent.message.held':
            case 'agent.message.receipt':
            case 'agent.messaging.changed':
            case 'agentHooks.changed':
            case 'files.changed':
            case 'files.operationChanged':
            case 'git.changed':
            case 'terminal.exit':
            case 'terminal.output':
            case 'updates.state':
                return;
            default:
                return assertNever(event, 'Unhandled workbench Runtime event');
        }
    });
}
