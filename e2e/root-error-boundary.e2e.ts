import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createShellSession, launchCaxri, pageRequest } from './support/helpers.ts';

/**
 * Mirrors `ROOT_PROVIDER_FAULT_KEY` in the Renderer; the key makes the next root render throw where a provider sits.
 */
const PROVIDER_FAULT_KEY = 'caxri.test.root-provider-fault';

async function failProviderThenReload(
    page: Page,
    crash: { heading: string; reload: string },
    assertRendered: (page: Page) => Promise<void>,
): Promise<void> {
    // Arm only once the window has rendered: an entry that is still booting would consume the flag itself.
    await assertRendered(page);
    await page.evaluate((key) => sessionStorage.setItem(key, '1'), PROVIDER_FAULT_KEY);
    await page.reload();
    await expect(page.getByRole('heading', { name: crash.heading })).toBeVisible();
    await expect(page.locator('.renderer-crash-message')).toHaveText(
        'Error: Forced root provider render error',
    );
    await page.getByRole('button', { name: crash.reload }).click();
    await expect(page.getByRole('heading', { name: crash.heading })).toBeHidden();
    await assertRendered(page);
}

/**
 * Each Renderer entry wraps its I18n and Query providers in the crash boundary, so a provider that throws while
 * rendering still lands on the recovery screen and its Reload action brings the window back.
 */
test('Renderer entries recover from a provider render failure', async () => {
    // Per entry, React logs the caught render error and the boundary logs it again; Main mirrors both per window.
    allowE2EErrors([
        { source: 'renderer', event: 'console', code: 'CONSOLE_ERROR', count: 8 },
        { source: 'desktop', event: 'renderer.console_error', code: 'CONSOLE_ERROR', count: 2 },
        {
            source: 'desktop',
            event: 'benchmark_window.console_error',
            code: 'CONSOLE_ERROR',
            count: 2,
        },
        {
            source: 'desktop',
            event: 'caxri_bot.console_error',
            code: 'CONSOLE_ERROR',
            count: 2,
        },
        {
            source: 'desktop',
            event: 'process_explorer.console_error',
            code: 'CONSOLE_ERROR',
            count: 2,
        },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-root-boundary-e2e-'));
    const root = join(directory, 'project');
    await mkdir(root);
    const userDataDirectory = join(directory, 'user-data');
    const agentMode = await createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: { codex: {} },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userDataDirectory,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        await failProviderThenReload(
            running.page,
            { heading: 'Something went wrong', reload: 'Reload' },
            (page) => expect(page.locator('.workbench-session:not([hidden])')).toBeVisible(),
        );

        await pageRequest(running.page, 'benchmark.open');
        await expect.poll(() => running.app.windows().length).toBe(2);
        const benchmark = running.app.windows().find((page) => page !== running.page)!;
        await failProviderThenReload(
            benchmark,
            { heading: 'Benchmark stopped rendering', reload: 'Reload Benchmark' },
            (page) => expect(page.locator('[data-benchmark-window]')).toBeVisible(),
        );

        await pageRequest(running.page, 'caxriBot.open');
        await expect.poll(() => running.app.windows().length).toBe(3);
        const bot = running.app.windows().find((page) => page.url().includes('caxri-bot.html'))!;
        await failProviderThenReload(
            bot,
            { heading: 'Caxri Bot stopped rendering', reload: 'Reload Caxri Bot' },
            (page) =>
                expect(page.locator('.terminal-pane .xterm-rows')).toContainText(
                    'Fake codex ready',
                ),
        );

        const explorerAction = running.page.getByRole('button', {
            name: /^Open Process Explorer — Terminal memory: [\d.]+ MB$/,
        });
        await explorerAction.click();
        await expect.poll(() => running.app.windows().length).toBe(4);
        const explorer = running.app
            .windows()
            .find((page) => page.url().includes('process-explorer.html'))!;
        await failProviderThenReload(
            explorer,
            { heading: 'Process Explorer stopped rendering', reload: 'Reload Process Explorer' },
            (page) => expect(page.locator('[role=treegrid]')).toBeVisible(),
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(directory, { recursive: true, force: true });
    }
});
