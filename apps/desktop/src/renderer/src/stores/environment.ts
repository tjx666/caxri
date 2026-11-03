import type { EnvironmentState, SshEnvironmentState } from '@caxri/protocol';

import { translate } from '../i18n';
import { caxri } from '../lib/caxri';
import { forgetEnvironment } from '../lib/environment-routing';
import { createStore } from '../lib/store';
import { pushToast } from './toasts';

const LOCAL: EnvironmentState = { kind: 'local' };

interface EnvironmentStoreState {
    /**
     * Every SSH Host this Mac is connected to, as Main lists them, in connection order.
     */
    hosts: SshEnvironmentState[];
    /**
     * The SSH Host owning the Session the window shows, or `undefined` while it shows one of this Mac's.
     */
    selectedEnvironmentId?: string;
    /**
     * The machine of the Session the window shows: this Mac, or that SSH Host's connection state. Every argless
     * predicate below (`isLocalOnlyAvailable`, `isSshHost`) answers for it.
     */
    state: EnvironmentState;
}

/**
 * The machines the Workbench reaches: this Mac's Server and every connected SSH Host
 * (docs/adr/0022-multi-environment-window.md). Main owns the connections; the Renderer mirrors their states and which
 * one the selected Session lives on, so UI can hide what that machine cannot do.
 */
export const useEnvironmentStore = createStore<EnvironmentStoreState>('environment', () => ({
    hosts: [],
    state: LOCAL,
}));

function selectedState(
    hosts: readonly SshEnvironmentState[],
    selectedEnvironmentId: string | undefined,
): EnvironmentState {
    if (selectedEnvironmentId === undefined) return LOCAL;
    return hosts.find((host) => host.hostIdentity === selectedEnvironmentId) ?? LOCAL;
}

/**
 * The SSH Host a connected environment's state belongs to; its id everywhere else is this resolved identity.
 */
export function environmentIdOf(state: SshEnvironmentState): string {
    return state.hostIdentity;
}

export function findHost(environmentId: string | undefined): SshEnvironmentState | undefined {
    if (environmentId === undefined) return undefined;
    return useEnvironmentStore
        .getState()
        .hosts.find((host) => environmentIdOf(host) === environmentId);
}

/**
 * Records which machine the shown Session lives on, and tells Main so the native menu disables items that act on this
 * Mac's disk while an SSH Host's Session is shown.
 */
export function setSelectedEnvironment(environmentId: string | undefined): void {
    const current = useEnvironmentStore.getState();
    if (current.selectedEnvironmentId === environmentId) return;
    useEnvironmentStore.setState({
        selectedEnvironmentId: environmentId,
        state: selectedState(current.hosts, environmentId),
    });
    void caxri
        .request('window.reportSelectedMachine', { isLocal: environmentId === undefined })
        .catch(() => {
            // Best effort: the next selection reports again, and the menu item still fails safely in Main.
        });
}

/**
 * Applies Main's host list: starts the event stream of each newly connected Host and stops and forgets each one that
 * was disconnected.
 */
function applyHosts(hosts: SshEnvironmentState[]): void {
    const previous = useEnvironmentStore.getState();
    const ids = new Set(hosts.map(environmentIdOf));
    for (const host of previous.hosts) {
        const id = environmentIdOf(host);
        if (ids.has(id)) continue;
        caxri.environments.detach(id);
        forgetEnvironment(id);
    }
    for (const host of hosts)
        if (host.phase === 'connected') caxri.environments.attach(environmentIdOf(host));
    const selectedEnvironmentId =
        previous.selectedEnvironmentId !== undefined && ids.has(previous.selectedEnvironmentId)
            ? previous.selectedEnvironmentId
            : undefined;
    useEnvironmentStore.setState({
        hosts,
        selectedEnvironmentId,
        state: selectedState(hosts, selectedEnvironmentId),
    });
}

/**
 * Starts mirroring Main's SSH Host list. It subscribes before reading so a change pushed while the read is in flight is
 * never lost, and once any event has arrived the slower read is discarded: an event is always at least as new as the
 * read it raced. It also explains a connect that Main answered by reusing an existing connection.
 */
export function subscribeEnvironment(): () => void {
    /**
     * Mutated from the event listener and the cleanup; kept in one object so the async read sees the current values.
     */
    const subscription = { hasReceivedEvent: false, isActive: true };
    const unsubscribe = caxri.onEvent((event, environmentId) => {
        if (event.event === 'environment.connectionReused') {
            const typed = event.payload.destination;
            const host = findHost(environmentId);
            pushToast(
                'info',
                translate('sshHost.connect.reused', {
                    destination: host?.destination ?? typed,
                    typed,
                }),
            );
            return;
        }
        if (environmentId !== undefined || event.event !== 'sshHost.environmentsChanged') return;
        subscription.hasReceivedEvent = true;
        applyHosts(event.payload);
    });
    void (async () => {
        try {
            const hosts = await caxri.request('sshHost.environments.list');
            if (subscription.isActive && !subscription.hasReceivedEvent) applyHosts(hosts);
        } catch {
            // Best effort: the `sshHost.environmentsChanged` subscription above still delivers the next change.
        }
    })();
    return () => {
        subscription.isActive = false;
        unsubscribe();
    };
}

/**
 * The name a machine keys its on-device state by: `local`, or the SSH Host's resolved identity, so two aliases of one
 * host share their drafts while two hosts never see each other's.
 */
export function storageScopeOf(environmentId: string | undefined): string {
    return environmentId === undefined ? 'local' : `ssh:${environmentId}`;
}

function sshEnvironment(state: EnvironmentState | undefined): SshEnvironmentState | undefined {
    return state?.kind === 'ssh' ? state : undefined;
}

/**
 * True while the shown Session lives on an SSH Host.
 */
export function isSshHost(state = useEnvironmentStore.getState().state): boolean {
    return state.kind === 'ssh';
}

/**
 * True while the shown Session lives on this Mac. Every entry point that reaches a Main method classified `local-only`
 * in `main/environment-method-policy.ts` (Reveal in Finder, Trash, Process Explorer, Caxri Bot, native folder pickers…)
 * checks this one predicate, so an SSH Host's Session never offers an action on this Mac's disk.
 */
export function isLocalOnlyAvailable(state = useEnvironmentStore.getState().state): boolean {
    return state.kind === 'local';
}

export function getSshEnvironment(): SshEnvironmentState | undefined {
    return sshEnvironment(useEnvironmentStore.getState().state);
}

export function useIsSshHost(): boolean {
    return useEnvironmentStore((store) => isSshHost(store.state));
}

export function useIsLocalOnlyAvailable(): boolean {
    return useEnvironmentStore((store) => isLocalOnlyAvailable(store.state));
}

/**
 * The SSH Host state of the shown Session, or `undefined` for this Mac. The selector returns the stored object itself,
 * so subscribers re-render only when Main pushes a new state.
 */
export function useSshEnvironment(): SshEnvironmentState | undefined {
    return useEnvironmentStore((store) => sshEnvironment(store.state));
}
