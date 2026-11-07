import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, concludeScenario } from './mobile-agent-actions-scenarios';
import type { MobileAgentChatDriver } from './mobile-agent-chat-driver';
import {
    checkBounds,
    hasCheck,
    isReachedWithin,
    waitForCheck,
    waitForNoCheck,
    withVisibleKeyboard,
} from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import {
    adbShell,
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * Whether the settings chips row is on screen. The model chip is a button once the provider lists its models and a
 * plain label before that, so either one marks the row.
 */
const hasSettingsChips = (nodes: readonly MobileSemanticNode[]): boolean =>
    hasCheck(nodes, 'agent-chat-model-button') || hasCheck(nodes, 'agent-chat-model-label');

/**
 * The capsule's height, or `undefined` on the previous composer, which had no capsule.
 */
const capsuleHeight = (nodes: readonly MobileSemanticNode[]): number | undefined => {
    const bounds = checkBounds(nodes, 'agent-chat-composer-capsule');
    return bounds && bounds.bottom - bounds.top;
};

/**
 * Whether the composer shows the idle one-row capsule: a capsule as tall as the idle one, without the settings chips.
 */
const isOneRowCapsule = (
    nodes: readonly MobileSemanticNode[],
    idle: readonly MobileSemanticNode[],
): boolean => {
    const height = capsuleHeight(nodes);
    return height !== undefined && height === capsuleHeight(idle) && !hasSettingsChips(nodes);
};

/**
 * Pairs the phone with the fake Codex Chat fixture, opens its empty Chat, and runs `step` with the Chat's driver and
 * the idle composer's semantics.
 */
async function withEmptyChat(
    environment: MobileAgentScenarioEnvironment,
    step: (chat: MobileAgentChatDriver, idle: MobileSemanticNode[]) => Promise<void>,
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await step(chat, await waitForCheck(serial, 'agent-chat-composer-input'));
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-COMPOSER-CAPSULE-01` (#3752): the idle Chat composer is one capsule row, `[+] input [Send]`. Focusing it with
 * the keyboard up adds the settings chips as a second row, and closing the keyboard with Back folds it to one row.
 */
export const executeMobileComposerCapsuleLayoutScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> =>
    withEmptyChat(environment, async (_chat, idle) => {
        const { serial } = environment;
        const idleInput = checkBounds(idle, 'agent-chat-composer-input');
        if (!idleInput) throw new Error('The Chat composer is not laid out');
        const idleHeight = capsuleHeight(idle);
        await capture(environment, 'idle', artifacts);
        const focused: { hasChips: boolean; height: number | undefined } = {
            hasChips: false,
            height: undefined,
        };
        await withVisibleKeyboard(serial, async () => {
            await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
            // The composer rises above the keyboard only once the app laid it out for the keyboard, so the frame shows
            // the layout a user types into rather than a keyboard still sliding in.
            const nodes = await waitForMobile(
                () => mobileSemantics(serial),
                (current) => {
                    const input = checkBounds(current, 'agent-chat-composer-input');
                    return input !== undefined && input.top < idleInput.top - 300;
                },
            );
            focused.hasChips = hasSettingsChips(nodes);
            focused.height = capsuleHeight(nodes);
            await capture(environment, 'focused', artifacts);
        });
        const isFolded = await isReachedWithin(
            serial,
            (nodes) => isOneRowCapsule(nodes, idle),
            5_000,
        );
        await capture(environment, 'keyboard-closed', artifacts);
        await concludeScenario(
            environment,
            artifacts,
            { capsuleHeight: { focused: focused.height ?? null, idle: idleHeight ?? null } },
            {
                'idle composer has no settings chips': !hasSettingsChips(idle),
                'focused composer shows the settings chips': focused.hasChips,
                'focused capsule is taller than the idle one':
                    idleHeight !== undefined &&
                    focused.height !== undefined &&
                    focused.height > idleHeight,
                'composer folds to one row once the keyboard closes': isFolded,
            },
        );
    });

/**
 * `MOB-COMPOSER-CAPSULE-02` (#3752): the capsule's `+` opens the Add to Chat sheet, which lists the model, permission,
 * and usage rows under the photo sources.
 */
export const executeMobileComposerAddSheetScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> =>
    withEmptyChat(environment, async () => {
        const { serial } = environment;
        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await waitForCheck(serial, 'image-source-sheet');
        const rows = ['model', 'permission', 'usage'].map((entry) => `agent-chat-add-${entry}`);
        // The model row turns enabled once the provider lists its models, so the frame shows it ready to tap.
        const hasSettings = await isReachedWithin(
            serial,
            (nodes) =>
                rows.every((row) => hasCheck(nodes, row)) &&
                nodes.some(({ checkId, enabled }) => checkId === rows[0] && enabled),
            15_000,
        );
        await capture(environment, 'add-sheet', artifacts);
        await tapMobileCheck(serial, 'image-source-cancel');
        await waitForNoCheck(serial, 'image-source-sheet');
        await concludeScenario(
            environment,
            artifacts,
            {},
            { 'the + sheet lists the model, permission, and usage rows': hasSettings },
        );
    });

/**
 * `MOB-COMPOSER-CAPSULE-03` (#3752): a running turn keeps the single capsule, with Stop in Send's place and the status
 * row above it, and tapping that slot stops the turn.
 */
export const executeMobileComposerRunningScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> =>
    withEmptyChat(environment, async (chat, idle) => {
        const { serial } = environment;
        const send = checkBounds(idle, 'agent-chat-composer-send');
        if (!send) throw new Error('Send is not laid out');
        await chat.send({ text: 'longstream' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => Boolean(snapshot.activeTurnId),
        );
        // The status row's shimmer keeps UIAutomator from settling, so the running frame is read from pixels only. The
        // pause lets the phone receive the running turn, so the frame does not show a state that has not arrived yet.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        await capture(environment, 'running', artifacts);
        // Stop takes Send's place in the capsule, so the slot Send held while idle is where a user taps to stop.
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.floor((send.left + send.right) / 2)),
            String(Math.floor((send.top + send.bottom) / 2)),
        ]);
        let isStoppedFromSendSlot = true;
        try {
            await waitForMobile(
                () => chat.read(),
                (snapshot) => !snapshot.activeTurnId,
                15_000,
            );
        } catch {
            isStoppedFromSendSlot = false;
            await chat.interrupt();
            await waitForMobile(
                () => chat.read(),
                (snapshot) => !snapshot.activeTurnId,
            );
        }
        await waitForNoCheck(serial, 'agent-chat-activity');
        const stopped = await mobileSemantics(serial);
        await capture(environment, 'stopped', artifacts);
        await concludeScenario(
            environment,
            artifacts,
            {},
            {
                'the slot Send held stops the running turn': isStoppedFromSendSlot,
                'the stopped composer is the idle one-row capsule': isOneRowCapsule(stopped, idle),
            },
        );
    });

/**
 * `MOB-COMPOSER-CAPSULE-04` (#3752): offline, the reason the Chat cannot send shows above the capsule, which stays one
 * row.
 */
export const executeMobileComposerOfflineScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> =>
    withEmptyChat(environment, async (_chat, idle) => {
        const { serial } = environment;
        await setMobileNetworkAvailable(serial, false);
        try {
            const offline = await waitForCheck(serial, 'agent-chat-composer-reason', 60_000);
            await capture(environment, 'offline', artifacts);
            await concludeScenario(
                environment,
                artifacts,
                {},
                { 'the offline capsule stays one row': isOneRowCapsule(offline, idle) },
            );
        } finally {
            await setMobileNetworkAvailable(serial, true);
        }
    });
