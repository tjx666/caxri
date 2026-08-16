import { describe, expect, it } from 'vitest';

import type { RuntimeEvent } from '../../registry/events';
import { createRecoveringEventClient } from '../event-client';

describe('createRecoveringEventClient error handling', () => {
    it('reports a failed recovery through onError instead of throwing out of start()', async () => {
        const errors: unknown[] = [];
        const client = createRecoveringEventClient({
            emit: () => {},
            onError: (error) => {
                errors.push(error);
            },
            // oxlint-disable-next-line typescript/require-await -- rejects synchronously to exercise the onError path deterministically
            recover: async () => {
                throw new Error('recovery transport failed');
            },
        });

        await client.start();

        expect(errors).toHaveLength(1);
        expect((errors[0] as Error).message).toBe('recovery transport failed');
    });

    it('emits a transient event immediately without waiting for recovery to settle', () => {
        const emitted: RuntimeEvent[] = [];
        const client = createRecoveringEventClient({
            emit: (event) => {
                emitted.push(event);
            },
            // oxlint-disable-next-line typescript/require-await -- resolves synchronously; this path is never awaited by the assertion
            recover: async () => ({ kind: 'events', cursor: 0, events: [] }),
        });

        client.receive({
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'direct bytes' },
        });

        expect(emitted).toEqual([
            {
                event: 'terminal.output',
                payload: { terminalId: 'terminal-1', data: 'direct bytes' },
            },
        ]);
    });
});
