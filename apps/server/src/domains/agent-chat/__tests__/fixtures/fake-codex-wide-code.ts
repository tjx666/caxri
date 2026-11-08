/**
 * The fake Codex `widecode` reply: a fenced block whose lines are wider than a phone, a quiet pause, then a slow tail
 * the reply keeps growing with, so a Client can check that a code block scrolls sideways while its reply still
 * streams.
 */
import crypto from 'node:crypto';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

/**
 * The block's text, as Copy puts it on the clipboard. Every line is wider than a phone screen.
 */
export const FAKE_CODEX_WIDE_CODE = [
    'admin sets   member limit   members { limitMode: "custom", limitUsd: 50, window: "monthly", resetsAt: "2026-12-01" }',
    'member sets  key limit      api_keys { spendingLimitUsd: 5, window: "daily", owner: "member", note: "test key" }',
    'request admitted only when the organization balance, the member limit, and the key limit all still have room left',
].join('\n');

/**
 * How long the reply holds still after its block, so a phone Acceptance case can read the settled layout through
 * UIAutomator before the tail keeps the screen from idling.
 */
const WIDE_CODE_PAUSE_MS = 6_000;

/**
 * The pause between the tail's words: about fifteen seconds for the whole tail, long enough to swipe the block while
 * the reply still grows.
 */
const WIDE_CODE_TAIL_WORD_MS = 500;

const WIDE_CODE_TAIL = Array.from({ length: 30 }, (_, index) => `word${index + 1}`).join(' ');

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams one reply item by hand, as `streamMessage` does, because a second `streamMessage` call would start a second
 * reply instead of pausing the first.
 */
export async function runWideCode(io: FakeCodexIo, turn: FakeTurn) {
    const item = { type: 'agentMessage', id: crypto.randomUUID(), text: '' };
    io.startItem(turn, { ...item });
    const send = (delta: string) => {
        item.text += delta;
        io.notifyTurn(turn, 'item/agentMessage/delta', { turnId: turn.id, itemId: item.id, delta });
    };
    send(`The limits stack like this:\n\n\`\`\`\n${FAKE_CODEX_WIDE_CODE}\n\`\`\`\n\n`);
    const deadline = Date.now() + WIDE_CODE_PAUSE_MS;
    // eslint-disable-next-line no-await-in-loop -- the pause polls so an interrupt ends it promptly
    while (!turn.interrupted && Date.now() < deadline) await delay(100);
    const words = `${WIDE_CODE_TAIL} Done.`.split(/(?<= )/u);
    for (const word of words) {
        if (turn.interrupted) return;
        send(word);
        // eslint-disable-next-line no-await-in-loop -- words stream one at a time on purpose
        await delay(WIDE_CODE_TAIL_WORD_MS);
    }
    io.completeItem(turn, item);
}
