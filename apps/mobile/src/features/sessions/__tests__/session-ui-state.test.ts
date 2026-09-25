import { describe, expect, it } from 'vitest';

import {
    emptyHostSessionUiState,
    preferredSessionSegment,
    rememberSessionDraft,
    rememberSessionSegment,
    resolveSessionConversationSegment,
    selectSessionProject,
} from '../session-ui-state';

describe('host Session UI state', () => {
    it('defaults to Conversation only when a timeline is available', () => {
        expect(preferredSessionSegment(undefined, true)).toBe('conversation');
        expect(preferredSessionSegment(undefined, false)).toBe('terminal');
        expect(preferredSessionSegment('changes', true)).toBe('changes');
        expect(preferredSessionSegment('terminal', true)).toBe('terminal');
    });

    it('defaults to a likely Agent Conversation and falls back when its record is unavailable', () => {
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: true,
                remembered: undefined,
                status: 'loading',
            }),
        ).toEqual({ fallback: false, segment: 'conversation' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: true,
                remembered: 'conversation',
                status: 'unsupported',
            }),
        ).toEqual({ fallback: true, segment: 'terminal' });
        expect(
            resolveSessionConversationSegment({
                hasAgentEndpoint: false,
                remembered: undefined,
                status: 'missing',
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
        expect(first.draftBySession).toEqual({ one: 'draft one' });
    });

    it('keeps the Project filter while Session-specific state changes', () => {
        const filtered = selectSessionProject(emptyHostSessionUiState(), 'project-one');
        const afterNavigation = rememberSessionSegment(filtered, 'session-one', 'changes');
        expect(afterNavigation.projectId).toBe('project-one');
    });
});
