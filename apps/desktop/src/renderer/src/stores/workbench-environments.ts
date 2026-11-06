import type { BootstrapState } from '@caxri/protocol';

import { caxri } from '../lib/caxri';
import {
    environmentOfSession,
    forgetEnvironment,
    forgottenRecordIds,
    indexEnvironmentSnapshot,
    routingGeneration,
    settleForgottenRecords,
} from '../lib/environment-routing';
import { composedReadMeter } from './composed-read-diagnostics';
import { environmentIdOf, setSelectedEnvironment, useEnvironmentStore } from './environment';

/**
 * Remembers which machine the user last selected a Session on across reloads, so the Workbench reopens on it once that
 * SSH Host reconnects instead of on this Mac's last selection.
 */
const ACTIVE_ENVIRONMENT_KEY = 'caxri.workbench.activeEnvironment';

function readActiveEnvironment(): string | undefined {
    try {
        return localStorage.getItem(ACTIVE_ENVIRONMENT_KEY) ?? undefined;
    } catch {
        return undefined;
    }
}

const snapshots = {
    /**
     * The latest `app.bootstrap` of each connected SSH Host.
     */
    remote: new Map<string, BootstrapState>(),
    /**
     * SSH Hosts whose state changed since their snapshot was read.
     */
    dirty: new Set<string>(),
    /**
     * The machine whose selected Session the window shows: `undefined` is this Mac.
     */
    active: readActiveEnvironment(),
    /**
     * Each machine's selection as last read, keyed by environment id with `''` for this Mac, so a selection another
     * path made (a new Session, a notification's reveal) can move the window to that machine.
     */
    selections: new Map<string, MachineSelection>(),
};

/**
 * One machine's selected Session and the Sessions it listed alongside it.
 */
export interface MachineSelection {
    selectedSessionId: string | undefined;
    sessionIds: ReadonlySet<string>;
}

function selectionOf(state: BootstrapState): MachineSelection {
    return {
        selectedSessionId: state.selectedSessionId,
        sessionIds: new Set(state.sessions.map((session) => session.id)),
    };
}

/**
 * The machine the window should show after a read. A machine whose Server moved its selection to another Session while
 * the one it had selected still exists was asked to (a Session created there, a reveal): the window follows it. A
 * selection that moved because its Session was deleted or archived is the Server's fallback, not a request, and does
 * not pull the window away. The active machine wins a tie; `''` is this Mac.
 */
export function followSelection(
    previous: ReadonlyMap<string, MachineSelection>,
    next: ReadonlyMap<string, MachineSelection>,
    active: string,
): string {
    const moved = [...next].flatMap(([machine, selection]) => {
        const before = previous.get(machine);
        if (before === undefined || selection.selectedSessionId === undefined) return [];
        if (before.selectedSessionId === selection.selectedSessionId) return [];
        const isFallback =
            before.selectedSessionId !== undefined &&
            !selection.sessionIds.has(before.selectedSessionId);
        return isFallback ? [] : [machine];
    });
    if (moved.length === 0 || moved.includes(active)) return active;
    return moved[0] ?? active;
}

/**
 * Records that the user is selecting a Session, before `session.select` goes out, so the snapshot its `state.changed`
 * triggers shows that Session's machine.
 */
export function noteSessionSelection(sessionId: string): void {
    setActiveEnvironment(environmentOfSession(sessionId));
}

function setActiveEnvironment(environmentId: string | undefined): void {
    snapshots.active = environmentId;
    try {
        if (environmentId === undefined) localStorage.removeItem(ACTIVE_ENVIRONMENT_KEY);
        else localStorage.setItem(ACTIVE_ENVIRONMENT_KEY, environmentId);
    } catch {
        // Storage is a convenience; the selection itself is the Server's.
    }
}

/**
 * Marks an SSH Host's snapshot stale, so the next Workbench read fetches it again.
 */
export function markEnvironmentChanged(environmentId: string): void {
    snapshots.dirty.add(environmentId);
}

function listedHosts(): { connected: string[]; listed: ReadonlySet<string> } {
    const { hosts } = useEnvironmentStore.getState();
    return {
        connected: hosts.filter((host) => host.phase === 'connected').map(environmentIdOf),
        listed: new Set(hosts.map(environmentIdOf)),
    };
}

/**
 * Re-reads a Host's snapshot when it is missing or stale. Resolves to the read's duration in milliseconds, or
 * `undefined` when the cached snapshot was still current and nothing was requested.
 */
async function readRemote(environmentId: string): Promise<number | undefined> {
    if (snapshots.remote.has(environmentId) && !snapshots.dirty.has(environmentId)) return;
    snapshots.dirty.delete(environmentId);
    const startedAt = performance.now();
    try {
        const readAt = routingGeneration();
        const state = await caxri.in(environmentId).request('app.bootstrap');
        snapshots.remote.set(environmentId, state);
        indexEnvironmentSnapshot(environmentId, state, readAt);
    } catch {
        // A Host that dropped mid-read keeps its last snapshot until Main reports it disconnected; read it next time.
        snapshots.dirty.add(environmentId);
    }
    return performance.now() - startedAt;
}

