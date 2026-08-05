import { describe, expect, it } from 'vitest';

import { mergeStructurally } from './structural-sharing';

describe('mergeStructurally', () => {
    it('returns the previous value when the incoming snapshot is deeply equal', () => {
        const previous = { terminals: [{ id: 'a', title: 'Shell' }], settings: { fontSize: 13 } };
        const next = structuredClone(previous);

        expect(mergeStructurally(previous, next)).toBe(previous);
    });

    it('keeps the identity of the branches that did not change', () => {
        const previous = {
            terminals: [
                { id: 'a', title: 'Shell' },
                { id: 'b', title: 'Codex' },
            ],
            settings: { fontSize: 13 },
        };
        const next = structuredClone(previous);
        next.terminals[1].title = 'Codex — refactor';

        const merged = mergeStructurally(previous, next);

        expect(merged).not.toBe(previous);
        expect(merged.settings).toBe(previous.settings);
        expect(merged.terminals[0]).toBe(previous.terminals[0]);
        expect(merged.terminals[1]).toEqual({ id: 'b', title: 'Codex — refactor' });
    });

    it('matches array elements by identifier rather than position', () => {
        const previous = { terminals: [{ id: 'a', title: 'Shell' }] };
        const next = { terminals: [{ id: 'b', title: 'Codex' }, { id: 'a', title: 'Shell' }] };

        const merged = mergeStructurally(previous, next);

        expect(merged.terminals[1]).toBe(previous.terminals[0]);
    });

    it('replaces a branch whose keys were removed', () => {
        const previous = { runtime: { status: 'ready', restartCount: 1 } };
        const next = { runtime: { status: 'ready' } };

        expect(mergeStructurally(previous, next).runtime).toEqual({ status: 'ready' });
    });
});
