import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { searchSessionReferences, sessionReferenceQuery } from '../session-reference';

function session(id: string, title: string, extra: Partial<SessionRecord> = {}) {
    return {
        id,
        title,
        projectId: 'p1',
        primaryAgentTerminalId: `t-${id}`,
        lastVisitedAt: 0,
        ...extra,
    } as SessionRecord;
}

const projects = [{ id: 'p1', title: 'Demo' }] as ProjectRecord[];

describe('searchSessionReferences', () => {
    it('offers other unarchived Sessions with an Agent, most recently opened first', () => {
        const sessions = [
            session('current', 'Current work', { lastVisitedAt: 9 }),
            session('old', 'Old plan', { lastVisitedAt: 1 }),
            session('recent', 'Recent fix', { lastVisitedAt: 5 }),
            session('archived', 'Archived', { archivedAt: 3 }),
            session('shell', 'Shell only', { primaryAgentTerminalId: undefined }),
        ];
        expect(searchSessionReferences(sessions, projects, 'current', '')).toEqual([
            { sessionId: 'recent', title: 'Recent fix', projectTitle: 'Demo' },
            { sessionId: 'old', title: 'Old plan', projectTitle: 'Demo' },
        ]);
    });

    it('ranks a title prefix ahead of a word start ahead of a substring', () => {
        const sessions = [
            session('substring', 'Relogin flow', { lastVisitedAt: 3 }),
            session('word', 'Fix login bug', { lastVisitedAt: 2 }),
            session('prefix', 'Login page', { lastVisitedAt: 1 }),
            session('miss', 'Settings'),
        ];
        expect(
            searchSessionReferences(sessions, projects, undefined, 'LOGIN').map(
                (candidate) => candidate.sessionId,
            ),
        ).toEqual(['prefix', 'word', 'substring']);
    });
});

describe('sessionReferenceQuery', () => {
    it('searches Sessions only after a leading @', () => {
        expect(sessionReferenceQuery('@login')).toBe('login');
        expect(sessionReferenceQuery('  @')).toBe('');
        expect(sessionReferenceQuery('/review')).toBeUndefined();
    });
});
