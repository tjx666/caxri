import type { MobileDeviceRole } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { MobileConnectionStatus } from '../connection/connection-state';
import type { MobileGatewayRouteKind } from '../connection/gateway-routes';
import type { MobileRelayFailureKind } from '../connection/relay-failure';
import type { MobileRoutePreference } from '../connection/route-preference';

/**
 * The role's name and the capability it adds over the role below it.
 */
export const deviceRoleDetails = (
    role: MobileDeviceRole,
    t: Translate = translate,
): { label: string; description: string } => {
    switch (role) {
        case 'view':
            return {
                label: t('settings.role.view'),
                description: t('settings.role.viewDescription'),
            };
        case 'reply':
            return {
                label: t('settings.role.reply'),
                description: t('settings.role.replyDescription'),
            };
        case 'control':
            return {
                label: t('settings.role.control'),
                description: t('settings.role.controlDescription'),
            };
    }
};

/**
 * The Connection method row and sheet: each choice's name and what it does.
 */
export const routePreferenceDetails = (
    preference: MobileRoutePreference,
    t: Translate = translate,
): { label: string; description: string } => {
    switch (preference) {
        case 'auto':
            return { label: t('settings.route.auto'), description: t('settings.route.autoDetail') };
        case 'direct':
            return {
                label: t('settings.route.direct'),
                description: t('settings.route.directDetail'),
            };
        case 'relay':
            return {
                label: t('settings.route.relay'),
                description: t('settings.route.relayDetail'),
            };
    }
};

export const connectionStatusLabel = (
    status: MobileConnectionStatus,
    t: Translate = translate,
): string => {
    switch (status) {
        case 'connected':
            return t('settings.status.connected');
        case 'booting':
        case 'connecting':
            return t('settings.status.connecting');
        case 'stale':
            return t('settings.status.reconnecting');
        case 'unverified':
            return t('settings.status.unverified');
        case 'revoked':
            return t('settings.status.revoked');
        case 'version-mismatch':
            return t('settings.status.updateRequired');
        case 'storage-error':
            return t('settings.status.storageError');
        case 'unpaired':
            return t('settings.status.notPaired');
    }
};

/**
 * The Settings Status row: the connection state, plus the route a live connection took ("Connected · via Relay") or the
 * Relay's refusal while it is down, in the same sentences the Sessions connection banner uses.
 */
export const connectionStatusView = (
    status: MobileConnectionStatus,
    route: MobileGatewayRouteKind | null,
    relayFailure: MobileRelayFailureKind | null,
    t: Translate = translate,
): { detail: string | undefined; value: string } => {
    const label = connectionStatusLabel(status, t);
    if (status === 'connected') {
        return {
            detail: undefined,
            value:
                route === null
                    ? label
                    : `${label} · ${t(route === 'relay' ? 'settings.status.viaRelay' : 'settings.status.direct')}`,
        };
    }
    switch (relayFailure) {
        case 'host-offline':
            return { detail: t('sessions.banner.hostOffline'), value: label };
        case 'unauthorized':
            return { detail: t('sessions.banner.relayUnauthorized'), value: label };
        case 'busy':
            return { detail: t('sessions.banner.relayBusy'), value: label };
        case null:
            return { detail: undefined, value: label };
    }
};

/**
 * Longest computer name the Server accepts (`mobile.computerName`); the field stops typing here.
 */
export const COMPUTER_NAME_MAX_LENGTH = 100;

/**
 * What saving the rename field would send: the trimmed name, `null` for an empty field (back to the system host name),
 * or `undefined` when the field still shows the current name and Save has nothing to do.
 */
export const computerRenameDraft = (
    draft: string,
    currentName: string,
): { name: string | null } | undefined => {
    const name = draft.trim();
    if (name === currentName) return undefined;
    return { name: name === '' ? null : name.slice(0, COMPUTER_NAME_MAX_LENGTH) };
};
