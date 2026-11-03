import type {
    HostIcon,
    HostPreference,
    HostPreferences,
    HostSystemIconName,
    SshEnvironmentState,
} from '@caxri/protocol';
import { detectedSystemOf, LOCAL_HOST_PREFERENCE_ID } from '@caxri/protocol';

import { translate } from '../i18n';
import { caxri } from '../lib/caxri';
import { createStore } from '../lib/store';
import { environmentIdOf, findHost } from './environment';
import { tryCommand } from './toasts';

/**
 * This Mac's display preferences for every machine, mirrored from Desktop Main (Settings › Hosts).
 */
export const useHostPreferencesStore = createStore<HostPreferences>('host-preferences', () => ({
    shouldShowHostNames: false,
    hosts: {},
}));

/**
 * How one machine's Host mark looks: its display name, the chosen icon (absent is Auto), and the system logo Auto
 * shows.
 */
export interface HostDisplay {
    /**
     * The SSH destination, or `undefined` for this Mac.
     */
    destination?: string;
    icon?: HostIcon;
    name: string;
    system?: HostSystemIconName;
}

/**
 * The preference id of a machine: `local` for this Mac (`undefined`), else the SSH Host's id.
 */
function hostPreferenceId(environmentId: string | undefined): string {
    return environmentId ?? LOCAL_HOST_PREFERENCE_ID;
}

/**
 * One machine's preference, or `undefined` when the user never changed it and it never connected.
 */
export function useHostPreference(environmentId: string | undefined): HostPreference | undefined {
    return useHostPreferencesStore(
        (store): HostPreference | undefined => store.hosts[hostPreferenceId(environmentId)],
    );
}

/**
 * Resolves a machine's display from its preference and, for a connected SSH Host, the platform it reported now.
 */
export function hostDisplayOf(
    environmentId: string | undefined,
    preference: HostPreference | undefined,
): HostDisplay {
    if (environmentId === undefined)
        return {
            name: preference?.name ?? translate('sshHost.thisMac'),
            system: 'macos',
            ...(preference?.icon && { icon: preference.icon }),
        };
    const host = findHost(environmentId);
    const destination = host?.destination ?? preference?.destination ?? environmentId;
    const system =
        (host?.platform && detectedSystemOf(host.platform)) ?? preference?.detectedSystem;
    return {
        destination,
        name: preference?.name ?? destination,
        ...(preference?.icon && { icon: preference.icon }),
        ...(system && { system }),
    };
}

/**
 * Starts mirroring Main's Host preferences: subscribes first, then reads, and drops the read once an event arrived.
 */
export function subscribeHostPreferences(): () => void {
    const subscription = { hasReceivedEvent: false, isActive: true };
    const unsubscribe = caxri.onEvent((event, environmentId) => {
        if (environmentId !== undefined || event.event !== 'sshHost.preferencesChanged') return;
        subscription.hasReceivedEvent = true;
        useHostPreferencesStore.setState(event.payload, true);
    });
    void (async () => {
        try {
            const preferences = await caxri.request('sshHost.preferences.get');
            if (subscription.isActive && !subscription.hasReceivedEvent)
                useHostPreferencesStore.setState(preferences, true);
        } catch {
            // Best effort: marks fall back to the destination and generic glyph until the next change event.
        }
    })();
    return () => {
        subscription.isActive = false;
        unsubscribe();
    };
}

/**
 * The SSH Hosts Settings › Hosts lists after this Mac: every connected Host in connection order, then every Host this
 * Mac reached before and can connect again (its preference remembers a destination).
 */
export function listedHostIds(
    hosts: readonly SshEnvironmentState[],
    preferences: HostPreferences,
): string[] {
    const connected = hosts.map((host) => environmentIdOf(host));
    const connectedIds = new Set(connected);
    const remembered = Object.entries(preferences.hosts)
        .filter(
            ([id, preference]) =>
                id !== LOCAL_HOST_PREFERENCE_ID &&
                preference.destination !== undefined &&
                !connectedIds.has(id),
        )
        .map(([id]) => id);
    return [...connected, ...remembered];
}

/**
 * Changes one machine's name, icon, or Reconnect on Launch. `null` clears a name or icon back to Auto.
 */
export async function updateHostPreference(
    environmentId: string | undefined,
    change: { name?: string | null; icon?: HostIcon | null; reconnectOnLaunch?: boolean },
): Promise<void> {
    await tryCommand(translate('sshHost.preferences.failed'), () =>
        caxri.in(undefined).request('sshHost.preferences.update', {
            hostId: hostPreferenceId(environmentId),
            ...change,
        }),
    );
}

export async function setShowHostNames(shouldShowHostNames: boolean): Promise<void> {
    await tryCommand(translate('sshHost.preferences.failed'), () =>
        caxri
            .in(undefined)
            .request('sshHost.preferences.setShowHostNames', { shouldShowHostNames }),
    );
}
