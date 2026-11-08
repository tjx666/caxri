import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    androidBounds,
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
 * A message that is only a numbered list, so no plain line widens the bubble: the list content alone must size it.
 */
const LIST_ONLY_MESSAGE = [
    '1. 先对比几家开源网关的路由、限流和计费能力',
    '2. 再估算自研需要的人力和维护成本',
].join('\n');

/**
 * The narrowest a list line of {@link LIST_ONLY_MESSAGE} may draw, as a share of the screen. Each line runs longer than
 * the bubble's 85% limit, so it should wrap at that limit; before the fix its content measured as zero wide and the
 * bubble shrank to the number, leaving one character per line.
 */
const LIST_LINE_MIN_SHARE = 0.5;

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
        /**
         * UIAutomator clips a view's reported bounds to its parent, so a line hanging below the bubble still reports
         * bounds inside it; it shows instead as a line shorter than a whole one. The bubble's first lines may sit above
         * the screen edge, so only the wrapped item and the one after it, the lines that used to spill, are judged.
         */
        const height = (position: number) => {
            const bounds = checkBounds(semantics, `${prefix}${position}`);
            return bounds ? bounds.bottom - bounds.top : 0;
        };
        const line = height(WRAPPING_BLOCK - 1);
        if (line === 0)
            throw new Error('The one-line list item before the long one is not laid out');
        if (height(WRAPPING_BLOCK) < 1.5 * line)
            throw new Error('The long list item did not wrap, so the bubble check proves nothing');
        if (height(WRAPPING_BLOCK + 1) < line - 2)
            throw new Error(
                `Block ${WRAPPING_BLOCK + 1} of the user message is cut off below its bubble`,
            );

        const listLineIds = new Set(
            semantics.map(({ checkId }) => checkId).filter((id) => id.startsWith(prefix)),
        );
        await chat.send({ text: LIST_ONLY_MESSAGE });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.filter((item) => item.type === 'agentMessage').length >= 2,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        const after = await mobileSemantics(serial);
        const screen = androidBounds(
            after.find(({ checkId }) => checkId === 'conversation-view')?.bounds ?? '',
        );
        const listLine = after.find(
            ({ checkId }) =>
                /^conversation-user-text-.+-0$/u.test(checkId) && !listLineIds.has(checkId),
        );
        const lineBounds = listLine && androidBounds(listLine.bounds);
        if (!screen || !lineBounds) throw new Error('The list-only bubble is not on screen');
        const share = (lineBounds.right - lineBounds.left) / (screen.right - screen.left);
        // Captured before the check so a squeezed bubble is on record too.
        await capture(environment, 'user-markdown-list-only-bubble', artifacts);
        if (share < LIST_LINE_MIN_SHARE)
            throw new Error(
                `A list-only bubble squeezes its first line to ${Math.round(share * 100)}% of the screen`,
            );

        await finish(environment, artifacts, {
            listLineShare: Number(share.toFixed(2)),
            renderedLines: RENDERED_LINES.length,
            status: 'passed',
        });
    } finally {
        await fixture?.stop();
    }
}
