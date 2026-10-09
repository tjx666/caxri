import type { AgentChatRequest, AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { describeTool } from '../../conversation/tool-presentation';
import {
    agentChatActivityLabel,
    agentChatApprovalChoices,
    agentChatApprovalFiles,
    agentChatComposerDisabledReason,
    agentChatFailureMessage,
    agentChatProviderName,
    agentChatQuestionAnswers,
    agentChatRequestTitle,
    agentChatTimelineItems,
    isAgentChatTerminal,
} from '../agent-chat-model';

const base: AgentChatSnapshot = {
    terminalId: 'terminal-1',
    revision: 4,
    status: 'ready',
    truncated: false,
    items: [],
    turns: [],
    requests: [],
};

describe('Agent Chat model', () => {
    it('recognizes a Chat Terminal and names its provider', () => {
        expect(isAgentChatTerminal({ surface: 'chat' })).toBe(true);
        expect(isAgentChatTerminal({})).toBe(false);
        expect(isAgentChatTerminal(undefined)).toBe(false);
        expect(agentChatProviderName({ kind: 'codex' })).toBe('Codex');
        expect(agentChatProviderName({ kind: 'shell' })).toBe('the Agent');
    });

    it('projects a Chat onto the Conversation timeline with a Thought row and turn dividers', () => {
        const timeline = agentChatTimelineItems({
            ...base,
            items: [
                { id: 'u1', turnId: 't1', type: 'userMessage', text: 'Fix the test' },
                {
                    id: 'r1',
                    turnId: 't1',
                    type: 'reasoning',
                    text: '**Inspecting tests**\n\nLooking at the failure.',
                    streaming: false,
                },
                {
                    id: 'c1',
                    turnId: 't1',
                    type: 'command',
                    command: 'pnpm test',
                    output: 'ok',
                    status: 'completed',
                    durationMs: 1200.4,
                },
                {
                    id: 'f1',
                    turnId: 't1',
                    type: 'fileChange',
                    status: 'declined',
                    changes: [
                        { path: 'src/a.ts', kind: 'update', diff: '+a' },
                        { path: 'src/b.ts', kind: 'add', diff: '+b' },
                    ],
                },
                { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Done.', streaming: false },
                { id: 'u2', turnId: 't2', type: 'userMessage', text: 'Thanks' },
                { id: 'empty', turnId: 't2', type: 'agentMessage', text: '', streaming: true },
            ],
            turns: [
                { id: 't1', status: 'completed', durationMs: 9000 },
                { id: 't2', status: 'running' },
            ],
            activeTurnId: 't2',
        });
        expect(timeline.map((item) => item.type)).toEqual([
            'userMessage',
            'toolCall',
            'toolCall',
            'toolCall',
            'agentMessage',
            'turnBoundary',
            'userMessage',
        ]);
        const thought = timeline[1] as Extract<(typeof timeline)[number], { type: 'toolCall' }>;
        expect(thought).toMatchObject({ summary: 'Inspecting tests', status: 'succeeded' });
        expect(describeTool(thought)).toMatchObject({ kind: 'thought', label: 'Thought' });
        expect(timeline[2]).toMatchObject({
            name: 'exec_command',
            summary: 'pnpm test',
            durationMs: 1200,
        });
        expect(timeline[3]).toMatchObject({ summary: 'src/a.ts and 1 more', status: 'failed' });
        expect(timeline[5]).toMatchObject({ durationMs: 9000 });
    });

    it('reports what the Chat is doing and waits on a pending request', () => {
        expect(agentChatActivityLabel(undefined, 'Codex')?.text).toBe('Starting Codex…');
        expect(agentChatActivityLabel(base, 'Codex')).toBeUndefined();
        expect(agentChatActivityLabel({ ...base, activeTurnId: 't1' }, 'Codex')).toEqual({
            text: 'Working…',
            isBusy: true,
        });
        const request: AgentChatRequest = { id: 'q', kind: 'command', command: 'ls' };
        expect(
            agentChatActivityLabel({ ...base, activeTurnId: 't1', requests: [request] }, 'Codex')
                ?.text,
        ).toBe('Waiting for your answer');
    });

    it('offers only the approval decisions the provider accepts', () => {
        expect(
            agentChatApprovalChoices({ id: 'r', kind: 'command', command: 'ls' }).map(
                (choice) => choice.label,
            ),
        ).toEqual(['Accept', 'Accept for this Chat', 'Decline']);
        expect(
            agentChatApprovalChoices({
                id: 'r',
                kind: 'command',
                command: 'ls',
                decisions: ['accept', 'decline', 'cancel'],
            }).map((choice) => choice.decision),
        ).toEqual(['accept', 'decline']);
    });

    it('names the tool a generic tool approval would run', () => {
        expect(agentChatRequestTitle({ id: 'r', kind: 'tool', name: 'WebFetch' })).toBe(
            'Allow WebFetch?',
        );
        expect(
            agentChatRequestTitle({
                id: 'r',
                kind: 'tool',
                name: 'ExitPlanMode',
                summary: 'Plan',
            }),
        ).toBe('Start with this plan?');
    });

    it('lists the files a file-change approval gates', () => {
        expect(
            agentChatApprovalFiles({ id: 'r', kind: 'fileChange', itemId: 'f1' }, [
                {
                    id: 'f1',
                    type: 'fileChange',
                    status: 'running',
                    changes: [{ path: 'src/a.ts', kind: 'update', diff: '' }],
                },
            ]),
        ).toEqual(['src/a.ts']);
    });

    it('prefers a typed answer and reports incomplete questions', () => {
        const request: Extract<AgentChatRequest, { kind: 'question' }> = {
            id: 'q',
            kind: 'question',
            questions: [
                {
                    id: 'a',
                    header: 'Pick',
                    question: 'Which?',
                    options: [{ label: 'One', description: '' }],
                    allowsOther: true,
                },
                { id: 'b', header: 'Reason', question: 'Why?', options: [], allowsOther: true },
            ],
        };
        expect(agentChatQuestionAnswers(request, { a: 'One' }, {})).toEqual({
            answers: { a: ['One'] },
            isComplete: false,
        });
        expect(
            agentChatQuestionAnswers(request, { a: 'One' }, { a: ' Two ', b: 'Because' }),
        ).toEqual({ answers: { a: ['Two'], b: ['Because'] }, isComplete: true });
    });

    it('explains why the composer is unavailable', () => {
        expect(
            agentChatComposerDisabledReason({
                deviceRole: 'view',
                isConnected: true,
                snapshot: base,
            }),
        ).toMatch(/Reply access/u);
        expect(
            agentChatComposerDisabledReason({
                deviceRole: 'reply',
                isConnected: true,
                snapshot: { ...base, status: 'failed' },
            }),
        ).toMatch(/Retry/u);
        expect(
            agentChatComposerDisabledReason({
                deviceRole: 'control',
                isConnected: true,
                snapshot: base,
            }),
        ).toBeUndefined();
        expect(agentChatFailureMessage('executable_not_found', 'Codex')).toMatch(/Codex/u);
    });
});
