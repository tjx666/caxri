import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MOBILE_FIXTURE_IME_ID = 'caxri.acceptance.ime/.FixtureIme';
const packageId = 'caxri.acceptance.ime';

export interface MobileFixtureImeCommands {
    build: (directory: string) => void;
    readDevice: (arguments_: string[]) => string;
    runDevice: (arguments_: string[]) => void;
}

/**
 * Owns the test IME for one disposable emulator batch, including partial setup failures. The caller must invoke the
 * returned cleanup after every completed or failed case batch.
 */
export async function prepareMobileFixtureIme(
    serial: string,
    commands: MobileFixtureImeCommands,
): Promise<() => Promise<void>> {
    if (!/^emulator-\d+$/u.test(serial))
        throw new Error('The fixture IME requires an explicit disposable emulator');
    const previousIme = commands
        .readDevice(['shell', 'settings', 'get', 'secure', 'default_input_method'])
        .trim();
    if (!previousIme || previousIme === 'null' || previousIme === MOBILE_FIXTURE_IME_ID)
        throw new Error('The emulator default input method cannot be preserved safely');
    const existingPackages = commands.readDevice([
        'shell',
        'pm',
        'list',
        'packages',
        '--user',
        '0',
        packageId,
    ]);
    if (existingPackages.split(/\r?\n/u).some((line) => line.trim() === `package:${packageId}`))
        throw new Error('The emulator already contains the fixture IME package');

    const directory = await mkdtemp(join(tmpdir(), 'caxri-fixture-ime-'));
    let isUninstallPending = false;
    let isDisablePending = false;
    let isRestorePending = false;
    let isVerifyPreviousIme = false;
    let isCleaned = false;
    const cleanup = async (): Promise<void> => {
        if (isCleaned) return;
        let stage = 'restore';
        try {
            if (isRestorePending) {
                commands.runDevice(['shell', 'ime', 'set', previousIme]);
                isRestorePending = false;
            }
            stage = 'verify';
            if (isVerifyPreviousIme) {
                const current = commands
                    .readDevice(['shell', 'settings', 'get', 'secure', 'default_input_method'])
                    .trim();
                if (current !== previousIme) {
                    isRestorePending = true;
                    throw new Error('The emulator default input method was not restored');
                }
            }
            stage = 'disable';
            if (isDisablePending) {
                commands.runDevice(['shell', 'ime', 'disable', MOBILE_FIXTURE_IME_ID]);
                isDisablePending = false;
            }
            stage = 'uninstall';
            if (isUninstallPending) {
                commands.runDevice(['uninstall', packageId]);
                isUninstallPending = false;
            }
            stage = 'remove-temp';
            await rm(directory, { force: true, recursive: true });
        } catch (error) {
            await rm(directory, { force: true, recursive: true });
            throw new Error(`Mobile fixture IME cleanup failed at ${stage}`, { cause: error });
        }
        isCleaned = true;
    };

    try {
        commands.build(directory);
        isUninstallPending = true;
        commands.runDevice(['install', '-r', join(directory, 'fixture-ime.apk')]);
        let isRegistered = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            // A newly installed IME is disabled; `ime list -s` omits it until after `ime enable`.
            const listed = commands.readDevice(['shell', 'ime', 'list', '-a', '-s']);
            if (listed.includes(`${packageId}/`)) {
                isRegistered = true;
                break;
            }
            // eslint-disable-next-line no-await-in-loop -- bounded polling avoids a blind post-install sleep.
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!isRegistered) throw new Error('The fixture IME was not registered on the emulator');
        isDisablePending = true;
        commands.runDevice(['shell', 'ime', 'enable', MOBILE_FIXTURE_IME_ID]);
        isRestorePending = true;
        isVerifyPreviousIme = true;
        commands.runDevice(['shell', 'ime', 'set', MOBILE_FIXTURE_IME_ID]);
        const selectedIme = commands
            .readDevice(['shell', 'settings', 'get', 'secure', 'default_input_method'])
            .trim();
        if (selectedIme !== MOBILE_FIXTURE_IME_ID)
            throw new Error('The fixture IME did not become the emulator default');
        return cleanup;
    } catch (error) {
        try {
            await cleanup();
        } catch (cleanupError) {
            throw new AggregateError(
                [error, cleanupError],
                'Mobile fixture IME setup and cleanup failed',
                { cause: cleanupError },
            );
        }
        throw error;
    }
}
