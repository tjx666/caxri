import type { MobileAccessStatus } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createMobileAccessPersistence } from '../access-persistence';

const status = (isEnabled: boolean) => ({ enabled: isEnabled }) as unknown as MobileAccessStatus;

const fakeGateway = () => ({
    enable: vi.fn(() => Promise.resolve(status(true))),
    disable: vi.fn(() => Promise.resolve(status(false))),
});

describe('createMobileAccessPersistence', () => {
    it('saves the owner switch after applying it', async () => {
        const registry = {
            isAccessEnabled: () => false,
            rememberAccessEnabled: vi.fn(async () => {}),
        };
        const persistence = createMobileAccessPersistence(registry, undefined);
        const gateway = fakeGateway();

        await expect(persistence.apply(gateway, true)).resolves.toEqual(status(true));
        await expect(persistence.apply(gateway, false)).resolves.toEqual(status(false));

        expect(registry.rememberAccessEnabled.mock.calls).toEqual([[true], [false]]);
    });

    it('keeps the applied switch and logs when the save fails', async () => {
        const logger = { write: vi.fn() };
        const persistence = createMobileAccessPersistence(
            {
                isAccessEnabled: () => false,
                rememberAccessEnabled: vi.fn(() => Promise.reject(new Error('disk full'))),
            },
            logger,
        );

        await expect(persistence.apply(fakeGateway(), true)).resolves.toEqual(status(true));
        expect(logger.write).toHaveBeenCalledWith('warn', 'mobile_gateway.access_persistence', {
            fields: { outcome: 'write-failed' },
        });
    });

    it('reopens only a saved switch and logs a failed bind', async () => {
        const logger = { write: vi.fn() };
        const off = fakeGateway();
        await createMobileAccessPersistence(
            { isAccessEnabled: () => false, rememberAccessEnabled: vi.fn() },
            logger,
        ).restore(off);
        expect(off.enable).not.toHaveBeenCalled();

        const on = createMobileAccessPersistence(
            { isAccessEnabled: () => true, rememberAccessEnabled: vi.fn() },
            logger,
        );
        const gateway = fakeGateway();
        await on.restore(gateway);
        expect(gateway.enable).toHaveBeenCalledOnce();
        gateway.enable.mockRejectedValueOnce(new Error('EADDRINUSE'));
        await on.restore(gateway);
        expect(logger.write).toHaveBeenNthCalledWith(
            1,
            'info',
            'mobile_gateway.access_persistence',
            {
                fields: { outcome: 'restored' },
            },
        );
        expect(logger.write).toHaveBeenNthCalledWith(
            2,
            'warn',
            'mobile_gateway.access_persistence',
            {
                fields: { outcome: 'restore-failed' },
            },
        );
    });
});
