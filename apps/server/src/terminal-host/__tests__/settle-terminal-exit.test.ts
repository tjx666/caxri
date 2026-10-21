import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionExit } from '../engine';
import { settleTerminalExit } from '../execution-event-projection';

function exitEvent(capture: Promise<unknown>): TerminalExecutionExit {
    return { record: { id: 'terminal-1' }, capture } as unknown as TerminalExecutionExit;
}

describe('settleTerminalExit', () => {
    it('keeps the snapshot when the Agent cancel rejects', async () => {
        const write = vi.fn();
        const snapshot = { kind: 'snapshot' };
        const result = await settleTerminalExit(exitEvent(Promise.resolve(snapshot)), 'launch-1', {
            agentLauncher: { cancel: () => Promise.reject(new Error('cancel failed')) },
            logger: { write } as never,
        });

        expect(result).toBe(snapshot);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]?.[2]).toMatchObject({ fields: { step: 'cancel' } });
    });

    it('yields no snapshot and logs when both steps reject', async () => {
        const write = vi.fn();
        const capture = Promise.reject(new Error('capture failed'));
        const cancel = () => Promise.reject(new Error('cancel failed'));
        const result = await settleTerminalExit(exitEvent(capture), 'launch-1', {
            agentLauncher: { cancel },
            logger: { write } as never,
        });

        expect(result).toBeUndefined();
        const steps = write.mock.calls.map(
            (call) => (call[2] as { fields: { step: string } }).fields.step,
        );
        expect(steps).toEqual(['cancel', 'capture']);
    });
});
