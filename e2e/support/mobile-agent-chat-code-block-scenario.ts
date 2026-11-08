import { draculaTheme } from '@caxri/protocol';

import { FAKE_CODEX_WIDE_CODE } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-codex-wide-code.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, concludeScenario } from './mobile-agent-actions-scenarios';
import {
    agentText,
    checkBounds,
    hasCheck,
    hideChatKeyboard,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import type { androidBounds } from './mobile-android';
import {
    adbShell,
    mobileColorBounds,
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
 * The block's inside, clear of its border and of the scroll indicator a drag flashes along its bottom, so two
 * fingerprints of it compare only the text: a drag the block snapped back from still showed that indicator.
 */
const inner = (bounds: ScreenBounds): ScreenBounds => ({
    bottom: bounds.bottom - 24,
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

/**
 * The timeline on the 1080x2400 emulator between the header and the composer, left of the user's right-aligned bubble.
 * The code block is the only thing in it drawn in the theme's border color.
 */
const TIMELINE_LEFT_REGION = { bottom: 1700, left: 0, right: 700, top: 320 };

/**
 * The code block's frame from its border pixels, stretched to the right edge the left region leaves out: the block
 * spans the reply's width, which mirrors its left margin.
 */
async function blockByBorder(serial: string): Promise<ScreenBounds | undefined> {
    const found = await mobileColorBounds(
        serial,
        TIMELINE_LEFT_REGION,
        draculaTheme.colors.border,
        4,
    );
    return found && { ...found, right: 1080 - found.left };
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
        // Sent from the computer: the phone's own send is covered elsewhere and is not what this case checks.
        await chat.send({ text: 'widecode' });

        // A running turn never lets UIAutomator idle, so while the reply streams the block is found by its border.
        const start = await waitForMobile(
            () => blockByBorder(serial),
            (bounds) => bounds !== undefined,
        );
        if (!start) throw new Error('The wide code block is not on screen');
        // Past the reply's quiet pause, its tail streams word by word for about fifteen seconds.
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('word'),
        );
        await settle(2000);
        const unscrolled = await mobileRegionFingerprint(serial, inner(start));
        await capture(environment, 'wide-code-streaming', artifacts);
        await swipeBlockLeft(serial, start);
        // Several words arrive in this time, each one a redraw of the reply.
        await settle(2500);
        const duringStream = await mobileRegionFingerprint(serial, inner(start));
        await capture(environment, 'wide-code-swiped-while-streaming', artifacts);
        const isStillStreaming = Boolean((await chat.read()).activeTurnId);

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
        const isCopyHiddenAtRest = !hasCheck(atEnd, `${BLOCK_ID}-copy`);
        const afterStream = await mobileRegionFingerprint(serial, inner(end));
        await capture(environment, 'wide-code-after-stream', artifacts);

        // At rest, another drag moves the block further.
        await swipeBlockLeft(serial, end);
        await settle(1000);
        const afterRestSwipe = await mobileRegionFingerprint(serial, inner(end));
        await capture(environment, 'wide-code-swiped-at-rest', artifacts);

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
            { codeBlock: 'wide-code' },
            {
                'Copy hidden before a tap': isCopyHiddenAtRest,
                'block scrolls sideways while the reply streams':
                    isStillStreaming && duringStream !== unscrolled,
                'block keeps its sideways scroll once the reply ends': afterStream === duringStream,
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
