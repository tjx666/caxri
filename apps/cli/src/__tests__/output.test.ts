import { describe, expect, it } from 'vitest';

import { quietLines, stableJson } from '../output';

describe('CLI machine output', () => {
    it('sorts JSON keys recursively for stable snapshots', () => {
        expect(stableJson({ z: 1, nested: { b: 2, a: 1 }, a: 0 })).toBe(
            '{"a":0,"nested":{"a":1,"b":2},"z":1}',
        );
    });

    it('projects object and array IDs in quiet mode and rejects ambiguous output', () => {
        expect(quietLines({ id: 'session-1', displayTitle: 'Session' })).toEqual(['session-1']);
        expect(quietLines([{ id: 'one' }, { id: 'two' }])).toEqual(['one', 'two']);
        expect(() => quietLines({ state: 'ready' })).toThrow('has no stable ID');
        expect(quietLines([{ sessionId: 'one' }], 'sessionId')).toEqual(['one']);
        expect(() => quietLines({ id: 'one' }, 'sessionId')).toThrow('has no stable ID');
    });
});
