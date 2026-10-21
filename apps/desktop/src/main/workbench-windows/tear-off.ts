import { randomUUID } from 'node:crypto';

import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

interface TearOffPoint {
    x: number;
    y: number;
}

export interface TearOffRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Closed reasons a tear-off opens nothing, logged as `window.tear_off_rejected`.
 */
export type TearOffRejection = 'open_elsewhere' | 'shown_session' | 'window_failed';

const isInside = (rect: TearOffRect, point: TearOffPoint): boolean =>
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height;

const distanceToRect = (rect: TearOffRect, point: TearOffPoint): number => {
    const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
    const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
    return Math.hypot(dx, dy);
};

/**
 * The work area a point belongs to: the one containing it, else the nearest, so a drop in a gap between displays or
 * just past an edge still lands on a screen.
 */
function workAreaFor(
    workAreas: readonly TearOffRect[],
    point: TearOffPoint,
): TearOffRect | undefined {
    return (
        workAreas.find((area) => isInside(area, point)) ??
        workAreas.toSorted((a, b) => distanceToRect(a, point) - distanceToRect(b, point))[0]
    );
}

/**
 * Bounds for a Session opened in a new window: it cascades from the source window (30px per other window, clamped to
 * the display), since the command has no drop point to honor.
 */
export function planNewWindowBounds(input: {
    sourceBounds: TearOffRect;
    size: { width: number; height: number };
    otherWindowCount: number;
    workAreas: readonly TearOffRect[];
}): TearOffRect {
    const { sourceBounds, size, otherWindowCount, workAreas } = input;
    return cascadedBounds(
        { ...sourceBounds, width: size.width, height: size.height },
        Math.min(otherWindowCount, 8),
        workAreas,
    );
}

/**
 * Bounds for a torn-off window restored at launch. Per-window bounds are not persisted yet, so each reopens cascaded
 * below and right of the primary window, clamped to the display like a fresh tear-off.
 */
export function cascadedBounds(
    primary: TearOffRect,
    index: number,
    workAreas: readonly TearOffRect[],
): TearOffRect {
    const step = 30 * (index + 1);
    const area = workAreaFor(workAreas, { x: primary.x, y: primary.y });
    const x = primary.x + step;
    const y = primary.y + step;
    if (!area) return { ...primary, x, y };
    return {
        ...primary,
        x: Math.min(Math.max(x, area.x), area.x + Math.max(area.width - primary.width, 0)),
        y: Math.min(Math.max(y, area.y), area.y + Math.max(area.height - primary.height, 0)),
    };
}

export interface TearOffWindowHandle {
    destroy(): void;
}

export interface TearOffControllerOptions<W extends TearOffWindowHandle> {
    /**
     * Creates and registers a hidden Workbench window under `windowKey`. The window shows itself once `placement`
     * resolves and stays hidden when it rejects.
     */
    createWindow(input: {
        windowKey: string;
        sessionId: string;
        bounds: TearOffRect;
        placement: Promise<void>;
    }): W;
    logger: () => StructuredLogger | undefined;
    mintKey?(): string;
    /**
     * Moves the Session in one Server transaction. Rejects with the Server's classified refusal when it cannot.
     */
    moveSession: (input: {
        sourceKey: string;
        targetKey: string;
        sessionId: string;
    }) => Promise<unknown>;
    now?: () => number;
    /**
     * The geometry of the source window and the other live Workbench windows.
     */
    sourceBounds: (
        windowKey: string,
    ) => { bounds: TearOffRect; size: { width: number; height: number } } | undefined;
    otherBounds: (excludeKey: string) => TearOffRect[];
    workAreas: () => TearOffRect[];
    /**
     * Forgets a window whose move failed, before it is destroyed.
     */
    discardWindow: (windowKey: string) => void;
}

function refusalReason(error: unknown): TearOffRejection {
    const reason =
        typeof error === 'object' && error !== null && 'details' in error
            ? (error.details as { reason?: unknown } | undefined)?.reason
            : undefined;
    return reason === 'open_elsewhere' || reason === 'shown_session' ? reason : 'window_failed';
}

/**
 * Opens one Session in a new window so a Session is never left in zero or two windows: the hidden window exists first,
 * the Server move runs second, and the window only shows once the move succeeded. A failed move destroys the window and
 * leaves the Server's strips as they were, because the move is one transaction.
 */
export function createTearOffController<W extends TearOffWindowHandle>(
    options: TearOffControllerOptions<W>,
) {
    const now = options.now ?? (() => performance.now());
    const reject = (reason: TearOffRejection): { opened: false } => {
        options.logger()?.write('info', logEventCatalog.window.tearOffRejected, {
            fields: { reason },
        });
        return { opened: false };
    };
    return {
        async tearOff(input: {
            sourceKey: string;
            sessionId: string;
        }): Promise<{ opened: boolean }> {
            const startedAt = now();
            const source = options.sourceBounds(input.sourceKey);
            if (!source) return reject('window_failed');
            const bounds = planNewWindowBounds({
                sourceBounds: source.bounds,
                size: source.size,
                otherWindowCount: options.otherBounds(input.sourceKey).length,
                workAreas: options.workAreas(),
            });
            const windowKey = options.mintKey?.() ?? `win-${randomUUID()}`;
            const moved = Promise.withResolvers<void>();
            // Rejections are handled below; this keeps an unhandled-rejection report off the hidden window's gate.
            // eslint-disable-next-line unicorn/prefer-await -- detached handler, nothing to await
            moved.promise.catch(() => {});
            let window: W;
            try {
                window = options.createWindow({
                    windowKey,
                    sessionId: input.sessionId,
                    bounds,
                    placement: moved.promise,
                });
            } catch {
                return reject('window_failed');
            }
            try {
                await options.moveSession({
                    sourceKey: input.sourceKey,
                    targetKey: windowKey,
                    sessionId: input.sessionId,
                });
            } catch (error) {
                moved.reject(error);
                options.discardWindow(windowKey);
                window.destroy();
                return reject(refusalReason(error));
            }
            moved.resolve();
            options.logger()?.write('info', logEventCatalog.window.tearOffOpened, {
                durationMs: now() - startedAt,
            });
            return { opened: true };
        },
    };
}
