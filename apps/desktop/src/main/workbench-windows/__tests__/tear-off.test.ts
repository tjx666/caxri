import { describe, expect, it, vi } from 'vitest';

import {
    cascadedBounds,
    createTearOffController,
    planCommandTearOff,
    planTearOff,
    TEAR_OFF_GRAB_OFFSET,
} from '../tear-off';

const SOURCE = { x: 100, y: 100, width: 1200, height: 800 };
const SIZE = { width: 1200, height: 800 };
const DISPLAY = { x: 0, y: 0, width: 2560, height: 1440 };

describe('planTearOff', () => {
    it('rejects a release inside the source window', () => {
        expect(
            planTearOff({
                point: { x: 500, y: 500 },
                sourceBounds: SOURCE,
                otherBounds: [],
                workAreas: [DISPLAY],
                size: SIZE,
            }),
        ).toEqual({ action: 'reject', reason: 'inside_window' });
    });

    it('rejects a release over another Workbench window', () => {
        const other = { x: 1500, y: 100, width: 800, height: 800 };
        expect(
            planTearOff({
                point: { x: 1600, y: 300 },
                sourceBounds: SOURCE,
                otherBounds: [other],
                workAreas: [DISPLAY],
                size: SIZE,
            }),
        ).toEqual({ action: 'reject', reason: 'over_other_window' });
    });

    it('puts the title bar under the cursor', () => {
        const plan = planTearOff({
            point: { x: 1400, y: 300 },
            sourceBounds: SOURCE,
            otherBounds: [],
            workAreas: [DISPLAY],
            size: SIZE,
        });
        expect(plan).toEqual({
            action: 'open',
            bounds: {
                x: 1400 - TEAR_OFF_GRAB_OFFSET.x,
                y: 300 - TEAR_OFF_GRAB_OFFSET.y,
                width: 1200,
                height: 800,
            },
        });
    });

    it('clamps the window into the display work area', () => {
        const plan = planTearOff({
            point: { x: 2500, y: 1400 },
            sourceBounds: SOURCE,
            otherBounds: [],
            workAreas: [DISPLAY],
            size: SIZE,
        });
        expect(plan).toEqual({
            action: 'open',
            bounds: { x: 2560 - 1200, y: 1440 - 800, width: 1200, height: 800 },
        });
    });

    it('shrinks a window larger than the display and honors negative multi-display coordinates', () => {
        const left = { x: -1280, y: 0, width: 1280, height: 720 };
        const plan = planTearOff({
            point: { x: -600, y: 300 },
            sourceBounds: SOURCE,
            otherBounds: [],
            workAreas: [left, DISPLAY],
            size: SIZE,
        });
        expect(plan).toEqual({
            action: 'open',
            bounds: { x: -1200, y: 0, width: 1200, height: 720 },
        });
    });

    it('lands a release in a display gap on the nearest display', () => {
        const plan = planTearOff({
            point: { x: 2600, y: 100 },
            sourceBounds: SOURCE,
            otherBounds: [],
            workAreas: [DISPLAY],
            size: SIZE,
        });
        expect(plan.action).toBe('open');
        if (plan.action === 'open')
            expect(plan.bounds.x + plan.bounds.width).toBeLessThanOrEqual(2560);
    });
});

describe('cascadedBounds', () => {
    it('steps each restored window below and right of the primary', () => {
        expect(cascadedBounds(SOURCE, 0, [DISPLAY])).toMatchObject({ x: 130, y: 130 });
        expect(cascadedBounds(SOURCE, 1, [DISPLAY])).toMatchObject({ x: 160, y: 160 });
    });

    it('keeps the cascade inside the display', () => {
        const bounds = cascadedBounds({ x: 1300, y: 600, width: 1200, height: 800 }, 3, [DISPLAY]);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(2560);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(1440);
    });
});

