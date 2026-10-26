import { describe, expect, it } from 'vitest';

import { withSeenFailures } from '../agent-chat-seen-failures';

describe('withSeenFailures', () => {
    it('adds failures per Chat Terminal', () => {
        const seen = withSeenFailures(new Map(), 'chat-a', ['task-1']);
        const next = withSeenFailures(seen, 'chat-a', ['task-2']);
        expect([...(next.get('chat-a') ?? [])]).toEqual(['task-1', 'task-2']);
        expect(next.get('chat-b')).toBeUndefined();
    });

    it('keeps the same map when every failure was already seen', () => {
        const seen = withSeenFailures(new Map(), 'chat-a', ['task-1']);
        expect(withSeenFailures(seen, 'chat-a', ['task-1'])).toBe(seen);
        expect(withSeenFailures(seen, 'chat-a', [])).toBe(seen);
    });
});
