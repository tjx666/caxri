import { execFile } from 'node:child_process';
import process from 'node:process';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { Notification } from 'electron';

import type { AgentSystemNotification, AgentSystemNotificationHandle } from './agent-notifications';
import type { AlerterNotificationDriver } from './alerter-notification';
import { createAlerterNotificationDriver } from './alerter-notification';

/**
 * One per Main process. Creating it probes the running app's code signature and logs the unsigned-build fallback, so
 * every notification family shares the instance `createDesktopNotifications` creates rather than probing on its own.
 */
export interface AgentNotificationDelivery {
    show(notification: AgentSystemNotification, onClick: () => void): AgentSystemNotificationHandle;
}

interface CreateAgentNotificationDeliveryOptions {
    alerter?: AlerterNotificationDriver;
    detectUnsignedOrAdHoc?: () => Promise<boolean>;
    forceNative?: boolean;
    logger: () => StructuredLogger | undefined;
    Notification?: typeof Notification;
}

type DeliveryMode = 'alerter' | 'native';

export function isUnsignedOrAdHocSignature(output: string, didInspect: boolean): boolean {
    if (!didInspect) return true;
    return /Signature=adhoc|\badhoc\b|TeamIdentifier=not set/i.test(output);
}

/**
 * Electron 44's macOS notification API requires a signed application. Inspect the running executable once so an ad-hoc
 * development build can use alerter without treating a user's notification refusal in a signed build as a reason to
 * bypass macOS.
 */
function detectCurrentAppUnsignedOrAdHoc(): Promise<boolean> {
    if (process.platform !== 'darwin') return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
        execFile(
            '/usr/bin/codesign',
            ['--display', '--verbose=2', process.execPath],
            { encoding: 'utf8' },
            (error, stdout, stderr) => {
                resolve(isUnsignedOrAdHocSignature(`${stdout}${stderr}`, error === null));
            },
        );
    });
}

export function createAgentNotificationDelivery({
    alerter = createAlerterNotificationDriver(),
    detectUnsignedOrAdHoc = detectCurrentAppUnsignedOrAdHoc,
    forceNative = false,
    logger,
    Notification: NativeNotification = Notification,
}: CreateAgentNotificationDeliveryOptions): AgentNotificationDelivery {
    const reportOperationFailure = (errorKind: string): void => {
        logger()?.write('warn', logEventCatalog.agentNotifications.operationFailed, {
            fields: { errorKind },
        });
    };

    const resolveMode = async (): Promise<DeliveryMode> => {
        let isUnsignedOrAdHoc: boolean;
        try {
            isUnsignedOrAdHoc = !forceNative && (await detectUnsignedOrAdHoc());
        } catch {
            reportOperationFailure('signature_probe_failed');
            return 'native';
        }
        if (!isUnsignedOrAdHoc) return 'native';

        let isAlerterAvailable: boolean;
        try {
            isAlerterAvailable = await alerter.isAvailable();
        } catch {
            reportOperationFailure('alerter_probe_failed');
            return 'native';
        }
        if (!isAlerterAvailable) {
            reportOperationFailure('alerter_unavailable');
            return 'native';
        }
        logger()?.write('info', logEventCatalog.agentNotifications.deliveryFallback, {
            fields: { reason: 'unsigned_build' },
        });
        return 'alerter';
    };
    const mode = resolveMode();

    return {
        show(notification, onClick): AgentSystemNotificationHandle {
            let isClosed = false;
            let alerterHandle: AgentSystemNotificationHandle | undefined;
            let nativeNotification: Notification | undefined;
            const handleNativeClick = (): void => onClick();
            const handleNativeFailure = (): void => {
                if (isClosed || !nativeNotification) return;
                nativeNotification.removeListener('click', handleNativeClick);
                nativeNotification.removeListener('failed', handleNativeFailure);
                nativeNotification.close();
                reportOperationFailure('native_failed');
            };

            const showNative = (): void => {
                if (isClosed) return;
                if (!NativeNotification.isSupported()) {
                    reportOperationFailure('native_unsupported');
                    return;
                }
                try {
                    /**
                     * Every field of the Caxri notification is a declared Electron option; see the
                     * `AgentSystemNotification` JSDoc for what `id` and `groupId` do on macOS.
                     */
                    nativeNotification = new NativeNotification(notification);
                    nativeNotification.on('click', handleNativeClick);
                    nativeNotification.on('failed', handleNativeFailure);
                    nativeNotification.show();
                } catch {
                    reportOperationFailure('native_show_failed');
                }
            };

            const start = (resolvedMode: DeliveryMode): void => {
                if (isClosed) return;
                if (resolvedMode === 'native') {
                    showNative();
                    return;
                }
                alerterHandle = alerter.show(notification, onClick, (failure) => {
                    reportOperationFailure(`alerter_${failure}`);
                });
            };

            const startAfterModeResolution = async (): Promise<void> => {
                try {
                    start(await mode);
                } catch {
                    reportOperationFailure('delivery_start_failed');
                }
            };
            // eslint-disable-next-line no-void -- the synchronous handle below owns the asynchronously selected backend
            void startAfterModeResolution();

            return {
                close(): void {
                    if (isClosed) return;
                    isClosed = true;
                    alerterHandle?.close();
                    if (!nativeNotification) return;
                    nativeNotification.removeListener('click', handleNativeClick);
                    nativeNotification.removeListener('failed', handleNativeFailure);
                    nativeNotification.close();
                },
            };
        },
    };
}
