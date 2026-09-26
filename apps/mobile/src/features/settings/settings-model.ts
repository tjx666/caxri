import type { MobileDeviceRole } from '@caxri/protocol';

import type { MobileConnectionStatus } from '../connection/connection-state';

export const DEVICE_ROLE_DETAILS: Record<MobileDeviceRole, { label: string; description: string }> =
    {
        view: {
            label: 'View',
            description: 'Read Sessions, Terminal previews, changes, and files.',
        },
        reply: {
            label: 'Reply',
            description: 'View, plus reply to Agents and mark Sessions read.',
        },
        control: {
            label: 'Control',
            description:
                'Reply, plus start, rename, and archive Sessions, take over Terminals, and add Projects.',
        },
    };

export const connectionStatusLabel = (status: MobileConnectionStatus): string => {
    switch (status) {
        case 'connected':
            return 'Connected';
        case 'booting':
        case 'connecting':
            return 'Connecting…';
        case 'stale':
            return 'Reconnecting…';
        case 'unverified':
            return 'Pairing not verified';
        case 'revoked':
            return 'Access revoked';
        case 'version-mismatch':
            return 'Update required';
        case 'unpaired':
            return 'Not paired';
    }
};
