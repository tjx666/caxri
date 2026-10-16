import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppSettings } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
} from './support/helpers.ts';

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('English command prefixes outrank weak Session matches in either interface language', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-palette-search-'));
    const root = join(directory, 'Example Components');
    await mkdir(root);
    const running = await launchCaxri({
        testRootPath: root,
        userDataDir: join(directory, 'profile'),
    });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        await pageRequest(page, 'session.rename', {
            sessionId: await selectedSessionId(page),
            displayTitle: 'Compile an app with retries',
        });
        const check = async (language: 'en' | 'zh-CN', title: string): Promise<void> => {
            const settings = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
            await pageRequest(page, 'settings.update', {
                source: JSON.stringify({ ...settings.value, 'workbench.language': language }),
            });
            await page.keyboard.press('Meta+Shift+P');
            const palette = page.getByRole('dialog');
            const checkQuery = async (query: string): Promise<void> => {
                await palette.getByRole('combobox').fill(query);
                await expect(palette.getByRole('option').first()).toContainText(title);
                await expect(palette.getByRole('option').first()).toHaveAttribute(
                    'aria-selected',
                    'true',
                );
            };
            await checkQuery('compa');
            await checkQuery('compac');
            await checkQuery('compa');
            await page.screenshot({ path: testInfo.outputPath(`palette-${language}.png`) });
            await palette.getByRole('combobox').fill('qqzzxvqqzzxv');
            await expect(palette.getByRole('option')).toHaveCount(0);
            await expect(palette.locator('[cmdk-empty]')).toBeVisible();
            await palette.getByRole('combobox').fill('');
            await expect(palette.getByRole('option').first()).toContainText('Example Components');
            await expect(palette.locator('[cmdk-group-heading]')).toHaveCount(3);
            await page.keyboard.press('Escape');
            await expect(palette).toHaveCount(0);
        };
        await check('en', 'Compact Recently Idle Sessions');
        await check('zh-CN', '压缩最近空闲的会话');
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
