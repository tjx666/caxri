import { TerminalImageOutputFilter } from './image-recovery';
import type { LiveTerminal, TerminalExecutionEvent } from './types';

/**
 * Emits a loss reason before clearing the old observer stream and its image filter.
 */
export const flushObserverOutput = (
    live: LiveTerminal,
    emit: (event: TerminalExecutionEvent) => void,
): void => {
    if (live.observers.size === 0) return;
    if (live.observerNeedsResync) {
        live.observerDroppedBytes = 0;
        emit({
            type: 'observerGap',
            terminalId: live.record.id,
            sequence: live.observerSequence++,
            reason: live.observerResyncReason ?? 'overflow',
        });
        live.observerOutputQueue.clear();
        live.observerImageOutput = new TerminalImageOutputFilter();
        live.observerNeedsResync = false;
        live.observerResyncReason = null;
        return;
    }
    if (live.observerOutputQueue.byteCount === 0) return;
    emit({
        type: 'observerOutput',
        terminalId: live.record.id,
        sequence: live.observerSequence++,
        data: live.observerOutputQueue.drain(),
    });
};
