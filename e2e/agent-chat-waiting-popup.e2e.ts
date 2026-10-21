import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeClaudeChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';

async function selectedSessionId(page: Parameters<typeof pageRequest>[0]) {
    const bootstrap = await pageRequest<{ selectedSessionId?: string }>(page, 'app.bootstrap');
    if (!bootstrap.selectedSessionId) throw new Error('No Session selected');
    return bootstrap.selectedSessionId;
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Chats that are not on screen ask through the waiting popup, one request at a time', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-waiting-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        const popup = page.locator('[data-agent-chat-waiting="card"]');

        // A Chat on screen answers its own question in place: the popup stays out of the way.
        const askingId = await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Claude Chat');
        const asking = page.locator(VISIBLE_SESSION);
        await asking.getByRole('textbox', { name: 'Message' }).fill('ask multi');
        await asking.getByRole('textbox', { name: 'Message' }).press('Enter');
        await expect(
            asking.getByRole('group', { name: 'Which checks should run before the pull request?' }),
        ).toBeVisible();
        await expect(popup).toHaveCount(0);

        // Moving on to another Session leaves that question behind, so the popup brings it along.
        await createAdditionalShellSession(page);
        await openAgentChat(page, 'Claude Chat');
        const approvingId = await selectedSessionId(page);
        const approving = page.locator(VISIBLE_SESSION);
        await approving.getByRole('textbox', { name: 'Message' }).fill('please approve this');
        await approving.getByRole('textbox', { name: 'Message' }).press('Enter');
        await expect(approving.getByRole('region', { name: 'Run this command?' })).toBeVisible();
        await expect(popup).toContainText('Which checks should run before the pull request?');
        await expect(popup).toContainText('Waiting for your answer');
        await expect(popup).toContainText('ask multi');

        // Two Chats wait off screen: the earlier one asks first, and the other is counted.
        await createAdditionalShellSession(page);
        await expect(popup).toContainText('Which checks should run before the pull request?');
        await expect(popup).toContainText('1 more pending');
        await page.screenshot({ path: testInfo.outputPath('waiting-popup-question.png') });

        // The popup never takes focus from what the user was doing.
        await expect(popup.locator(':focus')).toHaveCount(0);

        // A click only ticks an option; nothing is sent until Submit.
        const checks = popup.getByRole('group', {
            name: 'Which checks should run before the pull request?',
        });
        await checks.getByRole('checkbox', { name: /^Lint/u }).click();
        await checks.getByRole('checkbox', { name: /^Type check/u }).click();
        await expect(checks.getByRole('checkbox', { name: /^Lint/u })).toBeChecked();
        await expect(checks.getByRole('checkbox', { name: /^Type check/u })).toBeChecked();
        await expect(checks.getByRole('checkbox', { name: /^Unit tests/u })).not.toBeChecked();
        await page.screenshot({ path: testInfo.outputPath('waiting-popup-multi-select.png') });
        await popup.getByRole('button', { name: 'Submit' }).click();

        // The next waiting Chat takes its place.
        await expect(popup).toContainText('Waiting for your approval');
        await expect(popup).toContainText('echo approved');
        await expect(popup).not.toContainText('more pending');
        await page.screenshot({ path: testInfo.outputPath('waiting-popup-approval.png') });

        // Minimizing folds the popup into a pill that reopens it.
        await popup.getByRole('button', { name: 'Minimize' }).click();
        const pill = page.getByRole('button', { name: 'Show 1 pending' });
        await expect(pill).toBeVisible();
        await expect(popup).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('waiting-popup-pill.png') });
        await pill.click();
        await expect(popup).toContainText('echo approved');

        await popup.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(popup).toHaveCount(0);
        await expect(pill).toHaveCount(0);

        // Each answer reached its own Chat, never the one on screen.
        await sessionCard(page, askingId).click();
        await expect(page.locator(VISIBLE_SESSION)).toContainText(/Running Lint, Type check\./u);
        await sessionCard(page, approvingId).click();
        await expect(page.locator(VISIBLE_SESSION).getByText('The command ran.')).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
