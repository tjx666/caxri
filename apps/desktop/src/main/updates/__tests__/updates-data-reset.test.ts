import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    releaseFetch,
    removeTemporaryDirectories,
    temporaryDirectory,
} from '../../__tests__/support/update-service-harness';
import { UpdateService } from '../updates';

afterEach(removeTemporaryDirectories);

describe('UpdateService data-resetting updates', () => {
    it('installs a data-resetting update only after the user confirms that version', async () => {
        const directory = await temporaryDirectory();
        const launchInstall = vi.fn(() => Promise.resolve());
        const confirmDataReset = vi.fn(() => Promise.resolve(false));
        /**
         * Unset, the quit is cancelled; set, it runs the quit flow's `applyOnExit` like a confirmed restart.
         */
        const quit: { finish?: () => Promise<unknown> } = {};
        const restartToUpdate = vi.fn(async () => {
            await quit.finish?.();
        });
        const service = new UpdateService({
            confirmDataReset,
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch: releaseFetch('0.0.4', new TextEncoder().encode('dmg')),
            launchInstall,
            openPath: vi.fn(() => Promise.resolve('')),
            prepareInstall: vi.fn(() =>
                Promise.resolve({ installMode: 'restart' as const, resetsData: true as const }),
            ),
            restartToUpdate,
        });

        await service.check();
        await expect(service.download()).resolves.toMatchObject({
            status: 'ready',
            installMode: 'restart',
            resetsData: true,
        });
        // An ordinary quit never installs it silently.
        await expect(service.applyOnExit({ relaunch: false })).resolves.toBe(false);

        // Declining the prompt keeps the update staged without starting the restart.
        await expect(service.install()).resolves.toMatchObject({ status: 'ready' });
        expect(confirmDataReset).toHaveBeenCalledWith('0.0.4');
        expect(restartToUpdate).not.toHaveBeenCalled();

        // Confirming and then cancelling the quit withdraws the consent again.
        confirmDataReset.mockResolvedValue(true);
        await service.install();
        expect(restartToUpdate).toHaveBeenCalledOnce();
        await expect(service.applyOnExit({ relaunch: false })).resolves.toBe(false);
        expect(launchInstall).not.toHaveBeenCalled();

        quit.finish = () => service.applyOnExit({ relaunch: true });
        await service.install();
        expect(launchInstall).toHaveBeenCalledWith({ relaunch: true, version: '0.0.4' });
    });
});
