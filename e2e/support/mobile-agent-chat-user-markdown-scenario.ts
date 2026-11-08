import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, isInside, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';

/**
 * A list item long enough to wrap inside the bubble's 85% width. The bubble sizes to its content, and a list line that
 * measured its words unwrapped left the wrapped line, and every block after it, hanging below the bubble.
 */
const WRAPPING_ITEM = '点击发送时图片的 view transition 从输入框飞进刚发出的消息气泡里';

/**
 * A user message with every block Desktop's bubble renders: bold and inline code in a line, a quote, and a bullet list
 * whose middle item wraps.
 */
const MARKDOWN_MESSAGE = [
    '这个是写了**迁移脚本**?看 `0004` 文件',
    '> 迁移给现有渠道各建一份凭证',
    '- 第一项',
    `- ${WRAPPING_ITEM}`,
    '- 第二项',
].join('\n');

/**
 * The text each block of the bubble shows once its Markdown markers are hidden, in block order. Each is its own native
 * text view (`conversation-user-text-<id>-<index>`), so an exact match proves the `**`, backticks, `> `, and `- ` are
 * gone from what the reader sees.
 */
const RENDERED_LINES = [
    '这个是写了迁移脚本?看 0004 文件',
    '迁移给现有渠道各建一份凭证',
    '第一项',
    WRAPPING_ITEM,
    '第二项',
] as const;

/**
 * `MOB-CHAT-USER-MARKDOWN-01`: the user's own message reads as Desktop's bubble shows it. Bold and inline code lose
 * their markers, a quote sits behind its bar without `> `, and list lines get a bullet in place of `- `. Before the fix
 * the bubble showed the message as typed, markers included. Every block also stays inside the bubble when a list item
 * wraps; it used to spill the wrapped line and the item after it below the bubble's background.
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

        // The fake Agent echoes the message back, so each line also shows in the reply; read the bubble's own blocks.
        const semantics = await mobileSemantics(serial);
        const first = semantics.find(({ checkId }) =>
            /^conversation-user-text-.+-0$/u.test(checkId),
        )?.checkId;
        if (!first) throw new Error('The user bubble has no text blocks on screen');
        const prefix = first.slice(0, -'0'.length);
        for (const [position, text] of RENDERED_LINES.entries()) {
            // eslint-disable-next-line no-await-in-loop -- one UI dump at a time; parallel dumps share one device path.
            const line = await observeMobileNode(serial, `${prefix}${position}`, {
                kind: 'equals',
                value: text,
            });
            if (!line.exists || line.textMatches !== true)
                throw new Error(`The user bubble does not show "${text}" with its markers hidden`);
        }
        const bubble = checkBounds(
            semantics,
            `conversation-user-bubble-${prefix.slice('conversation-user-text-'.length, -'-'.length)}`,
        );
        if (!bubble) throw new Error('The user bubble is not laid out');
        for (const position of RENDERED_LINES.keys()) {
            const block = checkBounds(semantics, `${prefix}${position}`);
            if (!block || !isInside(block, bubble))
                throw new Error(`Block ${position} of the user message spills outside its bubble`);
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
