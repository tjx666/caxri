/**
 * The fake Codex `burststream` replies: a reply arriving in a few large deltas 400ms apart, the way a phone on a
 * cellular or VPN link receives a stream in clumps. With `clip` it also passes the phone's clip and crosses a window
 * re-read (#2682); with `end` its last delta is a long paragraph the reply completes with at once (#3781).
 */
import crypto from 'node:crypto';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The `burststream` reply: seven paragraphs cut into 23 uneven deltas of 30 to 140 characters, long enough (about ten
 * seconds at 400ms apart) for a recording to show whether text keeps typing between deltas.
 */
const BURST_STREAM_DELTAS = [
    'Here is how the stream pacing works. Providers deliver ',
    'text in uneven bursts: a few words, then nothing for a while, then a whole sentence or two at once. ',
    'Drawing each burst as it lands makes a reply stutter.\n\n',
    'The pacer reveals what arrived a little behind it, ',
    'a share of the hidden text on every frame, so a burst eases in over a few frames while a steady stream stays only a few characters behind. ',
    'It never holds text back for long.\n\n',
    'On a phone the same stream crosses a cellular or VPN link, ',
    'and the network often hands it over in clumps: nothing for a few hundred milliseconds, ',
    'then several deltas together. ',
    'Draining each clump quickly and then waiting for the next one reads as blocks of text jumping in.\n\n',
    'So the pacer watches how far apart the clumps land ',
    'and how much text each one brings. ',
    'It stretches its window to cover the gap and keeps revealing at about the rate text arrives, ',
    'so the reply keeps typing between clumps instead of stopping.\n\n',
    'A paragraph that lands all at once still eases in over a few frames, ',
    'because the followed rate has a ceiling. ',
    'A long pause, such as a tool running or the model thinking, ',
    'teaches the pacer nothing about the link, so the next reply starts from the usual short window.\n\n',
    'Text that already arrived never waits long: ',
    'the window never stretches past a fraction of a second, ',
    'so a reader on a slow link sees the reply a moment late but never sees it stall.\n\n',
    'When the turn completes, fails, or is interrupted, ',
    'everything that arrived shows at once, so the reply is never left half drawn after the Agent has stopped.',
];

/**
 * The `burststreamend` closing paragraph (#3781): about 600 characters that land in the reply's last delta, with the
 * reply completing at once, so the phone still has the whole paragraph to show when the stream ends.
 */
const BURST_STREAM_END_PARAGRAPH = Array.from(
    { length: 6 },
    (_, index) =>
        `Closing sentence ${index + 1} arrives in the last delta together with the end of the reply, and still types out. `,
).join('');

/**
 * The `burststreamclip` lead-in: 32 numbered lines of about 150 characters, which carry the reply past the phone's
 * 4,000-character clip before {@link CLIPPED_STREAM_LANDING} arrives.
 */
const CLIPPED_STREAM_LEAD_IN = Array.from(
    { length: 32 },
    (_, index) =>
        `Line ${String(index + 1).padStart(2, '0')}: the reply grows past what one phone window keeps, so the phone shows only its newest part behind a marker.\n\n`,
);

/**
 * The paragraph that arrives together with the oversized command output, so it is still easing in when the phone
 * re-reads its window.
 */
const CLIPPED_STREAM_LANDING = Array.from(
    { length: 8 },
    (_, index) =>
        `Sentence ${index + 1} of the landing paragraph arrived in the same moment as a command's large output, and keeps typing after the phone re-reads its window. `,
).join('');

/**
 * More than a phone frame holds (`MOBILE_AGENT_CHAT_MAX_BYTES`, 48 KiB), so the Gateway sends a content-free change
 * notice instead of the patch carrying it.
 */
const OVERSIZED_COMMAND_OUTPUT = `${'build output line\n'.repeat(3_500)}`;

/**
 * The `burststream` turn: {@link BURST_STREAM_DELTAS} 400ms apart. With `isClipped` (`burststreamclip`, #2682), the
 * reply first passes the phone's clip; then a command's output too large for one phone frame lands beside a long
 * paragraph of the reply, so the phone re-reads a window whose clipped reply starts later than the one it shows. With
 * `isEnding` (`burststreamend`, #3781), the last delta carries {@link BURST_STREAM_END_PARAGRAPH} and the reply
 * completes in the same moment, so the phone's stream ends with that paragraph still hidden.
 */
export async function runBurstStream(
    io: FakeCodexIo,
    turn: FakeTurn,
    { isClipped, isEnding = false }: { isClipped: boolean; isEnding?: boolean },
) {
    if (!isClipped && !isEnding) {
        await io.streamMessage(turn, BURST_STREAM_DELTAS, 400);
        return;
    }
    const reply = { type: 'agentMessage', id: crypto.randomUUID(), text: '' };
    io.startItem(turn, { ...reply });
    const say = (delta: string) => {
        reply.text += delta;
        io.notifyTurn(turn, 'item/agentMessage/delta', {
            turnId: turn.id,
            itemId: reply.id,
            delta,
        });
    };
    if (isEnding) {
        for (const delta of BURST_STREAM_DELTAS.slice(0, 10)) {
            if (turn.interrupted) return;
            say(delta);
            // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
            await delay(400);
        }
        say(`\n\n${BURST_STREAM_END_PARAGRAPH}`);
        io.completeItem(turn, reply);
        return;
    }
    for (const line of CLIPPED_STREAM_LEAD_IN) {
        if (turn.interrupted) return;
        say(line);
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        await delay(400);
    }
    const command = {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: '/bin/zsh -lc "bun run build"',
        cwd: process.cwd(),
        status: 'inProgress',
    };
    io.startItem(turn, command);
    io.notifyTurn(turn, 'item/commandExecution/outputDelta', {
        turnId: turn.id,
        itemId: command.id,
        delta: OVERSIZED_COMMAND_OUTPUT,
    });
    say(CLIPPED_STREAM_LANDING);
    await delay(400);
    io.completeItem(turn, {
        ...command,
        status: 'completed',
        aggregatedOutput: OVERSIZED_COMMAND_OUTPUT,
        exitCode: 0,
        durationMs: 400,
    });
    const closing = BURST_STREAM_DELTAS.slice(-5);
    for (const delta of closing) {
        if (turn.interrupted) return;
        say(delta);
        // eslint-disable-next-line no-await-in-loop -- chunks stream one at a time on purpose
        await delay(400);
    }
    io.completeItem(turn, reply);
}
