import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { observeMobileNode, tapMobileCheck } from './mobile-android';
import { insertMobileInputUnicode } from './mobile-unicode-input';

/**
 * A draft with every look the composer renders while typing: bold and inline code in a line, a heading, a bullet, and a
 * quote. The cursor ends on the quote line, so its `> ` stays visible while every other marker is hidden.
 */
const MARKDOWN_DRAFT = [
    '先看**迁移脚本**和 `0004` 文件',
    '# 下一步',
    '- 列表项',
    '> 引用的话',
].join('\n');

/**
 * A plain last line typed after the draft, moving the cursor off the quote so its marker hides too.
 */
const PLAIN_LINE = '\n继续输入';

/**
 * `MOB-CHAT-COMPOSER-MARKDOWN-01`: the composer renders Markdown as it is typed, as Desktop's composer does. Bold,
 * inline code, the heading, and the quote take their look and lose their markers away from the cursor, while the field
 * still holds exactly what was typed, so the message the Agent gets is unchanged. Before the change the field showed
 * plain text with every marker.
 */
export async function executeMobileChatComposerMarkdownScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    let fixture: Awaited<ReturnType<typeof createMobileAcceptanceFixture>> | undefined;
    try {
        fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
        await fixture.pair();
        if (!fixture.agentChat || !fixture.allowedSessionId)
            throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await insertMobileInputUnicode(
            serial,
            'agent-chat-composer-input',
            MARKDOWN_DRAFT,
            MARKDOWN_DRAFT,
        );
        await capture(environment, 'composer-markdown-quote-line', artifacts);
        await insertMobileInputUnicode(
            serial,
            'agent-chat-composer-input',
            PLAIN_LINE,
            MARKDOWN_DRAFT + PLAIN_LINE,
        );
        // The field's text is the draft as typed: the rendering styles it but never rewrites it.
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: MARKDOWN_DRAFT + PLAIN_LINE,
        });
        if (!draft.exists || draft.textMatches !== true)
            throw new Error('The composer no longer holds the Markdown draft exactly as typed');
        await capture(environment, 'composer-markdown-rendered', artifacts);
        await finish(environment, artifacts, { status: 'passed' });
    } finally {
        await fixture?.stop();
    }
}
