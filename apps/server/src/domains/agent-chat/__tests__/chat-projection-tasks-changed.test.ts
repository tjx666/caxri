import type { AgentChatTask } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { ChatProjection } from '../chat-projection';

const logger = { write: () => {} } as unknown as StructuredLogger;

const task: AgentChatTask = {
    id: 'a',
    kind: 'agent',
    title: 'Explore',
    status: 'running',
    isBackground: true,
    canStop: true,
};

describe('ChatProjection onTasksChanged', () => {
    it('reports the task list only when a state operation changed it', () => {
        const onTasksChanged = vi.fn();
        const projection = new ChatProjection({
            terminalId: 'terminal-1',
            revision: 0,
            taskRevisionFloors: new Map(),
            logger,
            send: () => {},
            onChange: () => {},
            onTasksChanged,
            delegatedTaskSource: () => {},
        });
        projection.apply([{ op: 'state', state: { status: 'ready' } }]);
        expect(onTasksChanged).not.toHaveBeenCalled();
        projection.apply([{ op: 'state', state: { tasks: [task] } }]);
        expect(onTasksChanged).toHaveBeenCalledTimes(1);
        expect(onTasksChanged).toHaveBeenLastCalledWith([task]);
        projection.apply([{ op: 'state', state: { status: 'starting' } }]);
        expect(onTasksChanged).toHaveBeenCalledTimes(1);
    });
});
