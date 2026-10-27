import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentUsageReadout, UsageLimit } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    coldStartMobileApp,
    mobileSemantics,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * Scrolls the model sheet toward its end until the weekly plan-limit row is laid out, one drag per try. The drag stays
 * inside the sheet, away from Android's Back gesture edges.
 */
async function scrollModelSheetToPlanLimits(serial: string, triesLeft = 6): Promise<void> {
    const nodes = await mobileSemantics(serial);
    if (checkBounds(nodes, 'agent-chat-plan-limit-10080')) return;
    const sheet = checkBounds(nodes, 'agent-chat-model-sheet');
    if (!sheet || triesLeft === 0) throw new Error('The plan limits are not on screen');
    const x = Math.floor((sheet.left + sheet.right) / 2);
    const height = sheet.bottom - sheet.top;
    await adbShell(serial, [
        'input',
        'swipe',
        String(x),
        String(sheet.top + Math.floor(height * 0.8)),
        String(x),
        String(sheet.top + Math.floor(height * 0.3)),
        '300',
    ]);
    await scrollModelSheetToPlanLimits(serial, triesLeft - 1);
}

/**
 * `MOB-CHAT-22`: a phone shows a running Claude Chat's plan limits. With the weekly limit used faster than an even pace
 * (the fake Claude's `/usage` answer: 61% of the week used with 5 days 3 hours to go), the composer shows the pace
 * notice, the model sheet lists the 5-hour and weekly windows with what is left and when each resets, and dismissing
 * the notice keeps it hidden, also after the app is killed and opened again (the OS reclaiming a backgrounded app).
 */
export async function executeMobilePlanLimitsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await writeFile(join(fixture.testDirectory, 'plan-behind-pace'), '');
        await chat.send({ text: 'hi there' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage'),
        );
        // The running Chat answers `/usage` in the background; the first usage read only asks for it.
        const readout = await waitForMobile(
            () =>
                pageRequest<AgentUsageReadout | null>(fixture.running.page, 'terminal.agentUsage', {
                    terminalId: chat.terminalId,
                }),
            // The behind-pace answer took effect: the week is 61% used, not the fake's on-pace 10%.
            (current) =>
                current?.limit?.windows.length === 2 &&
                current.limit.windows.some(
                    ({ windowMinutes, usedPercent }) =>
                        windowMinutes === 10_080 && usedPercent === 61,
                ),
        );
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-plan-pace');
        await capture(environment, 'pace-notice', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-model-button');
        await waitForCheck(serial, 'agent-chat-model-sheet');
        await scrollModelSheetToPlanLimits(serial);
        await waitForCheck(serial, 'agent-chat-plan-limit-300');
        await capture(environment, 'model-sheet-limits', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');

        await tapMobileCheckByBounds(serial, 'agent-chat-plan-pace-dismiss');
        await waitForNoCheck(serial, 'agent-chat-plan-pace');
        await capture(environment, 'pace-dismissed', artifacts);
        // The notice hides from the phone's cache at once; kill the app only after the Server kept the dismissal.
        await waitForMobile(
            () => pageRequest<UsageLimit[]>(fixture.running.page, 'usage.limits', {}),
            (limits) =>
                (limits.find((limit) => limit.provider === 'claude')?.paceDismissedAt ?? 0) > 0,
        );

        await coldStartMobileApp(serial);
        await waitForCheck(serial, `session-row-${fixture.allowedSessionId}`, 60_000);
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        // The model sheet listing the weekly window proves the relaunched app read the behind-pace limit, so the absent
        // notice is the remembered dismissal rather than a limit that has not loaded yet.
        await tapMobileCheckByBounds(serial, 'agent-chat-model-button');
        await waitForCheck(serial, 'agent-chat-model-sheet');
        await scrollModelSheetToPlanLimits(serial);
        await waitForCheck(serial, 'agent-chat-plan-limit-300');
        await capture(environment, 'model-sheet-limits-after-relaunch', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');
        await waitForNoCheck(serial, 'agent-chat-plan-pace');
        await capture(environment, 'pace-dismissed-after-relaunch', artifacts);
        await finish(environment, artifacts, {
            limitWindows: readout?.limit?.windows.map(({ windowMinutes, usedPercent }) => ({
                windowMinutes,
                usedPercent,
            })),
            paceNotice: 'shown-then-dismissed-across-relaunch',
            planType: readout?.limit?.planType,
        });
    } finally {
        await fixture.stop();
    }
}
