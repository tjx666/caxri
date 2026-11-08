import { join } from 'node:path';

import { connectToServer } from '@caxri/client/supervise';
import type { MethodResult, ServerOperationParameters } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { adbShell, observeMobileNode, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * The fixture Server's `CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME`, which stands in for the system host name.
 */
const FIXTURE_HOST_NAME = 'Caxri Test Host';
const NEW_NAME = 'Studio Mac';
const DESKTOP_NAME = 'Office Mac';
const DESKTOP_NAME_KEY = 'mobile.computerName';

async function expectHostName(serial: string, name: string): Promise<void> {
    await waitForMobile(
        () => observeMobileNode(serial, 'session-home-host-name', { kind: 'equals', value: name }),
        (observation) => observation.textMatches === true,
        15_000,
    );
}

/**
 * `MOB-COMPUTER-RENAME-01`: a control phone renames the paired computer from the computer menu, the Session home title
 * shows the new name at once, and the Server stores it as `mobile.computerName`. Clearing the name from Settings, Name
 * puts the system host name back.
 */
export async function executeMobileComputerRenameScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'empty', serial });
    const client = await connectToServer(join(fixture.testDirectory, 'user-data'), 5_000);
    const readComputerName = async (): Promise<string | null> => {
        const settings: MethodResult<'settings.inspect'> = await client.request('settings.inspect');
        // Read through a record so the case also runs on the pre-change build that lacks the key (its baseline round).
        const value = (settings.value as Record<string, unknown>)['mobile.computerName'];
        return typeof value === 'string' ? value : null;
    };
    try {
        await fixture.pair();
        await expectHostName(serial, FIXTURE_HOST_NAME);
        await capture(environment, 'home-before', artifacts);

        await tapMobileCheck(serial, 'computer-menu-button');
        await waitForCheck(serial, 'settings-action');
        await capture(environment, 'computer-menu', artifacts);
        await waitForCheck(serial, 'rename-computer-action');
        await tapMobileCheck(serial, 'rename-computer-action');
        await waitForCheck(serial, 'computer-rename-input');
        // The field opens focused with its text selected, so typing replaces the current name.
        await adbShell(serial, ['input', 'text', NEW_NAME.replaceAll(' ', '%s')]);
        await capture(environment, 'rename-sheet', artifacts);
        await tapMobileCheck(serial, 'computer-rename-save');
        await waitForNoCheck(serial, 'computer-rename-sheet');
        await expectHostName(serial, NEW_NAME);
        await capture(environment, 'home-renamed', artifacts);
        const savedName = await readComputerName();
        if (savedName !== NEW_NAME)
            throw new Error('The Server did not store the new computer name');

        await tapMobileCheck(serial, 'computer-menu-button');
        await waitForCheck(serial, 'settings-action');
        await tapMobileCheck(serial, 'settings-action');
        await waitForCheck(serial, 'settings-computer-name');
        await capture(environment, 'settings-renamed', artifacts);
        await tapMobileCheck(serial, 'settings-computer-name');
        await waitForCheck(serial, 'computer-rename-input');
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_DEL']);
        await tapMobileCheck(serial, 'computer-rename-save');
        await waitForNoCheck(serial, 'computer-rename-sheet');
        await waitForMobile(readComputerName, (name) => name === null, 15_000);
        await waitForMobile(
            () =>
                observeMobileNode(serial, 'settings-computer-name', {
                    kind: 'includes',
                    value: FIXTURE_HOST_NAME,
                }),
            (observation) => observation.textMatches === true,
            15_000,
        );
        await capture(environment, 'settings-restored', artifacts);

        // A name set on the computer (Desktop Settings writes the same setting) must reach the phone as well, through
        // the Server's `settings.changed` refresh rather than the phone's own rename reply.
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await expectHostName(serial, FIXTURE_HOST_NAME);
        // Cast: the pre-change build (the baseline round) has no such key; that round stops at the menu anyway.
        await client.request('settings.patch', {
            changes: [{ key: DESKTOP_NAME_KEY, value: DESKTOP_NAME }],
            dryRun: false,
        } as unknown as ServerOperationParameters<'settings.patch'>);
        await expectHostName(serial, DESKTOP_NAME);
        await capture(environment, 'home-desktop-renamed', artifacts);

        await finish(environment, artifacts, {
            desktopNameReachedPhone: true,
            renamedOnPhone: true,
            restoredHostName: true,
            savedName,
            status: 'passed',
        });
    } finally {
        client.close();
        await fixture.stop();
    }
}
