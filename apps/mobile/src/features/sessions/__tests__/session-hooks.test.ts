import { describe, expect, it, vi } from 'vitest';

vi.mock('../../connection/mobile-client-provider', () => ({
    useMobileClient: () => {
        throw new Error('The pure hook helpers do not access the mobile client.');
    },
}));

import { sessionReadKey } from '../hooks/use-session-attention';
import {
    flattenMobileSessionSections,
    nextSelectedSessionId,
    projectSessionList,
} from '../hooks/use-session-polling';
import type { MobileSession } from '../session-model';
import { buildMobileSessionSections } from '../session-model';

const session = (overrides: Partial<MobileSession> = {}): MobileSession => ({
    id: 'session-1',
    projectId: 'project-1',
    title: 'Mobile phase one',
    projectTitle: 'Caxri',
    lastVisitedAt: 100,
    sessionActivityAt: 100,
    agentActivityState: 'waiting',
    primaryAgentTerminalId: 'terminal-1',
    attentionGeneration: 3,
    hasUnread: true,
    hasPendingAttention: true,
    primaryTerminal: {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'codex',
        provider: 'codex',
        lastProcessState: 'running',
    },
    ...overrides,
});

describe('mobile Session hooks', () => {
    const sections = buildMobileSessionSections({
        total: 2,
        truncated: false,
        sessions: [
            session(),
            session({
                id: 'session-2',
                hasUnread: false,
                hasPendingAttention: false,
                agentActivityState: 'running',
                sessionActivityAt: 200,
            }),
        ],
    });

    it('keeps an explicit selection without auto-selecting or replacing a missing Session', () => {
        expect(nextSelectedSessionId('session-2', sections)).toBe('session-2');
        expect(nextSelectedSessionId('missing', sections)).toBeNull();
        expect(nextSelectedSessionId(null, sections)).toBeNull();
        expect(
            nextSelectedSessionId(
                null,
                buildMobileSessionSections({ sessions: [], total: 0, truncated: false }),
            ),
        ).toBeNull();
    });

    it('flattens priority groups without empty headers', () => {
        expect(flattenMobileSessionSections(sections).map(({ id }) => id)).toEqual([
            'header:attention',
            'attention:session-1',
            'header:working',
            'working:session-2',
        ]);
        expect(
            flattenMobileSessionSections(sections).flatMap((entry) =>
                entry.type === 'header' ? [entry.group] : [],
            ),
        ).toEqual(['attention', 'working']);
    });

    it("leaves a listed creator's consult and delegated work off the home list", () => {
        const settled = {
            agentActivityState: 'completed',
            hasUnread: false,
            hasPendingAttention: false,
        } as const;
        const nested = buildMobileSessionSections({
            total: 7,
            truncated: false,
            sessions: [
                session({ id: 'creator', ...settled }),
                session({
                    id: 'consult',
                    createdBySessionId: 'creator',
                    createdByRelation: 'consult',
                    ...settled,
                }),
                session({
                    id: 'delegated',
                    createdBySessionId: 'creator',
                    createdByRelation: 'delegated',
                    ...settled,
                }),
                session({
                    id: 'pinned-delegated',
                    createdBySessionId: 'creator',
                    createdByRelation: 'delegated',
                    pinnedAt: 1,
                    ...settled,
                }),
                session({
                    id: 'handoff',
                    createdBySessionId: 'creator',
                    createdByRelation: 'handoff',
                    ...settled,
                }),
                session({
                    id: 'orphan-consult',
                    createdBySessionId: 'archived-creator',
                    createdByRelation: 'consult',
                    ...settled,
                }),
                session({
                    id: 'waiting-delegated',
                    createdBySessionId: 'creator',
                    createdByRelation: 'delegated',
                    lastAttentionKind: 'waiting',
                }),
            ],
        });
        const listed = flattenMobileSessionSections(nested).flatMap((entry) =>
            entry.type === 'session' ? [entry.session.id] : [],
        );
        expect(listed.toSorted((left, right) => left.localeCompare(right))).toEqual([
            'creator',
            'handoff',
            'orphan-consult',
            'pinned-delegated',
            'waiting-delegated',
        ]);
        // Still openable from the creator's timeline links.
        expect(nested.sessions.map(({ id }) => id)).toContain('consult');
    });

    it('holds the rendered order during touch and shows the latest snapshot on release', () => {
        const latest = {
            deviceRole: 'control' as const,
            hostDisplayName: 'Test computer',
            projects: [],
            sections: buildMobileSessionSections({
                sessions: [session({ id: 'session-3', hasUnread: false })],
                total: 1,
                truncated: false,
            }),
        };
        const frozen = projectSessionList(latest, sections, 'session-1');
        expect(frozen.sections).toBe(sections);
        expect(frozen.selectedId).toBe('session-1');
        const released = projectSessionList(latest, null, 'session-1');
        expect(released.sections).toBe(latest.sections);
        expect(released.selectedId).toBeNull();
        expect(released.hasLoaded).toBe(true);
    });

    it('keys read acknowledgement by Session and attention generation', () => {
        const item = sections.groups.attention[0];
        expect(sessionReadKey(item)).toBe('session-1:3');
        expect(sessionReadKey({ ...item, attentionGeneration: 4 })).toBe('session-1:4');
    });
});
