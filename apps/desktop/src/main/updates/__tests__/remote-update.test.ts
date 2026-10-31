import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    releaseFetch,
    removeTemporaryDirectories,
    temporaryDirectory,
} from '../../__tests__/support/update-service-harness';
import { createRemoteUpdateControl, remoteInstallBlock } from '../remote-update';
import type { PreparedInstall } from '../update-service-contract';
import { UpdateService } from '../updates';

afterEach(removeTemporaryDirectories);

async function stagedService(prepared: PreparedInstall) {
    const restartToUpdate = vi.fn(() => Promise.resolve());
    const service = new UpdateService({
        currentVersion: '0.0.3',
        downloadDirectory: await temporaryDirectory(),
        enabled: true,
        fetch: releaseFetch('0.0.4', new TextEncoder().encode('dmg')),
        launchInstall: vi.fn(() => Promise.resolve()),
        openPath: vi.fn(() => Promise.resolve('')),
        prepareInstall: vi.fn(() => Promise.resolve(prepared)),
        restartToUpdate,
    });
    await service.check();
    await service.download();
    return { restartToUpdate, service };
}

function control(
    service: UpdateService,
    unsaved = 0,
): {
    handle: ReturnType<typeof createRemoteUpdateControl>;
    log: ReturnType<typeof vi.fn>;
    run: () => void;
} {
    const log = vi.fn();
    let scheduled: (() => void) | undefined;
    const handle = createRemoteUpdateControl({
        logger: () => ({ write: log }),
        unsavedEditors: { countForRemoteUpdate: () => Promise.resolve(unsaved) },
        schedule: (run) => {
            scheduled = run;
        },
        service: () => service,
    });
    return { handle, log, run: () => scheduled?.() };
}

describe('UpdateService remote installs', () => {
    it('restarts into the staged version the phone confirmed, after answering', async () => {
        const { restartToUpdate, service } = await stagedService({ installMode: 'restart' });
        const { handle, log, run } = control(service);

        await expect(
            handle({ kind: 'update', action: 'install', version: '0.0.4' }),
        ).resolves.toEqual({ outcome: 'restarting', version: '0.0.4' });
        // The restart waits until the reply has left, so its quit flow cannot queue behind this command.
        expect(restartToUpdate).not.toHaveBeenCalled();
        run();
        await vi.waitFor(() => expect(restartToUpdate).toHaveBeenCalledWith({ remote: true }));
        expect(log).toHaveBeenCalledWith('info', 'updates.remote_install', {
            fields: { outcome: 'restarting' },
        });
    });

    it.each([
        ['resets-data', { installMode: 'restart', resetsData: true }],
        ['manual-install', { installMode: 'manual' }],
    ] as const)('refuses a %s update', async (reason, prepared) => {
        const { restartToUpdate, service } = await stagedService(prepared);
        const { handle, run } = control(service);

        await expect(
            handle({ kind: 'update', action: 'install', version: '0.0.4' }),
        ).resolves.toEqual({ outcome: 'blocked', reason });
        run();
        expect(restartToUpdate).not.toHaveBeenCalled();
    });

    it('refuses a version other than the staged one', async () => {
        const { service } = await stagedService({ installMode: 'restart' });

        expect(remoteInstallBlock(service, '0.0.5')).toBe('version-changed');
    });

    it('refuses before anything is staged', async () => {
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: await temporaryDirectory(),
            enabled: true,
            openPath: vi.fn(() => Promise.resolve('')),
        });

        expect(remoteInstallBlock(service, '0.0.4')).toBe('not-ready');
    });

    it('names how many unsaved Editor buffers keep the computer from restarting', async () => {
        const { restartToUpdate, service } = await stagedService({ installMode: 'restart' });
        const { handle, log, run } = control(service, 2);

        await expect(
            handle({ kind: 'update', action: 'install', version: '0.0.4' }),
        ).resolves.toEqual({
            outcome: 'blocked',
            reason: 'unsaved-editors',
            unsavedEditorCount: 2,
        });
        run();
        expect(restartToUpdate).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('warn', 'updates.remote_install', {
            fields: { outcome: 'blocked', reason: 'unsaved-editors' },
        });
    });

    it('answers a check at once with the state it started', async () => {
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: await temporaryDirectory(),
            enabled: true,
            fetch: releaseFetch('0.0.4', new TextEncoder().encode('dmg')),
            openPath: vi.fn(() => Promise.resolve('')),
        });
        const { handle } = control(service);

        await expect(handle({ kind: 'update', action: 'check' })).resolves.toMatchObject({
            status: 'checking',
        });
    });
});
