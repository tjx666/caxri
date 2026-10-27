import type { AgentAction } from '@caxri/protocol';
import { agentChatDraftMatches, agentChatMenuActions } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    checkBounds,
    hasCheck,
    hideChatKeyboard,
    sendFromPhone,
    typeChatDraft,
    waitForCheck,
    waitForNoCheck,
    withVisibleKeyboard,
} from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import {
    adbShell,
    mobileDisplayState,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import {
    MOBILE_CHAT_SKILL_QUERY,
    mobileChatSkills,
    seedMobileChatSkills,
} from './mobile-chat-skills-fixture';

/**
 * The tallest an answer option row may be and still read as compact, in density-independent pixels. A row holds a label
 * and a one-line description; a layout that stacks extra padding or wraps the description runs past it.
 */
const MAX_OPTION_ROW_DP = 72;

/**
 * The shortest a question part may render while its card shares the screen with the keyboard: one line of the question
 * text. A part the card had to clip to fit comes out shorter.
 */
const MIN_TYPING_PART_DP = 20;

const menuRows = (nodes: readonly MobileSemanticNode[]): number =>
    nodes.filter(({ checkId }) => /^agent-chat-command-\d+$/u.test(checkId)).length;

/**
 * Whether `inner` lies wholly inside `outer`, so nothing of it is clipped by the edge of `outer`.
 */
const isInside = (
    inner: NonNullable<ReturnType<typeof checkBounds>>,
    outer: NonNullable<ReturnType<typeof checkBounds>>,
): boolean =>
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom;

/**
 * Which language the empty composer's placeholder is in. UIAutomator reports an empty field's hint as its text, so the
 * hint names the app language without exposing anything the user typed.
 */
async function placeholderLanguage(serial: string): Promise<'chinese' | 'english' | 'unreadable'> {
    const english = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'includes',
        value: 'Message',
    });
    if (english.textMatches) return 'english';
    const chinese = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'includes',
        value: '发消息',
    });
    return chinese.textMatches ? 'chinese' : 'unreadable';
}

/**
 * The shared Claude Code flow behind `MOB-CHAT-14` and `MOB-CHAT-18`.
 *
 * Typing `/` lists the provider's commands under Commands and the Project's discovered skills under Skills; `/to`
 * narrows the menu to the two skills that share the prefix. Then a two-question `AskUserQuestion` card: with the
 * keyboard closed it fits wholly inside its dock, its options are compact rows, the first option carries the
 * Recommended badge, and an inline Other row sits under the options. Answering both questions finishes the turn. Last,
 * a `multiSelect` question keeps its card open across two ticks and sends both on Submit.
 */