/**
 * Notes when a read settles on a side branch, so timing it adds no promise hop to the read itself (the Workbench's
 * refresh tests depend on how many microtasks a snapshot takes to land).
 */
async function noteSettledAt(read: Promise<unknown>, settledAt: { ms: number }, startedAt: number) {
    try {
        await read;
    } catch {
        // The caller of the read handles its failure.
    }
    settledAt.ms = performance.now() - startedAt;
}

/**
 * Lists this Mac's records first, then each SSH Host's, in connection order. Device state (settings, keybindings,
 * theme, Runtime status) is this Mac's. The selection is the active machine's when it has one, else this Mac's.
 */
export function composeSnapshots(
    local: BootstrapState,
    remotes: ReadonlyArray<readonly [string, BootstrapState]>,
    activeEnvironmentId: string | undefined,
): BootstrapState {
    if (remotes.length === 0) return local;
    const all = [local, ...remotes.map(([, state]) => state)];
    const active = remotes.find(([id]) => id === activeEnvironmentId)?.[1];
    const selection = active?.selectedSessionId === undefined ? local : active;
    const optional = <T>(values: Array<T[] | undefined>): T[] | undefined => {
        const flat = values.flatMap((value) => value ?? []);
        return flat.length === 0 ? undefined : flat;
    };
    return {
        ...local,
        projects: all.flatMap((state) => state.projects),
        sessions: all.flatMap((state) => state.sessions),
        terminals: all.flatMap((state) => state.terminals),
        archivedTerminals: all.flatMap((state) => state.archivedTerminals),
        sessionStates: all.flatMap((state) => state.sessionStates),
        openSessionIds: optional(all.map((state) => state.openSessionIds)),
        otherWindowOpenSessionIds: optional(all.map((state) => state.otherWindowOpenSessionIds)),
        automaticNamingUnavailable: optional(all.map((state) => state.automaticNamingUnavailable)),
        selectedSessionId: selection.selectedSessionId,
        selectedProjectId: selection.selectedProjectId,
    };
}

/**
 * The Workbench's full snapshot: this Mac's `app.bootstrap` plus every SSH Host's, read again only when that Host
 * reported a change. Every Host Main still lists keeps its last snapshot, whatever its phase (reconnecting, failed, or
 * taken over by another Desktop), so its Projects stay in the side bar and their headings keep the connection row with
 * Reconnect (`HostConnectionRows`); a failed read never fails the whole Workbench. Only a Host the user disconnected,
 * which leaves Main's list, takes its records with it.
 */
export async function readComposedSnapshot(): Promise<BootstrapState> {
    const { connected, listed } = listedHosts();
    for (const id of snapshots.remote.keys())
        if (!listed.has(id)) {
            snapshots.remote.delete(id);
            snapshots.dirty.delete(id);
            forgetEnvironment(id);
        }
    const forgottenIds = forgottenRecordIds();
    const startedAt = performance.now();
    const dirtyHostCount = connected.filter((id) => snapshots.dirty.has(id)).length;
    const localRead = caxri.request('app.bootstrap');
    const localSettled = { ms: 0 };
    void noteSettledAt(localRead, localSettled, startedAt);
    const [local, ...remoteDurations] = await Promise.all([
        localRead,
        ...connected.map((id) => readRemote(id)),
    ]);
    const performed = remoteDurations.filter((ms): ms is number => ms !== undefined);
    composedReadMeter.record({
        connectedHostCount: connected.length,
        dirtyHostCount,
        localBootstrapMs: localSettled.ms,
        remoteReadCount: performed.length,
        remoteReadMs: Math.max(0, ...performed),
        totalMs: performance.now() - startedAt,
    });
    const composed = composeRead(local, listed);
    settleForgottenRecords(forgottenIds);
    return composed;
}

function composeRead(local: BootstrapState, listed: ReadonlySet<string>): BootstrapState {
    const remotes = [...listed].flatMap((id) => {
        const state = snapshots.remote.get(id);
        return state ? [[id, state] as const] : [];
    });
    const selections = new Map<string, MachineSelection>([
        ['', selectionOf(local)],
        ...remotes.map(([id, state]) => [id, selectionOf(state)] as const),
    ]);
    const followed = followSelection(snapshots.selections, selections, snapshots.active ?? '');
    snapshots.selections = selections;
    if (followed !== (snapshots.active ?? '')) setActiveEnvironment(followed || undefined);
    const composed = composeSnapshots(local, remotes, snapshots.active);
    setSelectedEnvironment(environmentOfSession(composed.selectedSessionId));
    return composed;
}
