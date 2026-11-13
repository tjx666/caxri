import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, concludeScenario, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    checkBounds,
    hasCheck,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileRegionFingerprint,
    mobileSemantics,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * `MOB-CHAT-LIST-APPROVAL-01` (Codex) and `MOB-CHAT-LIST-APPROVAL-02` (Claude Code): a Chat waiting on an approval
 * shows the approval card under its row in the Sessions list, with no "handled in Terminal" hint, and approving it
 * there lets the Agent continue without opening the Chat. `MOB-CHAT-LIST-QUESTION-01` shares the Claude Code entry and
 * runs the question flow instead.
 */
export async function executeMobileChatListApprovalScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    provider: 'claude' | 'codex',
): Promise<void> {
    if (environment.caseId === 'MOB-CHAT-LIST-QUESTION-01')
        return executeMobileChatListQuestionScenario(environment, artifacts);
    if (environment.caseId === 'MOB-CHAT-LIST-QUESTION-02')
        return executeMobileChatListLongQuestionScenario(environment, artifacts);
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        ...(provider === 'claude' && { chatProvider: 'claude' as const }),
        mode: 'agent-chat',
        serial,
    });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // Sent from the Mac so the phone stays on the Sessions list the whole time.
        await chat.send({ text: provider === 'claude' ? 'planmode' : 'approve' });
        await waitForCheck(serial, 'session-chat-requests');
        await waitForCheck(serial, 'agent-chat-approval-accept');
        if (hasCheck(await mobileSemantics(serial), 'attention-open-terminal-fallback'))
            throw new Error('A Chat approval must not point the user at a Terminal');
        await capture(environment, 'list-approval', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-approval-accept');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.requests.length === 0 &&
                !snapshot.activeTurnId &&
                agentText(snapshot).length > 0,
        );
        await waitForNoCheck(serial, 'session-chat-requests');
        await capture(environment, 'list-approved', artifacts);

        await finish(environment, artifacts, {
            approval: 'accepted-from-list',
            terminalHint: 'absent',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-LIST-QUESTION-01`: a Claude Code Chat asking an `AskUserQuestion` shows the question card under its row in
 * the Sessions list, framed by the amber attention border, and answering both questions there finishes the turn without
 * opening the Chat.
 */
async function executeMobileChatListQuestionScenario(
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
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // Sent from the Mac so the phone stays on the Sessions list the whole time.
        await chat.send({ text: 'ask recommended' });
        await waitForCheck(serial, 'session-chat-requests');
        await waitForCheck(serial, 'agent-chat-question-0-option-0');
        await capture(environment, 'list-question', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-0');
        await waitForCheck(serial, 'agent-chat-question-1-option-0');
        await tapMobileCheckByBounds(serial, 'agent-chat-question-1-option-0');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.requests.length === 0 &&
                !snapshot.activeTurnId &&
                agentText(snapshot).includes('You chose'),
        );
        await waitForNoCheck(serial, 'session-chat-requests');
        await capture(environment, 'list-answered', artifacts);

        await finish(environment, artifacts, {
            question: 'answered-from-list',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-LIST-QUESTION-02`: a Claude Code Chat asking a question far longer than the card's fold. In the Sessions
 * list the card names the Project and Session it belongs to, the question text scrolls inside the card (the list and
 * the options stay put), and tapping the name opens that Session. Every frame is captured before any check, so a
 * baseline round on the previous build shows the same views and fails naming what differed.
 */
async function executeMobileChatListLongQuestionScenario(
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
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // Sent from the Mac so the phone stays on the Sessions list the whole time.
        await chat.send({ text: 'ask long' });
        await waitForCheck(serial, 'session-chat-requests');
        await waitForCheck(serial, 'agent-chat-question-0-option-0');
        await capture(environment, 'list-long-question', artifacts);

        const before = await mobileSemantics(serial);
        const isSourceShown = hasCheck(before, 'session-attention-source');
        const text = checkBounds(before, 'agent-chat-question-0-text');
        const option = checkBounds(before, 'agent-chat-question-0-option-0');
        if (!text || !option) throw new Error('The question card is not laid out');
        const textFingerprint = await mobileRegionFingerprint(serial, text);
        // A second read proves the text is at rest, so a later change can only come from the drag.
        const isTextStill = (await mobileRegionFingerprint(serial, text)) === textFingerprint;
        // Drag the question text upward from inside it, as a reader does to see the rest.
        const x = Math.round((text.left + text.right) / 2);
        const fromY = Math.round(text.bottom - (text.bottom - text.top) / 5);
        const toY = Math.round(text.top + (text.bottom - text.top) / 5);
        const dragText = () =>
            adbShell(serial, ['input', 'swipe', `${x}`, `${fromY}`, `${x}`, `${toY}`, '600']);
        await dragText();
        await capture(environment, 'list-long-question-scrolled', artifacts);
        const after = await mobileSemantics(serial);
        const textAfter = checkBounds(after, 'agent-chat-question-0-text');
        const optionAfter = checkBounds(after, 'agent-chat-question-0-option-0');
        // The card holding still while its text changes is what tells a scroll inside it from a scroll of the list.
        const isTextScrolled =
            isTextStill &&
            textAfter !== undefined &&
            textAfter.top === text.top &&
            optionAfter?.top === option.top &&
            (await mobileRegionFingerprint(serial, textAfter)) !== textFingerprint;
        // Two more drags reach the end of the text, so the frame shows its closing END-OF-QUESTION marker.
        await dragText();
        await dragText();
        await capture(environment, 'list-long-question-end', artifacts);

        let isSessionOpened = false;
        if (isSourceShown) {
            await tapMobileCheckByBounds(serial, 'session-attention-source');
            await waitForCheck(serial, 'session-detail');
            await capture(environment, 'source-opened-session', artifacts);
            isSessionOpened = true;
        }

        await concludeScenario(
            environment,
            artifacts,
            { question: 'long-in-list' },
            {
                'card names its Project and Session': isSourceShown,
                'question text scrolls inside the card': isTextScrolled,
                'tapping the name opens the Session': isSessionOpened,
            },
        );
    } finally {
        await fixture.stop();
    }
}
