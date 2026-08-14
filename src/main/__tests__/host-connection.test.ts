import { describe, expect, it, vi } from 'vitest';

import { DesktopHostConnection } from '../host-connection';

describe('Desktop Host connection facade', () => {
    it('returns a classified rejected Promise before Host attachment instead of throwing', async () => {
        const connection = new DesktopHostConnection({
            currentDirectory: '/app/out/main',
            cliPath: '/app/cli/caxri.cjs',
            desktopId: 'desktop-1',
            desktopLaunch: { executable: '/app/Caxri', args: [], cwd: '/app' },
            handleCommand: () => Promise.resolve(null),
            logger: { write: vi.fn() } as never,
            userDataPath: '/profile',
        });
        let request: Promise<unknown> | undefined;

        expect(() => {
            request = connection.request('app.health');
        }).not.toThrow();
        await expect(request).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('shares a pending attachment and retries after that attachment rejects', async () => {
        const connection = new DesktopHostConnection({
            currentDirectory: '/app/out/main',
            cliPath: '/app/cli/caxri.cjs',
            desktopId: 'desktop-1',
            desktopLaunch: { executable: '/app/Caxri', args: [], cwd: '/app' },
            handleCommand: () => Promise.resolve(null),
            logger: { write: vi.fn() } as never,
            userDataPath: '/profile',
        });
        const connect = vi
            .spyOn(connection as unknown as { connect(): Promise<void> }, 'connect')
            .mockRejectedValueOnce(new Error('first attachment failed'))
            .mockResolvedValueOnce();

        const first = connection.start();
        expect(connection.start()).toBe(first);
        await expect(first).rejects.toThrow('first attachment failed');

        const retry = connection.start();
        expect(connection.start()).toBe(retry);
        await expect(retry).resolves.toBeUndefined();
        expect(connect).toHaveBeenCalledTimes(2);
    });
});
