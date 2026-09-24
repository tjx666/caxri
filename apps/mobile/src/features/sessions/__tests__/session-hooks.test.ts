import { MOBILE_SHORT_REPLY_MAX_BYTES } from '@caxri/protocol';
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
import {
    acceptedShortReplyDraft,
    isDeliveredReplyCurrent,
    shortReplyByteLength,
} from '../hooks/use-short-reply';
import {
    failedTerminalPreviewState,
    loadingTerminalPreviewState,
    shouldPollTerminalPreview,
} from '../hooks/use-terminal-preview';
import type { MobileSession } from '../session-model';
import { buildMobileSessionSections } from '../session-model';

const session = (overrides: Partial<MobileSession> = {}): MobileSession => ({
    id: 'session-1',
    projectId: 'project-1',
    displayTitle: 'Mobile phase one',
    projectTitle: 'Caxri',
    lastOpenedAt: 100,
    lastActivityState: 'waiting',
    primaryAgentTerminalId: 'terminal-1',
    attentionEpoch: 3,
    hasUnread: true,
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
                lastActivityState: 'running',
                lastOpenedAt: 200,
            }),
        ],
    });

    it('keeps an explicit selection without auto-selecting or replacing a missing Session', () => {
        expect(nextSelectedSessionId('session-2', sections)).toBe('session-2');
        expect(nextSelectedSessionId('missing', sections)).toBeNull();
        expect(nextSelectedSessionId(null, sections)).toBeNull();
        expect(
            nextSelectedSessionId(null, {
                needsAttention: [],
                recent: [],
                running: [],
                total: 0,
                truncated: false,
            }),
        ).toBeNull();
    });

    it('flattens priority groups without empty headers', () => {
        expect(flattenMobileSessionSections(sections).map(({ id }) => id)).toEqual([
            'header:NEEDS ATTENTION',
            'session-1',
            'header:RUNNING',
            'session-2',
        ]);
    });

    it('holds the rendered order during touch and shows the latest snapshot on release', () => {
        const latest = {
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

    it('starts preview polling only for a visible connected Terminal', () => {
        expect(
            shouldPollTerminalPreview({
                isForeground: true,
                status: 'connected',
                terminalId: 'terminal-1',
                visible: true,
            }),
        ).toBe(true);
        expect(
            shouldPollTerminalPreview({
                isForeground: true,
                status: 'stale',
                terminalId: 'terminal-1',
                visible: true,
            }),
        ).toBe(false);
        expect(
            shouldPollTerminalPreview({
                isForeground: true,
                status: 'connected',
                terminalId: null,
                visible: true,
            }),
        ).toBe(false);
        expect(
            shouldPollTerminalPreview({
                isForeground: false,
                status: 'connected',
                terminalId: 'terminal-1',
                visible: true,
            }),
        ).toBe(false);
    });

    it('keeps the last successful preview while exposing a later refresh failure', () => {
        const preview = {
            availability: 'live' as const,
            content: 'Last known output',
            terminalId: 'terminal-1',
            truncated: false,
            updatedAt: 100,
        };
        const loading = loadingTerminalPreviewState(
            {
                error: null,
                isLoading: false,
                preview,
                terminalId: 'terminal-1',
            },
            'terminal-1',
        );
        expect(failedTerminalPreviewState(loading, 'terminal-1')).toEqual({
            error: 'Unable to load the latest output.',
            isLoading: false,
            preview,
            terminalId: 'terminal-1',
        });
    });

    it('enforces the short-reply limit by UTF-8 bytes without discarding the current draft', () => {
        const current = 'kept';
        const tooLarge = '🙂'.repeat(MOBILE_SHORT_REPLY_MAX_BYTES / 4 + 1);
        expect(shortReplyByteLength(tooLarge)).toBeGreaterThan(MOBILE_SHORT_REPLY_MAX_BYTES);
        expect(acceptedShortReplyDraft(current, tooLarge)).toBe(current);
        expect(acceptedShortReplyDraft(current, 'accepted')).toBe('accepted');
    });

    it('keeps delivery feedback only for the accepted Session attention generation', () => {
        const delivered = { attentionEpoch: 3, sessionId: 'session-1' };
        expect(isDeliveredReplyCurrent(delivered, session())).toBe(true);
        expect(isDeliveredReplyCurrent(delivered, session({ attentionEpoch: 4 }))).toBe(false);
        expect(isDeliveredReplyCurrent(delivered, session({ id: 'session-2' }))).toBe(false);
    });

    it('keys read acknowledgement by Session and attention generation', () => {
        const item = sections.needsAttention[0];
        expect(sessionReadKey(item)).toBe('session-1:3');
        expect(sessionReadKey({ ...item, attentionEpoch: 4 })).toBe('session-1:4');
    });
});
