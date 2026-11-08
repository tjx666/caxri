import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import {
    observeMobileNode,
    startMobileFramebufferRecording,
    tapMobileCheck,
} from './mobile-android';
import { insertMobileInputUnicode } from './mobile-unicode-input';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A draft with every look the composer renders while typing: bold and inline code in a line, a heading, a bullet, and a
 * quote, then a plain last line. It is typed in one commit, so the cursor ends on the plain line, away from every
 * marker; a second insert would tap the field first and drop the caret mid-draft.
 */
const MARKDOWN_DRAFT = [
    '先看**迁移脚本**和 `0004` 文件',
    '# 下一步',
    '- 列表项',
    '> 引用的话',
    '继续输入',
].join('\n');

/**
 * `MOB-CHAT-COMPOSER-MARKDOWN-01`: the composer renders Markdown as it is typed, as Desktop's composer does. Bold,
 * inline code, the heading, and the quote take their look and lose their markers away from the cursor, while the field
 * still holds exactly what was typed, so the message the Agent gets is unchanged. Before the change the field showed
 * plain text with every marker. The recording spans the commit, so it also shows the capsule growing from one line to
 * five with its height motion instead of jumping.
 */
export async function executeMobileChatComposerMarkdownScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-CHAT-COMPOSER-MARKDOWN-01 records the draft growing');
    let fixture: Awaited<ReturnType<typeof createMobileAcceptanceFixture>> | undefined;
    try {
        fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
        await fixture.pair();
        if (!fixture.agentChat || !fixture.allowedSessionId)
            throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        const recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        try {
            await pause(800);
            await insertMobileInputUnicode(
                serial,
                'agent-chat-composer-input',
                MARKDOWN_DRAFT,
                MARKDOWN_DRAFT,
            );
            await pause(1500);
        } finally {
            await recording.stop();
        }
        // The field's text is the draft as typed: the rendering styles it but never rewrites it.
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: MARKDOWN_DRAFT,
        });
        if (!draft.exists || draft.textMatches !== true)
            throw new Error('The composer no longer holds the Markdown draft exactly as typed');
        await capture(environment, 'composer-markdown-rendered', artifacts);
        await finish(environment, artifacts, { motion: 'live', status: 'passed' });
    } finally {
        await fixture?.stop();
    }
}
