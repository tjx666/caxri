import { describe, expect, it } from 'vitest';

import { withToggledFold } from '../agent-chat-strip-folds';

describe('withToggledFold', () => {
    it('collapses and expands one section per Chat Terminal', () => {
        const collapsed = withToggledFold(new Map(), 'chat-a', 'tasks');
        expect([...(collapsed.get('chat-a') ?? [])]).toEqual(['tasks']);
        expect(collapsed.get('chat-b')).toBeUndefined();
        const both = withToggledFold(collapsed, 'chat-a', 'plan');
        expect([...(both.get('chat-a') ?? [])]).toEqual(['tasks', 'plan']);
        expect([...(withToggledFold(both, 'chat-a', 'tasks').get('chat-a') ?? [])]).toEqual([
            'plan',
        ]);
    });
});
