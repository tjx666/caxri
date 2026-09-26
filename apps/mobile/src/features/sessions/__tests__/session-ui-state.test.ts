import { describe, expect, it } from 'vitest';

import {
    emptyHostSessionUiState,
    hasKnownConversationAgent,
    isSideSessionSegment,
    preferredSessionSegment,
    rememberSessionDraft,
    rememberSessionSegment,
    resolveSessionConversationSegment,
    selectSessionProject,
} from '../session-ui-state';

describe('host Session UI state', () => {
    it('recognizes a newly launched Agent from Terminal kind before provider probing', () => {
        expect(hasKnownConversationAgent({ kind: 'claude' })).toBe(true);
        expect(hasKnownConversationAgent({ kind: 'codex' })).toBe(true);
        expect(hasKnownConversationAgent({ kind: 'shell', provider: 'claude' })).toBe(true);
        expect(hasKnownConversationAgent({ kind: 'shell' })).toBe(false);
    });

    it('defaults to Conversation only when a timeline is available', () => {
        expect(preferredSessionSegment(undefined, true)).toBe('conversation');
        expect(preferredSessionSegment(undefined, false)).toBe('terminal');
        expect(preferredSessionSegment('changes', true)).toBe('changes');
        expect(preferredSessionSegment('terminal', true)).toBe('terminal');
    });

    it('defaults to a likely Agent Conversation and falls back when its record is unavailable', () => {
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: true,
                remembered: undefined,
                status: 'loading',
            }),
        ).toEqual({ fallback: false, segment: 'conversation' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: true,
                hasKnownAgent: true,
                remembered: undefined,
                status: 'loading',
            }),
        ).toEqual({ fallback: false, segment: 'conversation' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: true,
                hasKnownAgent: true,
                remembered: 'conversation',
                status: 'unsupported',
            }),
        ).toEqual({ fallback: true, segment: 'terminal' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: true,
                remembered: undefined,
                status: 'missing',
            }),
        ).toEqual({ fallback: true, segment: 'terminal' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: true,
                remembered: 'terminal',
                status: 'loading',
            }),
        ).toEqual({ fallback: false, segment: 'terminal' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: false,
                remembered: 'conversation',
                status: 'loading',
            }),
        ).toEqual({ fallback: false, segment: 'conversation' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                hasKnownAgent: false,
                remembered: 'conversation',
                status: 'unsupported',
            }),
        ).toEqual({ fallback: true, segment: 'terminal' });
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

    it('treats Panels like Changes as a side view over the remembered content', () => {
        expect(isSideSessionSegment('panels')).toBe(true);
        expect(isSideSessionSegment('changes')).toBe(true);
        expect(isSideSessionSegment('terminal')).toBe(false);
        const state = rememberSessionSegment(
            emptyHostSessionUiState(),
            'one',
            'panels',
            'conversation',
        );
        expect(state.contentSegmentBySession).toEqual({ one: 'conversation' });
        expect(
            rememberSessionSegment(state, 'one', 'panels', 'changes').contentSegmentBySession,
        ).toEqual({ one: 'conversation' });
    });

    it('keeps the Project filter while Session-specific state changes', () => {
        const filtered = selectSessionProject(emptyHostSessionUiState(), 'project-one');
        const afterNavigation = rememberSessionSegment(filtered, 'session-one', 'changes');
        expect(afterNavigation.projectId).toBe('project-one');
    });
});
