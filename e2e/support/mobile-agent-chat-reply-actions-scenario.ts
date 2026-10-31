import type { AgentChatSnapshot, BootstrapState } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { adbShell, tapMobileCheck, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

const PROMPT = 'Which Expo SDK should we target?';
const FOLLOW_UP = 'thanks';

/**
 * Public pages the search lists, in Claude Code's `WebSearch` result shape (`Links: [...]`), so Server Core records
 * them as the call's sources. Their favicons load from the sites themselves when the emulator is online.
 */
const LINKS = [
    { title: 'Expo SDK changelog', url: 'https://expo.dev/changelog' },
    { title: 'React Native blog', url: 'https://reactnative.dev/blog' },
    { title: 'Android Developers: Releases', url: 'https://developer.android.com/about/versions' },
    { title: 'GitHub: expo/expo', url: 'https://github.com/expo/expo' },
];

/**
 * The first turn searches the web, so its reply ends with Sources; the second turn only answers, so its bar has none.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                {
                    kind: 'tool',
                    name: 'WebSearch',
                    input: { query: 'latest Expo SDK release' },
                    output: `Web search results for query: "latest Expo SDK release"\n\nLinks: ${JSON.stringify(LINKS)}`,
                },
                {
                    kind: 'text',
                    text: 'Target the latest Expo SDK; its changelog lists the React Native it ships.',
                },
            ],
        },
        {
            prompt: FOLLOW_UP,
            steps: [{ kind: 'text', text: 'You are welcome.' }],
        },
    ],
};

const sessionIds = async (page: Parameters<typeof pageRequest>[0]): Promise<string[]> =>
    (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.map(({ id }) => id);

const replyTurnId = (snapshot: AgentChatSnapshot, text: string): string | undefined =>
    snapshot.items.find((item) => item.type === 'agentMessage' && item.text.startsWith(text))
        ?.turnId;

/**
 * `MOB-CHAT-REPLY-ACTIONS-01` (#3354): every finished turn's reply ends with Copy, Share, and More, and a turn that
 * searched the web stacks its pages' site icons beside Sources. More heads its menu with when the reply was sent and
 * offers Fork in New Chat, Retry, and Select Text; Sources opens a sheet of each page's site and title. Fork from the
 * first reply opens a new Session.
 */
export async function executeMobileChatReplyActionsScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: script,
        mode: 'agent-chat',
        serial,
    });
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: PROMPT });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && replyTurnId(snapshot, 'Target') !== undefined,
            60_000,
        );
        await chat.send({ text: FOLLOW_UP });
        const answered = await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && replyTurnId(snapshot, 'You are') !== undefined,
            60_000,
        );
        const searched = replyTurnId(answered, 'Target');
        const thanked = replyTurnId(answered, 'You are');
        if (!searched || !thanked) throw new Error('The scripted turns did not finish');
        const recorded = answered.items.find(
            (item): item is Extract<AgentChatSnapshot['items'][number], { type: 'toolCall' }> =>
                item.type === 'toolCall',
        )?.sources;
        if (recorded?.length !== LINKS.length) throw new Error('Server Core recorded no sources');

        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, `agent-chat-reply-sources-${searched}`, 60_000);
        await waitForCheck(serial, `agent-chat-reply-more-${thanked}`);
        await waitForNoCheck(serial, `agent-chat-reply-sources-${thanked}`);
        // Favicons load from the sites; give them a moment before the settled capture.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await capture(environment, 'action-bars', artifacts);

        await tapMobileCheckByBounds(serial, `agent-chat-reply-more-${searched}`);
        await waitForCheck(serial, 'agent-chat-reply-time');
        await waitForCheck(serial, 'agent-chat-reply-fork');
        await waitForCheck(serial, 'agent-chat-reply-retry');
        await waitForCheck(serial, 'agent-chat-reply-select');
        await capture(environment, 'more-menu', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-reply-time');

        await tapMobileCheckByBounds(serial, `agent-chat-reply-sources-${searched}`);
        await waitForCheck(serial, 'agent-chat-sources-sheet');
        await waitForCheck(serial, `agent-chat-source-${LINKS.length - 1}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await capture(environment, 'sources-sheet', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-sources-sheet');

        const before = await sessionIds(fixture.running.page);
        await tapMobileCheckByBounds(serial, `agent-chat-reply-more-${searched}`);
        await waitForCheck(serial, 'agent-chat-reply-fork');
        await tapMobileCheckByBounds(serial, 'agent-chat-reply-fork');
        const forkedId = (
            await waitForMobile(
                () => sessionIds(fixture.running.page),
                (ids) => ids.some((id) => !before.includes(id)),
                60_000,
            )
        ).find((id) => !before.includes(id));
        if (!forkedId) throw new Error('Fork did not create a Session');
        await waitForCheck(serial, 'session-detail-title');
        await capture(environment, 'forked-session', artifacts);
        await finish(environment, artifacts, {
            fork: 'opened-new-session',
            menu: 'time-fork-retry-select',
            recordedSources: recorded.length,
            sourcesOnReplyWithoutSearch: 'absent',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
