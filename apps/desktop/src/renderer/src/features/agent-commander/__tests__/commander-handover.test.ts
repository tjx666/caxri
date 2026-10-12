import type { CommanderBoardRow, CommanderConversation } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    handoverConversationGroups,
    handoverRequestEntries,
    handoverSessionGroups,
    summarizeHandover,
} from '../commander-handover';

function row(overrides: Partial<CommanderBoardRow> = {}): CommanderBoardRow {
    return {
        activityState: 'idle',
        agent: { kind: 'codex', processState: 'running', terminalId: 'terminal-1', title: 'Codex' },
        commanderSession: false,
        group: 'idle',
        hasUnread: false,
        lastActivityAt: 0,
        projectId: 'project-1',
        projectRoot: '/workspace/alpha',
        projectTitle: 'alpha',
        sessionId: 'session-1',
        sessionTitle: 'Fix the parser',
        ...overrides,
    };
}

function conversation(overrides: Partial<CommanderConversation> = {}): CommanderConversation {
    return {
        cwd: '/workspace/alpha',
        mayBeOpen: false,
        projectId: 'project-1',
        provider: 'claude',
        providerSessionId: 'conversation-1',
        title: 'Investigate the flaky test',
        updatedAt: 0,
        ...overrides,
    };
}

const projects = [{ id: 'project-1', rootPath: '/workspace/alpha', title: 'alpha' }];

describe('handoverSessionGroups', () => {
    it('offers only Sessions the Commander does not manage, grouped by Project, newest first', () => {
        const groups = handoverSessionGroups(
            [
                row({ sessionId: 'old', lastActivityAt: 1 }),
                row({ sessionId: 'managed', commanderSession: true, lastActivityAt: 5 }),
                row({
                    sessionId: 'other-project',
                    projectId: 'project-2',
                    projectTitle: 'beta',
                    lastActivityAt: 3,
                }),
                row({ sessionId: 'new', lastActivityAt: 2, agent: undefined }),
            ],
            '',
        );

        expect(
            groups.map((group) => [group.title, group.candidates.map(({ key }) => key)]),
        ).toEqual([
            ['beta', ['other-project']],
            ['alpha', ['new', 'old']],
        ]);
        expect(groups[1].candidates[0]).toMatchObject({ agentKind: 'shell', sessionId: 'new' });
    });

    it('matches the search against the Session or the Project title, ignoring case', () => {
        const rows = [
            row({ sessionId: 'by-title', sessionTitle: 'Fix the PARSER' }),
            row({ sessionId: 'by-project', sessionTitle: 'Docs', projectTitle: 'parser-kit' }),
            row({ sessionId: 'neither', sessionTitle: 'Docs' }),
        ];

        expect(
            handoverSessionGroups(rows, '  parser ')
                .flatMap((group) => group.candidates)
                .map(({ key }) => key),
        ).toEqual(['by-title', 'by-project']);
    });
});

describe('handoverConversationGroups', () => {
    it('groups a conversation outside every Project under its folder, which hand-over adds as a Project', () => {
        const groups = handoverConversationGroups(
            [
                conversation({ updatedAt: 1 }),
                conversation({
                    cwd: '/workspace/scratch',
                    projectId: null,
                    providerSessionId: 'conversation-2',
                    title: undefined,
                    mayBeOpen: true,
                    updatedAt: 2,
                }),
            ],
            projects,
            '',
            'Untitled',
        );

        expect(groups).toEqual([
            {
                key: 'folder:/workspace/scratch',
                title: '/workspace/scratch',
                newProjectRoot: '/workspace/scratch',
                candidates: [
                    {
                        key: 'claude:conversation-2',
                        title: 'Untitled',
                        agentKind: 'claude',
                        updatedAt: 2,
                        conversation: { provider: 'claude', providerSessionId: 'conversation-2' },
                        mayBeOpen: true,
                    },
                ],
            },
            expect.objectContaining({ key: 'project-1', title: 'alpha' }),
        ]);
    });

    it('matches the search against the title, the folder, or the Project title', () => {
        const conversations = [
            conversation({ providerSessionId: 'by-title', title: 'Parser crash' }),
            conversation({
                providerSessionId: 'by-folder',
                title: 'Other',
                cwd: '/workspace/parser',
                projectId: null,
            }),
            conversation({ providerSessionId: 'none', title: 'Other' }),
        ];

        expect(
            handoverConversationGroups(conversations, projects, 'parser', 'Untitled')
                .flatMap((group) => group.candidates)
                .map(({ key }) => key)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['claude:by-folder', 'claude:by-title']);
        expect(
            handoverConversationGroups(conversations, projects, 'ALPHA', 'Untitled').flatMap(
                (group) => group.candidates,
            ),
        ).toHaveLength(2);
    });
});

describe('handoverRequestEntries', () => {
    it('splits the selection into Sessions and conversations and drops keys no longer offered', () => {
        const candidates = [
            ...handoverSessionGroups([row({ sessionId: 'session-1' })], ''),
            ...handoverConversationGroups([conversation()], projects, '', 'Untitled'),
        ].flatMap((group) => group.candidates);

        expect(
            handoverRequestEntries(
                new Set(['session-1', 'claude:conversation-1', 'session-gone']),
                candidates,
            ),
        ).toEqual({
            sessionIds: ['session-1'],
            conversations: [{ provider: 'claude', providerSessionId: 'conversation-1' }],
        });
    });
});

describe('summarizeHandover', () => {
    it('counts accepted and ownership-only entries and orders refusals by frequency', () => {
        expect(
            summarizeHandover({
                outcomes: [
                    { outcome: 'accepted', sessionId: 's1', handoverId: 'h1', taskId: 't1' },
                    {
                        outcome: 'accepted',
                        sessionId: 's2',
                        handoverId: 'h2',
                        ownershipReason: 'agent_missing',
                    },
                    { outcome: 'rejected', reason: 'session_archived', sessionId: 's3' },
                    { outcome: 'rejected', reason: 'already_managed', sessionId: 's4' },
                    { outcome: 'rejected', reason: 'already_managed', sessionId: 's5' },
                ],
            }),
        ).toEqual({
            accepted: 2,
            ownershipOnly: 1,
            rejectedByKey: new Map([
                ['s3', 'session_archived'],
                ['s4', 'already_managed'],
                ['s5', 'already_managed'],
            ]),
            rejected: [
                { reason: 'already_managed', count: 2 },
                { reason: 'session_archived', count: 1 },
            ],
        });
    });
});

describe('handover refusals in place', () => {
    it('keys a refused conversation like its picker row and keeps a refused managed Session listed', () => {
        const summary = summarizeHandover({
            outcomes: [
                {
                    outcome: 'rejected',
                    reason: 'conversation_bound',
                    conversation: { provider: 'claude', providerSessionId: 'conversation-1' },
                },
                { outcome: 'rejected', reason: 'already_managed', sessionId: 'managed' },
            ],
        });

        expect([...summary.rejectedByKey]).toEqual([
            ['claude:conversation-1', 'conversation_bound'],
            ['managed', 'already_managed'],
        ]);
        const rows = [row({ sessionId: 'managed', commanderSession: true })];
        expect(handoverSessionGroups(rows, '')).toEqual([]);
        const kept = handoverSessionGroups(rows, '', new Set(summary.rejectedByKey.keys()));
        expect(kept.flatMap((group) => group.candidates).map((candidate) => candidate.key)).toEqual(
            ['managed'],
        );
    });
});
