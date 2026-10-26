import type { StructuredLogger } from '@caxri/system';
import type { Notification as ElectronNotification } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSystemNotification } from '../../agent-notifications';
import {
    createAgentNotificationDelivery,
    isUnsignedOrAdHocSignature,
    presentDelivery,
} from '../agent-notification-delivery';
import type { AlerterNotificationDriver } from '../alerter-notification';
import type { OsascriptNotificationDriver } from '../osascript-notification';

const notification: AgentSystemNotification = {
    body: 'Claude Code is waiting for your input.',
    groupId: 'caxri-agent-sessions',
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

function harness({
    alerterAvailable = true,
    alerterProbeFails = false,
    osascriptWorks = true,
    unsigned = false,
} = {}) {
    const state = { alerterAvailable };
    const onHelperUnavailable = vi.fn();
    const osascriptShow = vi.fn<OsascriptNotificationDriver['show']>(() =>
        Promise.resolve(osascriptWorks),
    );
    const alerterHandles: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    const alerterShow = vi.fn<AlerterNotificationDriver['show']>(() => {
        const handle = { close: vi.fn() };
        alerterHandles.push(handle);
        return handle;
    });
    const alerterIsAvailable = vi.fn<AlerterNotificationDriver['isAvailable']>(() =>
        alerterProbeFails
            ? Promise.reject(new Error('Alerter probe failed'))
            : Promise.resolve(state.alerterAvailable),
    );
    const alerter: AlerterNotificationDriver = {
        isAvailable: alerterIsAvailable,
        show: alerterShow,
    };
    const logWrite = vi.fn();
    const logger = { write: logWrite } as unknown as StructuredLogger;
    return {
        alerter,
        alerterHandles,
        alerterIsAvailable,
        alerterShow,
        delivery: createAgentNotificationDelivery({
            alerter,
            detectUnsignedOrAdHoc: () => Promise.resolve(unsigned),
            logger: () => logger,
            Notification: FakeNativeNotification as unknown as typeof ElectronNotification,
            onHelperUnavailable,
            osascript: { show: osascriptShow },
        }),
        logWrite,
        onHelperUnavailable,
        osascriptShow,
        state,
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
            { fields: { mode: 'alerter', reason: 'unsigned_build' } },
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

    it('falls back to a basic macOS banner when an unsigned build has no helper', async () => {
        const test = harness({ alerterAvailable: false, unsigned: true });

        test.delivery.show(notification, vi.fn());

        await vi.waitFor(() => expect(test.osascriptShow).toHaveBeenCalledWith(notification));
        expect(FakeNativeNotification.instances).toEqual([]);
        expect(test.alerterShow).not.toHaveBeenCalled();
        expect(test.logWrite).toHaveBeenCalledWith(
            'info',
            'agent_notifications.delivery_fallback',
            { fields: { mode: 'osascript', reason: 'unsigned_build_no_helper' } },
        );
        expect(test.onHelperUnavailable).not.toHaveBeenCalled();
    });

    it('classifies an alerter availability probe failure separately and still delivers', async () => {
        const test = harness({ alerterProbeFails: true, unsigned: true });

        test.delivery.show(notification, vi.fn());

        await vi.waitFor(() => expect(test.osascriptShow).toHaveBeenCalledOnce());
        expect(test.logWrite).toHaveBeenCalledWith('warn', 'agent_notifications.operation_failed', {
            fields: { errorKind: 'alerter_probe_failed' },
        });
    });

    it('switches to the helper on the next banner once it is installed', async () => {
        const test = harness({ alerterAvailable: false, unsigned: true });
        test.delivery.show(notification, vi.fn());
        await vi.waitFor(() => expect(test.osascriptShow).toHaveBeenCalledOnce());

        test.state.alerterAvailable = true;
        test.delivery.show(notification, vi.fn());

        await vi.waitFor(() => expect(test.alerterShow).toHaveBeenCalledOnce());
        expect(test.logWrite).toHaveBeenCalledWith(
            'info',
            'agent_notifications.delivery_fallback',
            { fields: { mode: 'alerter', reason: 'unsigned_build' } },
        );
    });

    it('tells the app once per launch when no banner can be shown', async () => {
        const test = harness({ alerterAvailable: false, osascriptWorks: false, unsigned: true });

        test.delivery.show(notification, vi.fn());
        test.delivery.show(notification, vi.fn());

        await vi.waitFor(() => expect(test.osascriptShow).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(test.onHelperUnavailable).toHaveBeenCalledOnce());
        expect(test.logWrite).toHaveBeenCalledWith('warn', 'agent_notifications.operation_failed', {
            fields: { errorKind: 'osascript_failed' },
        });
        await expect(test.delivery.status()).resolves.toEqual({ delivery: 'unavailable' });
    });

    it('re-probes the helper only when asked to recheck', async () => {
        const test = harness({ alerterAvailable: false, unsigned: true });
        await expect(test.delivery.status()).resolves.toEqual({ delivery: 'basic' });

        test.state.alerterAvailable = true;
        await test.delivery.status({ recheck: true });

        expect(test.alerterIsAvailable).toHaveBeenLastCalledWith({ isForced: true });
        await expect(test.delivery.status()).resolves.toEqual({ delivery: 'helper' });
    });

    it('reports a signed build as native', async () => {
        const test = harness();

        await expect(test.delivery.status()).resolves.toEqual({ delivery: 'native' });
    });

    it('sends a generic test banner through the current mode', async () => {
        const test = harness({ alerterAvailable: false, unsigned: true });

        const result = await test.delivery.sendTest({ body: 'Body', title: 'Title' });

        expect(result).toEqual({ delivery: 'basic', sent: true });
        expect(test.osascriptShow).toHaveBeenCalledWith(
            expect.objectContaining({ body: 'Body', title: 'Title' }),
        );
    });

    it('reports a test banner the backend refused as not sent', async () => {
        const test = harness({ alerterAvailable: false, osascriptWorks: false, unsigned: true });

        await expect(test.delivery.sendTest({ body: 'Body', title: 'Title' })).resolves.toEqual({
            delivery: 'unavailable',
            sent: false,
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

describe('delivery presentation', () => {
    it('maps each backend to the status the Settings row reports', () => {
        expect(presentDelivery('alerter', false)).toBe('helper');
        expect(presentDelivery('native', false)).toBe('native');
        expect(presentDelivery('osascript', false)).toBe('basic');
        expect(presentDelivery('osascript', true)).toBe('unavailable');
    });
});
