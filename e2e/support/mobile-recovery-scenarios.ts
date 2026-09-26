import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeJsonAtomic } from '../../scripts/atomic-json.ts';
import { expect } from './fixtures.ts';
import { pageRequest } from './helpers.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture.ts';
import {
    adbShell,
    captureMobileFramebuffer,
    mobileSemantics,
    openMobilePairingLink,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android.ts';

interface Environment {
    artifactManifestPath: string;
    assetsDirectory: string;
    caseId: string;
    remoteVideoPath?: string;
    scenarioReceiptPath: string;
    serial: string;
}

async function capture(
    environment: Environment,
    label: string,
    artifacts: string[],
): Promise<void> {
    const name = `${environment.caseId}-${label}-android.png`;
    await captureMobileFramebuffer(environment.serial, join(environment.assetsDirectory, name));
    artifacts.push(`assets/${name}`);
}

async function finish(
    environment: Environment,
    artifacts: string[],
    receipt: Record<string, unknown>,
): Promise<void> {
    await Promise.all([
        writeJsonAtomic(environment.artifactManifestPath, { artifacts, schemaVersion: 1 }),
        writeFile(
            environment.scenarioReceiptPath,
            `${JSON.stringify({ ...receipt, caseId: environment.caseId, schemaVersion: 1 }, null, 2)}\n`,
            'utf8',
        ),
    ]);
}

function requireVideoPath(path: string | undefined): string {
    if (!path) throw new Error('Scenario-owned Android recording path is unavailable');
    return path;
}

export async function executeMobileRecoveryScenario(
    environment: Environment,
    artifacts: string[],
): Promise<void> {
    const videoPath = environment.remoteVideoPath;
    switch (environment.caseId) {
        case 'MOB-PAIR-CANCEL-01': {
            const fixture = await createMobileAcceptanceFixture({
                delayPairingResult: true,
                mode: 'empty',
                serial: environment.serial,
            });
            let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
            try {
                await pageRequest(fixture.running.page, 'mobile.access.enable');
                const pairing = await pageRequest<{ pairingLink: string }>(
                    fixture.running.page,
                    'mobile.pairing.create',
                    { projectIds: [fixture.allowedProjectId] },
                );
                recording = await startMobileFramebufferRecording(
                    environment.serial,
                    requireVideoPath(videoPath),
                );
                await openMobilePairingLink(environment.serial, pairing.pairingLink);
                // UIAutomator can take longer than the delayed pairing result to read a loading frame.
                await new Promise((resolve) => setTimeout(resolve, 750));
                await adbShell(environment.serial, ['input', 'keyevent', 'KEYCODE_BACK']);
                // A deep link launched from Home returns to the Android launcher on Back.
                await new Promise((resolve) => setTimeout(resolve, 7_000));
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
                );
                const afterDelay = await mobileSemantics(environment.serial);
                expect(afterDelay.some(({ checkId }) => checkId === 'pairing-entry-screen')).toBe(
                    true,
                );
                expect(afterDelay.some(({ checkId }) => checkId === 'session-list')).toBe(false);
                await capture(environment, 'after-cancel', artifacts);
                await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
                );
                await capture(environment, 'after-restart', artifacts);
                await finish(environment, artifacts, {
                    latePairing: 'did-not-adopt-or-persist',
                    status: 'passed',
                });
            } finally {
                await recording?.stop();
                await fixture.stop();
            }
            return;
        }
        case 'MOB-RENDER-01': {
            await adbShell(environment.serial, [
                'am',
                'start',
                '-W',
                'com.caxri.mobile/.MainActivity',
            ]);
            await waitForMobile(
                () => mobileSemantics(environment.serial),
                (nodes) => nodes.some(({ checkId }) => checkId === 'route-error-retry'),
            );
            await capture(environment, 'render-error', artifacts);
            await tapMobileCheck(environment.serial, 'route-error-retry');
            await waitForMobile(
                () => mobileSemantics(environment.serial),
                (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
            );
            await capture(environment, 'render-recovered', artifacts);
            await finish(environment, artifacts, {
                retry: 'returned-to-pairing',
                status: 'passed',
            });
            return;
        }
        case 'MOB-STORAGE-01': {
            const fixture = await createMobileAcceptanceFixture({
                mode: 'empty',
                serial: environment.serial,
            });
            try {
                await fixture.pair();
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'session-list'),
                );
                await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
                await adbShell(environment.serial, [
                    'am',
                    'start',
                    '-W',
                    'com.caxri.mobile/.MainActivity',
                ]);
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'credential-storage-retry'),
                );
                await capture(environment, 'storage-error', artifacts);
                await tapMobileCheck(environment.serial, 'credential-storage-retry');
                await waitForMobile(
                    () => mobileSemantics(environment.serial),
                    (nodes) => nodes.some(({ checkId }) => checkId === 'session-list'),
                );
                await capture(environment, 'storage-recovered', artifacts);
                await finish(environment, artifacts, {
                    credential: 'preserved-across-failed-read-and-retry',
                    status: 'passed',
                });
            } finally {
                await fixture.stop();
            }
            return;
        }
        default:
            throw new Error(`Unsupported recovery Acceptance case: ${environment.caseId}`);
    }
}
