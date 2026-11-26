import type { AgentChatTask } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ChatBackgroundTaskCounts } from '../background-task-counts';

function task(id: string, fields: Partial<AgentChatTask> = {}): AgentChatTask {
    return {
        id,
        kind: 'shell',
        title: `Task ${id}`,
        status: 'running',
        isBackground: true,
        canStop: true,
        ...fields,
    };
}

describe('ChatBackgroundTaskCounts', () => {
    it('counts running background tasks and announces only when the count moves', () => {
        const publish = vi.fn();
        const counts = new ChatBackgroundTaskCounts(publish);

        counts.record('chat', [
            task('shell'),
            task('agent', { kind: 'agent' }),
            task('foreground', { kind: 'agent', isBackground: false }),
            task('done', { status: 'completed' }),
        ]);
        expect(counts.count('chat')).toBe(2);
        expect(publish).toHaveBeenCalledTimes(1);

        // A streamed update that leaves the count unchanged is not news.
        counts.record('chat', [
            task('shell', { summary: 'still waiting' }),
            task('agent', { kind: 'agent' }),
        ]);
        expect(publish).toHaveBeenCalledTimes(1);

        counts.record('chat', [task('shell', { status: 'stopped' })]);
        expect(counts.count('chat')).toBeUndefined();
        expect(publish).toHaveBeenCalledTimes(2);
    });

    it('clears and announces a forgotten Chat only when it had running tasks', () => {
        const publish = vi.fn();
        const counts = new ChatBackgroundTaskCounts(publish);
        counts.forget('chat');
        expect(publish).not.toHaveBeenCalled();

        counts.record('chat', [task('shell')]);
        counts.forget('chat');
        expect(counts.count('chat')).toBeUndefined();
        expect(publish).toHaveBeenCalledTimes(2);
    });
});
