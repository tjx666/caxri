import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    checkBounds,
    hideChatKeyboard,
    sendFromPhone,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

type ChatItem = AgentChatSnapshot['items'][number];

const userMessages = (snapshot: AgentChatSnapshot) =>
    snapshot.items.filter(
        (item): item is Extract<ChatItem, { type: 'userMessage' }> => item.type === 'userMessage',
    );

const replyTo = (snapshot: AgentChatSnapshot, word: string) =>
    snapshot.items.find(
        (item): item is Extract<ChatItem, { type: 'agentMessage' }> =>
            item.type === 'agentMessage' && item.text.includes(`You said: ${word}`),
    );

const longReply = (snapshot: AgentChatSnapshot) =>
    snapshot.items.find(
        (item): item is Extract<ChatItem, { type: 'agentMessage' }> =>
            item.type === 'agentMessage' && item.text.startsWith('Long reply first line.'),
    );

/**
 * Drags the timeline down until check `id` is on screen.
 */
const scrollTo = (serial: string, id: string) =>
    waitForMobile(
        async () => {
            const isShown = checkBounds(await mobileSemantics(serial), id) !== undefined;
            if (!isShown)
                await adbShell(serial, ['input', 'swipe', '540', '700', '540', '1500', '200']);
            return isShown;
        },
        (isShown) => isShown,
    );

const composerReads = (serial: string, value: string) =>
    waitForMobile(
        () => observeMobileNode(serial, 'agent-chat-composer-input', { kind: 'equals', value }),
        (node) => node.exists && node.textMatches === true,
    );

/**
 * `MOB-CHAT-35`: long-pressing a message. A reply's sheet copies the whole reply, including the start the phone's
 * window clipped (pasted back into the composer to prove the clipboard), and shows it selectable; a user message's
 * sheet edits it from here, where Cancel restores the draft and sending the edit rewinds the Chat to that message and
 * replaces the later turns.
 */
