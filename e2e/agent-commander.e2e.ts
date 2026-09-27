import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommanderSnapshot, CommanderStatus } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('Agent Commander keeps running after its window closes and stops on request', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: {} },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    const commanderWindow = async () => {
        await expect.poll(() => running.app.windows().length).toBe(2);
        return running.app.windows().find((page) => page !== running.page)!;
    };
    try {
        await createShellSession(running.page);
        const chip = running.page.locator('.commander-status-chip');
        await expect(chip).toHaveCount(0);

        await pageRequest(running.page, 'agentCommander.open');
        const firstWindow = await commanderWindow();
        await expect(chip).toContainText('Commander');
        const { identity } = await pageRequest<CommanderSnapshot>(
            running.page,
            'commander.snapshot',
        );

        await firstWindow.close();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(chip).toContainText('Commander');
        await testInfo.attach('commander-running-in-background', {
            body: await chip.screenshot(),
            contentType: 'image/png',
        });

        await running.app.evaluate(({ Menu }) => {
            Menu.getApplicationMenu()?.getMenuItemById('command.agentCommander.stop')?.click();
        });
        await expect(chip).toHaveCount(0);
        await expect
            .poll(() => pageRequest<CommanderStatus>(running.page, 'commander.status'))
            .toEqual({ state: 'stopped' });

        await pageRequest(running.page, 'agentCommander.open');
        const reopenedWindow = await commanderWindow();
        await expect(chip).toContainText('Commander');
        const reopened = await pageRequest<CommanderSnapshot>(running.page, 'commander.snapshot');
        expect(reopened.identity).toEqual(identity);

        await reopenedWindow.getByRole('button', { name: 'Stop', exact: true }).click();
        await expect.poll(() => running.app.windows().length).toBe(1);
        await expect(chip).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
