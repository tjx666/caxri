import { FAKE_CODEX_WIDE_CODE } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-wide-code.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, concludeScenario } from './mobile-agent-actions-scenarios';
import {
    agentText,
    checkBounds,
    hasCheck,
    hideChatKeyboard,
    sendFromPhone,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import type { androidBounds } from './mobile-android';
import {
    adbShell,
    mobileRegionFingerprint,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

type ScreenBounds = NonNullable<ReturnType<typeof androidBounds>>;

const BLOCK_ID = 'conversation-fenced-code';

/**
 * How far one sideways drag moves the block: well short of its scroll range, so a second drag still moves it.
 */
const SWIPE_DP = 300;

/**
 * The block's inside, clear of its border, so two fingerprints of it compare only what scrolled.
 */
const inner = (bounds: ScreenBounds): ScreenBounds => ({
    bottom: bounds.bottom - 4,
    left: bounds.left + 4,
    right: bounds.right - 4,
    top: bounds.top + 4,
});

/**
 * Drags the block's text left by {@link SWIPE_DP}, along its vertical middle.
 */
async function swipeBlockLeft(serial: string, bounds: ScreenBounds): Promise<void> {
    const y = String(Math.round((bounds.top + bounds.bottom) / 2));
    const from = bounds.right - 80;
    await adbShell(serial, ['input', 'swipe', String(from), y, String(from - SWIPE_DP), y, '400']);
}

/**
 * Whether a wait met its condition, so a missed outcome lands in the receipt instead of ending the case early.
 */
async function didSucceed(wait: Promise<unknown>): Promise<boolean> {
    try {
        await wait;
        return true;
    } catch {
        return false;
    }
}

async function settle(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `MOB-CHAT-CODE-01`: a code block wider than the phone in an Agent reply. The block scrolls sideways while the reply
 * still streams and keeps that position once it ends, it scrolls again at rest, Copy stays hidden until a tap on the
 * block shows it, Copy puts the whole block on the clipboard, and a long press still opens the message's actions.
 */
export async function executeMobileChatCodeBlockScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await sendFromPhone(serial, 'widecode');
        await hideChatKeyboard(serial);

        // The reply holds still after its block for a few seconds, so the layout reads through UIAutomator here.
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('resetsAt'),
        );
        await waitForCheck(serial, BLOCK_ID);
        const atStart = await mobileSemantics(serial);
        const start = checkBounds(atStart, BLOCK_ID);
        if (!start) throw new Error('The wide code block is not on screen');
        const isCopyHiddenAtStart = !hasCheck(atStart, `${BLOCK_ID}-copy`);
        const unscrolled = await mobileRegionFingerprint(serial, inner(start));
        await capture(environment, 'wide-code-streaming', artifacts);

        // The tail starts streaming word by word; the drag lands while the reply still grows.
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('word3 '),
        );
        await swipeBlockLeft(serial, start);
        await settle(1500);
        // Read where the block started: the growing tail may have moved it, so this is recorded rather than checked.
        const duringStream = await mobileRegionFingerprint(serial, inner(start));
        await capture(environment, 'wide-code-swiped-while-streaming', artifacts);

        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('Done.') && !snapshot.activeTurnId,
            60_000,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await settle(1000);
        const atEnd = await mobileSemantics(serial);
        const end = checkBounds(atEnd, BLOCK_ID);
        if (!end) throw new Error('The wide code block left the screen');
        const afterStream = await mobileRegionFingerprint(serial, inner(end));
        await capture(environment, 'wide-code-after-stream', artifacts);

        // At rest, another drag moves the block further.
        await swipeBlockLeft(serial, end);
        await settle(1000);
        const afterRestSwipe = await mobileRegionFingerprint(serial, inner(end));
        await capture(environment, 'wide-code-swiped-at-rest', artifacts);
        const isCopyHiddenAtRest = !hasCheck(await mobileSemantics(serial), `${BLOCK_ID}-copy`);

        // A tap on the block shows Copy; Copy takes the whole block.
        const x = String(end.left + 60);
        const y = String(Math.round((end.top + end.bottom) / 2));
        await adbShell(serial, ['input', 'tap', x, y]);
        const isCopyShownOnTap = await didSucceed(waitForCheck(serial, `${BLOCK_ID}-copy`, 5_000));
        await capture(environment, 'wide-code-copy-shown', artifacts);
        let isPasted = false;
        if (isCopyShownOnTap) {
            await tapMobileCheckByBounds(serial, `${BLOCK_ID}-copy`, {
                viewport: 'conversation-view',
            });
            await waitForCheck(serial, `${BLOCK_ID}-copy-copied`);
            await capture(environment, 'wide-code-copied', artifacts);
            // Android's clipboard preview appears over the composer after a copy: tap it away before pasting.
            await adbShell(serial, ['input', 'tap', '540', '1000']);
            await settle(1000);
            await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
            await adbShell(serial, ['input', 'keyevent', 'KEYCODE_PASTE']);
            isPasted = await didSucceed(
                waitForMobile(
                    () =>
                        observeMobileNode(serial, 'agent-chat-composer-input', {
                            kind: 'equals',
                            value: FAKE_CODEX_WIDE_CODE,
                        }),
                    (node) => node.exists && node.textMatches === true,
                ),
            );
            await hideChatKeyboard(serial);
            await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
            await adbShell(serial, ['input', 'keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A']);
            await adbShell(serial, ['input', 'keyevent', 'KEYCODE_DEL']);
            await hideChatKeyboard(serial);
        }

        // A long press on the block still opens the message's actions.
        const block = checkBounds(await mobileSemantics(serial), BLOCK_ID);
        if (!block) throw new Error('The wide code block left the screen');
        const pressX = String(block.left + 60);
        const pressY = String(Math.round((block.top + block.bottom) / 2));
        await adbShell(serial, ['input', 'swipe', pressX, pressY, pressX, pressY, '900']);
        await settle(1500);
        const hasSheet = hasCheck(await mobileSemantics(serial), 'conversation-message-sheet');
        await capture(environment, 'wide-code-long-press', artifacts);

        await concludeScenario(
            environment,
            artifacts,
            {
                codeBlock: 'wide-code',
                changedRightAfterDragWhileStreaming: duringStream !== unscrolled,
            },
            {
                'Copy hidden before a tap': isCopyHiddenAtStart && isCopyHiddenAtRest,
                'block kept its sideways scroll through the stream': afterStream !== unscrolled,
                'block scrolls sideways at rest': afterRestSwipe !== afterStream,
                'tap shows Copy': isCopyShownOnTap,
                'Copy puts the whole block on the clipboard': isPasted,
                'long press opens the message actions': hasSheet,
            },
        );
    } finally {
        await fixture.stop();
    }
}
