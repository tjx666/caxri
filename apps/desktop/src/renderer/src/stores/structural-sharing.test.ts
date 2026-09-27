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
        const next = {
            terminals: [
                { id: 'b', title: 'Codex' },
                { id: 'a', title: 'Shell' },
            ],
        };

        const merged = mergeStructurally(previous, next);

        expect(merged.terminals[1]).toBe(previous.terminals[0]);
    });

    it('replaces a branch whose keys were removed', () => {
        const previous = { runtime: { status: 'ready', restartCount: 1 } };
        const next = { runtime: { status: 'ready' } };

        expect(mergeStructurally(previous, next).runtime).toEqual({ status: 'ready' });
    });

    /**
     * Issue #1108's step 1: prove `app.bootstrap`'s reference stability across a Session switch, deterministically
     * rather than by reading a live snapshot over CDP. `workbench.ts` runs every incoming bootstrap through this exact
     * function (`mergeStructurally(previous.bootstrap, next)`), so this is the real merge, not a simulation of it — a
     * switch only ever changes `selectedSessionId`, and the Server always re-sends the full record set alongside it, so
     * `sessions` and `projects` arrive as new but deeply-equal arrays on every refresh. The sibling keys must keep
     * their previous reference: **stable**. The 5 Session cards' residual updates are not explained by a bootstrap
     * reference change; see `use-session-order.ts`/`use-session-rename.ts` for the actual cause.
     */
    it('keeps sessions and projects stable across a bootstrap refresh that only changes the selected Session', () => {
        const previous = {
            selectedSessionId: 'session-a',
            sessions: [
                { id: 'session-a', displayTitle: 'First' },
                { id: 'session-b', displayTitle: 'Second' },
            ],
            projects: [{ id: 'project-a', name: 'Caxri' }],
            sessionStates: { 'session-a': { status: 'idle' }, 'session-b': { status: 'idle' } },
            terminals: [{ id: 'terminal-a', title: 'Shell' }],
        };
        // The Server re-sends every collection as a fresh structured-clone on each refresh, deeply equal or not.
        const next = { ...structuredClone(previous), selectedSessionId: 'session-b' };

        const merged = mergeStructurally(previous, next);

        expect(merged).not.toBe(previous);
        expect(merged.selectedSessionId).toBe('session-b');
        expect(merged.sessions).toBe(previous.sessions);
        expect(merged.projects).toBe(previous.projects);
        expect(merged.sessionStates).toBe(previous.sessionStates);
        expect(merged.terminals).toBe(previous.terminals);
    });
});
