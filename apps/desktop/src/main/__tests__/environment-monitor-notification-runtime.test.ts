import { describe, expect, it, vi } from 'vitest';

import type {
    EnvironmentMonitor,
    EnvironmentMonitorAlertEvent,
} from '../environment-monitor/monitor';
import { createDesktopEnvironmentMonitorNotifications } from '../environment-monitor/notification-runtime';
import type { AgentNotificationDelivery } from '../notifications/agent-notification-delivery';

describe('Environment monitor notifications', () => {
    it('delivers a replaceable banner and focuses Caxri when clicked', async () => {
        let listener: ((event: EnvironmentMonitorAlertEvent) => void) | undefined;
        const close = vi.fn();
        const show = vi.fn<AgentNotificationDelivery['show']>(() => ({ close }));
        const focusMainWindow = vi.fn().mockResolvedValue({});
        const monitor = {
            subscribeAlerts(next) {
                listener = next;
                return () => {
                    listener = undefined;
                };
            },
        } as EnvironmentMonitor;
        const runtime = createDesktopEnvironmentMonitorNotifications({
            delivery: { show },
            focusMainWindow,
            logger: () => {},
            monitor,
        });

        listener?.({
            type: 'show',
            state: {
                state: 'warning',
                issues: ['publicIpChanged', 'proxyRouteChanged'],
                consecutiveFailures: 0,
                canAcceptBaseline: true,
            },
        });

        expect(show).toHaveBeenCalledWith(
            {
                body: 'Caxri detected 2 enabled environment signal(s).',
                groupId: 'caxri-environment-monitor',
                id: 'caxri-environment-monitor',
                title: 'Environment changed',
            },
            expect.any(Function),
        );
        show.mock.calls[0][1]();
        await vi.waitFor(() => expect(focusMainWindow).toHaveBeenCalledOnce());

        listener?.({ type: 'clear' });
        expect(close).toHaveBeenCalledOnce();

        runtime.dispose();
        expect(close).toHaveBeenCalledOnce();
        expect(listener).toBeUndefined();
    });
});
