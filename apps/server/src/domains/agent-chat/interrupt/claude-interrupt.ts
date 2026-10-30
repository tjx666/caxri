import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { CaxriError } from '@caxri/protocol';

import { withTimeout } from '../providers/claude/prompt-queue';

/**
 * An interrupt that Claude Code never acknowledges stops the process instead, so the Chat cannot stay stuck in a
 * running turn. A stopped turn gets as long again to end after the acknowledgment.
 */
const INTERRUPT_TIMEOUT_MS = 10_000;

/**
 * Asks Claude Code to abort the running turn. Resolves `true` when it never answered in time, so the caller stops the
 * process.
 */
export async function didClaudeInterruptTimeout(stream: Query): Promise<boolean> {
    try {
        await withTimeout(stream.interrupt(), INTERRUPT_TIMEOUT_MS);
    } catch (error) {
        return error instanceof CaxriError && error.code === 'TIMEOUT';
        // Otherwise the turn already ended; its `result` settles the projection.
    }
    return false;
}

/**
 * Stops the running turn and resolves once it ended, so the command that needed it gone runs next. `ended` is taken
 * before the interrupt so a turn ending at once is not missed. An interrupt Claude Code never acknowledged closes the
 * process, which ends no turn, so its exit also settles the wait; the caller's send then fails on the closed session.
 */
export async function stopClaudeTurn(
    ended: Promise<void>,
    interrupt: () => Promise<void>,
    exited: Promise<void> | undefined,
): Promise<void> {
    await interrupt();
    await withTimeout(Promise.race([ended, exited ?? Promise.resolve()]), INTERRUPT_TIMEOUT_MS);
}
