import { pageRequest } from '../helpers';
import { createMobileAcceptanceFixture } from '../mobile-acceptance-fixture';
import { capture, finish } from '../mobile-agent-actions-scenarios';
import {
    adbShell,
    mobileDisplayState,
    mobileSemantics,
    restoreMobileDisplayState,
    setMobileNetworkAvailable,
    tapMobileCheck,
    waitForMobile,
} from '../mobile-android';
import type {
    MobileAndroidCaseEnvironment,
    MobileAndroidCaseHandler,
} from '../mobile-android-case-registry';
import { showTabletSessionRow } from '../mobile-session-list';
import { executeMobileSessionRefreshScenario } from '../mobile-session-refresh-scenarios';

async function executeSessionLayouts(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const originalDisplay = await mobileDisplayState(environment.serial);
    const fixture = await createMobileAcceptanceFixture({
        mode: 'waiting',
        serial: environment.serial,
    });
    try {
        await fixture.pair();
        const allowedSessionId = fixture.allowedSessionId;
        if (!allowedSessionId) throw new Error('Waiting Session is unavailable');
        await capture(environment, 'phone-list', artifacts);
        await tapMobileCheck(environment.serial, `session-row-${allowedSessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'session-detail') &&
                nodes.some(({ checkId }) => checkId === 'terminal-live-webview'),
        );
        await capture(environment, 'phone-detail', artifacts);

        await adbShell(environment.serial, ['wm', 'size', '1600x2560']);
        await adbShell(environment.serial, ['wm', 'density', '320']);
        /**
         * The Android emulator reports the 800dp tablet configuration only after Activity recreation; changing `wm`
         * overrides underneath the running React Native Activity leaves its Window metrics unchanged.
         */
        await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
        await adbShell(environment.serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
        await showTabletSessionRow(environment.serial, fixture.allowedProjectId, allowedSessionId);
        await tapMobileCheck(environment.serial, `session-row-${allowedSessionId}`);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'session-list') &&
                nodes.some(({ checkId }) => checkId === 'session-detail') &&
                nodes.some(({ checkId }) => checkId === 'terminal-live-webview'),
        );
        await capture(environment, 'tablet-split', artifacts);
        await restoreMobileDisplayState(environment.serial, originalDisplay);
        await adbShell(environment.serial, ['am', 'force-stop', 'com.caxri.mobile']);
        await adbShell(environment.serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-list'),
        );

        await pageRequest(fixture.running.page, 'session.delete', {
            sessionId: allowedSessionId,
        });
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'session-list-empty'),
        );
        await capture(environment, 'empty', artifacts);
        await pageRequest(fixture.running.page, 'mobile.access.disable');
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) => nodes.some(({ checkId }) => checkId === 'connection-stale-banner'),
            7_000,
        );
        await capture(environment, 'stale-error', artifacts);
        await finish(environment, artifacts, {
            displayAfter: await mobileDisplayState(environment.serial),
            displayBefore: originalDisplay,
            states: ['phone-list', 'phone-detail', 'tablet-split', 'empty', 'stale-error'],
            terminalPreview: 'synthetic-non-empty',
            status: 'passed',
        });
    } finally {
        await restoreMobileDisplayState(environment.serial, originalDisplay);
        await fixture.stop();
    }
}

async function executeStaleSessionRecovery(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'waiting',
        serial: environment.serial,
    });
    let isNetworkDisabled = false;
    try {
        await fixture.pair();
        if (!fixture.allowedSessionId) throw new Error('Waiting Session is unavailable');
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        const disconnectedAt = Date.now();
        isNetworkDisabled = true;
        await setMobileNetworkAvailable(environment.serial, false);
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId === 'connection-stale-banner') &&
                nodes.some(
                    ({ checkId, enabled }) => checkId === 'session-composer-send' && !enabled,
                ),
            7_000,
        );
        const staleDurationMs = Date.now() - disconnectedAt;
        await setMobileNetworkAvailable(environment.serial, true);
        isNetworkDisabled = false;
        await waitForMobile(
            () => mobileSemantics(environment.serial),
            (nodes) =>
                nodes.every(({ checkId }) => checkId !== 'connection-stale-banner') &&
                nodes.some(({ checkId }) => checkId === 'session-detail'),
            30_000,
        );
        await finish(environment, artifacts, {
            contentDuringStale: 'preserved',
            recovery: 'automatic-without-restart',
            staleDurationMs,
            status: 'passed',
        });
    } finally {
        if (isNetworkDisabled) await setMobileNetworkAvailable(environment.serial, true);
        await fixture.stop();
    }
}

export const handlers = {
    'MOB-SESSION-01': executeSessionLayouts,
    'MOB-SESSION-03': executeStaleSessionRecovery,
    'MOB-SESSION-PUSH-01': executeMobileSessionRefreshScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
