import { describe, expect, it, vi } from 'vitest';

import { createDesktopOpenQueue } from '../desktop-open';

describe('Server Desktop open queue', () => {
    it('serializes concurrent targets without losing their Session identity', async () => {
        const { promise: firstSelection, resolve: releaseFirstSelection } =
            Promise.withResolvers<void>();
        const selected = vi.fn(async (sessionId: string) => {
            if (sessionId === 'session-first') await firstSelection;
            return true;
        });
        const opened = vi.fn(() => Promise.resolve());
        const queue = createDesktopOpenQueue({
            openFile: opened,
            revealDirectory: vi.fn(),
            selectSession: selected,
        });

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
            ['session-first', '/project/first.ts', {}],
            ['session-second', '/project/second.ts', {}],
        ]);
    });

    it('continues with later targets when an earlier Renderer action fails', async () => {
        const selected = vi.fn(() => Promise.resolve(true));
        const opened = vi
            .fn()
            .mockRejectedValueOnce(new Error('first target failed'))
            .mockResolvedValueOnce(undefined);
        const queue = createDesktopOpenQueue({
            openFile: opened,
            revealDirectory: vi.fn(),
            selectSession: selected,
        });

        await expect(
            queue.enqueue({ path: '/project/first.ts', sessionId: 'session-first' }),
        ).rejects.toThrow('first target failed');
        await expect(
            queue.enqueue({ path: '/project/second.ts', sessionId: 'session-second' }),
        ).resolves.toBeUndefined();

        expect(opened).toHaveBeenLastCalledWith('session-second', '/project/second.ts', {});
    });

    it('preserves the requested editor location and focus intent through serialized Desktop opens', async () => {
        const selected = vi.fn(() => Promise.resolve(true));
        const opened = vi.fn(() => Promise.resolve());
        const queue = createDesktopOpenQueue({
            openFile: opened,
            revealDirectory: vi.fn(),
            selectSession: selected,
        });

        await queue.enqueue({
            focusEditor: true,
            location: { mode: 'line', startLine: 12, endLine: 14 },
            path: '/project/file.ts',
            sessionId: 'session-1',
        });

        expect(opened).toHaveBeenCalledWith('session-1', '/project/file.ts', {
            focusEditor: true,
            location: { mode: 'line', startLine: 12, endLine: 14 },
        });
    });

    it('reveals a directory target in Files after selecting its Session instead of opening it as a file', async () => {
        const order: string[] = [];
        const queue = createDesktopOpenQueue({
            openFile: vi.fn(() => Promise.resolve()),
            revealDirectory: (sessionId, path) => order.push(`reveal:${sessionId}:${path}`),
            selectSession: (sessionId) => {
                order.push(`select:${sessionId}`);
                return Promise.resolve(true);
            },
        });

        await queue.enqueue({
            kind: 'directory',
            path: '/project/.config',
            sessionId: 'session-a',
        });

        expect(order).toEqual(['select:session-a', 'reveal:session-a:/project/.config']);
    });
});
