import type { Page } from './fixtures.ts';
import { expect } from './fixtures.ts';
import { pageRequest } from './helpers.ts';

/**
 * Opens the Caxri Bot window from the Workbench and, when this profile has never started Caxri Bot, presses the first
 * start prompt's Start button with the preselected Agent, so a spec reaches the same running Caxri Bot it did before
 * the prompt existed. A Caxri Bot that already has its rows (running or stopped) reopens without a prompt.
 * `caxri-bot.e2e.ts` covers the prompt itself.
 */
export async function openCaxriBot(workbench: Page): Promise<void> {
    await pageRequest(workbench, 'caxriBot.open');
    let start: ReturnType<Page['getByRole']> | undefined;
    await expect
        .poll(async () => {
            const bot = workbench
                .context()
                .pages()
                .find((page) => page.url().includes('caxri-bot.html'));
            start = bot?.getByRole('button', { name: 'Start Caxri Bot', exact: true });
            if (start && (await start.isVisible())) return 'prompt';
            return (await pageRequest(workbench, 'bot.snapshot')) ? 'started' : 'pending';
        })
        .not.toBe('pending');
    if (start && (await start.isVisible())) await start.click();
}
