import { describe, expect, it, vi } from 'vitest';

import { TerminalSurfaceSwitchRegistry } from '../terminal-surface-switch-pending';

describe('TerminalSurfaceSwitchRegistry', () => {
    it('marks a Terminal pending until its switch settles, and notifies on both edges', async () => {
        const switches = new TerminalSurfaceSwitchRegistry();
        const listener = vi.fn();
        switches.subscribe(listener);
        const task = Promise.withResolvers<void>();
        const run = switches.run('terminal-1', 'pty', () => task.promise);
        expect(switches.pendingSurface('terminal-1')).toBe('pty');
        expect(listener).toHaveBeenCalledTimes(1);
        task.resolve();
        await run;
        expect(switches.pendingSurface('terminal-1')).toBeUndefined();
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('refuses re-entry for the same Terminal but not for another one', () => {
        const switches = new TerminalSurfaceSwitchRegistry();
        const pending = () => new Promise<void>(() => {});
        expect(switches.run('terminal-1', 'chat', pending)).toBeDefined();
        const task = vi.fn(pending);
        expect(switches.run('terminal-1', 'pty', task)).toBeUndefined();
        expect(task).not.toHaveBeenCalled();
        expect(switches.run('terminal-2', 'chat', pending)).toBeDefined();
    });

    it('clears the pending mark when the switch fails', async () => {
        const switches = new TerminalSurfaceSwitchRegistry();
        await expect(
            switches.run('terminal-1', 'chat', () => Promise.reject(new Error('restart failed'))),
        ).rejects.toThrow('restart failed');
        expect(switches.pendingSurface('terminal-1')).toBeUndefined();
    });
});
