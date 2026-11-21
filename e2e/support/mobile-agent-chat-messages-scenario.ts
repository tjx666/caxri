import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, concludeScenario } from './mobile-agent-actions-scenarios';
import {
    chatTimelineFrame,
    checkBounds,
    hasCheck,
    isReachedWithin,
    swipeTimelineTowardEarlier,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import { mobileSemantics, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * Three messages, each answered by the fake Codex `longreply` (about 4,800 characters), so the first message sits many
 * screens above the end.
 */
const MESSAGES = [
    'First question longreply',
    'Second question longreply',
    'Third question longreply',
];

async function settle(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `MOB-CONV-MESSAGES-01`: returning to an earlier user message in a long Chat. At the end no Messages button shows;
 * after scrolling up it stacks above Jump to latest, opens a sheet listing all three messages with the one being read
 * selected, and a tap on the first row brings that message back on screen and closes the sheet.
 */
export async function executeMobileChatMessagesScenario(
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
        for (const [index, text] of MESSAGES.entries()) {
            // eslint-disable-next-line no-await-in-loop -- each message waits for the previous turn to end.
            await chat.send({ text });
            // eslint-disable-next-line no-await-in-loop -- each message waits for the previous turn to end.
            await waitForMobile(
                () => chat.read(),
                (snapshot) =>
                    !snapshot.activeTurnId &&
                    snapshot.items.filter((item) => item.type === 'agentMessage').length > index,
                90_000,
            );
        }
        const snapshot = await chat.read();
        const userIds = snapshot.items
            .filter((item) => item.type === 'userMessage')
            .map((item) => item.id);
        if (userIds.length !== MESSAGES.length) throw new Error('The Chat lost a user message');
        await waitForNoCheck(serial, 'agent-chat-activity');
        await settle(1500);
        const atEnd = await mobileSemantics(serial);
        const isHiddenAtEnd =
            !hasCheck(atEnd, 'conversation-jump-messages') &&
            !hasCheck(atEnd, 'conversation-jump-latest');
        await capture(environment, 'messages-at-end', artifacts);

        // Two drags leave the end, inside the last reply, well below the third message.
        const frame = await chatTimelineFrame(serial);
        await swipeTimelineTowardEarlier(serial, frame);
        await settle(800);
        await swipeTimelineTowardEarlier(serial, frame);
        const isButtonShown = await isReachedWithin(
            serial,
            (nodes) =>
                hasCheck(nodes, 'conversation-jump-messages') &&
                hasCheck(nodes, 'conversation-jump-latest'),
            10_000,
        );
        const away = await mobileSemantics(serial);
        const messagesButton = checkBounds(away, 'conversation-jump-messages');
        const latestButton = checkBounds(away, 'conversation-jump-latest');
        const isStackedAbove =
            messagesButton !== undefined &&
            latestButton !== undefined &&
            messagesButton.bottom <= latestButton.top &&
            Math.abs(messagesButton.right - latestButton.right) <= 2;
        await capture(environment, 'messages-button-above-jump', artifacts);

        let isListed = false;
        let isReadingSelected = false;
        let isFirstOnScreen = false;
        let isSheetClosed = false;
        if (isButtonShown) {
            await tapMobileCheck(serial, 'conversation-jump-messages');
            await waitForCheck(serial, 'conversation-messages-sheet');
            await settle(600);
            const sheet = await mobileSemantics(serial);
            isListed = MESSAGES.every((_, index) =>
                hasCheck(sheet, `conversation-messages-row-${index}`),
            );
            const third = sheet.find(
                ({ checkId }) => checkId === `conversation-messages-row-${MESSAGES.length - 1}`,
            );
            isReadingSelected = third?.selected === true;
            await capture(environment, 'messages-sheet', artifacts);

            await tapMobileCheck(serial, 'conversation-messages-row-0');
            isSheetClosed = await isReachedWithin(
                serial,
                (nodes) => !hasCheck(nodes, 'conversation-messages-sheet'),
                5_000,
            );
            await settle(1200);
            isFirstOnScreen = await isReachedWithin(
                serial,
                (nodes) => hasCheck(nodes, `conversation-user-${userIds[0]}`),
                8_000,
            );
            await capture(environment, 'messages-jumped-to-first', artifacts);
        }

        await concludeScenario(
            environment,
            artifacts,
            { messages: MESSAGES.length },
            {
                'no Messages button while following the end': isHiddenAtEnd,
                'Messages button shows after scrolling up': isButtonShown,
                'Messages button stacks above Jump to latest': isStackedAbove,
                'sheet lists every user message': isListed,
                'sheet selects the message being read': isReadingSelected,
                'tapping a row closes the sheet': isSheetClosed,
                'tapping the first row brings the first message on screen': isFirstOnScreen,
            },
        );
    } finally {
        await fixture.stop();
    }
}
