import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Codex feedback in Chat with a fake Codex app-server', () => {
    it('shows failed and blocking Hooks, warnings, and a model reroute in the turn, and logs them without text', async () => {
        const { logWrite, service, terminal, until } = await fixture({ provider: 'codex' });
        await until((snapshot) => snapshot.status === 'ready');
        await service.send(terminal.id, { text: 'hookfeedback' });
        const snapshot = await until((current) => current.turns.at(-1)?.status === 'completed');
        const turnId = snapshot.turns.at(-1)?.id;

        const notices = snapshot.items.filter((item) => item.type === 'notice');
        expect(notices.map((item) => [item.turnId, item.kind, item.title])).toEqual([
            [turnId, 'error', 'Hook "PreToolUse" failed'],
            [turnId, 'warning', 'Hook "PreToolUse" blocked the action'],
            [turnId, 'warning', 'Codex warning'],
            [turnId, 'warning', 'Codex configuration warning'],
            [turnId, 'warning', 'Model changed'],
        ]);
        expect(notices[1]).toMatchObject({
            message: 'Force pushes to main are not allowed.\nOpen a pull request instead.',
        });
        // The notices come before the reply, in the order Codex sent them.
        expect(snapshot.items.at(-1)?.type).toBe('agentMessage');

        const logged = logWrite.mock.calls
            .filter(([, event]) => event === 'agent_chat.provider_notice')
            .map((call) => call[2]?.fields);
        expect(logged).toEqual([
            expect.objectContaining({
                source: 'hook',
                hookEvent: 'preToolUse',
                hookStatus: 'failed',
            }),
            expect.objectContaining({ source: 'hook', hookStatus: 'blocked' }),
            expect.objectContaining({ source: 'warning' }),
            expect.objectContaining({ source: 'warning' }),
            expect.objectContaining({ source: 'configWarning' }),
            expect.objectContaining({ source: 'modelRerouted', reason: 'highRiskCyberActivity' }),
        ]);
        expect(JSON.stringify(logged)).not.toContain('Force pushes');
    });
});
