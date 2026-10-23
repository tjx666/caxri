import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { observePowerSource } from './power-source';

/**
 * The suite runs under Vitest's `node` environment (no jsdom), so the document element's dataset and
 * `navigator.getBattery` are stubbed, as in `window-active.test.ts`.
 */
const dataset: { power?: string } = {};

function createBattery(isCharging: boolean) {
    return Object.assign(new EventTarget(), { charging: isCharging });
}

beforeEach(() => {
    delete dataset.power;
    vi.stubGlobal('document', { documentElement: { dataset } });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('observePowerSource', () => {
    it('marks the window while the machine runs on battery and clears it on AC power', async () => {
        const battery = createBattery(false);
        vi.stubGlobal('navigator', { getBattery: () => Promise.resolve(battery) });

        const stop = observePowerSource();
        await vi.waitFor(() => expect(dataset.power).toBe('battery'));

        battery.charging = true;
        battery.dispatchEvent(new Event('chargingchange'));
        expect(dataset.power).toBeUndefined();
        stop();
    });

    it('leaves full-rate motion in place when the Battery Status API is unavailable', async () => {
        vi.stubGlobal('navigator', {});

        const stop = observePowerSource();
        await Promise.resolve();

        expect(dataset.power).toBeUndefined();
        stop();
    });

    it('stops publishing once torn down', async () => {
        const battery = createBattery(true);
        vi.stubGlobal('navigator', { getBattery: () => Promise.resolve(battery) });

        const stop = observePowerSource();
        await Promise.resolve();
        await Promise.resolve();
        stop();
        battery.charging = false;
        battery.dispatchEvent(new Event('chargingchange'));

        expect(dataset.power).toBeUndefined();
    });
});
