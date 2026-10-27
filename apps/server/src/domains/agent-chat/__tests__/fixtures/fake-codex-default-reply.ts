/**
 * The fake Codex app-server's reply to a message no scenario claims: reasoning, a plan, and a streamed reply quoting
 * the message, then a token usage report. A `hookfeedback` message plays Codex's non-item feedback instead
 * (`fake-codex-feedback.ts`).
 */
import crypto from 'node:crypto';

import { runProviderFeedback } from './fake-codex-feedback.ts';
import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

/**
 * The reply to a `longreply` message: a first and a last line around eighty numbered paragraphs, about 4,800
 * characters, past the phone's 4,000-character window so the phone holds only its tail and a whole-message copy must
 * read the rest from Core.
 */
const LONG_REPLY_TEXT = [
    'Long reply first line.',
    ...Array.from(
        { length: 80 },
        (_, index) =>
            `Paragraph ${String(index + 1).padStart(2, '0')}: the phone keeps only the end of this reply.`,
    ),
    'Long reply last line.',
].join('\n\n');

export async function runDefaultReply(io: FakeCodexIo, turn: FakeTurn, said: string) {
    if (said.includes('hookfeedback')) return runProviderFeedback(io, turn);
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
    const reply = said.includes('longreply')
        ? LONG_REPLY_TEXT
        : `Hello from fake Codex. You said: ${said}`;
    await io.streamMessage(turn, reply, 0);
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
