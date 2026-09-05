import type { ServerEvent } from '@caxri/protocol';

import type { AgentSystemNotification, AgentSystemNotificationHandle } from './agent-notifications';

/**
 * Caps how many delivery notifications this process keeps a handle for. Handles exist only so `dispose` can dismiss
 * what is still on screen at quit, so a burst of failures must not grow the map without bound.
 */
const MAX_TRACKED_NOTIFICATIONS = 32;

type DeliveryAlert = Extract<ServerEvent, { event: 'projectStatus.alert' }>['payload'];

interface DeliveryNotificationCoordinatorOptions {
    onError?(error: unknown): void;
    /**
     * Brings Caxri forward and opens the failure's provider page. Routing through Main's external-link path keeps the
     * Trusted Domains prompt and the `http(s)` scheme check in force for a URL that arrived inside a `gh` or `vc`
     * response, which this process never authored.
     */
    openFailure(url: string): Promise<void>;
    showNotification(
        notification: AgentSystemNotification,
        onClick: () => void,
    ): AgentSystemNotificationHandle | undefined;
}

export interface DeliveryNotificationCoordinator {
    dispose(): void;
    observe(event: ServerEvent): void;
}

/**
 * Notification copy for one delivery failure. A check already carries GitHub's `workflow / job` label, so it reads as
 * written; a deployment knows only its environment, which is capitalized into a sentence.
 */
export function deliveryNotificationText(alert: DeliveryAlert): { body: string; title: string } {
    const environment = `${alert.name.charAt(0).toUpperCase()}${alert.name.slice(1)}`;
    return {
        title: `${alert.repository} · ${alert.branch}`,
        body:
            alert.kind === 'check'
                ? `CI failed: ${alert.name}`
                : `${environment} deployment failed`,
    };
}

/**
 * Turns `projectStatus.alert` into a native notification. The Server owns the transition detection, the startup
 * baseline, and the deduplication, so every alert reaching this layer is already a genuine new failure: it decides only
 * how the failure reads and where a click lands.
 */
export function createDeliveryNotificationCoordinator(
    options: DeliveryNotificationCoordinatorOptions,
): DeliveryNotificationCoordinator {
    let isDisposed = false;
    let tail = Promise.resolve();
    const notifications = new Map<string, AgentSystemNotificationHandle>();

    const runScheduled = async (previous: Promise<void>, task: () => Promise<void>) => {
        try {
            await previous;
            if (isDisposed) return;
            await task();
        } catch (error) {
            options.onError?.(error);
        }
    };

    const track = (id: string, handle: AgentSystemNotificationHandle): void => {
        if (notifications.size >= MAX_TRACKED_NOTIFICATIONS) {
            const oldest = notifications.keys().next();
            if (!oldest.done) notifications.delete(oldest.value);
        }
        notifications.set(id, handle);
    };

    const show = (alert: DeliveryAlert): void => {
        /**
         * The id is the notification's replacement identity, both here and in the `alerter` fallback, so it has to be
         * unambiguous: repository names, branch names, and check names all admit `/` and `-`, and joining them with a
         * separator they can contain would let `foo` + `bar-baz` collide with `foo-bar` + `baz` and silently replace an
         * unrelated failure. JSON quoting is the cheapest encoding that cannot collide and stays valid `alerter` argv.
         */
        const id = `caxri-delivery-${JSON.stringify([alert.kind, alert.repository, alert.branch, alert.name])}`;
        const { url } = alert;
        notifications.get(id)?.close();
        notifications.delete(id);
        const handle = options.showNotification(
            { id, groupId: 'caxri-delivery', ...deliveryNotificationText(alert) },
            () => {
                notifications.delete(id);
                if (!url) return;
                // Notification callbacks are synchronous; the queue owns async failure handling.
                tail = runScheduled(tail, () => options.openFailure(url));
            },
        );
        if (handle) track(id, handle);
    };

    return {
        dispose(): void {
            isDisposed = true;
            for (const handle of notifications.values()) handle.close();
            notifications.clear();
        },
        observe(event: ServerEvent): void {
            if (isDisposed || event.event !== 'projectStatus.alert') return;
            try {
                show(event.payload);
            } catch (error) {
                options.onError?.(error);
            }
        },
    };
}
