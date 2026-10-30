import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    VISIBLE_SESSION,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat switches its permission level and plan mode, and a new Chat starts from the Project default until it is cleared', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-permissions-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const picker = chat
            .getByRole('button', { name: /^Permissions: / })
            .filter({ visible: true });
        // Codex launches with its default autonomy flag, which is the Full access level.
        await expect(picker).toHaveAccessibleName('Permissions: Full access');
        // The resting Full access trigger, which keeps the muted composer tone instead of a warning tint.
        await page.screenshot({ path: testInfo.outputPath('codex-chat-full-access.png') });

        await picker.click();
        const menu = page.getByRole('menu');
        // Codex offers its own presets only: no "Ask for approval" level.
        await expect(menu.getByRole('menuitemradio')).toHaveText([
            /Read only/,
            /Default/,
            /Auto/,
            /Full access/,
        ]);
        await menu.getByRole('menuitemradio', { name: /Read only/ }).click();
        // Picking a level closes the menu.
        await expect(menu).toBeHidden();
        await expect(picker).toHaveAccessibleName('Permissions: Read only');
        // The keyboard reaches both from the composer: `Cmd+.` opens the menu and Escape returns to the input, and
        // `Cmd+Option+P` flips plan mode with the Plan chip as its only feedback.
        const message = chat.getByRole('textbox', { name: 'Message' }).filter({ visible: true });
        await message.focus();
        await page.keyboard.press('Meta+.');
        await expect(menu.getByRole('menuitemradio', { name: /Read only/ })).toBeChecked();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(message).toBeFocused();
        const shortcutPlanChip = chat
            .getByRole('button', { name: 'Plan mode', exact: true, pressed: true })
            .filter({ visible: true });
        await page.keyboard.press('Meta+Alt+p');
        await expect(shortcutPlanChip).toBeVisible();
        await expect(message).toBeFocused();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-plan-shortcut.png') });
        await page.keyboard.press('Meta+Alt+p');
        await expect(shortcutPlanChip).toBeHidden();
        // Plan mode lives in `+`, and a Plan chip beside it says it is on.
        await chat
            .getByRole('button', { name: 'Add files and more' })
            .filter({ visible: true })
            .click();
        await menu.getByRole('menuitemcheckbox', { name: /Plan mode/ }).click();
        const planChip = chat
            .getByRole('button', { name: 'Plan mode', exact: true, pressed: true })
            .filter({ visible: true });
        await expect(planChip).toBeVisible();
        await picker.click();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-permission-menu.png') });
        const projectDefault = menu.getByRole('menuitemcheckbox', {
            name: 'Use as Project default',
        });
        await expect(projectDefault).not.toBeChecked();
        await projectDefault.click();
        // Once saved, the row reads as the checked Project default.
        await expect(
            menu.getByRole('menuitemcheckbox', { name: 'Project default', exact: true }),
        ).toBeChecked();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();

        // Sending works with plan mode on; the fake Codex app-server answers as usual.
        await message.fill('hello');
        await message.press('Enter');
        await expect(chat.getByText(/hello/u).filter({ visible: true }).first()).toBeVisible();

        await openAgentChat(page, 'Codex Chat');
        await expect(
            chat.getByRole('button', { name: /^Permissions: / }).filter({ visible: true }),
        ).toHaveAccessibleName('Permissions: Read only');
        await expect(
            chat
                .getByRole('button', { name: 'Plan mode', exact: true, pressed: true })
                .filter({ visible: true }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-project-default.png') });

        // Clearing the default leaves this Chat's own choice alone; the next new Chat follows the launch settings.
        // This Chat matches the saved default, so the checked "Project default" row clears it and no separate
        // "Clear Project default" row repeats it.
        const defaultedPicker = chat
            .getByRole('button', { name: /^Permissions: / })
            .filter({ visible: true });
        await defaultedPicker.click();
        const savedDefault = menu.getByRole('menuitemcheckbox', {
            name: 'Project default',
            exact: true,
        });
        await expect(savedDefault).toBeChecked();
        await expect(menu.getByRole('menuitem', { name: /Clear Project default/ })).toHaveCount(0);
        // Let the menu finish opening so the evidence shows it opaque, not mid-fade over the composer.
        await menu.evaluate(async (element) => {
            await Promise.allSettled(
                element.getAnimations({ subtree: true }).map((animation) => animation.finished),
            );
        });
        await page.screenshot({ path: testInfo.outputPath('codex-chat-clear-default-menu.png') });
        await savedDefault.click();
        await expect(
            menu.getByRole('menuitemcheckbox', { name: 'Use as Project default' }),
        ).not.toBeChecked();
        await expect(defaultedPicker).toHaveAccessibleName('Permissions: Read only');
        await page.screenshot({ path: testInfo.outputPath('codex-chat-default-cleared.png') });
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();

        await openAgentChat(page, 'Codex Chat');
        await expect(
            chat.getByRole('button', { name: /^Permissions: / }).filter({ visible: true }),
        ).toHaveAccessibleName('Permissions: Full access');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex Chat offers to build a proposed plan: Keep Planning keeps plan mode, Start Building leaves it and sends the build turn', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-plan-approval-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' }).filter({ visible: true });
        const planChip = chat
            .getByRole('button', { name: 'Plan mode', exact: true, pressed: true })
            .filter({ visible: true });
        await message.focus();
        await page.keyboard.press('Meta+Alt+p');
        await expect(planChip).toBeVisible();

        // `proposeplan` makes the fake Codex end its plan-mode turn with a `plan` item.
        await message.fill('proposeplan refactor the parser');
        await message.press('Enter');
        const card = chat.getByRole('region', { name: 'Start with this plan?' });
        await expect(card).toBeVisible();
        await expect(chat.getByText('Split the tokenizer from the grammar rules.')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-plan-approval.png') });

        // Keep Planning only dismisses the card; plan mode stays on.
        await card.getByRole('button', { name: 'Keep Planning' }).click();
        await expect(card).toBeHidden();
        await expect(planChip).toBeVisible();

        // A fresh plan gets its own card; Start Building leaves plan mode and sends the build turn.
        await message.fill('proposeplan again');
        await message.press('Enter');
        await expect(card).toBeVisible();
        await card.getByRole('button', { name: 'Start Building' }).click();
        await expect(card).toBeHidden();
        await expect(planChip).toBeHidden();
        await expect(chat.getByText('Implement the plan.').first()).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('codex-chat-plan-started.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a Codex proposed plan waits in the popup and status bar count of another Session until it is approved', async ({}, testInfo) => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-agent-chat-plan-waiting-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' }).filter({ visible: true });
        await message.focus();
        await page.keyboard.press('Meta+Alt+p');
        await message.fill('proposeplan refactor the parser');
        await message.press('Enter');
        await expect(chat.getByRole('region', { name: 'Start with this plan?' })).toBeVisible();

        // Another Session leaves the plan off screen, so the popup carries its approval.
        await createAdditionalShellSession(page);
        const popup = page.locator('[data-agent-chat-waiting="card"]');
        await expect(popup).toContainText('Start with this plan?');
        await page.screenshot({ path: testInfo.outputPath('plan-waiting-popup.png') });

        await popup.getByRole('button', { name: 'Start Building' }).click();
        await expect(popup).toHaveCount(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
