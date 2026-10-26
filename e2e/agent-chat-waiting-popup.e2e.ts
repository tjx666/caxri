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
        await expect(popup).toContainText('Claude has a question');
        await expect(popup).toContainText('ask multi');

        // A second approval, answered later by the focus command and Deny Request.
        await createAdditionalShellSession(page);
        await openAgentChat(page, 'Claude Chat');
        const denyingId = await selectedSessionId(page);
        const denying = page.locator(VISIBLE_SESSION);
        await denying.getByRole('textbox', { name: 'Message' }).fill('please approve this');
        await denying.getByRole('textbox', { name: 'Message' }).press('Enter');
        await expect(denying.getByRole('region', { name: 'Run this command?' })).toBeVisible();

        // Three Chats wait off screen: the earliest asks first, and the others are counted.
        await createAdditionalShellSession(page);
        await expect(popup).toContainText('Which checks should run before the pull request?');
        await expect(popup).toContainText('2 more pending');
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
        // Enter typed into a Terminal stays the Terminal's; with nothing focused, it sends the question.
        const terminalInput = page.locator(VISIBLE_SESSION).locator('.xterm-helper-textarea');
        await terminalInput.focus();
        await page.keyboard.press('Enter');
        await expect(popup).toContainText('Which checks should run before the pull request?');
        await terminalInput.blur();
        await page.keyboard.press('Enter');

        // The next waiting Chat takes its place.
        await expect(popup).toContainText('Run this command?');
        await expect(popup).toContainText('echo approved');
        await expect(popup).toContainText('1 more pending');
        const run = popup.getByRole('button', { name: 'Run', exact: true });
        await expect(run).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter');
        await expect(run).not.toHaveAttribute('aria-disabled', 'true');
        await page.screenshot({ path: testInfo.outputPath('waiting-popup-approval.png') });

        // A Terminal keeps Cmd+Enter; from a spot that does nothing with the key, Allow Request answers the popup.
        // Pressed twice in a row, the second press lands on the card that just dropped in and is ignored.
        await terminalInput.focus();
        await page.keyboard.press('Meta+Enter');
        await expect(popup).toContainText('1 more pending');
        await terminalInput.blur();
        await page.keyboard.press('Meta+Enter');
        await page.keyboard.press('Meta+Enter');
        await expect(popup).not.toContainText('more pending');
        // An answer given from outside the popup does not pull focus into the next card.
        await expect(popup.locator(':focus')).toHaveCount(0);
        await expect(run).not.toHaveAttribute('aria-disabled', 'true');
        await expect(popup).toContainText('Run this command?');

        // Minimizing folds the popup into a status bar item, off the Terminal, that reopens it.
        await popup.getByRole('button', { name: 'Minimize' }).click();
        const waitingItem = page.locator('footer.statusbar').getByRole('button', {
            name: 'Show 1 waiting for you',
        });
        await expect(waitingItem).toBeVisible();
        await expect(popup).toHaveCount(0);
        const terminalBox = await page
            .locator(VISIBLE_SESSION)
            .locator('.xterm-screen')
            .boundingBox();
        const itemBox = await waitingItem.boundingBox();
        expect(terminalBox && itemBox && itemBox.y >= terminalBox.y + terminalBox.height).toBe(
            true,
        );
        await page.screenshot({ path: testInfo.outputPath('waiting-popup-status-item.png') });
        await waitingItem.click();
        await expect(popup).toContainText('echo approved');
        await popup.getByRole('button', { name: 'Minimize' }).click();
        await expect(popup).toHaveCount(0);

        // Focus Waiting Request unfolds the popup and moves focus in; answering the last request returns it.
        await terminalInput.focus();
        await page.keyboard.press('Meta+Alt+w');
        await expect(run).toBeFocused();
        // The card that just unfolded ignores keys until it arms, like one that just dropped in.
        await expect(run).not.toHaveAttribute('aria-disabled', 'true');
        await page.keyboard.press('Meta+Backspace');
        await expect(popup).toHaveCount(0);
        await expect(waitingItem).toHaveCount(0);
        await expect(terminalInput).toBeFocused();

        // Each answer reached its own Chat, never the one on screen.
        await sessionCard(page, askingId).click();
        await expect(page.locator(VISIBLE_SESSION)).toContainText(/Running Lint, Type check\./u);
        await sessionCard(page, approvingId).click();
        await expect(page.locator(VISIBLE_SESSION).getByText('The command ran.')).toBeVisible();
        await sessionCard(page, denyingId).click();
        await expect(page.locator(VISIBLE_SESSION).getByText('Skipped the command.')).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