async function executeSkillsAndQuestionFlow(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    language: 'chinese' | 'english',
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        seedProject: seedMobileChatSkills,
        serial,
    });
    try {
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        if (language === 'chinese') {
            // The app's language reaches every screen, not only the Chat: the Session list, its menu, and Settings.
            await waitForCheck(serial, `session-row-${fixture.allowedSessionId}`);
            await capture(environment, 'sessions', artifacts);
            await tapMobileCheck(serial, 'forget-device-button');
            await waitForCheck(serial, 'settings-action');
            await capture(environment, 'sessions-menu', artifacts);
            await tapMobileCheck(serial, 'settings-action');
            await waitForCheck(serial, 'settings-access-level');
            await capture(environment, 'settings', artifacts);
            await tapMobileCheck(serial, 'settings-back');
            await waitForCheck(serial, `session-row-${fixture.allowedSessionId}`);
        }
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        // An unreadable hint fails too: it would let a Chat that never switched language pass.
        const placeholder = await placeholderLanguage(serial);
        if (placeholder !== language)
            throw new Error(`The Chat placeholder is ${placeholder}, not ${language}`);
        await capture(environment, 'empty', artifacts);

        // Skills are discovered from the running Agent, which the first reply proves is up.
        await sendFromPhone(serial, 'hello');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => agentText(snapshot).includes('You said: hello') && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await capture(environment, 'reply', artifacts);
        const discovered = await waitForMobile(
            () =>
                pageRequest<{ actions: AgentAction[] }>(fixture.running.page, 'agentActions.list', {
                    terminalId: chat.terminalId,
                }),
            ({ actions }) =>
                mobileChatSkills.every(({ name }) =>
                    actions.some(
                        (action) => action.kind === 'skill' && action.invocation === `/${name}`,
                    ),
                ),
        );
        const menu = agentChatMenuActions((await chat.read()).commands, discovered.actions);
        const all = agentChatDraftMatches(menu, '/');
        if (
            all.every(({ kind }) => kind !== 'command') ||
            all.every(({ kind }) => kind !== 'skill')
        )
            throw new Error('The fixture menu lacks a command or a skill');
        const narrowed = agentChatDraftMatches(menu, MOBILE_CHAT_SKILL_QUERY);
        const narrowedSkills = narrowed
            .filter(({ kind }) => kind === 'skill')
            .map(({ invocation }) => invocation);
        if (
            narrowedSkills.toSorted((a, b) => a.localeCompare(b)).join(',') !==
                '/topic-summary,/tour-guide' ||
            narrowed.length > 6
        )
            throw new Error('The narrowed fixture menu is not the two prefixed skills');

        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'text', '/']);
        await waitForCheck(serial, 'agent-chat-command-list');
        await waitForNoCheck(serial, 'agent-chat-skill-notice');
        await capture(environment, 'slash-menu', artifacts);
        await adbShell(serial, ['input', 'text', MOBILE_CHAT_SKILL_QUERY.slice(1)]);
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: MOBILE_CHAT_SKILL_QUERY,
        });
        if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
        // The phone shows exactly the rows the shared ranking gives for `/to`: the two skills, and no release-notes.
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => menuRows(nodes) === narrowed.length,
        );
        await waitForNoCheck(serial, 'agent-chat-skill-notice');
        await capture(environment, 'slash-menu-narrowed', artifacts);
        await adbShell(serial, [
            'input',
            'keyevent',
            ...Array.from(MOBILE_CHAT_SKILL_QUERY, () => 'KEYCODE_DEL'),
        ]);
        await waitForNoCheck(serial, 'agent-chat-command-list');

        await typeChatDraft(serial, 'ask recommended');
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
        await waitForCheck(serial, 'agent-chat-question-0-option-0');
        // The question header hides while the keyboard is open; the card is judged as a reader sees it after closing it.
        await hideChatKeyboard(serial);
        const card = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                [
                    'agent-chat-question-tab-1',
                    'agent-chat-question-0-text',
                    'agent-chat-question-0-other-open',
                ].every((id) => hasCheck(nodes, id)),
        );
        const dock = checkBounds(card, 'agent-chat-requests');
        if (!dock) throw new Error('The question dock is not laid out');
        const display = await mobileDisplayState(serial);
        const screen = display.size.override ?? display.size.physical;
        if (dock.top < 0 || dock.bottom > screen.height)
            throw new Error('The question dock runs off the screen');
        const parts = card.filter(({ checkId }) =>
            /^agent-chat-question-(?:tab-\d+|0-text|0-options|0-option-\d+|0-other-open)$/u.test(
                checkId,
            ),
        );
        for (const part of parts) {
            const bounds = checkBounds(card, part.checkId);
            if (!bounds || !isInside(bounds, dock))
                throw new Error(`${part.checkId} is clipped outside the question card`);
        }
        const density = display.density.override ?? display.density.physical;
        const optionHeights = card
            .filter(({ checkId }) => /^agent-chat-question-0-option-\d+$/u.test(checkId))
            .map(({ checkId }) => {
                const bounds = checkBounds(card, checkId);
                return bounds
                    ? Math.round(((bounds.bottom - bounds.top) * 160) / density)
                    : Infinity;
            });
        if (optionHeights.length < 2 || optionHeights.some((height) => height > MAX_OPTION_ROW_DP))
            throw new Error('The question options are not compact rows');
        await capture(environment, 'question', artifacts);

        // The fixture IME draws no keyboard, so the emulator's own keyboard takes its half of the screen here.
        await withVisibleKeyboard(serial, async () => {
            // Other opens in place as a text field under the options, then the answer is still a tap away.
            await tapMobileCheckByBounds(serial, 'agent-chat-question-0-other-open');
            await waitForCheck(serial, 'agent-chat-question-0-other');
            await adbShell(serial, ['input', 'text', 'typed']);
            // With the keyboard up the card used to shrink below its content and draw the answer field and buttons over
            // the status row and composer, outside its own background. Every part stays whole inside the card, above the
            // composer.
            const typing = await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) =>
                    // The form hides the options while the keyboard is up; the bounds below judge everything else.
                    !hasCheck(nodes, 'agent-chat-question-0-option-0') &&
                    hasCheck(nodes, 'agent-chat-question-0-other') &&
                    hasCheck(nodes, 'agent-chat-request'),
            );
            const typingCard = checkBounds(typing, 'agent-chat-request');
            if (!typingCard) throw new Error('The question card is not laid out while typing');
            // The card ends above the waiting status row, the access and model row, and the composer input below it.
            for (const id of [
                'agent-chat-activity',
                'agent-chat-model-button',
                'agent-chat-composer-input',
            ]) {
                const below = checkBounds(typing, id);
                if (!below || typingCard.bottom > below.top)
                    throw new Error(`The question card overlaps ${id} while typing`);
            }
            for (const id of [
                'agent-chat-question-0-text',
                'agent-chat-question-0-other',
                'agent-chat-question-skip',
                'agent-chat-question-next',
            ]) {
                const bounds = checkBounds(typing, id);
                if (!bounds || !isInside(bounds, typingCard))
                    throw new Error(`${id} spills outside the question card while typing`);
                if (((bounds.bottom - bounds.top) * 160) / density < MIN_TYPING_PART_DP)
                    throw new Error(`${id} is cut short inside the question card while typing`);
            }
            await capture(environment, 'question-other', artifacts);
        });
        await waitForCheck(serial, 'agent-chat-question-0-option-0');

        // A tap answers and moves to the next question; answering the last one sends the card.
        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-0');
        await waitForCheck(serial, 'agent-chat-question-1-option-0');
        await capture(environment, 'question-second', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-question-1-option-0');
        await waitForMobile(
            () => chat.read(),
            (snapshot) => /You chose .*Yes/u.test(agentText(snapshot)) && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');
        await capture(environment, 'question-sent', artifacts);

        // A multiSelect question ticks options instead of answering on the first tap, and Submit sends every tick.
        await typeChatDraft(serial, 'ask multi');
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
        await waitForCheck(serial, 'agent-chat-question-0-option-0');
        await hideChatKeyboard(serial);
        await waitForCheck(serial, 'agent-chat-question-submit');
        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-0');
        await tapMobileCheckByBounds(serial, 'agent-chat-question-0-option-1');
        // Two taps leave the card open: a single-choice card would have sent after the first.
        await waitForCheck(serial, 'agent-chat-question-0-option-2');
        await capture(environment, 'question-multi-ticked', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-question-submit');
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                /Running Lint.*Unit tests\./u.test(agentText(snapshot)) && !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-request');
        await capture(environment, 'question-multi-sent', artifacts);

        await finish(environment, artifacts, {
            language,
            menu: 'commands-and-skills',
            narrowedRows: narrowed.length,
            optionRowHeightsDp: optionHeights,
            placeholderLanguage: placeholder,
            question: 'fully-visible-and-answered',
            multiSelect: 'two-ticks-submitted',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-14`: the Skills group beside Commands in the `/` menu, and the compact AskUserQuestion card.
 */
export const executeMobileChatSkillsQuestionScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> => executeSkillsAndQuestionFlow(environment, artifacts, 'english');

/**
 * `MOB-CHAT-18`: the same Chat flow with the app's language set to Simplified Chinese by the runner, so the empty
 * state, menu headings, question card, and composer read in Chinese. The reply and option text come from the fake Agent
 * and stay English.
 */
export const executeMobileChatChineseScenario = (
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> => executeSkillsAndQuestionFlow(environment, artifacts, 'chinese');
