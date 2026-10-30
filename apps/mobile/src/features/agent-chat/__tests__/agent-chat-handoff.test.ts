import { parseAgentChatSessionHandoff } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatHandoffText, agentChatIssueHandoffDraft } from '../agent-chat-handoff';

const source = { projectId: 'project-1', providerId: 'claude', sessionId: 'session-1' } as const;

describe('agentChatHandoffText', () => {
    it('composes /new-session as hand-off instructions naming the Chat Project and Agent', () => {
        const text = agentChatHandoffText('/new-session write the docs', source);
        expect(parseAgentChatSessionHandoff(text ?? '')).toEqual({ note: 'write the docs' });
        expect(text).toContain('--project project-1');
        expect(text).toContain('--provider claude');
    });

    it('leaves any other draft to the ordinary send path', () => {
        expect(agentChatHandoffText('hello', source)).toBeUndefined();
        expect(agentChatHandoffText('/new-sessions', source)).toBeUndefined();
    });

    it('refuses to send the literal command when the Project or Agent is unknown', () => {
        expect(
            agentChatHandoffText('/new-session x', { ...source, projectId: undefined }),
        ).toBeNull();
        expect(
            agentChatHandoffText('/new-session x', { ...source, providerId: undefined }),
        ).toBeNull();
    });
});

describe('agentChatIssueHandoffDraft', () => {
    it('hands the issue reference and URL to the new Session', () => {
        const draft = agentChatIssueHandoffDraft({
            reference: 'ENG-12',
            url: 'https://linear.app/x/issue/ENG-12',
        });
        expect(draft).toBe('/new-session Work on ENG-12: https://linear.app/x/issue/ENG-12');
        expect(parseAgentChatSessionHandoff(agentChatHandoffText(draft, source) ?? '')?.note).toBe(
            'Work on ENG-12: https://linear.app/x/issue/ENG-12',
        );
    });
});
