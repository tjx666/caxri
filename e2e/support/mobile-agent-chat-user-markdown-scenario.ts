import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import { mobileNativeControlBounds, tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * A user message with every block Desktop's bubble renders: bold and inline code in a line, a quote, and a bullet list.
 */
const MARKDOWN_MESSAGE = [
    '这个是写了**迁移脚本**?看 `0004` 文件',
    '> 迁移给现有渠道各建一份凭证',
    '- 第一项',
    '- 第二项',
].join('\n');

/**
 * The text each block shows once its Markdown markers are hidden. Each is its own native text view, so an exact match
 * proves the `**`, backticks, `> `, and `- ` are gone from what the reader sees.
 */
const RENDERED_LINES = [
    '这个是写了迁移脚本?看 0004 文件',
    '迁移给现有渠道各建一份凭证',
    '第一项',
    '第二项',
] as const;

/**
 * `MOB-CHAT-USER-MARKDOWN-01`: the user's own message reads as Desktop's bubble shows it. Bold and inline code lose
 * their markers, a quote sits behind its bar without `> `, and list lines get a bullet in place of `- `. Before the fix
 * the bubble showed the message as typed, markers included.
 */
export async function executeMobileChatUserMarkdownScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    let fixture: Awaited<ReturnType<typeof createMobileAcceptanceFixture>> | undefined;
    try {
        fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await chat.send({ text: MARKDOWN_MESSAGE });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage'),
        );
        await waitForNoCheck(serial, 'agent-chat-activity');

        for (const text of RENDERED_LINES) {
            // eslint-disable-next-line no-await-in-loop -- one UI dump at a time; parallel dumps share one device path.
            const line = await waitForMobile(
                () =>
                    mobileNativeControlBounds(serial, {
                        className: 'android.widget.TextView',
                        text,
                    }),
                (candidate) => candidate !== null,
                15_000,
            );
            if (!line)
                throw new Error(`The user bubble does not show "${text}" with its markers hidden`);
        }
        await capture(environment, 'user-markdown-bubble', artifacts);

        await finish(environment, artifacts, {
            renderedLines: RENDERED_LINES.length,
            status: 'passed',
        });
    } finally {
        await fixture?.stop();
    }
}
