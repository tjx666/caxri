import { create } from 'zustand';

import type { RuntimeEvent } from '@shared/ipc/events';
import type { BootstrapState, SessionRecord, SessionState, TerminalRecord } from '@shared/types';

import { caxri } from '../lib/caxri';
import { mergeStructurally } from './structural-sharing';
import { describeFailure, pushToast } from './toasts';

interface WorkbenchState {
    /** The last Runtime snapshot, or `undefined` until the first `app.bootstrap` resolves. */
    bootstrap?: BootstrapState;
    /**
     * Bumped every time the Runtime reports ready again. Mounted Terminal panes watch this to
     * re-issue `terminal.attach`, because a Runtime restart drops attachment state the pane cannot
     * observe on its own.
     */
    attachEpoch: number;
    /** Mirrors the native window's fullscreen state, pushed by Main via `window.fullScreen`. */
    isFullScreen: boolean;
    /** Idempotent attach used on mount; joins an in-flight snapshot read instead of duplicating it. */
    initialize(): Promise<void>;
    /** Re-reads the snapshot, coalescing concurrent callers into at most one follow-up read. */
    refresh(): Promise<void>;
    /** Optimistically applies a Session layout/tab/inspector change and reports persistence. */
    patchSessionState(next: SessionState, failureLabel?: string): Promise<boolean>;
}

let inFlight: Promise<void> | undefined;
let queued: Promise<void> | undefined;
let recordRefreshInFlight: Promise<void> | undefined;
const pendingSessionRecordIds = new Set<string>();
const pendingTerminalRecordIds = new Set<string>();
let configurationErrorsReported = false;
let nextSessionPatchRevision = 0;
const pendingSessionPatches = new Map<string, { revision: number; state: SessionState }>();

/**
 * A bootstrap read started before `session.updateState` can resolve after the optimistic Renderer
 * write. Preserve the latest unacknowledged Session state so that stale Runtime snapshots cannot
 * make a just-selected tab or layout visibly jump backwards.
 */
function applyPendingSessionPatches(state: BootstrapState): BootstrapState {
    if (pendingSessionPatches.size === 0) return state;
    const sessionStates = state.sessionStates.map(
        (sessionState) => pendingSessionPatches.get(sessionState.sessionId)?.state ?? sessionState,
    );
    return { ...state, sessionStates };
}

