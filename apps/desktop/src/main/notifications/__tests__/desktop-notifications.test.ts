import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { afterEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({
    detectUnsignedOrAdHoc: vi.fn(() => Promise.resolve(true)),
    isAlerterAvailable: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('electron', () => ({ Notification: class {} }));
/**
 * Keeps the real delivery (mode resolution and its fallback log included) and swaps only the two probes that would run
 * `codesign` against this machine's executable and look for an installed alerter binary.
 */
vi.mock(import('../agent-notification-delivery'), async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        createAgentNotificationDelivery: (options) =>
            actual.createAgentNotificationDelivery({
                ...options,
                alerter: { ...options.alerter!, isAvailable: probes.isAlerterAvailable },
                detectUnsignedOrAdHoc: probes.detectUnsignedOrAdHoc,
            }),
    };
});

import type { DesktopServerConnection } from '../../connection/server-connection';
import { createDesktopNotifications } from '../desktop-notifications';

afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});

describe('desktop notifications', () => {
    it('probes the signature and logs the unsigned-build fallback once for both notification families', async () => {
        vi.stubEnv('CAXRI_E2E', '0');
        const write = vi.fn();
        const notifications = createDesktopNotifications({
            currentDirectory: '/caxri/out/main',
            focusMainWindow: vi.fn(),
            isSessionShown: () => false,
            handleMainMethod: vi.fn(),
            isPackaged: false,
            logger: () => ({ write }) as unknown as StructuredLogger,
            resourcesPath: '/caxri/resources',
            supervisor: { request: vi.fn() } as unknown as DesktopServerConnection,
            sendEvent: vi.fn(),
        });
        const fallbackLogs = () =>
            write.mock.calls.filter(
                ([, event]) => event === logEventCatalog.agentNotifications.deliveryFallback,
            );

        await vi.waitFor(() => expect(fallbackLogs()).not.toHaveLength(0));
        // A second delivery's mode resolution would settle in the same macrotask; let it finish before counting.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(probes.detectUnsignedOrAdHoc).toHaveBeenCalledOnce();
        expect(probes.isAlerterAvailable).toHaveBeenCalledOnce();
        expect(fallbackLogs()).toEqual([
            [
                'info',
                logEventCatalog.agentNotifications.deliveryFallback,
                { fields: { mode: 'alerter', reason: 'unsigned_build' } },
            ],
        ]);
        notifications.dispose();
    });
});
