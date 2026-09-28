import type { MobileAccessStatus } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { MobileDeviceRegistry } from './device-registry';

type AccessPersistenceOutcome = 'restored' | 'restore-failed' | 'write-failed';

interface MobileAccessSwitch {
    disable: () => Promise<MobileAccessStatus>;
    enable: () => Promise<MobileAccessStatus>;
}

/**
 * Remembers the owner's mobile-access switch across Server starts, so a Desktop relaunch reopens the gateway without
 * another click in Settings.
 */
export const createMobileAccessPersistence = (
    registry: Pick<MobileDeviceRegistry, 'isAccessEnabled' | 'rememberAccessEnabled'>,
    logger: Pick<StructuredLogger, 'write'> | undefined,
) => {
    const log = (outcome: AccessPersistenceOutcome): void => {
        logger?.write(
            outcome === 'restored' ? 'info' : 'warn',
            logEventCatalog.mobileGateway.accessPersistence,
            { fields: { outcome } },
        );
    };
    return {
        /**
         * Applies the owner's switch, then saves it. The switch already took effect when the save runs, so a failed
         * write only costs the next start its automatic reopen and is logged instead of failing the request.
         */
        async apply(gateway: MobileAccessSwitch, isEnabled: boolean): Promise<MobileAccessStatus> {
            const status = await (isEnabled ? gateway.enable() : gateway.disable());
            try {
                await registry.rememberAccessEnabled(isEnabled);
            } catch {
                log('write-failed');
            }
            return status;
        },
        /**
         * Reopens the gateway when the saved switch is on. A failed bind (for example, the port is taken) leaves access
         * off, which is what the Settings switch then shows.
         */
        async restore(gateway: MobileAccessSwitch | undefined): Promise<void> {
            if (!gateway || !registry.isAccessEnabled()) return;
            try {
                await gateway.enable();
                log('restored');
            } catch {
                log('restore-failed');
            }
        },
    };
};
