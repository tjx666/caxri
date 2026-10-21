import { randomUUID } from 'node:crypto';

import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

export interface TearOffPoint {
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
export type TearOffRejection =
    'inside_window' | 'last_tab' | 'not_open' | 'over_other_window' | 'window_failed';

export type TearOffPlan =
    { action: 'open'; bounds: TearOffRect } | { action: 'reject'; reason: TearOffRejection };

/**
 * Where inside the new window the dragged tab's grab point lands: the window opens with its title bar under the cursor,
 * the way VS Code offsets an auxiliary window by the tab's own offset (`maybeCreateAuxiliaryEditorPartAt`).
 */
export const TEAR_OFF_GRAB_OFFSET: TearOffPoint = { x: 80, y: 20 };

const MIN_WINDOW_WIDTH = 960;
const MIN_WINDOW_HEIGHT = 640;

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
 * Decides whether releasing a dragged tab at `point` opens a window and where. Pure, so the placement rules run under
 * Vitest without Electron.
 *
 * - Released over the source window (a cancelled or mis-aimed drag) or over another Workbench window (merging into it is
 *   not supported) opens nothing.
 * - Otherwise the window keeps the source window's normal size, shrunk to fit the display under the point, and is moved
 *   so its title bar sits under the cursor and the whole window stays inside that display's work area.
 */
export function planTearOff(input: {
    point: TearOffPoint;
    sourceBounds: TearOffRect;
    otherBounds: readonly TearOffRect[];
    workAreas: readonly TearOffRect[];
    size: { width: number; height: number };
}): TearOffPlan {
    const { point, sourceBounds, otherBounds, workAreas, size } = input;
    if (isInside(sourceBounds, point)) return { action: 'reject', reason: 'inside_window' };
    if (otherBounds.some((bounds) => isInside(bounds, point)))
        return { action: 'reject', reason: 'over_other_window' };
    const area = workAreaFor(workAreas, point);
    const width = Math.min(Math.max(size.width, MIN_WINDOW_WIDTH), area?.width ?? size.width);
    const height = Math.min(Math.max(size.height, MIN_WINDOW_HEIGHT), area?.height ?? size.height);
    const wantedX = point.x - TEAR_OFF_GRAB_OFFSET.x;
    const wantedY = point.y - TEAR_OFF_GRAB_OFFSET.y;
    if (!area) return { action: 'open', bounds: { x: wantedX, y: wantedY, width, height } };
    return {
        action: 'open',
        bounds: {
            x: Math.min(Math.max(wantedX, area.x), area.x + area.width - width),
            y: Math.min(Math.max(wantedY, area.y), area.y + area.height - height),
            width,
            height,
        },
    };
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
     * Native cursor, used when the Renderer's `dragend` carried no usable point.
     */
    cursorPoint: () => TearOffPoint;
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
    return reason === 'last_tab' || reason === 'not_open' ? reason : 'window_failed';
}

/**
 * Orchestrates one tab tear-off so a Session is never left in zero or two windows: the hidden window exists first, the
 * Server move runs second, and the window only shows once the move succeeded. A failed move destroys the window and
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
            screenPoint?: TearOffPoint;
        }): Promise<{ opened: boolean }> {
            const startedAt = now();
            const source = options.sourceBounds(input.sourceKey);
            if (!source) return reject('window_failed');
            const plan = planTearOff({
                point: input.screenPoint ?? options.cursorPoint(),
                sourceBounds: source.bounds,
                otherBounds: options.otherBounds(input.sourceKey),
                workAreas: options.workAreas(),
                size: source.size,
            });
            if (plan.action === 'reject') return reject(plan.reason);
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
                    bounds: plan.bounds,
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
