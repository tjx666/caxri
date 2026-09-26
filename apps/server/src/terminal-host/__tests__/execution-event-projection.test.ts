import { describe, expect, it, vi } from 'vitest';

import { projectTerminalExecutionEvent } from '../execution-event-projection';
import { terminalHostMessageSchema } from '../protocol';

describe('Terminal Host execution event projection', () => {
    const identity = {
        scope: 'terminal' as const,
        sessionId: 'session',
        terminalId: 'terminal',
        ptyGeneration: 2,
        attachmentId: 'desktop-attachment',
    };

    it('preserves the PTY generation and publishes content-free size ownership', () => {
        const send = vi.fn();
        projectTerminalExecutionEvent(
            {
                type: 'sizeOwnership',
                terminalId: 'terminal',
                owner: 'mobile',
                cols: 42,
                rows: 20,
            },
            identity,
            send,
        );

        expect(send).toHaveBeenCalledOnce();
        expect(send).toHaveBeenCalledWith({
            type: 'event',
            event: 'terminal.sizeOwnership',
            identity,
            owner: 'mobile',
            cols: 42,
            rows: 20,
        });
        expect(terminalHostMessageSchema.safeParse(send.mock.calls[0]?.[0]).success).toBe(true);
    });

    it('still gates Desktop output on an attachment', () => {
        const send = vi.fn();
        projectTerminalExecutionEvent(
            { type: 'output', terminalId: 'terminal', data: 'synthetic' },
            { ...identity, attachmentId: undefined },
            send,
        );
        expect(send).not.toHaveBeenCalled();
    });
});