describe('planCommandTearOff', () => {
    it('cascades from the source window without any point or refusal', () => {
        expect(
            planCommandTearOff({
                sourceBounds: SOURCE,
                size: SIZE,
                otherWindowCount: 0,
                workAreas: [DISPLAY],
            }),
        ).toEqual({ action: 'open', bounds: { x: 130, y: 130, width: 1200, height: 800 } });
    });

    it('steps further for each other window and stays inside the display', () => {
        const plan = planCommandTearOff({
            sourceBounds: { x: 1300, y: 600, width: 1200, height: 800 },
            size: SIZE,
            otherWindowCount: 3,
            workAreas: [DISPLAY],
        });
        expect(plan.action).toBe('open');
        if (plan.action !== 'open') return;
        expect(plan.bounds.x + plan.bounds.width).toBeLessThanOrEqual(2560);
        expect(plan.bounds.y + plan.bounds.height).toBeLessThanOrEqual(1440);
    });
});

function harness(overrides: { moveSession?: () => Promise<unknown> } = {}) {
    const events: string[] = [];
    const destroy = vi.fn(() => events.push('destroy'));
    const writes: Array<{ event: string; reason?: unknown }> = [];
    let placementSettled: 'pending' | 'resolved' | 'rejected' = 'pending';
    const controller = createTearOffController({
        createWindow: ({ placement }) => {
            events.push('create');
            // eslint-disable-next-line unicorn/prefer-await, unicorn/prefer-then-catch -- observing a gate, not awaiting it
            placement.then(
                () => (placementSettled = 'resolved'),
                () => (placementSettled = 'rejected'),
            );
            return { destroy };
        },
        cursorPoint: () => ({ x: 1800, y: 1000 }),
        discardWindow: () => events.push('discard'),
        logger: () =>
            ({
                write: (
                    _level: string,
                    event: string,
                    options?: { fields?: { reason?: unknown } },
                ) => {
                    writes.push({ event, reason: options?.fields?.reason });
                },
            }) as never,
        mintKey: () => 'win-test',
        moveSession:
            overrides.moveSession ??
            (() => {
                events.push('move');
                return Promise.resolve();
            }),
        otherBounds: () => [],
        sourceBounds: () => ({ bounds: SOURCE, size: SIZE }),
        workAreas: () => [DISPLAY],
    });
    return { controller, destroy, events, writes, settled: () => placementSettled };
}

describe('createTearOffController', () => {
    it('creates the hidden window before moving, then shows it only after the move', async () => {
        const { controller, events, settled, writes } = harness();
        const result = await controller.tearOff({ sourceKey: 'main', sessionId: 's1' });
        await Promise.resolve();
        expect(result).toEqual({ opened: true });
        expect(events).toEqual(['create', 'move']);
        expect(settled()).toBe('resolved');
        expect(writes.map((write) => write.event)).toContain('window.tear_off_opened');
    });

    it('destroys the window and never keeps a second owner when the move is refused', async () => {
        const refusal = Object.assign(new Error('last tab'), { details: { reason: 'last_tab' } });
        const { controller, destroy, events, settled, writes } = harness({
            moveSession: () => Promise.reject(refusal),
        });
        const result = await controller.tearOff({ sourceKey: 'main', sessionId: 's1' });
        await Promise.resolve();
        expect(result).toEqual({ opened: false });
        expect(events).toEqual(['create', 'discard', 'destroy']);
        expect(destroy).toHaveBeenCalledOnce();
        expect(settled()).toBe('rejected');
        expect(writes.find((write) => write.event === 'window.tear_off_rejected')?.reason).toBe(
            'last_tab',
        );
    });

    it('reports an unclassified Server failure as window_failed', async () => {
        const { controller, writes } = harness({
            moveSession: () => Promise.reject(new Error('boom')),
        });
        await controller.tearOff({ sourceKey: 'main', sessionId: 's1' });
        expect(writes.find((write) => write.event === 'window.tear_off_rejected')?.reason).toBe(
            'window_failed',
        );
    });

    it('creates nothing when the point is inside the source window', async () => {
        const { controller, events } = harness();
        const result = await controller.tearOff({
            sourceKey: 'main',
            sessionId: 's1',
            screenPoint: { x: 500, y: 500 },
        });
        expect(result).toEqual({ opened: false });
        expect(events).toEqual([]);
    });

    it('opens a cascaded window for a command placement even though the cursor is over the source', async () => {
        const { controller, events } = harness();
        const result = await controller.tearOff({
            sourceKey: 'main',
            sessionId: 's1',
            placement: 'cascade',
        });
        expect(result).toEqual({ opened: true });
        expect(events).toEqual(['create', 'move']);
    });
});
