import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';

import { markCaseLifecycleReady } from '../.agents/skills/acceptance/scripts/case-lifecycle.ts';
import { expect, test } from './support/fixtures.ts';
import { createMobileAcceptanceFixture } from './support/mobile-acceptance-fixture.ts';
import { openSettingsPage, revealSettingsSection } from './support/settings.ts';

/**
 * Automatic failure artifacts can freeze the short-lived QR credential outside the report-bound privacy scan. This spec
 * writes only its explicit pre-credential video and post-pairing screenshot/DOM evidence.
 */
test.use({ screenshot: 'off', trace: 'off' });

interface PairingDesktopEnvironment {
    assetsDirectory: string;
    cleanupReceiptPath: string;
    launchId: string;
    reportDirectory: string;
    scenarioReceiptPath: string;
    serial: string;
    sourceCommit: string;
}

function requireEnvironment(): PairingDesktopEnvironment {
    const assetsDirectory = process.env.CAXRI_MOBILE_ACCEPTANCE_ASSETS_DIR;
    const cleanupReceiptPath = process.env.CAXRI_MOBILE_ACCEPTANCE_CLEANUP_RECEIPT;
    const launchId = process.env.CAXRI_MOBILE_ACCEPTANCE_LAUNCH_ID;
    const reportDirectory = process.env.CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR;
    const scenarioReceiptPath = process.env.CAXRI_MOBILE_ACCEPTANCE_SCENARIO_RECEIPT;
    const serial = process.env.CAXRI_MOBILE_ACCEPTANCE_SERIAL;
    const sourceCommit = process.env.CAXRI_MOBILE_ACCEPTANCE_SOURCE_COMMIT;
    if (
        !assetsDirectory ||
        !cleanupReceiptPath ||
        !launchId ||
        !reportDirectory ||
        !scenarioReceiptPath ||
        !serial ||
        !sourceCommit
    ) {
        throw new Error('Desktop mobile-pairing Acceptance identity is incomplete');
    }
    return {
        assetsDirectory,
        cleanupReceiptPath,
        launchId,
        reportDirectory,
        scenarioReceiptPath,
        serial,
        sourceCommit,
    };
}

async function encodeSafePreCredentialVideo(
    framesDirectory: string,
    outputPath: string,
): Promise<void> {
    await execFileAsync(
        'ffmpeg',
        [
            '-v',
            'error',
            '-framerate',
            '2',
            '-i',
            join(framesDirectory, 'frame-%03d.png'),
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-r',
            '12',
            '-y',
            outputPath,
        ],
        { timeout: 30_000 },
    );
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument.
test('pairs from Desktop Settings without capturing the pairing credential', async ({}) => {
    test.skip(
        !process.env.CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR,
        'Run through the guarded Desktop mobile Acceptance adapter',
    );
    const environment = requireEnvironment();
    const videoPath = join(environment.assetsDirectory, 'MOB-PAIR-01-desktop.mp4');
    const screenshotPath = join(environment.assetsDirectory, 'MOB-PAIR-01-desktop.png');
    const domPath = join(environment.assetsDirectory, 'MOB-PAIR-01-desktop.html');
    const fixture = await createMobileAcceptanceFixture({
        mode: 'empty',
        serial: environment.serial,
    });
    const framesDirectory = join(fixture.testDirectory, 'acceptance-frames');
    await mkdir(framesDirectory, { recursive: true });
    try {
        await markCaseLifecycleReady(environment.reportDirectory, {
            caseId: 'MOB-PAIR-01',
            launchId: environment.launchId,
        });
        await fixture.running.page.setViewportSize({ height: 900, width: 1_200 });
        const settingsTab = await openSettingsPage(fixture.running.page);
        await revealSettingsSection(settingsTab, 'Mobile');
        const mobileForm = settingsTab.getByTestId('mobile-access-form');
        await expect(mobileForm).toContainText('Turn on to let a phone pair with this computer');

        let frameIndex = 1;
        const captureFrames = async (): Promise<void> => {
            for (let count = 0; count < 2; count += 1) {
                // Sequential capture deliberately records the actual UI state reached by the prior interaction.
                // eslint-disable-next-line no-await-in-loop
                await fixture.running.page.screenshot({
                    path: join(framesDirectory, `frame-${String(frameIndex).padStart(3, '0')}.png`),
                });
                frameIndex += 1;
            }
        };

        await captureFrames();
        await mobileForm.getByRole('button', { name: 'Turn on mobile access' }).click();
        await expect(mobileForm).toContainText('Available on this network');
        await captureFrames();

        const projectCheckboxes = mobileForm.getByRole('checkbox');
        await expect(projectCheckboxes).toHaveCount(2);
        await projectCheckboxes.nth(1).click();
        await expect(mobileForm).toContainText('Selected 1 of');
        await captureFrames();
        await mobileForm.getByRole('button', { name: 'Create pairing code' }).hover();
        await captureFrames();
        await encodeSafePreCredentialVideo(framesDirectory, videoPath);

        await fixture.pairFromDesktopUi(() =>
            mobileForm.getByRole('button', { name: 'Create pairing code' }).click(),
        );
        await expect(mobileForm).not.toContainText('Scan with Caxri Mobile');
        await expect(mobileForm).toContainText('Paired devices');
        await expect(mobileForm).toContainText('Access: allowed-project');
        await fixture.running.page.screenshot({ path: screenshotPath });
        const focusedDom = await mobileForm.evaluate((element) => element.outerHTML);
        await writeFile(domPath, focusedDom, 'utf8');
        await writeFile(
            environment.scenarioReceiptPath,
            `${JSON.stringify(
                {
                    captureBoundary:
                        'stopped-before-pairing-create-and-resumed-after-pairing-cleared',
                    caseId: 'MOB-PAIR-01',
                    grantedProjectCount: 1,
                    launchId: environment.launchId,
                    pairedDeviceCount: 1,
                    schemaVersion: 1,
                    sourceCommit: environment.sourceCommit,
                    status: 'passed',
                },
                null,
                2,
            )}\n`,
            'utf8',
        );
    } finally {
        await fixture.stop();
        await writeFile(
            environment.cleanupReceiptPath,
            `${JSON.stringify({ cleanupCompleted: true, schemaVersion: 1 })}\n`,
            'utf8',
        );
    }
});
