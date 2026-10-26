import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpdateService } from '../updates/updates';
import {
    releaseFetch,
    removeTemporaryDirectories,
    temporaryDirectory,
} from './support/update-service-harness';

afterEach(removeTemporaryDirectories);

describe('UpdateService announcement bookkeeping', () => {
    it('marks a fresh release unannounced, and every later read of it announced', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        const onState = vi.fn();
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch: releaseFetch('0.0.4', dmg),
            openPath: () => Promise.resolve(''),
            onState,
        });

        const discovered = await service.check();
        expect(discovered).toMatchObject({ status: 'available', announced: false });
        expect(onState).toHaveBeenCalledWith(expect.objectContaining({ announced: false }));

        await expect(service.acknowledge()).resolves.toMatchObject({ announced: true });
        // A window reload re-reads the same state and must not find a fresh discovery.
        expect(service.getState()).toMatchObject({ status: 'available', announced: true });
    });

    it('does not turn a cancelled download back into a fresh prompt', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        const baseFetch = releaseFetch('0.0.4', dmg);
        const fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
            if (!input.endsWith('.dmg')) return baseFetch(input);
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('Canceled', 'AbortError')),
                    { once: true },
                );
            });
        });
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        await service.acknowledge();
        const download = service.download();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
        await expect(service.cancel()).resolves.toMatchObject({
            status: 'available',
            announced: true,
        });
        await download;
    });

    it('announces a newer release again after the previous one was acknowledged', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        let version = '0.0.4';
        const fetch = vi.fn((input: string): Promise<Response> =>
            releaseFetch(version, dmg)(input),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        await service.acknowledge();
        version = '0.0.5';
        await expect(service.check()).resolves.toMatchObject({
            status: 'available',
            version: '0.0.5',
            announced: false,
        });
    });

    it('leaves a non-available status untouched', async () => {
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: await temporaryDirectory(),
            enabled: false,
            fetch: vi.fn(),
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        await expect(service.acknowledge()).resolves.toMatchObject({ status: 'unavailable' });
    });
});
