import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { resolveSessionCreator } from '../session-creator';

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id,
        projectId: 'p',
        workbenchProjectId: 'p',
        rootPath: '/fixture',
        createdAt: 0,
        lastOpenedAt: 0,
        lastSessionActivityAt: 0,
        sidebarOrder: 0,
        lastSessionActivityReason: 'created',
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        displayTitle: id,
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
        const creator = session('caller', { displayTitle: 'Coordinator' });
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
                [session('caller', { displayTitle: 'Coordinator', archivedAt: 1 })],
                undefined,
            ),
        ).toEqual({ kind: 'archived', title: 'Coordinator' });
    });

    it('names the Agent Commander for its own hidden Session', () => {
        expect(
            resolveSessionCreator(
                session('child', { createdBySessionId: 'commander' }),
                [],
                'commander',
            ),
        ).toEqual({ kind: 'commander' });
    });

    it('shows nothing when the creator is not visible in the Workbench', () => {
        expect(
            resolveSessionCreator(
                session('child', { createdBySessionId: 'hidden' }),
                [],
                'commander',
            ),
        ).toBe(undefined);
    });
});
