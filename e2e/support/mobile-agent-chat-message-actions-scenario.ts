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
    mobileNativeControlBounds,
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
 * Whether Android's text selection toolbar is up. It reads Select All in the app's locale.
 */
const selectionToolbarShown = async (serial: string) =>
    (await mobileNativeControlBounds(serial, { text: '全选' })) !== null ||
    (await mobileNativeControlBounds(serial, { text: 'Select all' })) !== null;

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
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_PASTE']);
        await composerReads(serial, reply.text);
        await hideChatKeyboard(serial);
        await capture(environment, 'reply-pasted', artifacts);

        // Select Text shows the whole reply selectable: a long press on it starts the system selection, whose
        // toolbar offers Select All.
        await tapMobileCheck(serial, `conversation-agent-${reply.id}`, { isLongPress: true });
        await waitForCheck(serial, 'conversation-message-select');
        await tapMobileCheckByBounds(serial, 'conversation-message-select');
        await waitForCheck(serial, 'conversation-message-select-text');
        await tapMobileCheck(serial, 'conversation-message-select-text', { isLongPress: true });
        await waitForMobile(
            () => selectionToolbarShown(serial),
            (isShown) => isShown,
        );
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
        await composerReads(serial, reply.text);
        await hideChatKeyboard(serial);
        await capture(environment, 'edit-cancelled', artifacts);

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
            editSend: 'rewound-and-replaced',
            selectText: 'selection-toolbar-shown',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
