import { execFile } from 'node:child_process';
import process from 'node:process';

import type { NotificationDelivery, NotificationHelperStatus } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { Notification } from 'electron';

import type {
    AgentSystemNotification,
    AgentSystemNotificationHandle,
} from '../agent-notifications';
import type { AlerterNotificationDriver } from './alerter-notification';
import { createAlerterNotificationDriver } from './alerter-notification';
import type { OsascriptNotificationDriver } from './osascript-notification';
import { createOsascriptNotificationDriver } from './osascript-notification';

/**
 * One per Main process. Creating it probes the running app's code signature once; the delivery mode is derived from
 * that and the notification helper's availability on every banner, so installing the helper while Caxri runs takes
 * effect without a restart. Every notification family shares the instance `createDesktopNotifications` creates.
 */
export interface AgentNotificationDelivery {
    show(notification: AgentSystemNotification, onClick: () => void): AgentSystemNotificationHandle;
}

/**
 * What Settings > Notifications > System notifications reads and drives. Kept apart from
 * {@link AgentNotificationDelivery} so the notification families, which only ever show banners, stay unaware of it.
 */
export interface NotificationHelperControl {
    /**
     * `recheck` forgets the cached helper lookup first.
     */
    status(options?: { recheck?: boolean }): Promise<NotificationHelperStatus>;
    /**
     * Sends a generic banner through the current delivery mode. `sent` means the backend accepted it (the helper
     * process started, or the basic or native call succeeded), not that macOS displayed it.
     */
    sendTest(notification: Pick<AgentSystemNotification, 'body' | 'title'>): Promise<{
        delivery: NotificationDelivery;
        sent: boolean;
    }>;
}

interface CreateAgentNotificationDeliveryOptions {
    alerter?: AlerterNotificationDriver;
    detectUnsignedOrAdHoc?: () => Promise<boolean>;
    forceNative?: boolean;
    logger: () => StructuredLogger | undefined;
    Notification?: typeof Notification;
    /**
     * Called at most once per launch, the first time a banner could not be shown because the helper is missing and the
     * basic macOS fallback failed too.
     */
    onHelperUnavailable?: () => void;
    osascript?: OsascriptNotificationDriver;
}

export type DeliveryMode = 'alerter' | 'native' | 'osascript';

/**
 * Why a delivery mode was chosen. A closed set so the log explains a missing banner without any Session content.
 */
export type DeliveryModeReason =
    | 'forced_native'
    | 'signature_probe_failed'
    | 'signed_build'
    | 'unsigned_build'
    | 'unsigned_build_no_helper';

interface ResolvedDeliveryMode {
    mode: DeliveryMode;
    reason: DeliveryModeReason;
}

/**
 * The delivery the Settings row reports for a resolved mode. `osascript` reads as unavailable once a basic banner
 * actually failed, so the row stops promising banners that are not appearing.
 */
