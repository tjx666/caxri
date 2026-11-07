import type { Page } from '@playwright/test';

import { pageRequest } from './helpers';
import type { MobileSemanticNode } from './mobile-android';
import { mobileSemantics, waitForMobile } from './mobile-android';

/**
 * Waits until the phone shows `readyCheckId` after opening a pairing link, then returns the one active paired device. A
 * timeout names the mark it waited for, so a case whose list never shows that mark fails with its cause rather than a
 * bare timeout after a full release build. Showing `deniedSessionId`'s row fails the Project grant.
 */
export async function waitForPairedDevice(input: {
    deniedSessionId?: string;
    page: Page;
    readyCheckId: string;
    serial: string;
}): Promise<{ deviceId: string }> {
    const { deniedSessionId, page, readyCheckId, serial } = input;
    let nodes: MobileSemanticNode[];
    try {
        nodes = await waitForMobile(
            () => mobileSemantics(serial),
            (semantics) =>
                semantics.some(
                    ({ checkId }) => checkId === readyCheckId || checkId === 'pairing-error',
                ),
        );
    } catch (error) {
        throw new Error(`Mobile Acceptance pairing never showed ${readyCheckId}`, {
            cause: error,
        });
    }
    if (nodes.some(({ checkId }) => checkId === 'pairing-error'))
        throw new Error('Mobile Acceptance pairing failed');
    if (
        deniedSessionId &&
        nodes.some(({ checkId }) => checkId === `session-row-${deniedSessionId}`)
    )
        throw new Error('The paired device exposed a Session outside its Project grant');
    const devices = await pageRequest<{
        devices: Array<{ deviceId: string; revokedAt?: number }>;
    }>(page, 'mobile.device.list');
    const active = devices.devices.filter(({ revokedAt }) => revokedAt === undefined);
    if (active.length !== 1) throw new Error('Unexpected active paired-device count');
    return { deviceId: active[0].deviceId };
}
