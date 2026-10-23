import { describe, expect, it } from 'vitest';

import {
    agentChatSessionHandoffDraft,
    agentChatSessionHandoffText,
    parseAgentChatSessionHandoff,
    parseAgentChatSessionHandoffCommand,
} from '../agent-chat-commands';
import {
    agentChatPathReferencePreview,
    agentChatTextWithPathReferences,
    parseAgentChatPathReferences,
} from '../agent-chat-path-references';
import { agentChatQueueEntry } from '../agent-chat-queue';
import { agentDelegationCreateRequestSchema } from '../agent-delegation-contract';

const handoff = (note: string) =>
    agentChatSessionHandoffText({ note, projectId: 'project-1', provider: 'claude' });

describe('/new-session hand-off', () => {
    it('reads the command and its note from a draft', () => {
        expect(parseAgentChatSessionHandoffCommand('/new-session')).toBe('');
        expect(parseAgentChatSessionHandoffCommand('  /new-session  write the docs \n')).toBe(
            'write the docs',
        );
        expect(parseAgentChatSessionHandoffCommand('/new-session\nline one\nline two')).toBe(
            'line one\nline two',
        );
        expect(parseAgentChatSessionHandoffCommand('/new-sessions')).toBeUndefined();
        expect(parseAgentChatSessionHandoffCommand('please /new-session')).toBeUndefined();
    });

    it('tells the Agent to delegate a hand-off into a new Session of its own Project and provider', () => {
        const text = handoff('write the docs');
        expect(text).toContain(
            'agent delegate create --project project-1 --new-session --handoff --title',
        );
        expect(text).toContain('--provider claude');
        expect(text.endsWith('## Next task from the user:\nwrite the docs')).toBe(true);
    });

    it('reads the note back, with or without one, and ignores other messages', () => {
        expect(parseAgentChatSessionHandoff(handoff('write the docs'))).toEqual({
            note: 'write the docs',
        });
        expect(parseAgentChatSessionHandoff(handoff(''))).toEqual({ note: '' });
        // A provider that trims the recorded message drops the empty note's trailing newline.
        expect(parseAgentChatSessionHandoff(handoff('').trimEnd())).toEqual({ note: '' });
        expect(parseAgentChatSessionHandoff('# Hand off to a new Caxri Session')).toBeUndefined();
        expect(parseAgentChatSessionHandoff('write the docs')).toBeUndefined();
        // A note that repeats the heading keeps everything after the first one.
        expect(parseAgentChatSessionHandoff(handoff('a\n## Next task from the user:\nb'))).toEqual({
            note: 'a\n## Next task from the user:\nb',
        });
    });

    it('gives the user their typed command back wherever a sent message is read as their words', () => {
        expect(agentChatSessionHandoffDraft(handoff('write the docs'))).toBe(
            '/new-session write the docs',
        );
        expect(agentChatSessionHandoffDraft(handoff(''))).toBe('/new-session');
        expect(agentChatSessionHandoffDraft('hello')).toBe('hello');
        expect(parseAgentChatPathReferences(handoff('write the docs')).text).toBe(
            '/new-session write the docs',
        );
        const cited = agentChatTextWithPathReferences(
            handoff('write the docs'),
            [{ path: '/work/notes.md', isDirectory: false }],
            'Claude',
        );
        expect(parseAgentChatPathReferences(cited)).toEqual({
            handoff: { note: 'write the docs' },
            references: [{ path: '/work/notes.md', isDirectory: false }],
            skills: [],
            text: '/new-session write the docs',
        });
        expect(agentChatPathReferencePreview(handoff('write the docs'))).toBe(
            '/new-session write the docs',
        );
        expect(agentChatQueueEntry({ id: 'q', text: handoff('') }, false).preview).toBe(
            '/new-session',
        );
    });

    it('marks only the composed instructions as a hand-off', () => {
        expect(parseAgentChatPathReferences(handoff('')).handoff).toEqual({ note: '' });
        // A literal command the composer could not compose reached the Agent as plain words.
        expect(parseAgentChatPathReferences('/new-session write the docs')).toEqual({
            references: [],
            skills: [],
            text: '/new-session write the docs',
        });
    });

    it('accepts --handoff only for a new Session', () => {
        const request = {
            projectId: 'project-1',
            provider: 'claude',
            prompt: 'Next step',
            handoff: true,
        };
        expect(
            agentDelegationCreateRequestSchema.safeParse({
                ...request,
                newSession: true,
                title: 'Docs',
            }).success,
        ).toBe(true);
        expect(
            agentDelegationCreateRequestSchema.safeParse({ ...request, sessionId: 'session-1' })
                .success,
        ).toBe(false);
    });
});
