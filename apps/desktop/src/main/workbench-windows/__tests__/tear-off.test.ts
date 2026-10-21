import { describe, expect, it, vi } from 'vitest';

import { cascadedBounds, createTearOffController, planNewWindowBounds } from '../tear-off';

const SOURCE = { x: 100, y: 100, width: 1200, height: 800 };
const SIZE = { width: 1200, height: 800 };
const DISPLAY = { x: 0, y: 0, width: 2560, height: 1440 };

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

describe('planNewWindowBounds', () => {
    it('cascades from the source window', () => {
        expect(
            planNewWindowBounds({
                sourceBounds: SOURCE,
                size: SIZE,
                otherWindowCount: 0,
                workAreas: [DISPLAY],
            }),
        ).toEqual({ x: 130, y: 130, width: 1200, height: 800 });
    });

    it('steps further for each other window and stays inside the display', () => {
        const bounds = planNewWindowBounds({
            sourceBounds: { x: 1300, y: 600, width: 1200, height: 800 },
            size: SIZE,
            otherWindowCount: 3,
            workAreas: [DISPLAY],
        });
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(2560);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(1440);
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
        const refusal = Object.assign(new Error('shown'), { details: { reason: 'shown_session' } });
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
            'shown_session',
        );
    });

    it('reports a Session another window owns as open_elsewhere', async () => {
        const refusal = Object.assign(new Error('owned'), {
            details: { reason: 'open_elsewhere' },
        });
        const { controller, writes } = harness({ moveSession: () => Promise.reject(refusal) });
        await controller.tearOff({ sourceKey: 'main', sessionId: 's1' });
        expect(writes.find((write) => write.event === 'window.tear_off_rejected')?.reason).toBe(
            'open_elsewhere',
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
});
