import type { EnvironmentState, SshEnvironmentState } from '@caxri/protocol';

import { translate } from '../i18n';
import { caxri } from '../lib/caxri';
import { createStore } from '../lib/store';
import { pushToast } from './toasts';

interface EnvironmentStoreState {
    /**
     * `undefined` until Main answers `environment.get` or pushes `environment.changed`. Main answers before the Server
     * attaches, so in practice this resolves long before the Workbench renders.
     */
    state?: EnvironmentState;
}

/**
 * Which environment this Workbench window belongs to: the local Server or one SSH Host
 * (docs/adr/0014-ssh-remote-server.md). Main owns the value; the Renderer only mirrors it so UI can hide what an SSH
 * Host window cannot do.
 */
export const useEnvironmentStore = createStore<EnvironmentStoreState>('environment', () => ({}));

/**
 * The name this window's environment keys its on-device state by: `local`, or the SSH Host's resolved identity, so two
 * aliases of one host share their drafts and backups while two hosts never see each other's.
 */
export function environmentStorageScope(environment: EnvironmentState): string {
    return environment.kind === 'ssh' ? `ssh:${environment.hostIdentity}` : 'local';
}

/**
 * Starts mirroring Main's environment state. It subscribes before reading so a change pushed while `environment.get` is
 * in flight is never lost, and once any event has arrived the slower read is discarded: an event is always at least as
 * new as the read it raced. It also explains a connect that Main answered by focusing this SSH Host window.
 */
export function subscribeEnvironment(): () => void {
    /**
     * Mutated from the event listener and the cleanup; kept in one object so the async read sees the current values.
     */
    const subscription = { hasReceivedEvent: false, isActive: true };
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event === 'environment.connectionReused') {
            const typed = event.payload.destination;
            const current = useEnvironmentStore.getState().state;
            pushToast(
                'info',
                translate('sshHost.connect.reused', {
                    destination: current?.kind === 'ssh' ? current.destination : typed,
                    typed,
                }),
            );
            return;
        }
        if (event.event !== 'environment.changed') return;
        subscription.hasReceivedEvent = true;
        useEnvironmentStore.setState({ state: event.payload });
    });
    void (async () => {
        try {
            const state = await caxri.request('environment.get');
            if (subscription.isActive && !subscription.hasReceivedEvent)
                useEnvironmentStore.setState({ state });
        } catch {
            // Best effort: the `environment.changed` subscription above still delivers the next change.
        }
    })();
    return () => {
        subscription.isActive = false;
        unsubscribe();
    };
}

function sshEnvironment(state: EnvironmentState | undefined): SshEnvironmentState | undefined {
    return state?.kind === 'ssh' ? state : undefined;
}

/**
 * True in an SSH Host window.
 */
export function isSshHost(state = useEnvironmentStore.getState().state): boolean {
    return state?.kind === 'ssh';
}

/**
 * True only once the window is known to belong to this Mac's own Server. Every entry point that reaches a Main method
 * classified `local-only` in `main/environment-method-policy.ts` (Reveal in Finder, Trash, Process Explorer, Agent
 * Commander, native folder pickers…) checks this one predicate. Unknown counts as unavailable, so an SSH Host window
 * never offers a local action during the moment before its environment is read.
 */
export function isLocalOnlyAvailable(state = useEnvironmentStore.getState().state): boolean {
    return state?.kind === 'local';
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
 * The SSH Host state, or `undefined` in a local window. The selector returns the stored object itself, so subscribers
 * re-render only when Main pushes a new state.
 */
export function useSshEnvironment(): SshEnvironmentState | undefined {
    return useEnvironmentStore((store) => sshEnvironment(store.state));
}
