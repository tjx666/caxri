import type { AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';
import { replaceEqualDeep } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import { selectAgentChatComposerView } from '../agent-chat-composer-snapshot';

const context = {
    hasConversation: true,
    pendingMessages: [],
    processState: undefined,
    provider: 'codex' as const,
    providerName: 'Codex',
    t: translate,
};

function snapshot(items: AgentChatItem[], revision: number): AgentChatSnapshot {
    return {
        terminalId: 'terminal-1',
        revision,
        status: 'ready',
        activeTurnId: 'turn-1',
        items,
        turns: [{ id: 'turn-1', status: 'running', startedAt: 1000 }],
        queue: [],
        requests: [],
        tasks: [],
    } as unknown as AgentChatSnapshot;
}

const prompt: AgentChatItem = { id: 'u1', type: 'userMessage', text: 'hi', turnId: 'turn-1' };

describe('Agent Chat composer snapshot selection', () => {
    it('keeps its identity while only the streamed reply changes', () => {
        // The query structurally shares what `select` returns, which is what keeps the composer from rendering.
        let shared = selectAgentChatComposerView(
            snapshot(
                [
                    prompt,
                    {
                        id: 'a1',
                        type: 'agentMessage',
                        text: 'Par',
                        streaming: true,
                        turnId: 'turn-1',
                    },
                ],
                1,
            ),
            context,
        );
        const first = shared;
        for (let revision = 2; revision < 20; revision++) {
            const streamed = snapshot(
                [
                    prompt,
                    {
                        id: 'a1',
                        type: 'agentMessage',
                        streaming: true,
                        text: 'Par'.repeat(revision),
                        turnId: 'turn-1',
                    },
                ],
                revision,
            );
            shared = replaceEqualDeep(shared, selectAgentChatComposerView(streamed, context));
        }
        expect(shared).toBe(first);
        expect(shared.snapshot?.items).toEqual([prompt]);
        expect(shared.activity?.kind).toBe('working');
    });

    it('moves when a field the composer reads changes', () => {
        const running = selectAgentChatComposerView(snapshot([prompt], 1), context);
        const settled = replaceEqualDeep(
            running,
            selectAgentChatComposerView(
                { ...snapshot([prompt], 2), activeTurnId: undefined },
                context,
            ),
        );
        expect(settled).not.toBe(running);
        expect(settled.activeTurnId).toBeUndefined();
        expect(settled.isBusy).toBe(false);
        expect(running.isBusy).toBe(true);
    });

    it('keeps the Fast mode and ultracode states the model picker toggles', () => {
        const view = selectAgentChatComposerView(
            { ...snapshot([prompt], 1), fast: true, ultracode: false },
            context,
        );
        expect(view.snapshot).toMatchObject({ fast: true, ultracode: false });
    });

    it('keeps the plan the status row leads with once a turn stops short of it', () => {
        const plan = {
            turnId: 'turn-1',
            steps: [{ step: 'Reply', status: 'inProgress' as const }],
        };
        const view = selectAgentChatComposerView({ ...snapshot([prompt], 1), plan }, context);
        expect(view.snapshot?.plan).toBe(plan);
    });

    it('says loading before the first snapshot', () => {
        expect(selectAgentChatComposerView(undefined, context).sendBlock).toBe('loading');
    });
});
