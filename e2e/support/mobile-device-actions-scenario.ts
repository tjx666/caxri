import { join } from 'node:path';

import { connectToServer } from '@caxri/client/supervise';

import { allowE2EErrors } from './error-gate.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck } from './mobile-android';

const LINK = 'https://example.com/';

const errorReason = (error: unknown): unknown =>
    typeof error === 'object' && error !== null
        ? (Reflect.get(error, 'details') as { reason?: unknown } | undefined)?.reason
        : undefined;

/**
 * `MOB-DEVICE-ACTIONS-01`: with the phone paired and Caxri open, a CLI caller sees it online, `openUrl` opens the link
 * in the phone's in-app browser, and `exec` is refused with `disabled` while the phone's Termux commands setting is off
 * (its default). Settings then shows that row, off; the emulator has no Termux, so the row also says it is missing.
 */
export async function executeMobileDeviceActionsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'empty', serial });
    const client = await connectToServer(join(fixture.testDirectory, 'user-data'), 5_000);
    try {
        const { deviceId } = await fixture.pair();
        const { devices } = (await client.request('mobile.deviceAction.targets', {})) as {
            devices: Array<{ deviceId: string; online: boolean }>;
        };
        if (devices.every((device) => !(device.deviceId === deviceId && device.online)))
            throw new Error('The paired phone is not listed as online');

        const opened = await client.request('mobile.deviceAction.openUrl', { url: LINK });
        if (opened.deviceId !== deviceId) throw new Error('The link opened on another device');
        await waitForCheck(serial, 'in-app-browser');
        await capture(environment, 'opened-link', artifacts);
        await tapMobileCheck(serial, 'in-app-browser-close');

        // The refused command reaches Server Core as one failed `mobile.deviceAction.exec` request.
        allowE2EErrors([
            { source: 'server-core', event: 'ipc.request_failed', code: 'FORBIDDEN', count: 1 },
        ]);
        let refusal: unknown;
        try {
            await client.request('mobile.deviceAction.exec', { argv: ['uname', '-a'] });
        } catch (error) {
            refusal = errorReason(error);
        }
        if (refusal !== 'disabled')
            throw new Error(`exec was not refused as disabled: ${String(refusal)}`);

        await tapMobileCheck(serial, 'computer-menu-button');
        await tapMobileCheck(serial, 'settings-action');
        await waitForCheck(serial, 'settings-termux-commands');
        await capture(environment, 'settings', artifacts);
        await finish(environment, artifacts, {
            execRefusal: refusal,
            openedOnPairedPhone: true,
            listedOnline: true,
            status: 'passed',
        });
    } finally {
        client.close();
        await fixture.stop();
    }
}
