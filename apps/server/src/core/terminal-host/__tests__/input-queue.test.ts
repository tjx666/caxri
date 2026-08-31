import { describe, expect, it } from 'vitest';

import { TerminalInputQueue } from '../input-queue';

describe('TerminalInputQueue', () => {
    it('keeps exact Agent input separate from ordinary Terminal input', () => {
        const queue = new TerminalInputQueue('attachment-1', {});
        queue.enqueue('keyboard', false);
        queue.enqueue('summary', false, 'launch-1');

        const ordinary = queue.takeBatch();
        expect(ordinary.data).toBe('keyboard');
        expect(ordinary.expectedAgentLaunchId).toBeUndefined();
        expect(queue.takeBatch()).toMatchObject({
            data: 'summary',
            expectedAgentLaunchId: 'launch-1',
        });
    });
});
