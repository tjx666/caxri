import { TERMINAL_WHEEL_MAX_LINES } from './view-scale';

interface TerminalWheel {
    col: number;
    lines: number;
    row: number;
}

/**
 * Keeps at most one scroll request in flight and folds every drag frame that arrives meanwhile into the next one, so a
 * fling over a slow connection cannot queue a backlog of stale scroll requests.
 */
export const createTerminalWheelQueue = (
    send: (wheel: TerminalWheel) => Promise<unknown>,
    onError: (error: unknown) => void,
) => {
    const pending: TerminalWheel = { col: 1, lines: 0, row: 1 };
    let isSending = false;
    const drain = async (): Promise<void> => {
        isSending = true;
        try {
            while (pending.lines !== 0) {
                const lines = Math.max(
                    -TERMINAL_WHEEL_MAX_LINES,
                    Math.min(TERMINAL_WHEEL_MAX_LINES, pending.lines),
                );
                pending.lines -= lines;
                // eslint-disable-next-line no-await-in-loop -- Scroll frames must reach the application in order.
                await send({ col: pending.col, lines, row: pending.row });
            }
        } catch (error) {
            pending.lines = 0;
            onError(error);
        } finally {
            isSending = false;
        }
    };
    return {
        add(wheel: TerminalWheel): void {
            pending.lines += wheel.lines;
            pending.col = wheel.col;
            pending.row = wheel.row;
            // eslint-disable-next-line no-void -- Failures are reported through `onError`.
            if (!isSending) void drain();
        },
    };
};
