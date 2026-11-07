import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    releaseFetch,
    removeTemporaryDirectories,
    temporaryDirectory,
} from '../../__tests__/support/update-service-harness';
import { UpdateService } from '../updates';

afterEach(removeTemporaryDirectories);

const dmg = new TextEncoder().encode('dmg');

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A service already holding a staged 0.0.4 whose feed can then be repointed at another release, like a release
 * published after the app staged its update.
 */
async function stagedService(options: { failNewerStage?: boolean } = {}) {
    const directory = await temporaryDirectory();
    let fetchImpl: FetchImpl = releaseFetch('0.0.4', dmg);
    const states: string[] = [];
    const prepareInstall = vi.fn(({ version }: { dmgPath: string; version: string }) =>
        Promise.resolve(
            version === '0.0.5' && options.failNewerStage
                ? { installMode: 'manual' as const }
                : { installMode: 'restart' as const },
        ),
    );
    const launchInstall = vi.fn(() => Promise.resolve());
    const service = new UpdateService({
        currentVersion: '0.0.3',
        downloadDirectory: directory,
        enabled: true,
        fetch: (input, init) => fetchImpl(input, init),
        launchInstall,
        onState: (state) =>
            states.push(`${state.status}:${'version' in state ? state.version : ''}`),
        openPath: vi.fn(() => Promise.resolve('')),
        prepareInstall,
        restartToUpdate: vi.fn(() => Promise.resolve()),
    });
    await service.check();
    await service.download();
    states.length = 0;
    return {
        directory,
        launchInstall,
        prepareInstall,
        service,
        states,
        point(next: FetchImpl) {
            fetchImpl = next;
        },
    };
}

describe('a newer release while an update is ready', () => {
    it('stages it silently and swaps the ready state to it', async () => {
        const harness = await stagedService();
        harness.point(releaseFetch('0.0.5', dmg));

        await harness.service.check({ background: true });

        expect(harness.states).toEqual(['ready:0.0.5']);
        expect(harness.service.getState()).toMatchObject({
            status: 'ready',
            version: '0.0.5',
            installMode: 'restart',
            announced: false,
        });
        await harness.service.applyOnExit({ relaunch: false });
        expect(harness.launchInstall).toHaveBeenCalledWith({ relaunch: false, version: '0.0.5' });
    });

    it('keeps the staged update installable while the newer one downloads', async () => {
        const harness = await stagedService();
        const base = releaseFetch('0.0.5', dmg);
        const { promise: gate, resolve: release } = Promise.withResolvers<void>();
        const dmgRequested = vi.fn();
        harness.point(async (input) => {
            if (input.endsWith('.dmg')) {
                dmgRequested();
                await gate;
            }
            return base(input);
        });

        const check = harness.service.check({ background: true });
        await vi.waitFor(() => expect(dmgRequested).toHaveBeenCalled());
        expect(harness.service.getState()).toMatchObject({ status: 'ready', version: '0.0.4' });
        await harness.service.applyOnExit({ relaunch: false });
        expect(harness.launchInstall).toHaveBeenCalledWith({ relaunch: false, version: '0.0.4' });
        release();
        await check;
        expect(harness.states).toEqual(['ready:0.0.5']);
    });

    it('leaves the ready state untouched when the newer download fails', async () => {
        const harness = await stagedService();
        harness.point(releaseFetch('0.0.5', dmg, 'f'.repeat(64)));

        await harness.service.check({ background: true });

        expect(harness.states).toEqual([]);
        expect(harness.service.getState()).toMatchObject({ status: 'ready', version: '0.0.4' });
        await expect(access(join(harness.directory, 'Caxri-0.0.4-arm64.dmg'))).resolves.toBe(
            undefined,
        );
    });

    it('does not download a newer release again after it failed once', async () => {
        const harness = await stagedService();
        const base = releaseFetch('0.0.5', dmg, 'f'.repeat(64));
        const dmgRequested = vi.fn();
        harness.point((input) => {
            if (input.endsWith('.dmg')) dmgRequested();
            return base(input);
        });

        await harness.service.check({ background: true });
        await harness.service.check({ background: true });

        // The installer is hundreds of megabytes; a release that failed verification is not fetched every tick.
        expect(dmgRequested).toHaveBeenCalledTimes(1);
        expect(harness.service.getState()).toMatchObject({ status: 'ready', version: '0.0.4' });
    });

    it('restages the old bundle when the newer one cannot be staged', async () => {
        const harness = await stagedService({ failNewerStage: true });
        harness.point(releaseFetch('0.0.5', dmg));

        await harness.service.check({ background: true });

        expect(harness.states).toEqual([]);
        expect(harness.service.getState()).toMatchObject({ status: 'ready', version: '0.0.4' });
        expect(harness.prepareInstall).toHaveBeenLastCalledWith({
            dmgPath: join(harness.directory, 'Caxri-0.0.4-arm64.dmg'),
            version: '0.0.4',
        });
    });

    it('ignores a feed that offers the staged version again or is rate limited', async () => {
        const harness = await stagedService();
        await harness.service.check({ background: true });
        harness.point(() => Promise.resolve(new Response(null, { status: 429 })));
        await harness.service.check({ background: true });

        expect(harness.states).toEqual([]);
        expect(harness.service.getState()).toMatchObject({ status: 'ready', version: '0.0.4' });
    });
});
