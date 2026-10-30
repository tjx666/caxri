import type { AgentChatSnapshot, AppSettings } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { executeMobileChatBrowserScenario } from './mobile-agent-chat-browser-scenario';
import { executeMobileChatComposerScenario } from './mobile-agent-chat-composer-scenario';
import { executeMobileChatDelegatedTaskScenario } from './mobile-agent-chat-delegated-scenario';
import {
    executeMobileChatMissingImageScenario,
    executeMobileChatModelRefusedScenario,
    executeMobileChatPreviewScenario,
} from './mobile-agent-chat-error-scenario';
import { executeMobileChatFeedbackScenario } from './mobile-agent-chat-feedback-scenario';
import { executeMobileChatGoalScenario } from './mobile-agent-chat-goal-scenario';
import {
    agentText,
    hasCheck,
    sendFromPhone,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    executeMobileChatImageScenario,
    executeMobileChatImageStripScenario,
    executeMobileChatMultiImagePickScenario,
} from './mobile-agent-chat-image-scenario';
import { executeMobileChatInlineLinkScenario } from './mobile-agent-chat-inline-link-scenario';
import { executeMobileChatListApprovalScenario } from './mobile-agent-chat-list-approval-scenario';
import {
    executeMobileChatLongCopyScenario,
    executeMobileChatMessageActionsScenario,
} from './mobile-agent-chat-message-actions-scenario';
import {
    executeMobileChatModelScenario,
    executeMobileClaudeModelScenario,
} from './mobile-agent-chat-model-scenario';
import {
    executeMobileChatPlanApprovalScenario,
    executeMobileChatUsageWaitScenario,
} from './mobile-agent-chat-plan-wait-scenarios';
import { executeMobileChatRunningTurnScenario } from './mobile-agent-chat-running-turn-scenario';
import {
    executeMobileChatChineseScenario,
    executeMobileChatSkillsQuestionScenario,
} from './mobile-agent-chat-skills-scenario';
import { executeMobileChatBurstStreamScenario } from './mobile-agent-chat-stream-scenario';
import { executeMobileChatSubagentScenario } from './mobile-agent-chat-subagent-scenario';
import { executeMobileChatSurfaceSwitchScenario } from './mobile-agent-chat-surface-switch-scenario';
import {
    executeMobileChatHistoryTasksScenario,
    executeMobileChatPinScrollScenario,
    executeMobileChatShimmerScenario,
} from './mobile-agent-chat-timeline-scenario';
import { executeMobileAgentUsageScenario } from './mobile-agent-usage-scenario';
import {
    androidBounds,
    mobileSemantics,
    observeMobileNode,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import { executeMobileBotInboxScenario } from './mobile-bot-inbox-scenario';
import {
    executeMobileChatSendUnknownScenario,
    executeMobileChatUsageGuardScenario,
} from './mobile-chat-delivery-guard-scenarios';
import { executeMobilePlanLimitsScenario } from './mobile-plan-limits-scenario';
import { executeMobilePullRequestScenario } from './mobile-pull-request-scenario';
import { executeMobileReadCacheScenario } from './mobile-read-cache-scenario';
import { executeMobileReplyPlaceholderScenario } from './mobile-reply-placeholder-scenario';
import { executeMobileSavedTurnArtifactsScenario } from './mobile-saved-turn-artifacts-scenario';
import {
    executeMobileSessionGroupsScenario,
    executeMobileSessionSwipeScenario,
} from './mobile-session-groups-scenario';
import { executeMobileSessionPinScenario } from './mobile-session-pin-scenario';
import { executeMobileSessionPreviewScenario } from './mobile-session-preview-scenario';
import { executeMobileSessionUsageScenario } from './mobile-session-usage-scenario';
import { executeMobileToastScenario } from './mobile-toast-scenario';

/**
 * Waits for the answered question list's `index`th answer to read `answer`.
 */
const waitForAnsweredText = (serial: string, index: number, answer: string) =>
    waitForMobile(
        () =>
            observeMobileNode(serial, `agent-chat-answered-answer-${index}`, {
                kind: 'equals',
                value: answer,
            }),
        ({ exists, textMatches }) => exists && textMatches === true,
    );

/**
 * The on-screen height of check `id`, or `undefined` while it is not laid out.
 */
async function checkHeight(serial: string, id: string): Promise<number | undefined> {
    const node = (await mobileSemantics(serial)).find(({ checkId }) => checkId === id);
    const bounds = node && androidBounds(node.bounds);
    return bounds ? bounds.bottom - bounds.top : undefined;
}

/**
 * Taps the approval text's Show all / Show less toggle and waits until the text grows or shrinks past `height`.
 */
async function toggleApprovalText(
    serial: string,
    id: string,
    height: number,
    direction: 'grow' | 'shrink',
): Promise<number> {
    await tapMobileCheckByBounds(serial, `${id}-toggle`);
    const next = await waitForMobile(
        () => checkHeight(serial, id),
        (value) => value !== undefined && (direction === 'grow' ? value > height : value < height),
    );
    if (next === undefined) throw new Error(`${id} is no longer laid out`);
    return next;
}

/**
 * A one-pixel PNG, small enough for the thumbnail limit and decodable on the phone.
 */
const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

/**
 * `MOB-CHAT-01`: a phone reads and drives a Codex Chat end to end. Each phone action is proven against the Server's own
 * Chat projection, and the screenshots cover empty, streamed, compacted, approval, question, failed, and offline
 * states.
 */
async function executeMobileAgentChatScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    let isNetworkDisabled = false;
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat');
        const tabs = await mobileSemantics(serial);
        if (hasCheck(tabs, 'session-segment-terminal'))
            throw new Error('A Chat must not offer a Terminal tab');
        await waitForCheck(serial, 'agent-chat-status-empty');
        await capture(environment, 'empty', artifacts);

        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await sendFromPhone(serial, '/compact');
        const compacted = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.items.some(
                    (item) => item.type === 'notice' && item.kind === 'compacted',
                ) && !snapshot.activeTurnId,
        );
        const compactNotice = compacted.items.findLast(
            (item) => item.type === 'notice' && item.kind === 'compacted',
        );
        if (!compactNotice) throw new Error('The native compaction did not finish');
        await waitForCheck(serial, `conversation-event-${compactNotice.id}`);
        await capture(environment, 'context-compacted', artifacts);
        await sendFromPhone(serial, 'bigdiffwrap');
        const changed = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.items.some((item) => item.type === 'fileChange') && !snapshot.activeTurnId,
        );
        const fileChange = changed.items.findLast((item) => item.type === 'fileChange');
        if (!fileChange?.turnId) throw new Error('The wrapped diff fixture did not finish');
        await tapMobileCheckByBounds(serial, `agent-chat-turn-${fileChange.turnId}`);
        // A settled lone change is its own row; with other work it sits in the run's summary.
        const unfolded = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, `agent-chat-work-${fileChange.id}`) ||
                hasCheck(nodes, `agent-chat-work-group-${fileChange.id}`),
        );
        if (!hasCheck(unfolded, `agent-chat-work-${fileChange.id}`)) {
            await tapMobileCheckByBounds(serial, `agent-chat-work-group-${fileChange.id}`);
            await waitForCheck(serial, `agent-chat-work-${fileChange.id}`);
        }
        await tapMobileCheckByBounds(serial, `agent-chat-work-${fileChange.id}`);
        await waitForCheck(serial, 'conversation-tool-detail');
        await capture(environment, 'wrapped-file-diff', artifacts);
        await tapMobileCheckByBounds(serial, 'tool-detail-close');
        await waitForNoCheck(serial, 'conversation-tool-detail');
        // An image-only message from the desktop: the phone fetches its thumbnail, which the Chat window leaves out.
        await chat.send({
            text: '',
            images: [
                {
                    mediaType: 'image/png',
                    data: PIXEL,
                    thumbnail: `data:image/png;base64,${PIXEL}`,
                },
            ],
        });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('Received 1 image.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'image-message', artifacts);

        await sendFromPhone(serial, 'table');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('| Option | Cost |') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'conversation', artifacts);

        await sendFromPhone(serial, 'approve');
        await waitForCheck(serial, 'agent-chat-approval-accept');
        await capture(environment, 'approval', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-approval-accept');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('The command ran.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');

        await sendFromPhone(serial, 'ask');
        await waitForCheck(serial, 'agent-chat-question-0-option-1');
        await capture(environment, 'question', artifacts);
        // One question: a single tap on an option answers and sends it, as in the Codex app.
        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-1');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You chose Blue.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');

        // Several questions sit behind tabs; a tap answers and moves to the next unanswered question.
        await sendFromPhone(serial, 'askmany');
        await waitForCheck(serial, 'agent-chat-question-tab-2');
        await capture(environment, 'questions', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-1');
        await waitForCheck(serial, 'agent-chat-question-1-option-1');
        await tapMobileCheckByBounds(serial, 'agent-chat-question-1-option-1');
        await waitForCheck(serial, 'agent-chat-question-2-other');
        await capture(environment, 'questions-filled', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-question-submit');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                agentText(snapshot).includes('You answered Per request / Free only / -.') &&
                !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');
        // The timeline lists each question over its answer, as Desktop does (MOB-CHAT-ANSWERED-01); the third question
        // was left unanswered and reads `Skipped`.
        await waitForCheck(serial, 'agent-chat-answered-question-0');
        await waitForAnsweredText(serial, 0, 'Per request');
        await waitForAnsweredText(serial, 1, 'Free only');
        await waitForAnsweredText(serial, 2, 'Skipped');
        await capture(environment, 'questions-answered', artifacts);

        await sendFromPhone(serial, 'crash');
        await waitForCheck(serial, 'agent-chat-failed-action');
        await capture(environment, 'failed', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-failed-action');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.status === 'ready',
        );
        await waitForNoCheck(serial, 'agent-chat-failed');
        // Online right after Retry resumed: the answered question and the crashed turn's message stay (#1830).
        await capture(environment, 'retried', artifacts);

        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await waitForCheck(serial, 'connection-stale-banner', 60_000);
        const offline = await mobileSemantics(serial);
        if (!hasCheck(offline, 'agent-chat') || hasCheck(offline, 'agent-chat-stale'))
            throw new Error(
                'An offline Chat must keep its last copy under the one connection banner',
            );
        await capture(environment, 'offline', artifacts);
        await setMobileNetworkAvailable(serial, true);
        isNetworkDisabled = false;
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);

        await finish(environment, artifacts, {
            approval: 'accepted',
            question: 'answered',
            retry: 'resumed',
            status: 'passed',
        });
    } finally {
        if (isNetworkDisabled) {
            try {
                await setMobileNetworkAvailable(serial, true);
            } catch {
                // Teardown must still stop the fixture; the scenario's own failure is the useful error.
            }
        }
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-02`: a Claude Code Chat asks to approve a plan, a tool request that is neither a command nor a file edit,
 * and the phone shows the tool name and plan, expands the plan past its clamp to read it whole, and accepts it.
 */
async function executeMobileClaudeToolApprovalScenario(
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
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');

        await sendFromPhone(serial, 'planmode');
        await waitForCheck(serial, 'agent-chat-request-tool');
        await waitForCheck(serial, 'agent-chat-approval-accept');
        // The eight-step plan runs past the six-line clamp, so the card offers Show all.
        await waitForCheck(serial, 'agent-chat-request-tool-toggle');
        const clamped = await checkHeight(serial, 'agent-chat-request-tool');
        if (clamped === undefined) throw new Error('The plan is not laid out');
        await capture(environment, 'tool-approval', artifacts);
        const expanded = await toggleApprovalText(
            serial,
            'agent-chat-request-tool',
            clamped,
            'grow',
        );
        await capture(environment, 'tool-approval-expanded', artifacts);
        await toggleApprovalText(serial, 'agent-chat-request-tool', expanded, 'shrink');
        await tapMobileCheckByBounds(serial, 'agent-chat-approval-accept');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('Plan approved.') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');
        await capture(environment, 'tool-approved', artifacts);

        await finish(environment, artifacts, { approval: 'accepted', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-03`: the phone starts a new Session as a Codex Chat. `Open as` follows the Mac's `Open Agents in Chat`
 * setting, hides for Shell, and the created Session opens the streamed Agent Chat view on a `chat` Terminal.
 */
async function executeMobileNewChatSessionScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const { page } = fixture.running;
        const current = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
        await pageRequest(page, 'settings.update', {
            source: JSON.stringify({ ...current.value, 'session.openAgentsInChat': true }, null, 2),
        });
        await fixture.pair();
        const before = await pageRequest<{ sessions: Array<{ id: string }> }>(
            page,
            'app.bootstrap',
        );

        await tapMobileCheck(serial, 'new-session-button');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, enabled }) => checkId === 'new-session-agent-codex' && enabled,
                ) && hasCheck(nodes, `new-session-project-${fixture.allowedProjectId}`),
        );
        await tapMobileCheck(serial, `new-session-project-${fixture.allowedProjectId}`);
        await tapMobileCheck(serial, 'new-session-agent-shell');
        // The Agent group is laid out with Shell picked, so a missing Open as means hidden, not unrendered.
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, selected }) => checkId === 'new-session-agent-shell' && selected,
                ) &&
                hasCheck(nodes, 'new-session-agent-codex') &&
                !hasCheck(nodes, 'new-session-surface-chat') &&
                !hasCheck(nodes, 'new-session-surface-terminal'),
        );
        await capture(environment, 'shell-no-surface', artifacts);

        await tapMobileCheck(serial, 'new-session-agent-codex');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, selected }) => checkId === 'new-session-surface-chat' && selected,
                ) &&
                nodes.some(
                    ({ checkId, selected }) =>
                        checkId === 'new-session-surface-terminal' && !selected,
                ),
        );
        await capture(environment, 'chat-default', artifacts);
        // An explicit pick overrides the setting's default both ways.
        await tapMobileCheck(serial, 'new-session-surface-terminal');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, selected }) =>
                        checkId === 'new-session-surface-terminal' && selected,
                ),
        );
        await tapMobileCheck(serial, 'new-session-surface-chat');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(
                    ({ checkId, selected }) => checkId === 'new-session-surface-chat' && selected,
                ),
        );

        await tapMobileCheck(serial, 'new-session-create');
        await waitForCheck(serial, 'agent-chat');
        await waitForCheck(serial, 'agent-chat-status-empty');
        const after = await pageRequest<{
            sessions: Array<{ id: string }>;
            terminals: Array<{ id: string; kind: string; sessionId: string; surface: string }>;
        }>(page, 'app.bootstrap');
        const knownSessionIds = new Set(before.sessions.map(({ id }) => id));
        const created = after.sessions.find(({ id }) => !knownSessionIds.has(id));
        const terminal = after.terminals.find(({ sessionId }) => sessionId === created?.id);
        if (terminal?.kind !== 'codex' || terminal.surface !== 'chat')
            throw new Error('The phone did not create a Codex Chat Terminal');
        await capture(environment, 'created', artifacts);
        const settingsAfter = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
        if (!settingsAfter.value['session.openAgentsInChat'])
            throw new Error(
                "The phone's pick must not write the Mac's Open Agents in Chat setting",
            );

        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () =>
                pageRequest<AgentChatSnapshot>(page, 'agentChat.read', {
                    terminalId: terminal.id,
                }),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'reply', artifacts);

        await finish(environment, artifacts, {
            defaultSurface: 'chat',
            shellSurface: 'hidden',
            createdSurface: 'chat',
            explicitPick: 'overrides-default',
            macSetting: 'unchanged',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * Runs the Agent Chat Acceptance case `environment.caseId` names.
 */
export async function executeMobileAgentChatCase(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    switch (environment.caseId) {
        case 'MOB-CHAT-01':
            return executeMobileAgentChatScenario(environment, artifacts);
        case 'MOB-CHAT-02':
            return executeMobileClaudeToolApprovalScenario(environment, artifacts);
        case 'MOB-CHAT-03':
            return executeMobileNewChatSessionScenario(environment, artifacts);
        case 'MOB-CHAT-04':
            return executeMobileChatModelScenario(environment, artifacts);
        case 'MOB-CHAT-05':
            return executeMobileChatImageScenario(environment, artifacts);
        case 'MOB-CHAT-06':
            return executeMobileReadCacheScenario(environment, artifacts);
        case 'MOB-CHAT-07':
            return executeMobileChatPreviewScenario(environment, artifacts);
        case 'MOB-CHAT-08':
            return executeMobileChatMissingImageScenario(environment, artifacts);
        case 'MOB-CHAT-09':
            return executeMobileChatModelRefusedScenario(environment, artifacts);
        case 'MOB-CHAT-10':
            return executeMobileChatComposerScenario(environment, artifacts);
        case 'MOB-CHAT-11':
            return executeMobileClaudeModelScenario(environment, artifacts);
        case 'MOB-CHAT-12':
            return executeMobileChatImageStripScenario(environment, artifacts);
        case 'MOB-CHAT-13':
            return executeMobileChatPinScrollScenario(environment, artifacts);
        case 'MOB-CHAT-14':
            return executeMobileChatSkillsQuestionScenario(environment, artifacts);
        case 'MOB-CHAT-15':
            return executeMobileChatShimmerScenario(environment, artifacts);
        case 'MOB-CHAT-16':
            return executeMobileChatHistoryTasksScenario(environment, artifacts);
        case 'MOB-CHAT-17':
            return executeMobileChatBrowserScenario(environment, artifacts);
        case 'MOB-CHAT-18':
            return executeMobileChatChineseScenario(environment, artifacts);
        case 'MOB-CHAT-19':
            return executeMobileChatDelegatedTaskScenario(environment, artifacts);
        case 'MOB-CHAT-20':
            return executeMobileChatFeedbackScenario(environment, artifacts);
        case 'MOB-CHAT-21':
            return executeMobileSessionPinScenario(environment, artifacts);
        case 'MOB-CHAT-22':
            return executeMobilePlanLimitsScenario(environment, artifacts);
        case 'MOB-CHAT-23':
            return executeMobileReplyPlaceholderScenario(environment, artifacts);
        case 'MOB-CHAT-24':
            return executeMobilePullRequestScenario(environment, artifacts, 'failing');
        case 'MOB-CHAT-25':
            return executeMobilePullRequestScenario(environment, artifacts, 'ready');
        case 'MOB-CHAT-26':
            return executeMobileChatSubagentScenario(environment, artifacts);
        case 'MOB-CHAT-27':
            return executeMobileSessionSwipeScenario(environment, artifacts);
        case 'MOB-CHAT-28':
            return executeMobileSessionGroupsScenario(environment, artifacts);
        case 'MOB-CHAT-29':
            return executeMobileSavedTurnArtifactsScenario(environment, artifacts);
        case 'MOB-CHAT-30':
            return executeMobileChatBurstStreamScenario(environment, artifacts);
        case 'MOB-CHAT-31':
            return executeMobileAgentUsageScenario(environment, artifacts);
        case 'MOB-CHAT-32':
            return executeMobileChatMultiImagePickScenario(environment, artifacts);
        case 'MOB-CHAT-33':
        case 'MOB-CHAT-34':
            return executeMobileBotInboxScenario(environment, artifacts);
        case 'MOB-CHAT-35':
            return executeMobileChatMessageActionsScenario(environment, artifacts);
        case 'MOB-CHAT-COPY-LONG-01':
            return executeMobileChatLongCopyScenario(environment, artifacts);
        case 'MOB-CHAT-36':
            return executeMobileSessionPreviewScenario(environment, artifacts);
        case 'MOB-CHAT-TOAST-01':
            return executeMobileToastScenario(environment, artifacts);
        case 'MOB-CHAT-LINK-WRAP-01':
            return executeMobileChatInlineLinkScenario(environment, artifacts);
        case 'MOB-CHAT-CLIP-REREAD-01':
            return executeMobileChatBurstStreamScenario(environment, artifacts, 'clipped');
        case 'MOB-CHAT-LIST-APPROVAL-01':
            return executeMobileChatListApprovalScenario(environment, artifacts, 'codex');
        case 'MOB-CHAT-LIST-APPROVAL-02':
        case 'MOB-CHAT-LIST-QUESTION-01':
            return executeMobileChatListApprovalScenario(environment, artifacts, 'claude');
        case 'MOB-CHAT-GOAL-01':
            return executeMobileChatGoalScenario(environment, artifacts);
        case 'MOB-CHAT-RUNNING-OPEN-01':
            return executeMobileChatRunningTurnScenario(environment, artifacts);
        case 'MOB-CHAT-SEND-UNKNOWN-01':
            return executeMobileChatSendUnknownScenario(environment, artifacts);
        case 'MOB-CHAT-SURFACE-SWITCH-01':
            return executeMobileChatSurfaceSwitchScenario(environment, artifacts);
        case 'MOB-CHAT-USAGE-GUARD-01':
            return executeMobileChatUsageGuardScenario(environment, artifacts);
        case 'MOB-CHAT-USAGE-WAIT-01':
            return executeMobileChatUsageWaitScenario(environment, artifacts);
        case 'MOB-CHAT-PLAN-APPROVAL-01':
            return executeMobileChatPlanApprovalScenario(environment, artifacts);
        case 'MOB-CHAT-USAGE-01':
            return executeMobileSessionUsageScenario(environment, artifacts);
        default:
            throw new Error(`Unsupported Agent Chat Acceptance case: ${environment.caseId}`);
    }
}
