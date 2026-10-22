/**
 * The `autocompact` scenario of the fake Codex app-server: the running turn compacts its context on its own, as Codex
 * does when a turn fills the window, then answers. A message steered in meanwhile is accepted at once but recorded only
 * after the compaction ends, which is when Codex takes pending input into the turn.
 */
import crypto from 'node:crypto';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

/**
 * Longer than the Desktop's 30-second pending-row bound (`AGENT_CHAT_PENDING_ACCEPTED_TTL_MS`), as a real compaction of
 * a full window can be.
 */
const AUTO_COMPACTION_MS = 40_000;

export async function runAutoCompact(io: FakeCodexIo, turn: FakeTurn) {
    const compaction = { type: 'contextCompaction', id: crypto.randomUUID() };
    turn.deferredSteers = [];
    io.startItem(turn, compaction);
    await new Promise((resolve) => setTimeout(resolve, AUTO_COMPACTION_MS));
    io.notifyTurn(turn, 'thread/tokenUsage/updated', {
        turnId: turn.id,
        tokenUsage: {
            total: { totalTokens: 1500 },
            last: { totalTokens: 300, inputTokens: 0, outputTokens: 0 },
            modelContextWindow: 200_000,
        },
    });
    io.completeItem(turn, compaction);
    const steers = turn.deferredSteers;
    turn.deferredSteers = undefined;
    for (const record of steers) record();
    await io.streamMessage(turn, 'Compacted, carrying on.', 0);
}
