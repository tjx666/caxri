import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { resolveSessionCreator } from '../session-creator';

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id,
        projectId: 'p',
        workbenchRootProjectId: 'p',
        rootPath: '/fixture',
        createdAt: 0,
        lastVisitedAt: 0,
        sessionActivityAt: 0,
        sidebarOrder: 0,
        sessionActivityReason: 'created',
        agentActivityState: 'idle',
        attentionGeneration: 0,
        acknowledgedAttentionGeneration: 0,
        hasUnread: false,
        title: id,
        titleMode: 'automatic',
        ...overrides,
    };
}

describe('resolveSessionCreator', () => {
    it('shows nothing for a Session the user created', () => {
        expect(resolveSessionCreator(session('child'), [session('child')], undefined)).toBe(
            undefined,
        );
    });

    it('links an open creating Session', () => {
        const creator = session('caller', { title: 'Coordinator' });
        expect(
            resolveSessionCreator(
                session('child', { createdBySessionId: 'caller' }),
                [creator],
                undefined,
            ),
        ).toEqual({ kind: 'session', session: creator });
    });

    it('names an archived creator without offering to open it', () => {
        expect(
            resolveSessionCreator(
                session('child', { createdBySessionId: 'caller' }),
                [session('caller', { title: 'Coordinator', archivedAt: 1 })],
                undefined,
            ),
        ).toEqual({ kind: 'archived', title: 'Coordinator' });
    });

    it('names Caxri Bot for its own hidden Session', () => {
        expect(
            resolveSessionCreator(session('child', { createdBySessionId: 'bot' }), [], 'bot'),
        ).toEqual({ kind: 'bot' });
    });

    it('shows nothing when the creator is not visible in the Workbench', () => {
        expect(
            resolveSessionCreator(session('child', { createdBySessionId: 'hidden' }), [], 'bot'),
        ).toBe(undefined);
    });
});
