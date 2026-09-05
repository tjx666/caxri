import type { StructuredLogger } from '@caxri/system';
import type { Notification as ElectronNotification } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createAgentNotificationDelivery,
    isUnsignedOrAdHocSignature,
} from '../agent-notification-delivery';
import type { AgentSystemNotification } from '../agent-notifications';
import type { AlerterNotificationDriver } from '../alerter-notification';

const notification: AgentSystemNotification = {
    body: 'Claude Code is waiting for your input.',
    id: 'caxri-agent-session-session-1',
    title: 'Background session',
};

class FakeNativeNotification {
    static supported = true;
    static supportError = false;
    static instances: FakeNativeNotification[] = [];

    static isSupported(): boolean {
        if (this.supportError) throw new Error('Support probe failed');
        return this.supported;
    }

    private readonly listeners = new Map<string, Set<(...arguments_: unknown[]) => void>>();
    readonly close = vi.fn();
    readonly show = vi.fn();

    constructor(readonly options: AgentSystemNotification) {
        FakeNativeNotification.instances.push(this);
    }

    emit(event: string, ...arguments_: unknown[]): void {
        const listeners = this.listeners.get(event) ?? [];
        for (const listener of listeners) listener(...arguments_);
    }

    on(event: string, listener: (...arguments_: unknown[]) => void): this {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    removeListener(event: string, listener: (...arguments_: unknown[]) => void): this {
        this.listeners.get(event)?.delete(listener);
        return this;
    }
}

function harness({ alerterAvailable = true, alerterProbeFails = false, unsigned = false } = {}) {
    const alerterHandles: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const alerterShow = vi.fn<AlerterNotificationDriver['show']>(() => {
        const handle = { close: vi.fn() };
        alerterHandles.push(handle);
        return handle;
    });
    const alerter: AlerterNotificationDriver = {
        isAvailable: vi.fn(() =>
            alerterProbeFails
                ? Promise.reject(new Error('Alerter probe failed'))
                : Promise.resolve(alerterAvailable),
        ),
        show: alerterShow,
    };
    const logWrite = vi.fn();
    const logger = { write: logWrite } as unknown as StructuredLogger;
    return {
        alerter,
        alerterHandles,
        alerterShow,
        delivery: createAgentNotificationDelivery({
            alerter,
            detectUnsignedOrAdHoc: () => Promise.resolve(unsigned),
            logger: () => logger,
            Notification: FakeNativeNotification as unknown as typeof ElectronNotification,
        }),
        logWrite,
    };
}

describe('Agent notification delivery', () => {
    beforeEach(() => {
        FakeNativeNotification.instances = [];
        FakeNativeNotification.supported = true;
        FakeNativeNotification.supportError = false;
        vi.clearAllMocks();
    });

    it('uses the native notification path for a signed build', async () => {
        const test = harness();

        test.delivery.show(notification, vi.fn());

        await vi.waitFor(() => expect(FakeNativeNotification.instances).toHaveLength(1));
        const nativeNotification = FakeNativeNotification.instances[0];
        expect(nativeNotification.show.mock.calls).toHaveLength(1);
        expect(test.alerterShow).not.toHaveBeenCalled();
    });

    it('uses alerter immediately for an unsigned build', async () => {
        const test = harness({ unsigned: true });
        const onClick = vi.fn();

        const handle = test.delivery.show(notification, onClick);

        await vi.waitFor(() => expect(test.alerterShow).toHaveBeenCalledOnce());
        expect(test.alerterShow).toHaveBeenCalledWith(notification, onClick, expect.any(Function));
        expect(FakeNativeNotification.instances).toEqual([]);
        expect(test.logWrite).toHaveBeenCalledWith(
            'info',
            'agent_notifications.delivery_fallback',
            { fields: { reason: 'unsigned_build' } },
        );

        handle.close();
        expect(test.alerterHandles[0]?.close.mock.calls).toHaveLength(1);
    });

    it('does not bypass system notification refusal for a signed build', async () => {
        const test = harness();

        test.delivery.show(notification, vi.fn());
        await vi.waitFor(() => expect(FakeNativeNotification.instances).toHaveLength(1));
        FakeNativeNotification.instances[0]?.emit('failed', {}, 'request not allowed');

        expect(test.alerterShow).not.toHaveBeenCalled();
        expect(test.logWrite).toHaveBeenCalledWith('warn', 'agent_notifications.operation_failed', {
            fields: { errorKind: 'native_failed' },
        });
    });

    it('keeps the native path when alerter is unavailable', async () => {
        const test = harness({ alerterAvailable: false, unsigned: true });

        test.delivery.show(notification, vi.fn());

        await vi.waitFor(() => expect(FakeNativeNotification.instances).toHaveLength(1));
        expect(test.alerterShow).not.toHaveBeenCalled();
        expect(test.logWrite).toHaveBeenCalledWith('warn', 'agent_notifications.operation_failed', {
            fields: { errorKind: 'alerter_unavailable' },
        });
    });

    it('classifies an alerter availability probe failure separately', async () => {
        const test = harness({ alerterProbeFails: true, unsigned: true });

        test.delivery.show(notification, vi.fn());

        await vi.waitFor(() => expect(FakeNativeNotification.instances).toHaveLength(1));
        expect(test.logWrite).toHaveBeenCalledWith('warn', 'agent_notifications.operation_failed', {
            fields: { errorKind: 'alerter_probe_failed' },
        });
    });

    it('contains an unexpected backend startup failure', async () => {
        FakeNativeNotification.supportError = true;
        const test = harness();

        test.delivery.show(notification, vi.fn());

        await vi.waitFor(() =>
            expect(test.logWrite).toHaveBeenCalledWith(
                'warn',
                'agent_notifications.operation_failed',
                { fields: { errorKind: 'delivery_start_failed' } },
            ),
        );
    });

    it('reports a bounded alerter failure classification', async () => {
        const test = harness({ unsigned: true });
        test.delivery.show(notification, vi.fn());
        await vi.waitFor(() => expect(test.alerterShow).toHaveBeenCalledOnce());
        const onFailure = test.alerterShow.mock.calls[0][2];

        onFailure('spawn_failed');

        expect(test.logWrite).toHaveBeenCalledWith('warn', 'agent_notifications.operation_failed', {
            fields: { errorKind: 'alerter_spawn_failed' },
        });
    });
});

describe('macOS notification signature classification', () => {
    it('recognizes Electron ad-hoc signatures', () => {
        expect(
            isUnsignedOrAdHocSignature(
                'flags=0x20002(adhoc,linker-signed)\nSignature=adhoc\nTeamIdentifier=not set',
                true,
            ),
        ).toBe(true);
    });

    it('keeps a Developer ID build on native notifications', () => {
        expect(
            isUnsignedOrAdHocSignature(
                'Authority=Developer ID Application: Example\nTeamIdentifier=ABCDE12345',
                true,
            ),
        ).toBe(false);
    });

    it('treats an unverifiable executable as unsigned', () => {
        expect(isUnsignedOrAdHocSignature('', false)).toBe(true);
    });
});
