import { describe, expect, it } from 'vitest';

import {
    emptyHostSessionUiState,
    hasKnownConversationAgent,
    isChatSegmentShown,
    isSegmentAwaitingAnswer,
    isSessionDetailVisible,
    isSideSessionSegment,
    preferredSessionSegment,
    rememberSessionDraft,
    rememberSessionSegment,
    resolveSessionConversationSegment,
    selectSessionProject,
    SESSION_SEGMENTS,
    sessionSegmentDirection,
    sessionSegments,
} from '../session-ui-state';

describe('host Session UI state', () => {
    it('recognizes a newly launched Agent from Terminal kind before provider probing', () => {
        expect(hasKnownConversationAgent({ kind: 'claude' })).toBe(true);
        expect(hasKnownConversationAgent({ kind: 'codex' })).toBe(true);
        expect(hasKnownConversationAgent({ kind: 'shell', provider: 'claude' })).toBe(true);
        expect(hasKnownConversationAgent({ kind: 'shell' })).toBe(false);
    });

    it('keeps the Conversation tab closed for a provider without a projected timeline', () => {
        expect(hasKnownConversationAgent({ kind: 'shell', provider: 'codex' })).toBe(true);
        expect(hasKnownConversationAgent({ kind: 'grok' })).toBe(false);
        expect(hasKnownConversationAgent({ kind: 'shell', provider: 'grok' })).toBe(false);
        expect(hasKnownConversationAgent(undefined)).toBe(false);
    });

    it('defaults to Conversation only when a timeline is available', () => {
        expect(preferredSessionSegment(undefined, true)).toBe('conversation');
        expect(preferredSessionSegment(undefined, false)).toBe('terminal');
        expect(preferredSessionSegment('changes', true)).toBe('changes');
        expect(preferredSessionSegment('terminal', true)).toBe('terminal');
    });

    it('opens a Chat on its own tab and never falls back to a Terminal it does not have', () => {
        for (const remembered of [undefined, 'terminal', 'conversation'] as const)
            expect(
                resolveSessionConversationSegment({
                    hasAgentEndpoint: false,
                    hasKnownAgent: true,
                    isChat: true,
                    remembered,
                    status: 'loading',
                }),
            ).toEqual({ fallback: false, hasConversation: true, segment: 'conversation' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: true,
                isChat: true,
                remembered: 'changes',
                status: 'unsupported',
            }).segment,
        ).toBe('changes');
    });

    it('defaults to a likely Agent Conversation and falls back when its record is unavailable', () => {
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: true,
                remembered: undefined,
                status: 'loading',
            }),
        ).toEqual({ fallback: false, hasConversation: true, segment: 'conversation' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: true,
                hasKnownAgent: true,
                remembered: undefined,
                status: 'loading',
            }),
        ).toEqual({ fallback: false, hasConversation: true, segment: 'conversation' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: true,
                hasKnownAgent: true,
                remembered: 'conversation',
                status: 'unsupported',
            }),
        ).toEqual({ fallback: true, hasConversation: true, segment: 'terminal' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: true,
                remembered: undefined,
                status: 'missing',
            }),
        ).toEqual({ fallback: true, hasConversation: true, segment: 'terminal' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: true,
                remembered: 'terminal',
                status: 'loading',
            }),
        ).toEqual({ fallback: false, hasConversation: true, segment: 'terminal' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: false,
                remembered: 'conversation',
                status: 'loading',
            }),
        ).toEqual({ fallback: false, hasConversation: true, segment: 'conversation' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: false,
                remembered: 'conversation',
                status: 'unsupported',
            }),
        ).toEqual({ fallback: false, hasConversation: false, segment: 'terminal' });
    });

    it('gives a plain shell no Conversation tab and no fallback notice', () => {
        for (const status of ['loading', 'unsupported', 'missing'] as const)
            expect(
                resolveSessionConversationSegment({
                    hasAgentEndpoint: false,
                    hasKnownAgent: false,
                    remembered: undefined,
                    status,
                }),
            ).toEqual({ fallback: false, hasConversation: false, segment: 'terminal' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: false,
                remembered: 'changes',
                status: 'unsupported',
            }),
        ).toEqual({ fallback: false, hasConversation: false, segment: 'changes' });
    });

    it('remembers segment and draft independently for each Session', () => {
        const initial = emptyHostSessionUiState();
        const first = rememberSessionDraft(
            rememberSessionSegment(initial, 'one', 'changes'),
            'one',
            'draft one',
        );
        const second = rememberSessionDraft(
            rememberSessionSegment(first, 'two', 'terminal'),
            'two',
            'draft two',
        );
        expect(second.segmentBySession).toEqual({ one: 'changes', two: 'terminal' });
        expect(second.draftBySession).toEqual({ one: 'draft one', two: 'draft two' });
        expect(second.contentSegmentBySession).toEqual({ two: 'terminal' });
        expect(first.draftBySession).toEqual({ one: 'draft one' });
    });

    it('keeps the prior content segment behind Changes for each Session', () => {
        const first = rememberSessionSegment(
            emptyHostSessionUiState(),
            'one',
            'changes',
            'conversation',
        );
        const second = rememberSessionSegment(first, 'two', 'changes', 'terminal');
        expect(second.contentSegmentBySession).toEqual({ one: 'conversation', two: 'terminal' });
        expect(
            rememberSessionSegment(second, 'one', 'changes', 'changes').contentSegmentBySession,
        ).toEqual(second.contentSegmentBySession);
    });

    it('treats Project view tabs like Changes as a side view over the remembered content', () => {
        expect(isSideSessionSegment('panel:caxri.files')).toBe(true);
        expect(isSideSessionSegment('changes')).toBe(true);
        expect(isSideSessionSegment('terminal')).toBe(false);
        const state = rememberSessionSegment(
            emptyHostSessionUiState(),
            'one',
            'panel:caxri.files',
            'conversation',
        );
        expect(state.contentSegmentBySession).toEqual({ one: 'conversation' });
        expect(
            rememberSessionSegment(state, 'one', 'panel:caxri.project-status', 'changes')
                .contentSegmentBySession,
        ).toEqual({ one: 'conversation' });
    });

    it('keeps the Project filter while Session-specific state changes', () => {
        const filtered = selectSessionProject(emptyHostSessionUiState(), 'project-one');
        const afterNavigation = rememberSessionSegment(filtered, 'session-one', 'changes');
        expect(afterNavigation.projectId).toBe('project-one');
    });

    it('reports the tab strip direction for the incoming panel', () => {
        const order = [
            ...SESSION_SEGMENTS,
            'panel:caxri.files',
            'panel:caxri.project-status',
        ] as const;
        expect(sessionSegmentDirection('conversation', 'changes', order)).toBe(1);
        expect(sessionSegmentDirection('panel:caxri.files', 'terminal', order)).toBe(-1);
        expect(
            sessionSegmentDirection('panel:caxri.project-status', 'panel:caxri.files', order),
        ).toBe(-1);
        expect(sessionSegmentDirection('changes', 'panel:not-loaded-yet', order)).toBe(1);
        expect(sessionSegmentDirection('terminal', 'terminal', order)).toBe(0);
    });

    it('hides a covered or unrouted phone detail', () => {
        const visible = { isFocused: true, isPhone: true, isRouted: true, isSelected: true };
        expect(isSessionDetailVisible(visible)).toBe(true);
        expect(isSessionDetailVisible({ ...visible, isFocused: false })).toBe(false);
        expect(isSessionDetailVisible({ ...visible, isRouted: false })).toBe(false);
        expect(isSessionDetailVisible({ ...visible, isPhone: false, isRouted: false })).toBe(true);
        expect(isSessionDetailVisible({ ...visible, isSelected: false })).toBe(false);
    });
});

