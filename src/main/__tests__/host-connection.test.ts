import { describe, expect, it, vi } from 'vitest';

import { DesktopHostConnection } from '../host-connection';

describe('Desktop Host connection facade', () => {
    it('returns a classified rejected Promise before Host attachment instead of throwing', async () => {
        const connection = new DesktopHostConnection({
            currentDirectory: '/app/out/main',
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
});
