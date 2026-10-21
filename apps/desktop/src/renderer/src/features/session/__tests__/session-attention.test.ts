import type { SessionRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { isChatRequestUnseen, shouldAcknowledgeSessionAttention } from '../session-attention';

const session: SessionRecord = {
    id: 'session-1',
    projectId: 'project-1',
    workbenchProjectId: 'project-1',
    rootPath: '/project',
    createdAt: 0,
    lastOpenedAt: 0,
    sidebarOrder: 0,
    lastSessionActivityAt: 0,
    lastSessionActivityReason: 'created',
    primaryAgentTerminalId: 'terminal-1',
    lastActivityState: 'waiting',
    attentionEpoch: 2,
    readAttentionEpoch: 1,
    lastAttentionKind: 'waiting',
    hasUnread: true,
    displayTitle: 'Needs input',
    titleMode: 'automatic',
};

describe('Session attention acknowledgement', () => {
    it('requires unread state in a visible and focused window', () => {
        expect(
            shouldAcknowledgeSessionAttention(session, {
                documentVisible: true,
                windowFocused: true,
            }),
        ).toBe(true);
        expect(
            shouldAcknowledgeSessionAttention(session, {
                documentVisible: false,
                windowFocused: true,
            }),
        ).toBe(false);
        expect(
            shouldAcknowledgeSessionAttention(session, {
                documentVisible: true,
                windowFocused: false,
            }),
        ).toBe(false);
        expect(
            shouldAcknowledgeSessionAttention(
                { ...session, hasUnread: false, readAttentionEpoch: 2 },
                { documentVisible: true, windowFocused: true },
            ),
        ).toBe(false);
    });
});

describe('Session attention with a pending Chat request', () => {
    const visible = { documentVisible: true, windowFocused: true };

    it('keeps the unread mark while a hidden Chat still waits on the user', () => {
        expect(shouldAcknowledgeSessionAttention(session, visible, true)).toBe(false);
        expect(shouldAcknowledgeSessionAttention(session, visible, false)).toBe(true);
    });

    it('treats only an off-screen primary Chat with a request as unseen', () => {
        const waiting = new Set(['terminal-1']);
        expect(isChatRequestUnseen(session, waiting, {})).toBe(true);
        expect(isChatRequestUnseen(session, waiting, { 'terminal-1': 1 })).toBe(false);
        expect(isChatRequestUnseen(session, new Set(), {})).toBe(false);
        expect(isChatRequestUnseen(session, new Set(['terminal-2']), {})).toBe(false);
        expect(isChatRequestUnseen({ primaryAgentTerminalId: undefined }, waiting, {})).toBe(false);
    });
});
