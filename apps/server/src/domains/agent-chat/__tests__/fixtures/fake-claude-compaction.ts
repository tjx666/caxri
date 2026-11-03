import crypto from 'node:crypto';

import type { FakeClaudeIo } from './fake-claude-io';

const delay = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * The sizes a `/compact` of the large-context turn reports, so the context drops below the suggestion threshold the way
 * a real compaction's `post_tokens` makes it.
 */
const LARGE_CONTEXT_COMPACTION = { pre_tokens: 141_240, post_tokens: 12_480 };

/**
 * The `/compact` command after it reported `compacting`: `break` in the command fails it the way Claude Code reports a
 * conversation too short to compact, anything else compacts. Compacting right after a large-context turn reports the
 * context's sizes, as Claude Code's `compact_metadata` does; otherwise the boundary carries none, so the total stays.
 */
export async function runCompactCommand(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
    isLargeContext = false,
) {
    await delay(300);
    if (text.includes('break')) {
        io.system('status', {
            status: null,
            compact_result: 'failed',
            compact_error: 'Not enough messages to compact.',
        });
        io.result(startedAt, 'Compaction failed.', true);
        return;
    }
    io.system(
        'compact_boundary',
        isLargeContext
            ? { compact_metadata: { trigger: 'manual', ...LARGE_CONTEXT_COMPACTION } }
            : undefined,
    );
    io.record({ type: 'system', subtype: 'compact_boundary' });
    io.system('status', { status: null, compact_result: 'success' });
    io.result(startedAt, 'Compacted.');
}

const MID_TURN_COMPACTIONS = [
    { pre_tokens: 250_270, post_tokens: 23_195 },
    { pre_tokens: 247_152, post_tokens: 29_395 },
];

/**
 * `compact first`: Claude Code compacts on its own before it reads the prompt, as it does when the context is already
 * past its threshold, then replies. The compaction holds while `isHeld` says so, so a spec can see the Chat mid-way.
 * Returns whether the turn was this scenario.
 */
async function didRunCompactFirstTurn(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
    isHeld: () => boolean,
): Promise<boolean> {
    if (!text.includes('compact first')) return false;
    io.system('status', { status: 'compacting' });
    // eslint-disable-next-line no-await-in-loop -- polls the spec's control file, like `hold-reply`
    while (isHeld()) await delay(100);
    io.system('compact_boundary', {
        compact_metadata: { trigger: 'auto', ...MID_TURN_COMPACTIONS[0] },
    });
    io.record({ type: 'system', subtype: 'compact_boundary' });
    io.system('status', { status: null, compact_result: 'success' });
    await io.didStreamFully('Picked up your message after compacting.', 0);
    io.result(startedAt, 'done');
    return true;
}

/**
 * `compact mid turn`: a long turn Claude Code compacts twice on its own, with a command before, between, and after the
 * compactions and then the reply. Returns whether the turn was this scenario.
 */
async function didRunCompactingTurn(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
): Promise<boolean> {
    if (!text.includes('compact mid turn')) return false;
    for (const [index, command] of ['git status', 'bun run test', 'git diff --stat'].entries()) {
        const id = `toolu_${crypto.randomUUID()}`;
        io.assistant(`msg_${crypto.randomUUID()}`, {
            type: 'tool_use',
            id,
            name: 'Bash',
            input: { command, description: `Step ${index + 1}` },
        });
        io.toolResult(id, 'ok');
        // eslint-disable-next-line no-await-in-loop -- the steps arrive one at a time, like a real turn
        await delay(200);
        if (index >= MID_TURN_COMPACTIONS.length) continue;
        io.system('compact_boundary', {
            compact_metadata: { trigger: 'auto', ...MID_TURN_COMPACTIONS[index] },
        });
        io.record({ type: 'system', subtype: 'compact_boundary' });
        // eslint-disable-next-line no-await-in-loop -- the steps arrive one at a time, like a real turn
        await delay(200);
    }
    await io.didStreamFully('Finished after two compactions.', 0);
    io.result(startedAt, 'done');
    return true;
}

/**
 * The turns in which Claude Code compacts on its own (`compact first`, `compact mid turn`); `isControlled` reads the
 * spec's control files (`hold-compaction`). Returns whether the turn was one of them.
 */
export async function didRunCompactionTurn(
    io: FakeClaudeIo,
    startedAt: number,
    text: string,
    isControlled: (name: string) => boolean,
): Promise<boolean> {
    return (
        (await didRunCompactFirstTurn(io, startedAt, text, () =>
            isControlled('hold-compaction'),
        )) || didRunCompactingTurn(io, startedAt, text)
    );
}
