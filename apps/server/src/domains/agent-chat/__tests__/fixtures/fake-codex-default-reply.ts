/**
 * The fake Codex app-server's reply to a message no scenario claims: reasoning, a plan, and a streamed reply quoting
 * the message, then a token usage report.
 */
import crypto from 'node:crypto';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

export async function runDefaultReply(io: FakeCodexIo, turn: FakeTurn, said: string) {
    const reasoning = { type: 'reasoning', id: crypto.randomUUID(), summary: [], content: [] };
    io.startItem(turn, { ...reasoning });
    /**
     * Real Codex announces every summary part, including the first, before streaming its text.
     */
    const summary = ['Thinking about it.', 'Checking the reply.'];
    for (const [summaryIndex, delta] of summary.entries()) {
        io.notifyTurn(turn, 'item/reasoning/summaryPartAdded', {
            turnId: turn.id,
            itemId: reasoning.id,
            summaryIndex,
        });
        io.notifyTurn(turn, 'item/reasoning/summaryTextDelta', {
            turnId: turn.id,
            itemId: reasoning.id,
            delta,
            summaryIndex,
        });
    }
    io.completeItem(turn, { ...reasoning, summary });
    io.notifyTurn(turn, 'turn/plan/updated', {
        turnId: turn.id,
        explanation: null,
        plan: [
            { step: 'Read the message', status: 'completed' },
            { step: 'Reply', status: 'inProgress' },
        ],
    });
    await io.streamMessage(turn, `Hello from fake Codex. You said: ${said}`, 0);
    io.notifyTurn(turn, 'thread/tokenUsage/updated', {
        turnId: turn.id,
        tokenUsage: {
            total: { totalTokens: 1200 },
            last: {
                totalTokens: 1200,
                inputTokens: 1150,
                cachedInputTokens: 900,
                outputTokens: 50,
            },
            modelContextWindow: 200000,
        },
    });
}
