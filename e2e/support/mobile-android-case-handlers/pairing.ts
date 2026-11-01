import { pageRequest } from '../helpers';
import { createMobileAcceptanceFixture } from '../mobile-acceptance-fixture';
import { capture, finish } from '../mobile-agent-actions-scenarios';
import { adbShell, mobileSemantics, tapMobileCheck, waitForMobile } from '../mobile-android';
import type {
    MobileAndroidCaseEnvironment,
    MobileAndroidCaseHandler,
} from '../mobile-android-case-registry';

async function executeDeniedCameraPairing(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    await adbShell(environment.serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
    );
    await capture(environment, 'first-connect', artifacts);
    await tapMobileCheck(environment.serial, 'pairing-scan-button');
    await waitForMobile(
        () => mobileSemantics(environment.serial),
        (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-camera-permission-button'),
    );
    const camera = await adbShell(environment.serial, ['dumpsys', 'package', 'com.caxri.mobile']);
    if (!/android\.permission\.CAMERA:\s+granted=false/u.test(camera)) {
        throw new Error('Camera permission is not in the expected denied state');
    }
    await capture(environment, 'camera-denied', artifacts);
    await tapMobileCheck(environment.serial, 'pairing-scan-back-button');
    const fixture = await createMobileAcceptanceFixture({
        mode: 'empty',
        serial: environment.serial,
    });
    try {
        await fixture.pair();
        await capture(environment, 'paired-empty-sessions', artifacts);
    } finally {
        await fixture.stop();
    }
    await finish(environment, artifacts, {
        cameraPermission: 'denied',
        fallback: 'paste-entry-remained-available',
        outcome: 'paired-empty-sessions',
        status: 'passed',
    });
}

async function executePairingRevocation(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'empty',
        serial: environment.serial,
    });
    try {
        const online = await fixture.pair();
        const revokedAt = Date.now();
        await pageRequest(fixture.running.page, 'mobile.device.revoke', {
            deviceId: online.deviceId,
        });
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
            5_000,
        );
        const onlineDurationMs = Date.now() - revokedAt;
        await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
        await adbShell(environment.serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'pairing-entry-screen'),
        );

        const offline = await fixture.pair();
        await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
        await pageRequest(fixture.running.page, 'mobile.device.revoke', {
            deviceId: offline.deviceId,
        });
        await adbShell(environment.serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'session-list-unverified') &&
                nodes.some(({ checkId }) => checkId === 'computer-menu-button') &&
                nodes.some(({ checkId }) => checkId === 'connection-retry-button'),
        );
        await finish(environment, artifacts, {
            offlineAuthentication: 'unverified-credential-preserved',
            onlineRevocation: 'credential-cleared',
            onlineRevocationDurationMs: onlineDurationMs,
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

export const handlers = {
    'MOB-PAIR-02': executeDeniedCameraPairing,
    'MOB-PAIR-03': executePairingRevocation,
} satisfies Record<string, MobileAndroidCaseHandler>;
