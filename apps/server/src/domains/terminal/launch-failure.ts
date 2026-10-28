import type { TerminalFailureReason, TerminalRecord } from '@caxri/protocol';
import { errorMessage, toWireError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { isPtyAllocationError, logEventCatalog, samplePtyUsage } from '@caxri/system';

import type { TerminalManagerOptions } from './manager-types';
import type { TerminalStateStore } from './state-store';

/**
 * Slots that may free up between a failed PTY allocation and the reading taken right after it: a Terminal or Agent
 * command exiting in that window must not hide that the machine was out of PTYs.
 */
const PTY_EXHAUSTION_MARGIN = 2;

/**
 * Whether the machine is out of PTY slots right now. A reading that fails or is unavailable counts as "not proven", so
 * an unrelated launch failure is never blamed on PTYs.
 */
export async function isMachinePtyExhausted(
    sample: () => Promise<{ inUse: number; limit: number } | undefined> = samplePtyUsage,
): Promise<boolean> {
    try {
        const usage = await sample();
        return usage !== undefined && usage.inUse >= usage.limit - PTY_EXHAUSTION_MARGIN;
    } catch {
        return false;
    }
}

interface TerminalLaunchFailure {
    durationMs: number;
    error: unknown;
    failureDetail: string | undefined;
    /**
     * The reason launch resolution or preparation already established; `spawn_failed` when the failure came later.
     */
    failureReason: TerminalFailureReason;
    record: TerminalRecord;
}

/**
 * Persists and logs a failed Terminal launch. A PTY allocation failure becomes `pty_exhausted` only when a fresh
 * reading confirms the machine is out of PTY slots, so the Terminal pane can tell the user to close Terminals instead
 * of showing a generic launch error.
 */
export async function recordTerminalLaunchFailure(
    context: {
        database: TerminalStateStore;
        isPtyExhausted: TerminalManagerOptions['isPtyExhausted'];
        logger: StructuredLogger;
    },
    { durationMs, error, failureDetail, record, ...failure }: TerminalLaunchFailure,
): Promise<void> {
    let { failureReason } = failure;
    if (
        failureReason === 'spawn_failed' &&
        isPtyAllocationError(errorMessage(error, '')) &&
        (await (context.isPtyExhausted ?? isMachinePtyExhausted)())
    )
        failureReason = 'pty_exhausted';
    if (context.database.getTerminal(record.id))
        context.database.updateTerminalState(record.id, 'failed', failureReason, failureDetail);
    context.logger.write('error', logEventCatalog.pty.spawnFailed, {
        durationMs,
        fields: {
            code: toWireError(error).code,
            terminalId: record.id,
            kind: record.kind,
            failureReason,
            error: errorMessage(error, 'unknown'),
        },
    });
}
