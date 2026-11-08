import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { mobileHostDisplayName } from './host-display-name';

export interface MobileComputerName {
    /**
     * The name every paired phone shows: the user's `mobile.computerName`, else the system host name's label.
     */
    displayName: () => string;
    /**
     * Re-reads `mobile.computerName`; call it once the domain service is ready and on every `settings.changed`.
     */
    refresh: () => void;
    /**
     * Renames this computer through the bounded `settings.patch` path and answers the name phones now show. An empty
     * name restores the system host name.
     */
    rename: (name: string | null) => Promise<string>;
}

/**
 * Follows `mobile.computerName` so a dashboard read stays synchronous and never re-parses the whole Settings file.
 * Reads run one at a time, so an older value never lands after a newer one; a failed read keeps the current name.
 */
export function createMobileComputerName(
    domainService: () => Pick<ServerDomainService, 'request'> | undefined,
    systemName: string,
): MobileComputerName {
    const fallback = mobileHostDisplayName(systemName);
    let customName: string | null = null;
    let tail = Promise.resolve();
    const displayName = (): string => customName ?? fallback;
    return {
        displayName,
        refresh: () => {
            const service = domainService();
            if (!service) return;
            const previous = tail;
            tail = (async (): Promise<void> => {
                await previous;
                try {
                    const settings = await service.request('settings.get');
                    customName = settings.value['mobile.computerName'];
                } catch {
                    // Settings report their own read failures; the phone keeps the last known name.
                }
            })();
        },
        rename: async (name) => {
            const service = domainService();
            if (!service) throw new CaxriError('UNAVAILABLE', 'Mobile access is unavailable');
            const trimmed = name?.trim() ?? '';
            const value = trimmed === '' ? null : trimmed;
            await service.request('settings.patch', {
                changes: [{ key: 'mobile.computerName', value }],
                dryRun: false,
            });
            customName = value;
            return displayName();
        },
    };
}
