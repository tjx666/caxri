import { setTimeout as delay } from 'node:timers/promises';

import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    startMobileFramebufferRecording,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';
import { createMobileDashboardParityFixture } from './mobile-dashboard-parity-fixture';

/**
 * Native Home states and live running-to-waiting updates, using the existing deterministic provider fixture.
 */
export async function executeMobileDashboardStateScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileDashboardParityFixture(serial);
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.pair();
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                Object.values(fixture.sessionIds).every((id) =>
                    hasCheck(nodes, `session-row-${id}`),
                ),
        );
        await capture(environment, 'home-three-states', artifacts);
        const row = checkBounds(
            await mobileSemantics(serial),
            `session-row-${fixture.sessionIds.completed}`,
        );
        if (!row) throw new Error('The Home Session row is unavailable');
        const x = String(Math.floor((row.left + row.right) / 2));
        const y = String(Math.floor((row.top + row.bottom) / 2));
        await adbShell(serial, ['input', 'swipe', x, y, x, y, '600']);
        await waitForCheck(serial, 'session-actions-sheet');
        await capture(environment, 'session-actions-pin-gap', artifacts);
        await tapMobileCheck(serial, 'session-actions-cancel');
        await waitForCheck(serial, 'session-list');
        await tapMobileCheck(serial, 'forget-device-button');
        await waitForCheck(serial, 'settings-action');
        await capture(environment, 'home-menu', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForCheck(serial, 'session-list');
        const rowTop = async () => {
            const row = (await mobileSemantics(serial)).find(
                ({ checkId }) => checkId === `session-row-${fixture.sessionIds.running}`,
            );
            return row ? Number(/^\[\d+,(\d+)\]/u.exec(row.bounds)?.[1]) : NaN;
        };
        const before = await rowTop();
        recording = environment.remoteVideoPath
            ? await startMobileFramebufferRecording(serial, environment.remoteVideoPath)
            : undefined;
        /**
         * Keep both settled states readable in the recording. An immediate fixture update can precede Android's first
         * encoded frame, and stopping as soon as it moves produces a clip below Acceptance's three-second minimum. This
         * dwell controls evidence duration; the semantic predicates still own application readiness.
         */
        if (recording) await delay(2_000);
        await fixture.triggerRunningToWaiting();
        await waitForMobile(rowTop, (top) => Number.isFinite(top) && top < before, 15_000);
        await capture(environment, 'home-running-to-waiting', artifacts);
        if (recording) await delay(2_000);
        await recording?.stop();
        recording = undefined;
        await finish(environment, artifacts, { states: 3, liveTransition: 'running-to-waiting' });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
