import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    chatTimelineFrame,
    hasCheck,
    sendFromPhone,
    swipeTimelineTowardEarlier,
    typeChatDraft,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    observeMobileNode,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

type ChatSnapshotItem = AgentChatSnapshot['items'][number];

/**
 * A queued follow-up longer than the 200-character queue preview the phone receives, so Edit has to fetch the full text
 * from Server Core. It avoids every keyword the fake Codex app-server reacts to.
 */
const LONG_QUEUED_MESSAGE =
    'Next, rename the helper to sumItems and update every call site, then run the unit tests again and report which ' +
    'files changed. Keep the public names unchanged and leave the docs alone for now, we will review them together ' +
    'tomorrow morning.';

const findItem = (
    snapshot: AgentChatSnapshot,
    isMatch: (item: ChatSnapshotItem) => boolean,
): ChatSnapshotItem | undefined => snapshot.items.find(isMatch);

/**
 * Swipes the Chat timeline toward earlier messages until the jump-to-latest button shows, so the next send starts away
 * from the bottom.
 */
async function scrollAwayFromLatest(serial: string): Promise<void> {
    const frame = await chatTimelineFrame(serial);
    for (let attempt = 0; attempt < 4; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- each gesture moves the same virtual list further.
        await swipeTimelineTowardEarlier(serial, frame);
        // eslint-disable-next-line no-await-in-loop -- the button follows the settled scroll position.
        if (hasCheck(await mobileSemantics(serial), 'conversation-jump-latest')) return;
    }
    throw new Error('The Chat did not offer Jump to latest after scrolling up');
}

/**
 * `MOB-CHAT-10`: the phone's Codex Chat composer and timeline. It covers the permission trigger and sheet, fenced code
 * highlighted by language, a finished multi-step turn folded behind `Worked for` with a failed command's exit code,
 * following the user's own send to the latest message, slash commands, the visible Steer button, editing a long queued
 * message, and a message shown as `Sending…` before Server Core accepts it.
 */
