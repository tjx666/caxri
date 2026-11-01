import type { AgentChatSnapshot, BootstrapState } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { scrollTimelineUntil, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    androidBounds,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

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

const reply = (snapshot: AgentChatSnapshot, text: string) =>
    snapshot.items.find(
        (item): item is Extract<AgentChatSnapshot['items'][number], { type: 'agentMessage' }> =>
            item.type === 'agentMessage' && item.text.startsWith(text),
    );

const replyTurnId = (snapshot: AgentChatSnapshot, text: string): string | undefined =>
    reply(snapshot, text)?.turnId;

/**
 * The turns land over a minute apart, so each reply's More menu must show its own minute rather than the time it was
 * opened or the latest reply's.
 */
const TURN_GAP_MS = 65_000;

/**
 * A reply's minute as its menu prints it (`:07`). Only the minute is compared, since the emulator's time zone may
 * differ from the host's.
 */
const minuteOf = (timestamp: number): string =>
    `:${String(new Date(timestamp).getMinutes()).padStart(2, '0')}`;

/**
 * Drags the timeline toward earlier messages until a reply's whole bar (Copy through Sources) is on screen. The latest
 * turn opens at the top of the Chat, so an earlier reply's bar starts above the screen, where Android still lists its
 * controls but a tap would land on whatever covers them.
 */
const showBar = (serial: string, turnId: string) =>
    scrollTimelineUntil(serial, async () => {
        const nodes = await mobileSemantics(serial);
        const frame = nodes.find(({ checkId }) => checkId === 'conversation-view');
        const view = frame && androidBounds(frame.bounds);
        return ['copy', 'more', 'sources'].every((action) => {
            const node = nodes.find(
                ({ checkId }) => checkId === `agent-chat-reply-${action}-${turnId}`,
            );
            const bounds = node && androidBounds(node.bounds);
            return Boolean(
                view && bounds && bounds.top >= view.top && bounds.bottom <= view.bottom,
            );
        });
    });

/**
 * Opens a reply's More menu and proves its heading reads today at that reply's own minute.
 */
async function openMoreMenu(serial: string, turnId: string, sentAt: number): Promise<void> {
    await tapMobileCheckByBounds(serial, `agent-chat-reply-more-${turnId}`, {
        viewport: 'conversation-view',
    });
    await waitForCheck(serial, 'agent-chat-reply-time');
    for (const value of ['今天', minuteOf(sentAt)]) {
        // eslint-disable-next-line no-await-in-loop -- one menu, read twice.
        const heading = await observeMobileNode(serial, 'agent-chat-reply-time', {
            kind: 'includes',
            value,
        });
        if (heading.textMatches !== true) throw new Error(`The More menu does not show ${value}`);
    }
}

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
        await new Promise((resolve) => setTimeout(resolve, TURN_GAP_MS));
        await chat.send({ text: FOLLOW_UP });
        const answered = await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && replyTurnId(snapshot, 'You are') !== undefined,
            60_000,
        );
        const searched = replyTurnId(answered, 'Target');
        const thanked = replyTurnId(answered, 'You are');
        const searchedAt = reply(answered, 'Target')?.createdAt;
        const thankedAt = reply(answered, 'You are')?.createdAt;
        if (!searched || !thanked || searchedAt === undefined || thankedAt === undefined)
            throw new Error('The scripted turns did not finish');
        if (minuteOf(searchedAt) === minuteOf(thankedAt))
            throw new Error('The two replies landed in the same minute');
        const recorded = answered.items.find(
            (item): item is Extract<AgentChatSnapshot['items'][number], { type: 'toolCall' }> =>
                item.type === 'toolCall',
        )?.sources;
        const pages = (sources: ReadonlyArray<{ url: string; title?: string }> | undefined) =>
            sources?.map(({ title, url }) => `${url} ${title ?? ''}`).join('\n');
        if (pages(recorded) !== pages(LINKS))
            throw new Error('Server Core did not record the searched pages with their titles');

        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, `agent-chat-reply-sources-${searched}`, 60_000);
        for (const turnId of [searched, thanked])
            for (const action of ['copy', 'share', 'more'])
                // eslint-disable-next-line no-await-in-loop -- each control is checked on the same settled screen.
                await waitForCheck(serial, `agent-chat-reply-${action}-${turnId}`);
        await waitForNoCheck(serial, `agent-chat-reply-sources-${thanked}`);

        // The latest turn opens at the top of the screen, so its bar is checked first.
        await openMoreMenu(serial, thanked, thankedAt);
        await capture(environment, 'more-menu-latest', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-reply-time');

        // The searched turn sits above it; every step on its bar starts with that bar on screen.
        await showBar(serial, searched);
        // Favicons load from the sites; give them a moment before the settled capture.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        await capture(environment, 'action-bars', artifacts);

        await tapMobileCheckByBounds(serial, `agent-chat-reply-copy-${searched}`, {
            viewport: 'conversation-view',
        });
        await waitForCheck(serial, 'toast');
        await capture(environment, 'copied', artifacts);

        await showBar(serial, searched);
        await openMoreMenu(serial, searched, searchedAt);
        await waitForCheck(serial, 'agent-chat-reply-fork');
        await waitForCheck(serial, 'agent-chat-reply-retry');
        await waitForCheck(serial, 'agent-chat-reply-select');
        await capture(environment, 'more-menu', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-reply-select');
        await waitForCheck(serial, 'conversation-message-select-text');
        await capture(environment, 'select-text', artifacts);
        await waitForCheck(serial, 'conversation-message-select-done');
        await tapMobileCheckByBounds(serial, 'conversation-message-select-done');
        await waitForNoCheck(serial, 'conversation-message-sheet');

        await showBar(serial, searched);
        await tapMobileCheckByBounds(serial, `agent-chat-reply-sources-${searched}`, {
            viewport: 'conversation-view',
        });
        await waitForCheck(serial, 'agent-chat-sources-sheet');
        await waitForCheck(serial, `agent-chat-source-${LINKS.length - 1}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await capture(environment, 'sources-sheet', artifacts);
        await adbShell(serial, ['input', 'keyevent', 'KEYCODE_BACK']);
        await waitForNoCheck(serial, 'agent-chat-sources-sheet');

        await showBar(serial, searched);
        const before = await sessionIds(fixture.running.page);
        await tapMobileCheckByBounds(serial, `agent-chat-reply-more-${searched}`, {
            viewport: 'conversation-view',
        });
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
        // The fork holds the conversation through the first turn only, so the phone showing it no longer shows the
        // second reply's bar.
        await waitForNoCheck(serial, `agent-chat-reply-more-${thanked}`, 60_000);
        await waitForCheck(serial, 'session-detail-title');
        await capture(environment, 'forked-session', artifacts);
        await finish(environment, artifacts, {
            forkedSessionCreated: true,
            recordedSources: recorded?.length,
            replyMinutes: [minuteOf(searchedAt), minuteOf(thankedAt)],
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