export function presentDelivery(
    mode: DeliveryMode,
    didOsascriptFail: boolean,
): NotificationDelivery {
    if (mode === 'alerter') return 'helper';
    if (mode === 'native') return 'native';
    return didOsascriptFail ? 'unavailable' : 'basic';
}

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
    onHelperUnavailable,
    osascript = createOsascriptNotificationDriver(),
}: CreateAgentNotificationDeliveryOptions): AgentNotificationDelivery & NotificationHelperControl {
    const reportOperationFailure = (errorKind: string): void => {
        logger()?.write('warn', logEventCatalog.agentNotifications.operationFailed, {
            fields: { errorKind },
        });
    };

    let didOsascriptFail = false;
    let didReportHelperUnavailable = false;
    let lastLogged: ResolvedDeliveryMode | undefined;
    let unsignedPromise: Promise<boolean> | undefined;

    const probeUnsigned = (): Promise<boolean> => {
        unsignedPromise ??= forceNative ? Promise.resolve(false) : detectUnsignedOrAdHoc();
        return unsignedPromise;
    };

    /**
     * The signature never changes while the app runs, so it is probed once; the helper lookup carries its own expiry
     * (see `AlerterNotificationDriver.isAvailable`), so a helper installed later is picked up on a later banner.
     */
    const resolveMode = async (shouldRecheck = false): Promise<ResolvedDeliveryMode> => {
        let resolved: ResolvedDeliveryMode;
        let isUnsignedOrAdHoc: boolean;
        try {
            isUnsignedOrAdHoc = await probeUnsigned();
        } catch {
            reportOperationFailure('signature_probe_failed');
            return { mode: 'native', reason: 'signature_probe_failed' };
        }
        if (!isUnsignedOrAdHoc) {
            resolved = {
                mode: 'native',
                reason: forceNative ? 'forced_native' : 'signed_build',
            };
        } else {
            let isAlerterAvailable = false;
            try {
                isAlerterAvailable = await alerter.isAvailable(
                    shouldRecheck ? { isForced: true } : undefined,
                );
            } catch {
                reportOperationFailure('alerter_probe_failed');
            }
            resolved = isAlerterAvailable
                ? { mode: 'alerter', reason: 'unsigned_build' }
                : { mode: 'osascript', reason: 'unsigned_build_no_helper' };
        }
        logModeChange(resolved);
        return resolved;
    };

    /**
     * One record per transition, not per banner: the log shows when the delivery mode changed and why, which is what
     * explains a user who "stopped getting clickable banners" after uninstalling the helper.
     */
    function logModeChange(resolved: ResolvedDeliveryMode): void {
        if (lastLogged?.mode === resolved.mode && lastLogged.reason === resolved.reason) return;
        lastLogged = resolved;
        if (resolved.mode === 'native') return;
        logger()?.write('info', logEventCatalog.agentNotifications.deliveryFallback, {
            fields: { mode: resolved.mode, reason: resolved.reason },
        });
        if (resolved.mode === 'osascript') reportOperationFailure('alerter_unavailable');
    }

    const reportOsascriptResult = (didSucceed: boolean): void => {
        didOsascriptFail = !didSucceed;
        if (didSucceed) return;
        reportOperationFailure('osascript_failed');
        if (didReportHelperUnavailable) return;
        didReportHelperUnavailable = true;
        onHelperUnavailable?.();
    };

    /**
     * Hands one banner to the backend `mode` names. `delivered` resolves true once the backend accepted it; `close`
     * withdraws what can be withdrawn.
     */
    const deliver = (
        mode: DeliveryMode,
        notification: AgentSystemNotification,
        onClick: () => void,
        isClosed: () => boolean,
    ): { close(): void; delivered: Promise<boolean> } => {
        if (mode === 'osascript') {
            const isBasicBannerShown = async (): Promise<boolean> => {
                const didSucceed = await osascript.show(notification);
                reportOsascriptResult(didSucceed);
                return didSucceed;
            };
            return { close: () => {}, delivered: isBasicBannerShown() };
        }
        if (mode === 'alerter') {
            const handle = alerter.show(notification, onClick, (failure) => {
                reportOperationFailure(`alerter_${failure}`);
            });
            return {
                close: () => handle.close(),
                delivered: handle.launched ?? Promise.resolve(true),
            };
        }

        let nativeNotification: Notification | undefined;
        const handleNativeClick = (): void => onClick();
        const handleNativeFailure = (): void => {
            if (!nativeNotification || isClosed()) return;
            nativeNotification.removeListener('click', handleNativeClick);
            nativeNotification.removeListener('failed', handleNativeFailure);
            nativeNotification.close();
            reportOperationFailure('native_failed');
        };
        let isDelivered = false;
        if (NativeNotification.isSupported()) {
            try {
                /**
                 * Every field of the Caxri notification is a declared Electron option; see the
                 * `AgentSystemNotification` JSDoc for what `id` and `groupId` do on macOS.
                 */
                nativeNotification = new NativeNotification(notification);
                nativeNotification.on('click', handleNativeClick);
                nativeNotification.on('failed', handleNativeFailure);
                nativeNotification.show();
                isDelivered = true;
            } catch {
                reportOperationFailure('native_show_failed');
            }
        } else {
            reportOperationFailure('native_unsupported');
        }
        return {
            close: () => {
                if (!nativeNotification) return;
                nativeNotification.removeListener('click', handleNativeClick);
                nativeNotification.removeListener('failed', handleNativeFailure);
                nativeNotification.close();
            },
            delivered: Promise.resolve(isDelivered),
        };
    };

    /**
     * Resolve once at startup so the signature probe and the first mode log happen at launch, not at the first banner.
     */
    void resolveMode().catch(() => {});

    return {
        show(notification, onClick): AgentSystemNotificationHandle {
            let isClosed = false;
            let delivery: { close(): void } | undefined;

            const startAfterModeResolution = async (): Promise<void> => {
                try {
                    const { mode } = await resolveMode();
                    // Closing while the mode resolves cancels delivery before anything is shown.
                    if (!isClosed) delivery = deliver(mode, notification, onClick, () => isClosed);
                } catch {
                    reportOperationFailure('delivery_start_failed');
                }
            };
            void startAfterModeResolution();

            return {
                close(): void {
                    if (isClosed) return;
                    isClosed = true;
                    delivery?.close();
                },
            };
        },
        async status(options): Promise<NotificationHelperStatus> {
            const { mode } = await resolveMode(options?.recheck === true);
            return { delivery: presentDelivery(mode, didOsascriptFail) };
        },
        async sendTest(notification) {
            const { mode } = await resolveMode();
            const testNotification: AgentSystemNotification = {
                ...notification,
                groupId: 'caxri-notification-test',
                id: 'caxri-notification-test',
            };
            try {
                const { delivered } = deliver(
                    mode,
                    testNotification,
                    () => {},
                    () => false,
                );
                const sent = await delivered;
                return { delivery: presentDelivery(mode, didOsascriptFail), sent };
            } catch {
                reportOperationFailure('test_delivery_failed');
                return { delivery: presentDelivery(mode, didOsascriptFail), sent: false };
            }
        },
    };
}
