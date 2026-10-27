import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    hideChatKeyboard,
    sendFromPhone,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    adbShell,
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

const composerReads = (serial: string, value: string) =>
    waitForMobile(
        () => observeMobileNode(serial, 'agent-chat-composer-input', { kind: 'equals', value }),
        (node) => node.exists && node.textMatches === true,
    );

/**
 * `MOB-CHAT-35`: long-pressing a message. A reply's sheet copies the whole reply (pasted back into the composer to
 * prove the clipboard) and shows it selectable; a user message's sheet edits it from here, where Cancel restores the
 * draft and sending the edit rewinds the Chat to that message and replaces the later turns.
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
        await sendFromPhone(serial, 'again');
        const twoTurns = await waitForMobile(
            () => chat.read(),
            (snapshot) => replyTo(snapshot, 'again') !== undefined && !snapshot.activeTurnId,
        );
        await hideChatKeyboard(serial);
        const firstReply = replyTo(twoTurns, 'hello');
        const firstMessage = userMessages(twoTurns).at(0);
        if (!firstReply || !firstMessage) throw new Error('The first turn is missing');

        // Copy Message on a reply puts its whole text on the clipboard; pasting it into the composer proves it.
        await waitForCheck(serial, `conversation-agent-${firstReply.id}`);
        await tapMobileCheck(serial, `conversation-agent-${firstReply.id}`, { isLongPress: true });
        await waitForCheck(serial, 'conversation-message-sheet');
        await waitForCheck(serial, 'conversation-message-select');
        await capture(environment, 'reply-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'conversation-message-copy');
        await waitForNoCheck(serial, 'conversation-message-sheet');
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_PASTE']);
        await composerReads(serial, firstReply.text);
        await hideChatKeyboard(serial);
        await capture(environment, 'reply-pasted', artifacts);

        // Select Text shows the reply selectable; a long press on it starts the system selection.
        await tapMobileCheck(serial, `conversation-agent-${firstReply.id}`, { isLongPress: true });
        await waitForCheck(serial, 'conversation-message-select');
        await tapMobileCheckByBounds(serial, 'conversation-message-select');
        await waitForCheck(serial, 'conversation-message-select-text');
        await tapMobileCheck(serial, 'conversation-message-select-text', { isLongPress: true });
        await capture(environment, 'select-text', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForCheck(serial, 'conversation-message-select-done');
        await tapMobileCheckByBounds(serial, 'conversation-message-select-done');
        await waitForNoCheck(serial, 'conversation-message-sheet');

        // Edit from Here, cancelled: the composer takes the message and Cancel gives the draft back.
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
        await composerReads(serial, firstReply.text);

        // Edit from Here, sent: the Chat rewinds to the first message and answers the edited one in its place.
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
                replyTo(snapshot, 'again') === undefined,
        );
        await waitForNoCheck(serial, 'agent-chat-edit-banner');
        await composerReads(serial, firstReply.text);
        const sentTexts = userMessages(rewound).map((item) => item.text);
        if (sentTexts.join('|') !== 'helloworld')
            throw new Error(`The rewound Chat holds unexpected messages: ${sentTexts.length}`);
        await hideChatKeyboard(serial);
        await capture(environment, 'edited', artifacts);
        await finish(environment, artifacts, {
            copyMessage: 'whole-reply-pasted',
            editCancel: 'draft-restored',
            editSend: 'rewound-and-replaced',
            selectText: 'selection-started',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
