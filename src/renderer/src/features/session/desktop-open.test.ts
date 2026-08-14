import { describe, expect, it, vi } from 'vitest';

import { createDesktopOpenQueue } from './desktop-open';

describe('Host Desktop open queue', () => {
    it('serializes concurrent targets without losing their Session identity', async () => {
        let releaseFirstSelection!: () => void;
        const firstSelection = new Promise<void>((resolve) => {
            releaseFirstSelection = resolve;
        });
        const selected = vi.fn(async (sessionId: string) => {
            if (sessionId === 'session-first') await firstSelection;
            return true;
        });
        const opened = vi.fn(() => Promise.resolve());
        const queue = createDesktopOpenQueue({ openFile: opened, selectSession: selected });

        const first = queue.enqueue({ path: '/project/first.ts', sessionId: 'session-first' });
        const second = queue.enqueue({ path: '/project/second.ts', sessionId: 'session-second' });
        await Promise.resolve();

        expect(selected).toHaveBeenCalledWith('session-first');
        expect(opened).not.toHaveBeenCalled();
        expect(selected).not.toHaveBeenCalledWith('session-second');

        releaseFirstSelection();
        await Promise.all([first, second]);

        expect(selected.mock.calls).toEqual([['session-first'], ['session-second']]);
        expect(opened.mock.calls).toEqual([
            ['session-first', '/project/first.ts'],
            ['session-second', '/project/second.ts'],
        ]);
    });

    it('continues with later targets when an earlier Renderer action fails', async () => {
        const selected = vi.fn(() => Promise.resolve(true));
        const opened = vi
            .fn()
            .mockRejectedValueOnce(new Error('first target failed'))
            .mockResolvedValueOnce(undefined);
        const queue = createDesktopOpenQueue({ openFile: opened, selectSession: selected });

        await expect(
            queue.enqueue({ path: '/project/first.ts', sessionId: 'session-first' }),
        ).rejects.toThrow('first target failed');
        await expect(
            queue.enqueue({ path: '/project/second.ts', sessionId: 'session-second' }),
        ).resolves.toBeUndefined();

        expect(opened).toHaveBeenLastCalledWith('session-second', '/project/second.ts');
    });
});
