import type { MobileDeviceRole } from '@caxri/protocol';

import type { TerminalControlTarget } from './control-input';
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
            if (!isSending) void drain();
        },
    };
};

/**
 * Only a control device may scroll a Terminal application. The Server refuses `mobile.terminal.scroll` from every other
 * role, so the document is told not to forward drags for them, and a wheel message that still arrives from a view or
 * reply device is dropped instead of becoming a refused request and an error message.
 */
export const canForwardTerminalWheel = (role: MobileDeviceRole | null): boolean =>
    role === 'control';

/**
 * Routes the document's forwarded drag frames to `mobile.terminal.scroll`. The queue is created on the first accepted
 * frame, and each request reads the current control target, so a frame that outlives its stream generation is dropped.
 *
 * @returns A handler that reports whether the frame was accepted for the given device role.
 */
export const createTerminalWheelForwarder = ({
    onError,
    request,
    target,
}: {
    onError: (error: unknown) => void;
    request: (
        method: 'mobile.terminal.scroll',
        parameters: TerminalControlTarget & TerminalWheel,
    ) => Promise<unknown>;
    target: () => TerminalControlTarget | null;
}) => {
    let queue: ReturnType<typeof createTerminalWheelQueue> | undefined;
    return (role: MobileDeviceRole | null, wheel: TerminalWheel): boolean => {
        if (!canForwardTerminalWheel(role)) return false;
        queue ??= createTerminalWheelQueue(async (next) => {
            const current = target();
            if (current) await request('mobile.terminal.scroll', { ...current, ...next });
        }, onError);
        queue.add(wheel);
        return true;
    };
};