describe('Chat Session tabs', () => {
    it('offers no Terminal tab for a Chat', () => {
        expect(sessionSegments({ hasConversation: true, isChat: true })).toEqual([
            'conversation',
            'changes',
        ]);
        expect(sessionSegments({ hasConversation: false, isChat: false })).toEqual([
            'terminal',
            'changes',
        ]);
    });

    it('observes a Chat on its tab or behind any wide side segment', () => {
        expect(isChatSegmentShown('conversation', false)).toBe(true);
        expect(isChatSegmentShown('changes', false)).toBe(false);
        expect(isChatSegmentShown('panel:notes', false)).toBe(false);
        expect(isChatSegmentShown('changes', true)).toBe(true);
        expect(isChatSegmentShown('panel:notes', true)).toBe(true);
        expect(isChatSegmentShown('terminal', true)).toBe(false);
    });

    it('marks the Chat tab while a request waits and the user is on another tab', () => {
        const waiting = {
            isChat: true,
            isSelected: false,
            lastActivityState: 'waiting',
            segment: 'conversation',
        } as const;
        expect(isSegmentAwaitingAnswer(waiting)).toBe(true);
        expect(isSegmentAwaitingAnswer({ ...waiting, isSelected: true })).toBe(false);
        expect(isSegmentAwaitingAnswer({ ...waiting, isChat: false })).toBe(false);
        expect(isSegmentAwaitingAnswer({ ...waiting, lastActivityState: 'running' })).toBe(false);
        expect(isSegmentAwaitingAnswer({ ...waiting, segment: 'changes' })).toBe(false);
    });
});
