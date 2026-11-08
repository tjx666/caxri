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
 * A numbered item long enough to wrap inside the bubble's 85% width. The bubble sizes to its content, and a list line
 * that measured its words unwrapped left the wrapped line, and the item after it, hanging below the bubble.
 */
const WRAPPING_ITEM = '点击发送时图片的 view transition 从输入框飞进刚发出的消息气泡里';

/**
 * A user message with every block Desktop's bubble renders: bold and inline code in a line, a quote, a bullet list, and
 * a numbered list whose third item wraps, as in the report that found the overflow.
 */
const MARKDOWN_MESSAGE = [
    '这个是写了**迁移脚本**?看 `0004` 文件',
    '> 迁移给现有渠道各建一份凭证',
    '- 第一项',
    '- 第二项',
    '1. 输入时所见即所得',
    '2. 内联图片显示',
    `3. ${WRAPPING_ITEM}`,
    '4. 输入框高度变化动画',
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
    '第二项',
    '输入时所见即所得',
    '内联图片显示',
    WRAPPING_ITEM,
    '输入框高度变化动画',
] as const;

/**
 * The block of `RENDERED_LINES` that must wrap, so the containment check below proves the case it was written for.
 */
const WRAPPING_BLOCK = RENDERED_LINES.indexOf(WRAPPING_ITEM);

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
        // Captured before judging, so a bubble that spills is on record as the reader saw it.
        await capture(environment, 'user-markdown-bubble', artifacts);
        const bubble = checkBounds(
            semantics,
            `conversation-user-bubble-${prefix.slice('conversation-user-text-'.length, -'-'.length)}`,
        );
        if (!bubble) throw new Error('The user bubble is not laid out');
        const wrapped = checkBounds(semantics, `${prefix}${WRAPPING_BLOCK}`);
        const single = checkBounds(semantics, `${prefix}${WRAPPING_BLOCK + 1}`);
        if (
            !wrapped ||
            !single ||
            wrapped.bottom - wrapped.top < 1.5 * (single.bottom - single.top)
        )
            throw new Error('The long list item did not wrap, so the bubble check proves nothing');
        // The bubble's first lines may sit above the screen edge, where UIAutomator's bounds are clipped; the wrapped
        // item and the one after it are the lines that used to spill, and both stay on screen.
        for (const [position, block] of [
            [WRAPPING_BLOCK, wrapped],
            [WRAPPING_BLOCK + 1, single],
        ] as const) {
            if (!isInside(block, bubble))
                throw new Error(`Block ${position} of the user message spills outside its bubble`);
        }

        await finish(environment, artifacts, {
            renderedLines: RENDERED_LINES.length,
            status: 'passed',
        });
    } finally {
        await fixture?.stop();
    }
}
