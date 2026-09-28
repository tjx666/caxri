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
     * Issue #1108's step 1: `workbench.ts` runs every incoming bootstrap through this exact function
     * (`mergeStructurally(previous.bootstrap, next)`), so this is the real merge, not a simulation of it. The Server
     * re-sends the full record set on every refresh, and a refresh that changes nothing but `selectedSessionId` keeps
     * every collection's reference.
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

    /**
     * Issue #1356: a real Session switch is not the refresh above. Selecting a Session stamps its `lastOpenedAt` and
     * its Project's, so `sessions` and `projects` do change reference on every switch — along with the two records
     * whose timestamp moved. Anything a Session row receives therefore cannot be derived from those arrays or records
     * by identity alone: the rows stay quiet only because the handlers read them through refs, the id lists are keyed
     * by content, and the Project reaches each row as fields.
     */
    it('replaces only the opened Session and its Project across a real Session switch', () => {
        const previous = {
            selectedSessionId: 'session-a',
            sessions: [
                { id: 'session-a', displayTitle: 'First', lastOpenedAt: 1 },
                { id: 'session-b', displayTitle: 'Second', lastOpenedAt: 1 },
            ],
            projects: [
                { id: 'project-a', displayTitle: 'Caxri', lastOpenedAt: 1 },
                { id: 'project-b', displayTitle: 'Docs', lastOpenedAt: 1 },
            ],
            terminals: [{ id: 'terminal-a', title: 'Shell' }],
        };
        const next = structuredClone(previous);
        next.selectedSessionId = 'session-b';
        next.sessions[1].lastOpenedAt = 2;
        next.projects[0].lastOpenedAt = 2;

        const merged = mergeStructurally(previous, next);

        expect(merged.sessions).not.toBe(previous.sessions);
        expect(merged.sessions[0]).toBe(previous.sessions[0]);
        expect(merged.sessions[1]).not.toBe(previous.sessions[1]);
        expect(merged.projects).not.toBe(previous.projects);
        expect(merged.projects[0]).not.toBe(previous.projects[0]);
        expect(merged.projects[1]).toBe(previous.projects[1]);
        expect(merged.terminals).toBe(previous.terminals);
    });
});
