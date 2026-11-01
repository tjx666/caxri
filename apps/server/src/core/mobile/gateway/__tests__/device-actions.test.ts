import type { DeviceActionRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DeviceActionListener } from '../device-actions';
import { DeviceActionBroker } from '../device-actions';

const DEVICE_A = 'device_a';
const DEVICE_B = 'device_b';
const exec = { kind: 'termuxExec' as const, argv: ['true'], timeoutMs: 1_000 };

const setup = (initial: Array<Omit<DeviceActionListener, 'deliver'>> = []) => {
    const delivered: Array<{ connectionId: string; request: DeviceActionRequest }> = [];
    const reports: unknown[][] = [];
    let isAccepts = true;
    let listeners: DeviceActionListener[] = [];
    const listen = (entries: Array<Omit<DeviceActionListener, 'deliver'>>) => {
        listeners = entries.map((entry) => ({
            ...entry,
            deliver: (request) => {
                delivered.push({ connectionId: entry.connectionId, request });
                return isAccepts;
            },
        }));
    };
    listen(initial);
    let id = 0;
    const broker = new DeviceActionBroker({
        listeners: () => listeners,
        now: () => 0,
        randomId: () => (id++).toString(16).padStart(32, '0'),
        report: (...entry) => reports.push(entry),
    });
    return {
        broker,
        delivered,
        listen,
        refuseDelivery: () => {
            isAccepts = false;
        },
        reports,
    };
};

const errorOf = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error) {
        return error as CaxriError;
    }
    throw new Error('expected a rejection');
};

afterEach(() => {
    vi.useRealTimers();
});

describe('DeviceActionBroker', () => {
    it('delivers to the one connected phone and resolves with its answer', async () => {
        const { broker, delivered, reports } = setup([{ connectionId: 'c1', deviceId: DEVICE_A }]);
        const pending = broker.request(undefined, exec);
        expect(delivered).toHaveLength(1);
        const { actionId } = delivered[0].request;
        expect(actionId).toMatch(/^action_[0-9a-f]{32}$/u);
        broker.complete(DEVICE_A, actionId, {
            status: 'exited',
            exitCode: 0,
            stdout: 'ok',
            stderr: '',
            truncated: false,
        });
        await expect(pending).resolves.toMatchObject({
            deviceId: DEVICE_A,
            outcome: { exitCode: 0 },
        });
        expect(reports).toEqual([['termuxExec', 'exited', 0, undefined]]);
    });

    it('fails at once with no listening phone, and asks for --device with several', async () => {
        const offline = setup();
        expect(() => offline.broker.request(undefined, exec)).toThrow(
            expect.objectContaining({ code: 'UNAVAILABLE', details: { reason: 'offline' } }),
        );
        const several = setup([
            { connectionId: 'c1', deviceId: DEVICE_A },
            { connectionId: 'c2', deviceId: DEVICE_B },
        ]);
        expect(() => several.broker.request(undefined, exec)).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }),
        );
        const named = several.broker.request(DEVICE_B, exec);
        expect(several.delivered.map((entry) => entry.connectionId)).toEqual(['c2']);
        several.broker.complete(DEVICE_B, several.delivered[0].request.actionId, {
            status: 'opened',
        });
        await expect(named).resolves.toMatchObject({ deviceId: DEVICE_B });
    });

    it('ignores an answer from another device', async () => {
        vi.useFakeTimers();
        const { broker, delivered } = setup([{ connectionId: 'c1', deviceId: DEVICE_A }]);
        const pending = broker.request(undefined, exec);
        broker.complete(DEVICE_B, delivered[0].request.actionId, { status: 'opened' });
        const error = errorOf(pending);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(await error).toMatchObject({ code: 'TIMEOUT' });
    });

    it('fails a pending action when its connection closes or delivery fails', async () => {
        const { broker, refuseDelivery, reports } = setup([
            { connectionId: 'c1', deviceId: DEVICE_A },
        ]);
        const pending = broker.request(undefined, exec);
        broker.connectionClosed('c1');
        expect(await errorOf(pending)).toMatchObject({ code: 'UNAVAILABLE' });
        refuseDelivery();
        expect(await errorOf(broker.request(undefined, exec))).toMatchObject({
            code: 'UNAVAILABLE',
        });
        expect(reports.map((entry) => entry[1])).toEqual(['disconnected', 'disconnected']);
    });

    it('waits past the command deadline before giving up on the phone', async () => {
        vi.useFakeTimers();
        const { broker } = setup([{ connectionId: 'c1', deviceId: DEVICE_A }]);
        let isSettled = false;
        const error = (async () => {
            const result = await errorOf(broker.request(undefined, { ...exec, timeoutMs: 10_000 }));
            isSettled = true;
            return result;
        })();
        await vi.advanceTimersByTimeAsync(14_000);
        expect(isSettled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await error).toBeInstanceOf(CaxriError);
        expect(await error).toMatchObject({ code: 'TIMEOUT', details: { reason: 'timeout' } });
    });
});
