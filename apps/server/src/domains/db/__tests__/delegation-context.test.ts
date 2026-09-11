import { expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

it('requires explicit new-root authorization and atomically reuses the dedicated Session without stealing focus', () => {
    const database = new CaxriDatabase(':memory:');
    try {
        const original = database.createProject('/synthetic/original');
        const selected = database.createSession(original.id, null).session;
        expect(() =>
            database.ensureDelegationContext('/synthetic/external', 'codex', false),
        ).toThrow('register-project');
        expect(database.listProjects()).toHaveLength(1);
        const first = database.ensureDelegationContext('/synthetic/external', 'codex', true);
        const second = database.ensureDelegationContext('/synthetic/external', 'codex', false);
        expect(second).toEqual(first);
        expect(database.listSessions(first.projectId)).toHaveLength(1);
        expect(database.getAppState('lastSelectedSessionId')).toBe(selected.id);
        const other = database.ensureDelegationContext('/synthetic/external', 'grok', false);
        expect(other.sessionId).not.toBe(first.sessionId);
        expect(other.projectId).toBe(first.projectId);
        database.archiveSession(first.sessionId);
        const replacement = database.ensureDelegationContext('/synthetic/external', 'codex', false);
        expect(replacement.sessionId).not.toBe(first.sessionId);
        expect(database.getSession(replacement.sessionId)?.archivedAt).toBeUndefined();
        expect(database.getAppState('lastSelectedSessionId')).toBe(selected.id);
    } finally {
        database.close();
    }
});