function applySnapshot(state: BootstrapState): void {
    const current = applyPendingSessionPatches(state);
    useWorkbenchStore.setState((previous) => ({
        bootstrap: mergeStructurally(previous.bootstrap, current),
    }));
    if (configurationErrorsReported) return;
    configurationErrorsReported = true;
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

function scheduleRecordRefresh(): Promise<void> {
    if (recordRefreshInFlight) return recordRefreshInFlight;
    if (!useWorkbenchStore.getState().bootstrap) return refreshWorkbench();
    const sessionIds = new Set(pendingSessionRecordIds);
    const terminalIds = new Set(pendingTerminalRecordIds);
    pendingSessionRecordIds.clear();
    pendingTerminalRecordIds.clear();
    recordRefreshInFlight = caxri
        .request('app.records', {
            sessionIds: [...sessionIds],
            terminalIds: [...terminalIds],
        })
        .then((records) => applyRecordSnapshot(sessionIds, terminalIds, records))
        .catch(() => refreshWorkbench())
        .finally(() => {
            recordRefreshInFlight = undefined;
            if (pendingSessionRecordIds.size > 0 || pendingTerminalRecordIds.size > 0)
                void scheduleRecordRefresh();
        });
    return recordRefreshInFlight;
}

function applyStateChange(
    payload: Extract<RuntimeEvent, { event: 'state.changed' }>['payload'],
): Promise<void> {
    if (payload.kind === 'full') return refreshWorkbench();
    for (const sessionId of payload.sessionIds) pendingSessionRecordIds.add(sessionId);
    for (const terminalId of payload.terminalIds) pendingTerminalRecordIds.add(terminalId);
    return scheduleRecordRefresh();
}

function loadBootstrap(): Promise<void> {
    inFlight = caxri
        .request('app.bootstrap')
        .then(applySnapshot)
        .catch((error: unknown) => {
            pushToast('error', describeFailure(error, 'Unable to attach to the Runtime'));
        })
        .finally(() => {
            inFlight = undefined;
        });
    return inFlight;
}

/**
 * Single-flight snapshot read. A caller that arrives while a read is already in flight cannot reuse
 * it — its own mutation may not be reflected there — so every such caller shares one follow-up read
 * instead of issuing a burst of `app.bootstrap` requests. React StrictMode's double mount therefore
 * never doubles the Runtime work, and neither does a burst of `state.changed` events.
 */
export function initializeWorkbench(): Promise<void> {
    return inFlight ?? loadBootstrap();
}

export function refreshWorkbench(): Promise<void> {
    if (!inFlight) return loadBootstrap();
    queued ??= inFlight.then(() => {
        queued = undefined;
        return inFlight ?? loadBootstrap();
    });
    return queued;
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
    bootstrap: undefined,
    attachEpoch: 0,
    isFullScreen: false,
    initialize: initializeWorkbench,
    refresh: refreshWorkbench,
    patchSessionState(next, failureLabel = 'Session layout could not be saved') {
        const bootstrap = get().bootstrap;
        if (!bootstrap) return Promise.resolve(false);
        const previous = bootstrap.sessionStates.find(
            (state) => state.sessionId === next.sessionId,
        );
        const revision = ++nextSessionPatchRevision;
        pendingSessionPatches.set(next.sessionId, { revision, state: next });
        set({
            bootstrap: {
                ...bootstrap,
                sessionStates: bootstrap.sessionStates.map((state) =>
                    state.sessionId === next.sessionId ? next : state,
                ),
            },
        });
        const finish = (): void => {
            if (pendingSessionPatches.get(next.sessionId)?.revision === revision)
                pendingSessionPatches.delete(next.sessionId);
        };
        return caxri
            .request('session.updateState', next)
            .then(() => {
                finish();
                return true;
            })
            .catch((error: unknown) => {
                // Only the latest pending revision for this Session may roll back: an older
                // request's failure must not clobber a newer optimistic write (or the newer
                // write's own later success/failure) that has since superseded it.
                const isLatestRevision =
                    pendingSessionPatches.get(next.sessionId)?.revision === revision;
                finish();
                if (isLatestRevision && previous) {
                    set((current) => {
                        if (!current.bootstrap) return current;
                        return {
                            bootstrap: {
                                ...current.bootstrap,
                                sessionStates: current.bootstrap.sessionStates.map((state) =>
                                    state.sessionId === next.sessionId ? previous : state,
                                ),
                            },
                        };
                    });
                }
                pushToast('error', describeFailure(error, failureLabel));
                return false;
            });
    },
}));

export function patchSessionState(next: SessionState, failureLabel?: string): void {
    void useWorkbenchStore.getState().patchSessionState(next, failureLabel);
}

/** Allows durable workflows to wait until an optimistic Session-state patch reaches Runtime. */
export function persistSessionState(next: SessionState, failureLabel?: string): Promise<boolean> {
    return useWorkbenchStore.getState().patchSessionState(next, failureLabel);
}

export interface WorkbenchEventHandlers {
    /**
     * Runs a command id pushed by the native menu, honouring the modal guard. `viaAccelerator`
     * forwards whether the menu item fired from its keyboard accelerator rather than a mouse/touch
     * click, so the caller can apply the editable-focus shortcut policy only to the accelerator path.
     */
    onCommand(command: string, viaAccelerator: boolean): void;
}

/**
 * The single `onEvent` subscription for Runtime-driven workbench state. Every listener that used to
 * live inside App's mount effect dispatches into this store instead.
 */
export function subscribeWorkbenchEvents(handlers: WorkbenchEventHandlers): () => void {
    return caxri.onEvent((event) => {
        if (event.event === 'state.changed') void applyStateChange(event.payload);
        if (event.event === 'runtime.status') {
            const payload = event.payload;
            useWorkbenchStore.setState((current) =>
                current.bootstrap
                    ? { bootstrap: { ...current.bootstrap, runtime: payload } }
                    : current,
            );
            if (payload.status === 'ready') {
                useWorkbenchStore.setState((current) => ({ attachEpoch: current.attachEpoch + 1 }));
                void refreshWorkbench();
            }
        }
        if (
            event.event === 'settings.changed' ||
            event.event === 'keybindings.changed' ||
            event.event === 'theme.changed'
        ) {
            if (event.payload.error) pushToast('error', event.payload.error);
            else void refreshWorkbench();
        }
        if (event.event === 'command.execute')
            handlers.onCommand(event.payload.command, event.payload.viaAccelerator === true);
        if (event.event === 'window.fullScreen')
            useWorkbenchStore.setState({ isFullScreen: event.payload.isFullScreen });
    });
}
