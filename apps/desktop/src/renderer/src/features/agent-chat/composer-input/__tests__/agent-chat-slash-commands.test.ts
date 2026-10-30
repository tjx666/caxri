import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatAppCommandActions,
    agentChatAppCommandUnavailable,
    agentChatCaxriInvocations,
    agentChatGoalModeDraft,
    agentChatLeadingInvocation,
    agentChatSkillDiscoveryNotice,
    isAgentChatGoalAction,
    isAgentChatGoalOffered,
    parseAgentChatAppCommand,
    withAgentChatBuiltInActions,
} from '../agent-chat-slash-commands';

describe('Agent Chat slash commands', () => {
    it('explains missing skills until discovery answers', () => {
        expect(
            agentChatSkillDiscoveryNotice({ isAgentRunning: false, isLoading: false }, translate),
        ).toEqual({
            text: 'Skills appear once the Agent is running',
            isLoading: false,
        });
        expect(
            agentChatSkillDiscoveryNotice({ isAgentRunning: true, isLoading: true }, translate),
        ).toEqual({
            text: 'Loading skills…',
            isLoading: true,
        });
        expect(
            agentChatSkillDiscoveryNotice({ isAgentRunning: true, isLoading: false }, translate),
        ).toBeUndefined();
    });
});

describe('agentChatLeadingInvocation', () => {
    it('splits the skill or command a message starts with from what follows', () => {
        expect(agentChatLeadingInvocation('$status-report')).toEqual({
            invocation: '$status-report',
            rest: '',
        });
        expect(agentChatLeadingInvocation('/review the open PR')).toEqual({
            invocation: '/review',
            rest: ' the open PR',
        });
        expect(agentChatLeadingInvocation('/plugin:skill\nnext line')).toEqual({
            invocation: '/plugin:skill',
            rest: '\nnext line',
        });
    });

    it('leaves prices, paths, and mid-sentence names as plain text', () => {
        expect(agentChatLeadingInvocation('$5 is the price')).toBeUndefined();
        expect(agentChatLeadingInvocation('/usr/bin is missing')).toBeUndefined();
        expect(agentChatLeadingInvocation('run $status-report')).toBeUndefined();
    });
});

