import type { MethodResult } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * The Main calls behind the System notifications row. Kept out of the component so a request never lives inside render
 * code (`caxri/server-reads-through-query`).
 */
export function recheckNotificationHelper(): Promise<MethodResult<'notifications.helperStatus'>> {
    return caxri.request('notifications.helperStatus', { recheck: true });
}

export function sendTestNotification(input: {
    body: string;
    title: string;
}): Promise<MethodResult<'notifications.sendTest'>> {
    return caxri.request('notifications.sendTest', input);
}

export function openMacosNotificationSettings(): Promise<
    MethodResult<'notifications.openSystemSettings'>
> {
    return caxri.request('notifications.openSystemSettings');
}
