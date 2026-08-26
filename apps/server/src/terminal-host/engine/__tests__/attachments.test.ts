import { describe, expect, it, vi } from 'vitest';

import { TerminalAttachments } from '../attachments';

describe('TerminalAttachments', () => {
    it('preserves a pre-launch grid and reports repeated attachment', () => {
        const attachments = new TerminalAttachments();
        expect(attachments.attach('terminal-1', { cols: 120, rows: 40 })).toEqual({
            wasAttached: false,
        });
        expect(attachments.attach('terminal-1')).toEqual({ wasAttached: true });
        expect(attachments.size('terminal-1')).toEqual({ cols: 120, rows: 40 });
        expect(attachments.ids()).toEqual(['terminal-1']);
    });

    it('wakes a restore wait when a measured grid arrives', async () => {
        vi.useFakeTimers();
        try {
            const attachments = new TerminalAttachments();
            const completed = vi.fn();
            const waiting = attachments.waitForSize('terminal-1', 5_000);
            attachments.attach('terminal-1', { cols: 100, rows: 30 });
            await waiting;
            completed();
            expect(completed).toHaveBeenCalledOnce();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('wakes every pending restore during shutdown and forgets removed identities', async () => {
        vi.useFakeTimers();
        try {
            const attachments = new TerminalAttachments();
            const waits = [
                attachments.waitForSize('terminal-1', 5_000),
                attachments.waitForSize('terminal-2', 5_000),
            ];
            attachments.attach('terminal-1', { cols: 80, rows: 24 });
            attachments.remove('terminal-1');
            attachments.wakeAll();
            await Promise.all(waits);
            expect(attachments.has('terminal-1')).toBe(false);
            expect(attachments.size('terminal-1')).toBeUndefined();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});
