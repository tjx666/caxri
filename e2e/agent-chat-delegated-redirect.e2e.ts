import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openAgentChat } from './support/agent-chat-fixture.ts';
import { selectSession } from './support/delegated-sessions-fixture.ts';
import {
    createParentSession,
    DELEGATE_PROMPT,
    HOLD_CHILD_FILE,
    launchDelegatingChat,
} from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { pageRequest, VISIBLE_SESSION } from './support/helpers.ts';

const REDIRECT_TEXT = 'Focus on the retry backoff only.';

interface RedirectReceipt {
    redirectCount?: number;
    status: string;
}

/**
 * A redirect steers the running child inside its current turn. The child's Chat shows it as an "Updated direction from"
 * the delegator, and a repeated operation is answered from its claim.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a redirect steers a running delegated child and reads as updated direction from the delegator', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-redirect-');
    try {
        const { page } = chat.running;
        const { projectId, sessionId: parentId } = await createParentSession(chat);
        await chat.writeScript(projectId);
        await writeFile(join(chat.controlDirectory, HOLD_CHILD_FILE), '');
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill(DELEGATE_PROMPT);
        await message.press('Enter');

        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        const row = strip.locator('[data-agent-chat-delegated-session]');
        await expect(row.locator('[data-agent-chat-delegation-glyph="running"]')).toBeVisible();
        const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;
        const { delegations } = await pageRequest<{
            delegations: Array<{ delegationId: string }>;
        }>(page, 'agent.delegation.list', { active: true, limit: 1 });
        const delegationId = delegations[0].delegationId;

        const result = await pageRequest<RedirectReceipt>(page, 'agent.delegation.redirect', {
            delegationId,
            operationId: 'e2e-redirect-one',
            text: REDIRECT_TEXT,
        });
        expect(result).toMatchObject({ status: 'running', redirectCount: 1 });

        await selectSession(page, childId);
        const redirect = session.locator('[data-agent-chat-delegated-task]', {
            hasText: 'Updated direction from',
        });
        await expect(redirect).toBeVisible();
        await expect(redirect).toContainText(REDIRECT_TEXT);
        await page.screenshot({ path: testInfo.outputPath('delegated-redirect-child.png') });

        // The same operation is answered from its claim; it never reaches the child twice.
        const replay = await pageRequest<RedirectReceipt>(page, 'agent.delegation.redirect', {
            delegationId,
            operationId: 'e2e-redirect-one',
            text: REDIRECT_TEXT,
        });
        expect(replay).toMatchObject({ redirectCount: 1 });
        await expect(redirect).toHaveCount(1);

        await selectSession(page, parentId);
        await rm(join(chat.controlDirectory, HOLD_CHILD_FILE));
        await expect(strip.locator('[data-agent-chat-delegated-session]')).toContainText(
            'The retry design is sound.',
        );
    } finally {
        await chat.cleanup();
    }
});