export async function executeMobileChatComposerScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await waitForCheck(serial, 'agent-chat-permission-button');
        // The Full access trigger reads in the ordinary text color, as Desktop's; only the sheet's option warns.
        await capture(environment, 'permission-trigger-full-access', artifacts);

        // Permissions (#1773): the sheet, the fixture's Full access in the warning tone, and Plan mode on the trigger.
        await tapMobileCheckByBounds(serial, 'agent-chat-permission-button');
        await waitForCheck(serial, 'agent-chat-permission-sheet');
        await waitForCheck(serial, 'agent-chat-permission-full-access');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.permissionMode === 'fullAccess',
        );
        await capture(environment, 'permission-sheet', artifacts);
        await waitForCheck(serial, 'agent-chat-plan-mode');
        await tapMobileCheckByBounds(serial, 'agent-chat-plan-mode');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.planMode === true,
        );
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId, checked }) => checkId === 'agent-chat-plan-mode' && checked),
        );
        await capture(environment, 'permission-plan-on', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-permission-done');
        await waitForNoCheck(serial, 'agent-chat-permission-sheet');
        await waitForCheck(serial, 'agent-chat-permission-plan');
        await capture(environment, 'permission-trigger', artifacts);
        // Back to Codex's Default without plan mode, so the rest of the case runs as a fresh Chat would.
        await tapMobileCheckByBounds(serial, 'agent-chat-permission-button');
        await waitForCheck(serial, 'agent-chat-plan-mode');
        await tapMobileCheckByBounds(serial, 'agent-chat-plan-mode');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.planMode !== true,
        );
        await tapMobileCheckByBounds(serial, 'agent-chat-permission-accept-edits');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.permissionMode === 'acceptEdits',
        );
        // Choosing a different level applies it and closes the sheet.
        await waitForNoCheck(serial, 'agent-chat-permission-sheet');

        // Fenced code (#1884): ts, bash, json, diff, a fence without a language, and an indented block.
        await sendFromPhone(serial, 'codeblocks');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('An indented block:') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await waitForCheck(serial, 'conversation-fenced-code');
        await capture(environment, 'code-blocks', artifacts);

        // A finished multi-step turn (#1882) with a failed command (#1601).
        await sendFromPhone(serial, 'testrun');
        const tested = await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('One test fails') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        const reply = findItem(
            tested,
            (item) => item.type === 'agentMessage' && item.text.includes('One test fails'),
        );
        const failedCommand = findItem(
            tested,
            (item) => item.type === 'command' && item.exitCode === 1,
        );
        if (!failedCommand || !reply?.turnId) throw new Error('The test run turn is incomplete');
        const fold = `agent-chat-turn-${reply.turnId}`;
        await waitForCheck(serial, fold);
        const collapsed = await mobileSemantics(serial);
        if (collapsed.some(({ checkId }) => checkId.startsWith('agent-chat-work-group-')))
            throw new Error('A finished turn must fold its work behind Worked for');
        await capture(environment, 'turn-collapsed', artifacts);
        await tapMobileCheckByBounds(serial, fold);
        const expanded = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.some(({ checkId }) => checkId.startsWith('agent-chat-work-group-')),
        );
        await capture(environment, 'turn-expanded', artifacts);
        const group = expanded.find(({ checkId }) => checkId.startsWith('agent-chat-work-group-'));
        if (!group) throw new Error('The unfolded turn shows no work');
        await tapMobileCheckByBounds(serial, group.checkId);
        await waitForCheck(serial, `agent-chat-work-${failedCommand.id}`);
        await capture(environment, 'command-exit-code', artifacts);

        // Following the user's own send (#1878): scroll up, send, and land on the latest message.
        recording = environment.remoteVideoPath
            ? await startMobileFramebufferRecording(serial, environment.remoteVideoPath)
            : undefined;
        await scrollAwayFromLatest(serial);
        await capture(environment, 'scrolled-up', artifacts);
        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await waitForNoCheck(serial, 'conversation-jump-latest');
        await capture(environment, 'sent-latest', artifacts);
        await recording?.stop();
        recording = undefined;

        // Steered messages (#2408): a message steered into the running turn folds its own work and keeps its own reply.
        await chat.send({ text: 'slow please' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => Boolean(snapshot.activeTurnId),
        );
        await chat.send({ text: 'Is it deployed? Please answer.', delivery: 'steer' });
        const steered = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('Answered in this turn') && !snapshot.activeTurnId,
            60_000,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        const steeredTurnId = findItem(
            steered,
            (item) => item.type === 'agentMessage' && item.text.includes('Answered in this turn'),
        )?.turnId;
        if (!steeredTurnId) throw new Error('The steered turn is incomplete');
        await waitForCheck(serial, `agent-chat-turn-${steeredTurnId}:1`);
        await capture(environment, 'steered-segments', artifacts);

        // Slash commands (#1708): typing `/` lists the provider's commands, and choosing one runs it.
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'text', '/']);
        await waitForCheck(serial, 'agent-chat-command-list');
        await capture(environment, 'slash-commands', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-command-0');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.items.some(
                    (item) => item.type === 'notice' && item.kind === 'compacted',
                ) && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-command-list');
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'slash-command-ran', artifacts);

        /**
         * A turn waiting on a question stays running while the screen holds still; a streaming turn animates, which
         * keeps UIAutomator from reading the screen.
         */
        await sendFromPhone(serial, 'ask');
        await waitForCheck(serial, 'agent-chat-question-0-option-1');
        // The Steer button (#1812) shows beside Queue once there is a draft during the turn.
        await typeChatDraft(serial, LONG_QUEUED_MESSAGE);
        await waitForCheck(serial, 'agent-chat-steer');
        await capture(environment, 'steer-and-queue', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => (snapshot.queue?.length ?? 0) === 1,
        );
        await waitForCheck(serial, 'agent-chat-queue-edit');
        await capture(environment, 'queued', artifacts);
        // Edit (#1881) takes the message out of the queue and restores its full text, past the 200-character preview.
        await tapMobileCheckByBounds(serial, 'agent-chat-queue-edit');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => (snapshot.queue?.length ?? 0) === 0,
        );
        const restored = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: LONG_QUEUED_MESSAGE,
        });
        if (!restored.exists || !restored.textMatches)
            throw new Error('Edit did not restore the full queued text');
        await capture(environment, 'queue-edit-restored', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => (snapshot.queue?.length ?? 0) === 1,
        );
        // One question: the tap on an option sends it; the card shows no Submit.
        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-1');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('You said: Next, rename the helper') &&
                !snapshot.activeTurnId &&
                (snapshot.queue?.length ?? 0) === 0,
            60_000,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');

        /**
         * Sending (#1895): the fake never answers nor records a `lost` message, so the phone's optimistic row stays
         * `Sending…` until Server Core gives up on the provider, then the text returns to the composer with the error.
         */
        await sendFromPhone(serial, 'lost');
        await waitForCheck(serial, 'agent-chat-pending-sending');
        await capture(environment, 'sending', artifacts);
        await waitForCheck(serial, 'agent-chat-composer-error', 120_000);
        await waitForNoCheck(serial, 'agent-chat-pending-sending');
        const returned = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: 'lost',
        });
        if (!returned.exists || !returned.textMatches)
            throw new Error('A failed send did not return its text to the composer');
        await capture(environment, 'send-failed', artifacts);

        await finish(environment, artifacts, {
            codeBlocks: 'rendered',
            commandExitCode: 1,
            followAfterSend: 'latest',
            permission: 'full-access-and-plan-shown',
            queueEdit: 'full-text-restored',
            sendFailure: 'returned-to-composer',
            slashCommand: 'compact-ran',
            status: 'passed',
            steeredFold: 'per-segment',
            turnFold: 'collapsed-then-expanded',
        });
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}
