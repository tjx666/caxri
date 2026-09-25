import type * as pty from 'node-pty';
import { describe, expect, it, vi } from 'vitest';

import { stopTerminalAfterInputQuiescence } from '../agent-input';
import type { LiveTerminal } from '../types';

describe('PTY input quiescence', () => {
    it('waits for the in-flight write callback before closing the master descriptor', async () => {
        const ready = Promise.withResolvers<void>();
        const kill = vi.fn();
        const destroy = vi.fn();
        const live = {
            process: { quiesceInput: () => ready.promise, kill, destroy } as unknown as pty.IPty,
        } as LiveTerminal;

        stopTerminalAfterInputQuiescence(live, true);
        expect(kill).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();

        ready.resolve();
        await ready.promise;
        await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
        expect(kill).toHaveBeenCalledOnce();
        expect(kill.mock.invocationCallOrder[0]).toBeLessThan(destroy.mock.invocationCallOrder[0]);
    });
});
