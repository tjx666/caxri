import { join } from 'node:path';

import { connectToServer } from '@caxri/client/supervise';
import type { MethodResult } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { coldStartMobileApp, tapMobileCheck, waitForMobile } from './mobile-android';

async function openSettings(serial: string): Promise<void> {
    await waitForCheck(serial, 'computer-menu-button');
    await tapMobileCheck(serial, 'computer-menu-button');
    await waitForCheck(serial, 'settings-action');
    await tapMobileCheck(serial, 'settings-action');
    await waitForCheck(serial, 'settings-connection-method');
}

/**
 * Picks one connection method from the Settings sheet and waits for the sheet to leave.
 */
async function pickConnectionMethod(serial: string, method: 'direct' | 'relay'): Promise<void> {
    await tapMobileCheck(serial, 'settings-connection-method');
    await waitForCheck(serial, `connection-method-${method}`);
    await tapMobileCheck(serial, `connection-method-${method}`);
    await waitForNoCheck(serial, 'connection-method-sheet');
}

/**
 * `MOB-SETTINGS-ROUTE-01`: Settings > This device shows Connection method, Automatic by default, and its sheet offers
 * Automatic, Direct, and Relay with the current one checked. Choosing Direct keeps the direct connection, and the
 * choice survives a cold start. The emulator fixture has no Relay, so choosing Relay falls back to the direct route and
 * the phone stays online with the Status row saying Direct.
 */
export async function executeMobileSettingsRouteScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'empty', serial });
    const client = await connectToServer(join(fixture.testDirectory, 'user-data'), 5_000);
    const isOnline = (deviceId: string) =>
        waitForMobile(
            () => client.request('mobile.deviceAction.targets', {}),
            ({ devices }: MethodResult<'mobile.deviceAction.targets'>) =>
                devices.some((device) => device.deviceId === deviceId && device.online),
            30_000,
        );
    try {
        const { deviceId } = await fixture.pair();
        await isOnline(deviceId);

        await openSettings(serial);
        await capture(environment, 'settings-automatic', artifacts);

        await tapMobileCheck(serial, 'settings-connection-method');
        await waitForCheck(serial, 'connection-method-sheet');
        await waitForCheck(serial, 'connection-method-auto');
        await capture(environment, 'method-sheet', artifacts);
        await tapMobileCheck(serial, 'connection-method-cancel');
        await waitForNoCheck(serial, 'connection-method-sheet');

        await pickConnectionMethod(serial, 'direct');
        await isOnline(deviceId);
        await capture(environment, 'settings-direct', artifacts);

        // The choice lives in the phone's secure store, so it survives the app process being killed.
        await coldStartMobileApp(serial);
        await openSettings(serial);
        await isOnline(deviceId);
        await capture(environment, 'settings-direct-after-restart', artifacts);

        await pickConnectionMethod(serial, 'relay');
        await isOnline(deviceId);
        await waitForCheck(serial, 'settings-connection-status');
        await capture(environment, 'settings-relay-fallback', artifacts);

        await finish(environment, artifacts, {
            onlineAfterDirect: true,
            onlineAfterRelayFallback: true,
            status: 'passed',
        });
    } finally {
        client.close();
        await fixture.stop();
    }
}
