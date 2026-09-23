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

    it('preserves binary mouse bytes and their order between text inputs', () => {
        const queue = new TerminalInputQueue('attachment-1', {});
        queue.enqueue('before', false, 'launch-1');
        queue.enqueue('\u{1B}[M \u{80}\u{FF}', false, 'launch-1', 'binary');
        queue.enqueue('after', false, 'launch-1');

        expect(queue.takeBatch().params).toEqual({
            data: 'before',
            expectedAgentLaunchId: 'launch-1',
        });
        expect(queue.takeBatch().params).toEqual({
            data: '\u{1B}[M \u{80}\u{FF}',
            encoding: 'binary',
            expectedAgentLaunchId: 'launch-1',
        });
        expect(queue.takeBatch().params).toEqual({
            data: 'after',
            expectedAgentLaunchId: 'launch-1',
        });
    });
});
