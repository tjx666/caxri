import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    isRunningLastCommand,
    RUNNING_PROMPT,
    runningInvestigationScript,
} from './mobile-agent-chat-running-turn-scenario';
import {
    adbShell,
    androidBounds,
    mobileDisplayState,
    mobileRegionFingerprint,
    mobileSemantics,
    waitForMobile,
} from './mobile-android';
import { setEmulatorNetworkDelay } from './mobile-android-network';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Round-trip latency while the reader scrolls back, so each history page lands well after the drag that asked for it
 * ended and any movement it causes is the list's own, not the finger's.
 */
const PAGE_DELAY_MS = 800;

/**
 * Slow drags toward older rows. Each one is slow enough to leave no fling behind, and together they carry the reader
 * from the end of the opened window to its top, where the list reads older pages on its own.
 */
const DRAG_COUNT = 6;
const DRAG_MS = 1_500;

/**
 * How long after a drag the list may still move on its own: a page lands at {@link PAGE_DELAY_MS} and one scroll-back
 * reads several pages in a row.
 */
const WATCH_AFTER_DRAG_MS = 5_000;

/**
 * Lets the lifted finger's last scroll events and the scroll bar's fade finish before the reference picture.
 */
const LIFT_SETTLE_MS = 700;

/**
 * `MOB-CHAT-SCROLLBACK-01`: a reader who scrolls back through a long running turn keeps their place while older pages
 * load. Each page that extended the top work run gave that row a new id, FlashList lost the row it keeps in place, and
 * the list jumped page after page to the turn's request while the reader's finger was off the screen.
 *
 * UIAutomator never reads a Chat whose running status keeps ticking, so the rows are compared as pixels: after each
 * drag, a band of the timeline below the history header (and left of the scroll bar) must still show the picture it
 * showed when the finger lifted once the pages that drag asked for have landed.
 */
export async function executeMobileChatScrollbackScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: runningInvestigationScript,
        mode: 'agent-chat',
        serial,
    });
    let isDelayed = false;
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        const row = (await mobileSemantics(serial)).find(
            ({ checkId }) => checkId === `session-row-${fixture.allowedSessionId}`,
        );
        const bounds = row && androidBounds(row.bounds);
        if (!bounds) throw new Error('The Session row is not laid out');
        const { size } = await mobileDisplayState(serial);
        const { height, width } = size.override ?? size.physical;
        await chat.send({ text: RUNNING_PROMPT });
        await waitForMobile(() => chat.read(), isRunningLastCommand, 60_000);
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.floor((bounds.left + bounds.right) / 2)),
            String(Math.floor((bounds.top + bounds.bottom) / 2)),
        ]);
        await pause(WATCH_AFTER_DRAG_MS);
        await capture(environment, 'opened', artifacts);
        await setEmulatorNetworkDelay(serial, PAGE_DELAY_MS);
        isDelayed = true;
        const band = {
            bottom: Math.floor(height * 0.55),
            left: 0,
            right: Math.floor(width * 0.9),
            top: Math.floor(height * 0.3),
        };
        const x = String(Math.floor(width / 2));
        const moves: Array<{ drag: number; changedSamples: number }> = [];
        for (let drag = 1; drag <= DRAG_COUNT; drag += 1) {
            // eslint-disable-next-line no-await-in-loop -- each drag starts where the previous one left the list
            await adbShell(serial, [
                'input',
                'swipe',
                x,
                String(Math.floor(height * 0.3)),
                x,
                String(Math.floor(height * 0.6)),
                String(DRAG_MS),
            ]);
            // eslint-disable-next-line no-await-in-loop -- see above
            await pause(LIFT_SETTLE_MS);
            // eslint-disable-next-line no-await-in-loop -- see above
            const lifted = await mobileRegionFingerprint(serial, band);
            let changedSamples = 0;
            const deadline = Date.now() + WATCH_AFTER_DRAG_MS;
            while (Date.now() < deadline) {
                // eslint-disable-next-line no-await-in-loop -- one framebuffer read at a time
                await pause(400);
                // eslint-disable-next-line no-await-in-loop -- see above
                if ((await mobileRegionFingerprint(serial, band)) !== lifted) changedSamples += 1;
            }
            // eslint-disable-next-line no-await-in-loop -- see above
            const settled = await mobileRegionFingerprint(serial, band);
            if (settled !== lifted || changedSamples > 0) moves.push({ changedSamples, drag });
        }
        await setEmulatorNetworkDelay(serial, 0);
        isDelayed = false;
        await capture(environment, 'scrolled-back', artifacts);
        if (moves.length > 0)
            throw new Error(
                `The timeline moved without a touch after ${moves.length} of ${DRAG_COUNT} drags: ${JSON.stringify(moves)}`,
            );
        await finish(environment, artifacts, {
            drags: DRAG_COUNT,
            pageDelayMs: PAGE_DELAY_MS,
            status: 'passed',
        });
    } finally {
        if (isDelayed) await setEmulatorNetworkDelay(serial, 0);
        await fixture.stop();
    }
}