export async function executeMobileChatMessageActionsScenario(
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

        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => replyTo(snapshot, 'hello') !== undefined && !snapshot.activeTurnId,
        );
        await sendFromPhone(serial, 'longreply');
        const twoTurns = await waitForMobile(
            () => chat.read(),
            (snapshot) => longReply(snapshot) !== undefined && !snapshot.activeTurnId,
        );
        await hideChatKeyboard(serial);
        const reply = longReply(twoTurns);
        const firstMessage = userMessages(twoTurns).at(0);
        if (!reply || !firstMessage) throw new Error('The Chat is missing a turn');

        // Copy Message on a reply past the phone's window copies all of it, first line included, which the phone's
        // own copy lost; pasting it into the composer proves what reached the clipboard.
        await waitForCheck(serial, `conversation-agent-${reply.id}`);
        await tapMobileCheck(serial, `conversation-agent-${reply.id}`, { isLongPress: true });
        await waitForCheck(serial, 'conversation-message-sheet');
        await waitForCheck(serial, 'conversation-message-select');
        await capture(environment, 'reply-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'conversation-message-copy');
        await waitForNoCheck(serial, 'conversation-message-sheet');
        // Android shows its clipboard preview over the composer after a copy; a touch elsewhere dismisses it, and a
        // tap on the timeline does nothing in the Chat.
        await adbShell(serial, ['input', 'tap', '540', '1000']);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_PASTE']);
        await composerReads(serial, reply.text);
        await hideChatKeyboard(serial);
        await capture(environment, 'reply-pasted', artifacts);

        // Select Text shows the whole reply selectable: a long press on it starts the system selection and its toolbar.
        await tapMobileCheck(serial, `conversation-agent-${reply.id}`, { isLongPress: true });
        await waitForCheck(serial, 'conversation-message-select');
        await tapMobileCheckByBounds(serial, 'conversation-message-select');
        await waitForCheck(serial, 'conversation-message-select-text');
        // The selectable text is not a clickable node, so the long press goes to its on-screen bounds.
        const selectable = checkBounds(
            await mobileSemantics(serial),
            'conversation-message-select-text',
        );
        if (!selectable) throw new Error('The selectable reply is not on screen');
        const x = String(selectable.left + 60);
        const y = String(selectable.top + 60);
        await adbShell(serial, ['input', 'swipe', x, y, x, y, '900']);
        // The system selection toolbar is a popup UIAutomator's dump does not list, so the screenshot shows it once the
        // selection settles.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await capture(environment, 'select-text', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForCheck(serial, 'conversation-message-select-done');
        await tapMobileCheckByBounds(serial, 'conversation-message-select-done');
        await waitForNoCheck(serial, 'conversation-message-sheet');

        // Edit from Here, cancelled: the composer takes the message and Cancel gives the draft back. The long reply
        // pushed the first message above the screen, so the timeline scrolls back to it first.
        await scrollTo(serial, `conversation-user-bubble-${firstMessage.id}`);
        await tapMobileCheck(serial, `conversation-user-bubble-${firstMessage.id}`, {
            isLongPress: true,
        });
        await waitForCheck(serial, 'conversation-message-edit');
        await capture(environment, 'user-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'conversation-message-edit');
        await waitForCheck(serial, 'agent-chat-edit-banner');
        await composerReads(serial, 'hello');
        await hideChatKeyboard(serial);
        await capture(environment, 'editing', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-edit-cancel');
        await waitForNoCheck(serial, 'agent-chat-edit-banner');
        await composerReads(serial, reply.text);
        await hideChatKeyboard(serial);
        await capture(environment, 'edit-cancelled', artifacts);

        // Leaving the Chat mid-edit ends the edit the way Cancel does, so the message never lingers as a plain draft.
        await scrollTo(serial, `conversation-user-bubble-${firstMessage.id}`);
        await tapMobileCheck(serial, `conversation-user-bubble-${firstMessage.id}`, {
            isLongPress: true,
        });
        await waitForCheck(serial, 'conversation-message-edit');
        await tapMobileCheckByBounds(serial, 'conversation-message-edit');
        await waitForCheck(serial, 'agent-chat-edit-banner');
        await hideChatKeyboard(serial);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-composer-input');
        await composerReads(serial, reply.text);
        await waitForNoCheck(serial, 'agent-chat-edit-banner');

        // Edit from Here, sent: the Chat rewinds to the first message and answers the edited one in its place.
        await scrollTo(serial, `conversation-user-bubble-${firstMessage.id}`);
        await tapMobileCheck(serial, `conversation-user-bubble-${firstMessage.id}`, {
            isLongPress: true,
        });
        await waitForCheck(serial, 'conversation-message-edit');
        await tapMobileCheckByBounds(serial, 'conversation-message-edit');
        await composerReads(serial, 'hello');
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_MOVE_END']);
        await adbShell(serial, ['input', 'text', 'world']);
        await composerReads(serial, 'helloworld');
        await tapMobileCheck(serial, 'agent-chat-composer-send');
        const rewound = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                replyTo(snapshot, 'helloworld') !== undefined &&
                !snapshot.activeTurnId &&
                longReply(snapshot) === undefined,
        );
        await waitForNoCheck(serial, 'agent-chat-edit-banner');
        await composerReads(serial, reply.text);
        const sentTexts = userMessages(rewound).map((item) => item.text);
        if (sentTexts.join('|') !== 'helloworld')
            throw new Error(`The rewound Chat holds unexpected messages: ${sentTexts.length}`);
        await hideChatKeyboard(serial);
        await capture(environment, 'edited', artifacts);
        await finish(environment, artifacts, {
            copiedCharacters: reply.text.length,
            copyMessage: 'whole-reply-pasted',
            editCancel: 'draft-restored',
            editLeft: 'draft-restored',
            editSend: 'rewound-and-replaced',
            selectText: 'long-pressed',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

const hugeReply = (snapshot: AgentChatSnapshot) =>
    snapshot.items.find(
        (item): item is Extract<ChatItem, { type: 'agentMessage' }> =>
            item.type === 'agentMessage' && item.text.startsWith('Huge reply first line.'),
    );

/**
 * `MOB-CHAT-COPY-LONG-01`: Copy Message on a reply past 16 KiB, the most a phone may send. The whole reply, first and
 * last line included, reaches the clipboard, which pasting it back into the composer proves.
 */
export async function executeMobileChatLongCopyScenario(
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
        await sendFromPhone(serial, 'hugereply');
        const snapshot = await waitForMobile(
            () => chat.read(),
            (current) => hugeReply(current) !== undefined && !current.activeTurnId,
        );
        await hideChatKeyboard(serial);
        const reply = hugeReply(snapshot);
        if (!reply) throw new Error('The Chat is missing the huge reply');
        if (new TextEncoder().encode(reply.text).length <= 16 * 1_024)
            throw new Error('The huge reply does not exceed 16 KiB');
        await waitForCheck(serial, `conversation-agent-${reply.id}`);
        await tapMobileCheck(serial, `conversation-agent-${reply.id}`, { isLongPress: true });
        await waitForCheck(serial, 'conversation-message-sheet');
        await capture(environment, 'huge-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'conversation-message-copy');
        await waitForNoCheck(serial, 'conversation-message-sheet');
        // Android's clipboard preview appears over the composer after a copy: capture it as the copy feedback.
        await new Promise((resolve) => setTimeout(resolve, 600));
        await capture(environment, 'huge-copied', artifacts);
        await adbShell(serial, ['input', 'tap', '540', '1000']);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_PASTE']);
        await composerReads(serial, reply.text);
        await hideChatKeyboard(serial);
        await capture(environment, 'huge-pasted', artifacts);
        await finish(environment, artifacts, {
            copiedBytes: new TextEncoder().encode(reply.text).length,
            copiedCharacters: reply.text.length,
            copyMessage: 'whole-reply-pasted',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
