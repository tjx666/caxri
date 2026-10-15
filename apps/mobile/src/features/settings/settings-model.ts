import type { MobileDeviceRole } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { MobileConnectionStatus } from '../connection/connection-state';

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