describe('Goal mode', () => {
    it('is offered only when the provider reports a native goal command', () => {
        expect(isAgentChatGoalOffered([{ name: 'goal', goal: true }])).toBe(true);
        // A Claude Code custom /goal runs as an ordinary command.
        expect(isAgentChatGoalOffered([{ name: 'goal' }])).toBe(false);
        expect(isAgentChatGoalOffered([{ name: 'compact' }])).toBe(false);
        expect(isAgentChatGoalOffered(undefined)).toBe(false);
    });

    it('keeps the typed text as the goal and drops a /goal the user already typed', () => {
        expect(agentChatGoalModeDraft('')).toBe('');
        expect(agentChatGoalModeDraft('ship the picker')).toBe('ship the picker');
        expect(agentChatGoalModeDraft('/goal ship it')).toBe('ship it');
        expect(agentChatGoalModeDraft('  /goal')).toBe('');
        expect(agentChatGoalModeDraft('/goals are fun')).toBe('/goals are fun');
    });

    it('enters Goal mode from the /goal command row only', () => {
        expect(
            isAgentChatGoalAction({
                invocation: '/goal',
                kind: 'command',
                requiresArguments: true,
                source: 'builtIn',
            }),
        ).toBe(true);
        expect(
            isAgentChatGoalAction({
                invocation: '$goal',
                kind: 'skill',
                requiresArguments: false,
                source: 'project',
            }),
        ).toBe(false);
        expect(
            isAgentChatGoalAction({
                invocation: '/compact',
                kind: 'command',
                requiresArguments: false,
                source: 'builtIn',
            }),
        ).toBe(false);
    });

    it('offers /new-session first for every provider, replacing a provider command of that name', () => {
        const review = {
            invocation: '/review',
            kind: 'command',
            requiresArguments: false,
            source: 'builtIn',
        } as const;
        const actions = withAgentChatBuiltInActions(
            [review, { ...review, invocation: '/new-session' }],
            translate,
        );
        expect(actions.map(({ invocation }) => invocation)).toEqual(['/new-session', '/review']);
        expect(actions[0]).toMatchObject({
            description: 'Hand the next task to a new Session and stop here',
            argumentHint: '[next task]',
        });
    });

    describe('app commands', () => {
        const everything = {
            canChangeModel: true,
            canTogglePlanMode: true,
            canOpenSideChat: true,
            canFork: true,
            hasSession: true,
            isPinned: false,
        };

        it('offers every app command a fully capable Chat can run, in menu order', () => {
            expect(
                agentChatAppCommandActions(everything, translate).map(
                    ({ invocation }) => invocation,
                ),
            ).toEqual([
                '/status',
                '/usage',
                '/model',
                '/plan',
                '/btw',
                '/fork',
                '/new',
                '/rename',
                '/archive',
                '/pin',
            ]);
        });

        it('keeps the rows whose control this Chat lacks, disabled with a plain reason', () => {
            const lacking = {
                canChangeModel: false,
                canTogglePlanMode: false,
                canOpenSideChat: false,
                canFork: false,
                hasSession: false,
                isPinned: false,
            };
            expect(
                agentChatAppCommandActions(lacking, translate).map(({ invocation }) => invocation),
            ).toHaveLength(10);
            const unavailable = agentChatAppCommandUnavailable(lacking, translate);
            expect(unavailable.keys().toArray()).toEqual([
                '/model',
                '/plan',
                '/btw',
                '/fork',
                '/new',
                '/rename',
                '/archive',
                '/pin',
            ]);
            expect(unavailable.get('/fork')).toBe('Available after the first message in this Chat');
            expect(agentChatAppCommandUnavailable(everything, translate).size).toBe(0);
        });

        it('tags Caxri-run invocations, including /new-session', () => {
            const caxri = agentChatCaxriInvocations(
                agentChatAppCommandActions(everything, translate),
            );
            expect(caxri.has('/new-session')).toBe(true);
            expect(caxri.has('/fork')).toBe(true);
            expect(caxri.has('/review')).toBe(false);
        });

        it('describes /pin by whether the Session is pinned and hints a /btw question', () => {
            const pinned = agentChatAppCommandActions({ ...everything, isPinned: true }, translate);
            expect(pinned.find(({ invocation }) => invocation === '/pin')?.description).toBe(
                'Unpin this Session',
            );
            expect(pinned.find(({ invocation }) => invocation === '/btw')?.argumentHint).toBe(
                '[question]',
            );
        });

        it('runs only a bare offered command', () => {
            const state = { ...everything, canFork: false };
            const offered = agentChatAppCommandActions(state, translate);
            const unavailable = agentChatAppCommandUnavailable(state, translate);
            expect(parseAgentChatAppCommand('/status', offered, unavailable)).toBe('status');
            expect(parseAgentChatAppCommand('  /usage \n', offered, unavailable)).toBe('usage');
            expect(parseAgentChatAppCommand('/btw why?', offered)).toBeUndefined();
            expect(parseAgentChatAppCommand('/fork', offered, unavailable)).toBeUndefined();
            expect(parseAgentChatAppCommand('/statuses', offered)).toBeUndefined();
            expect(parseAgentChatAppCommand('see /status', offered)).toBeUndefined();
        });

        it('lists app commands after /new-session and over provider commands of the same name', () => {
            const status = {
                invocation: '/status',
                kind: 'command',
                description: 'Provider status',
                requiresArguments: false,
                source: 'builtIn',
            } as const;
            const actions = withAgentChatBuiltInActions(
                [status, { ...status, invocation: '/review' }],
                translate,
                agentChatAppCommandActions(everything, translate).slice(0, 2),
            );
            expect(actions.map(({ invocation }) => invocation)).toEqual([
                '/new-session',
                '/status',
                '/usage',
                '/review',
            ]);
            expect(actions[1]?.description).toBe(
                "Show this Agent's output speed and service status",
            );
        });
    });
});
