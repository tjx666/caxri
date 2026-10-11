import type { AgentChatRequest, AgentChatSnapshot } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, describeAgentTool } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { mobileTerminalExitPresentation } from '../../terminal/terminal-exit-presentation';
import {
    AGENT_CHAT_HANDED_OFF_BANNER,
    AGENT_CHAT_HANDED_OFF_NOTICE,
    agentChatActivityLabel,
    agentChatApprovalFiles,
    agentChatApprovalRows,
    agentChatComposerAvailability,
    agentChatComposerButton,
    agentChatComposerSubmission,
    agentChatDisabledReason,
    agentChatEmptyMessage,
    agentChatFailureMessage,
    agentChatImageCounts,
    agentChatProviderName,
    agentChatQuestionAnswers,
    agentChatRequestBlockedReason,
    agentChatTimelineItems,
    canAttachAgentChatImages,
    isAgentChatFailureRetryable,
    isAgentChatHandedOff,
    isAgentChatStopping,
    isAgentChatTerminal,
    sentenceStartProvider,
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
        expect(agentChatProviderName({ kind: 'grok', provider: 'grok' })).toBe('Grok Build');
        expect(agentChatProviderName({ kind: 'shell' })).toBe('the Agent');
        expect(agentChatProviderName(undefined)).toBe('the Agent');
    });

    it('names every Chat provider exactly as the Desktop catalog does', () => {
        for (const provider of agentProviderIds) {
            expect(agentChatProviderName({ kind: provider })).toBe(
                agentProviderCatalog[provider].displayName,
            );
            expect(agentChatProviderName({ kind: 'shell', provider })).toBe(
                agentProviderCatalog[provider].displayName,
            );
        }
        expect(agentChatProviderName({ kind: 'grok' })).toBe('Grok Build');
    });

    it('offers image attachments only to providers whose Chat takes images', () => {
        expect(canAttachAgentChatImages({ kind: 'claude' })).toBe(true);
        expect(canAttachAgentChatImages({ kind: 'codex' })).toBe(true);
        expect(canAttachAgentChatImages({ kind: 'grok' })).toBe(false);
        expect(canAttachAgentChatImages({ kind: 'shell' })).toBe(false);
        expect(canAttachAgentChatImages(undefined)).toBe(false);
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
        expect(describeAgentTool(thought)).toMatchObject({ kind: 'thought', label: 'Thought' });
        expect(timeline[2]).toMatchObject({
            name: 'exec_command',
            summary: 'pnpm test',
            durationMs: 1200,
        });
        expect(timeline[3]).toMatchObject({ summary: 'src/a.ts and 1 more', status: 'failed' });
        expect(timeline[5]).toMatchObject({ durationMs: 9000 });
    });

    it('keeps an image-only message, whose images the Chat view draws', () => {
        const timeline = agentChatTimelineItems({
            ...base,
            items: [
                { id: 'u1', turnId: 't1', type: 'userMessage', text: '', images: [{}] },
                {
                    id: 'u2',
                    turnId: 't1',
                    type: 'userMessage',
                    text: 'Compare these',
                    images: [{}, {}],
                },
            ],
        });
        expect(timeline.filter((item) => item.type === 'userMessage')).toEqual([
            { id: 'u1', type: 'userMessage', text: '' },
            { id: 'u2', type: 'userMessage', text: 'Compare these' },
        ]);
        expect(
            agentChatImageCounts({
                items: [
                    { id: 'u1', turnId: 't1', type: 'userMessage', text: '', images: [{}] },
                    { id: 'a1', turnId: 't1', type: 'agentMessage', text: 'Hi', streaming: true },
                ],
            }),
        ).toBe('[["u1",1]]');
        expect(agentChatImageCounts(undefined)).toBe('');
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
        ).toBe('Waiting for your approval');
        const question: AgentChatRequest = {
            id: 'q',
            kind: 'question',
            questions: [{ id: 'a', header: '', question: 'Why?', options: [], allowsOther: true }],
        };
        expect(
            agentChatActivityLabel({ ...base, activeTurnId: 't1', requests: [question] }, 'Codex')
                ?.text,
        ).toBe('Waiting for your answer');
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

    it('explains why the composer is unavailable, leaving a failed Chat to its banner', () => {
        expect(
            agentChatComposerAvailability({
                deviceRole: 'view',
                isConnected: true,
                isHandedOff: false,
                snapshot: base,
            }),
        ).toEqual({ isEnabled: false, reason: 'Reply access is required to message this Chat.' });
        expect(
            agentChatComposerAvailability({
                deviceRole: 'reply',
                isConnected: true,
                isHandedOff: false,
                snapshot: { ...base, status: 'failed' },
            }),
        ).toEqual({ isEnabled: false });
        expect(
            agentChatComposerAvailability({
                deviceRole: 'control',
                isConnected: true,
                isHandedOff: false,
                snapshot: base,
            }),
        ).toEqual({ isEnabled: true });
        expect(agentChatFailureMessage('executable_not_found', 'Codex')).toMatch(/Codex/u);
    });

    it('names the model, not sending, when the model cannot be changed', () => {
        const access = { isConnected: false, isHandedOff: false, snapshot: base } as const;
        expect(agentChatDisabledReason({ ...access, deviceRole: 'reply' })).toBe(
            'Reconnect to send messages.',
        );
        expect(
            agentChatDisabledReason({ ...access, action: 'configure', deviceRole: 'reply' }),
        ).toBe('Reconnect to change the model.');
        expect(
            agentChatDisabledReason({ ...access, action: 'configure', deviceRole: 'view' }),
        ).toBe('Reply access is required to change the model.');
    });

    it('asks only a device that can retry to retry a stopped provider', () => {
        expect(agentChatFailureMessage('process_exited', 'Claude')).toBe(
            'Claude stopped unexpectedly. Retry to resume the conversation.',
        );
        expect(agentChatFailureMessage('process_exited', 'Claude', false)).toBe(
            'Claude stopped unexpectedly. Reply access is required to retry.',
        );
    });

    it('starts a sentence with a capital when the provider falls back to the Agent', () => {
        expect(sentenceStartProvider('the Agent')).toBe('The Agent');
        expect(sentenceStartProvider('Codex')).toBe('Codex');
        expect(agentChatFailureMessage('spawn_failed', 'the Agent')).toBe(
            'The Agent could not be started on your computer.',
        );
    });

    it('offers no Retry for a provider that must be installed or updated on the computer', () => {
        expect(isAgentChatFailureRetryable('executable_not_found')).toBe(false);
        expect(isAgentChatFailureRetryable('unsupported_version')).toBe(false);
        for (const reason of [
            'spawn_failed',
            'handshake_failed',
            'process_exited',
            'resume_failed',
        ] as const)
            expect(isAgentChatFailureRetryable(reason)).toBe(true);
        expect(agentChatFailureMessage('executable_not_found', 'Codex')).toMatch(
            /Install it on your computer\./u,
        );
        expect(agentChatFailureMessage('unsupported_version', 'Codex')).toMatch(
            /Update it on your computer\./u,
        );
    });

    it('blocks answering a request without control access or a connection', () => {
        expect(agentChatRequestBlockedReason({ deviceRole: 'reply', isConnected: true })).toEqual({
            kind: 'access',
            message:
                'This device cannot answer requests. Pair it again on your computer with control access.',
        });
        expect(agentChatRequestBlockedReason({ deviceRole: null, isConnected: false })?.kind).toBe(
            'access',
        );
        expect(
            agentChatRequestBlockedReason({ deviceRole: 'control', isConnected: false }),
        ).toEqual({ kind: 'offline', message: 'Reconnect to answer.' });
        expect(
            agentChatRequestBlockedReason({ deviceRole: 'control', isConnected: true }),
        ).toBeUndefined();
    });

    it('keeps Stop pending only for the turn it stopped', () => {
        expect(isAgentChatStopping('t1', 't1')).toBe(true);
        expect(isAgentChatStopping('t1', undefined)).toBe(false);
        expect(isAgentChatStopping('t1', 't2')).toBe(false);
        expect(isAgentChatStopping(undefined, 't1')).toBe(false);
        expect(isAgentChatStopping(undefined, undefined)).toBe(false);
    });

    it('lets the composer button act only when editable, and steer only a running turn with a draft', () => {
        const base = {
            hasDraft: true,
            isEditable: true,
            isRunning: false,
            isStopAction: false,
            isStopping: false,
        };
        expect(agentChatComposerSubmission(base)).toEqual({ canSteer: false, canSubmit: true });
        expect(agentChatComposerSubmission({ ...base, isRunning: true })).toEqual({
            canSteer: true,
            canSubmit: true,
        });
        expect(agentChatComposerSubmission({ ...base, hasDraft: false })).toEqual({
            canSteer: false,
            canSubmit: false,
        });
        expect(
            agentChatComposerSubmission({
                ...base,
                hasDraft: false,
                isRunning: true,
                isStopAction: true,
            }),
        ).toEqual({ canSteer: false, canSubmit: true });
        expect(agentChatComposerSubmission({ ...base, isStopping: true })).toEqual({
            canSteer: false,
            canSubmit: false,
        });
        expect(agentChatComposerSubmission({ ...base, isEditable: false })).toEqual({
            canSteer: false,
            canSubmit: false,
        });
    });

    it('labels the composer button Send, Queue, Stop, or Stopping', () => {
        const base = {
            isRunning: false,
            isStopAction: false,
            isStopping: false,
            provider: 'Codex',
        };
        expect(agentChatComposerButton(base)).toEqual({
            kind: 'send',
            label: 'Send message',
            testID: 'agent-chat-composer-send',
        });
        expect(agentChatComposerButton({ ...base, isRunning: true }).label).toBe('Queue message');
        expect(agentChatComposerButton({ ...base, isRunning: true, isStopAction: true })).toEqual({
            kind: 'stop',
            label: 'Stop Codex',
            testID: 'agent-chat-composer-stop',
        });
        expect(agentChatComposerButton({ ...base, isRunning: true, isStopping: true })).toEqual({
            kind: 'stop',
            label: 'Stopping Codex',
            testID: 'agent-chat-composer-stop',
        });
    });

    it('lays out one-time answers in a row and the standing answer below', () => {
        const all = [
            { decision: 'accept', label: 'Run' },
            { decision: 'acceptForSession', label: 'Always Allow in This Chat' },
            { decision: 'decline', label: 'Deny' },
        ];
        expect(agentChatApprovalRows(all).map((row) => row.map((c) => c.decision))).toEqual([
            ['accept', 'decline'],
            ['acceptForSession'],
        ]);
        expect(
            agentChatApprovalRows(all.filter((c) => c.decision !== 'acceptForSession')),
        ).toHaveLength(1);
        expect(agentChatApprovalRows([])).toEqual([]);
    });

    it('treats a detached Chat as handed off, the way the phone treats a detached Terminal', () => {
        expect(isAgentChatHandedOff({ lastProcessState: 'detached' })).toBe(true);
        for (const state of [
            'running',
            'starting',
            'stopped',
            'dead',
            'failed',
            'interrupted',
            'suspended',
        ] as const)
            expect(isAgentChatHandedOff({ lastProcessState: state })).toBe(false);
        expect(isAgentChatHandedOff(undefined)).toBe(false);
        /**
         * The notice names the Chat where the detached PTY chip names the Terminal; the rest of the sentence is shared.
         */
        expect(AGENT_CHAT_HANDED_OFF_NOTICE).toBe('Chat was handed off on your computer');
        expect(AGENT_CHAT_HANDED_OFF_BANNER).toBe(
            'Chat was handed off on your computer. Resume it there to continue.',
        );
        expect(mobileTerminalExitPresentation('detached').label).toBe(
            AGENT_CHAT_HANDED_OFF_NOTICE.replace('Chat', 'Terminal'),
        );
    });

    it('disables sending to a handed-off Chat silently, since its banner says how to continue', () => {
        const stopped: AgentChatSnapshot = { ...base, status: 'stopped' };
        expect(
            agentChatComposerAvailability({
                deviceRole: 'control',
                isConnected: true,
                isHandedOff: true,
                snapshot: stopped,
            }),
        ).toEqual({ isEnabled: false });
        expect(
            agentChatComposerAvailability({
                deviceRole: 'reply',
                isConnected: true,
                isHandedOff: true,
                snapshot: undefined,
            }),
        ).toEqual({ isEnabled: false });
        // Role and connection keep precedence, exactly as before.
        expect(
            agentChatComposerAvailability({
                deviceRole: 'view',
                isConnected: true,
                isHandedOff: true,
                snapshot: stopped,
            }).reason,
        ).toMatch(/Reply access/u);
        expect(
            agentChatComposerAvailability({
                deviceRole: 'control',
                isConnected: false,
                isHandedOff: true,
                snapshot: stopped,
            }).reason,
        ).toBe('Reconnect to send messages.');
        // A stopped Chat that was not handed off still resumes on the next message.
        expect(
            agentChatComposerAvailability({
                deviceRole: 'control',
                isConnected: true,
                isHandedOff: false,
                snapshot: stopped,
            }),
        ).toEqual({ isEnabled: true });
    });

    it('does not invite a message into an empty Chat this device cannot send to', () => {
        expect(
            agentChatEmptyMessage({ canSend: true, isHandedOff: false, provider: 'Grok Build' }),
        ).toBe('No messages yet. Send a message to start working with Grok Build.');
        expect(
            agentChatEmptyMessage({ canSend: false, isHandedOff: false, provider: 'Grok Build' }),
        ).toBe('No messages yet.');
        for (const canSend of [true, false])
            expect(
                agentChatEmptyMessage({ canSend, isHandedOff: true, provider: 'Grok Build' }),
            ).toBe('No messages to show.');
    });
});
