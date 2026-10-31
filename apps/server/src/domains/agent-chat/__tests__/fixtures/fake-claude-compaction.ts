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
 * `compact mid turn`: a long turn Claude Code compacts twice on its own, with a command before, between, and after the
 * compactions and then the reply. Returns whether the turn was this scenario.
 */
export async function didRunCompactingTurn(
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
