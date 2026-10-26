import type { UpdateState } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { UpdateService } from '../updates/updates';

describe('Acceptance update discovery', () => {
    function acceptanceService(version = '999.0.0') {
        const states: UpdateState[] = [];
        const fetch = vi.fn<(input: string) => Promise<Response>>();
        const openPath = vi.fn(() => Promise.resolve(''));
        const discover = vi.fn(() =>
            Promise.resolve({ fileName: `Caxri-${version}-arm64.dmg`, version }),
        );
        const service = new UpdateService({
            acceptanceDiscovery: { discover },
            currentVersion: '0.0.76',
            downloadDirectory: '/unused',
            enabled: false,
            fetch,
            onState: (state) => states.push(state),
            openPath,
        });
        return { discover, fetch, openPath, service, states };
    }

    it('announces the fixed release through the normal state stream without any network request', async () => {
        const { discover, fetch, service, states } = acceptanceService();

        service.startAutomaticCheck({ isE2E: true });
        service.startAutomaticCheck({ isE2E: true });
        await vi.waitFor(() => expect(service.getState().status).toBe('available'));
        // A manual check after the launch check re-reads the served state rather than consuming the fixture again.
        await expect(service.check({ manual: true })).resolves.toMatchObject({
            status: 'available',
            version: '999.0.0',
        });

        expect(discover).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
        expect(states).toEqual([
            { status: 'checking', currentVersion: '0.0.76' },
            {
                status: 'available',
                currentVersion: '0.0.76',
                version: '999.0.0',
                fileName: 'Caxri-999.0.0-arm64.dmg',
                announced: false,
            },
        ]);
    });

    it('keeps download and install disabled for the fixture release', async () => {
        const { fetch, openPath, service } = acceptanceService();
        await service.check({ manual: true });

        await expect(service.download()).resolves.toMatchObject({
            status: 'error',
            action: 'download',
            message: 'Update downloads are disabled in Acceptance launches.',
            version: '999.0.0',
        });
        await expect(service.open()).resolves.toMatchObject({
            status: 'error',
            action: 'download',
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(openPath).not.toHaveBeenCalled();
    });

    it('restores the served release when a check follows the disabled download', async () => {
        const { discover, service } = acceptanceService();
        await service.check({ manual: true });
        await service.download();

        await expect(service.check({ manual: true })).resolves.toMatchObject({
            status: 'available',
            version: '999.0.0',
            fileName: 'Caxri-999.0.0-arm64.dmg',
        });
        expect(discover).toHaveBeenCalledOnce();
    });

    it('surfaces a rejected fixture request as a check error instead of the packaged-only notice', async () => {
        const service = new UpdateService({
            acceptanceDiscovery: {
                discover: () =>
                    Promise.reject(
                        new Error(
                            'The Acceptance update fixture request was rejected (unknown-fixture).',
                        ),
                    ),
            },
            currentVersion: '0.0.76',
            downloadDirectory: '/unused',
            enabled: false,
            openPath: () => Promise.resolve(''),
        });
        await expect(service.check()).resolves.toMatchObject({
            status: 'error',
            action: 'check',
            message: 'The Acceptance update fixture request was rejected (unknown-fixture).',
        });
    });

    it('rejects a fixture release that is not newer than the running build', async () => {
        const { service } = acceptanceService('0.0.76');
        await expect(service.check()).resolves.toMatchObject({
            status: 'error',
            action: 'check',
            message: 'The Acceptance update fixture must be newer than this build.',
        });
    });

    it('never starts an automatic check for an unpackaged build without the fixture', () => {
        const fetch = vi.fn<(input: string) => Promise<Response>>();
        const service = new UpdateService({
            currentVersion: '0.0.76',
            downloadDirectory: '/unused',
            enabled: false,
            fetch,
            openPath: () => Promise.resolve(''),
        });
        service.startAutomaticCheck({ isE2E: false });
        expect(service.getState().status).toBe('idle');
        expect(fetch).not.toHaveBeenCalled();
    });
});
