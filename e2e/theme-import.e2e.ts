import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ThemeTokens } from '@caxri/protocol';
import { draculaTheme } from '@caxri/protocol';

import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

test('VS Code theme import updates editor syntax and reports missing syntax rules', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-import-e2e-'));
    const root = join(directory, 'project');
    const fullThemePath = join(directory, 'full-theme.json');
    const plainThemePath = join(directory, 'plain-theme.json');
    await mkdir(root);
    await writeFile(
        join(root, 'sample.ts'),
        '// note\nexport const value = "hello";\nexport const count = 42;\n',
    );
    await writeFile(
        fullThemePath,
        JSON.stringify({
            name: 'Full Theme',
            type: 'light',
            colors: {
                'editor.background': '#ffffff',
                'editor.foreground': '#101010',
                'terminal.selectionBackground': '#55667788',
            },
            tokenColors: [
                { scope: 'comment', settings: { foreground: '#112233' } },
                { scope: 'keyword', settings: { foreground: '#223344' } },
                { scope: 'string', settings: { foreground: '#334455' } },
                { scope: 'constant.numeric', settings: { foreground: '#445566' } },
            ],
            semanticTokenColors: { variable: '#abcdef' },
        }),
    );
    await writeFile(
        plainThemePath,
        JSON.stringify({
            name: 'Plain Theme',
            type: 'light',
            colors: { 'editor.background': '#ffffff' },
        }),
    );

    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: root,
    });
    try {
        await running.app.evaluate(
            ({ dialog }, themePaths) => {
                const paths = [...themePaths];
                dialog.showOpenDialog = () =>
                    Promise.resolve({ canceled: false, filePaths: [paths.shift()!] });
            },
            [fullThemePath, plainThemePath],
        );
        await createProjectSession(running.page);
        await running.page.getByRole('treeitem', { name: 'sample.ts', exact: true }).click();

        await running.page.keyboard.press('Meta+,');
        let settings = running.page.getByRole('dialog');
        await settings.getByRole('tab', { name: 'Theme', exact: true }).click();
        await settings.getByRole('button', { name: 'Import Theme' }).click();
        await expect(settings.getByText('Semantic token colors were not imported.')).toBeVisible();
        await expect
            .poll(
                async () =>
                    (await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get')).value,
            )
            .toMatchObject({
                editor: {
                    comment: '#112233',
                    keyword: '#223344',
                    string: '#334455',
                    number: '#445566',
                },
                terminal: { selectionBackground: '#55667788' },
            });
        await running.page.keyboard.press('Escape');
        await expect(settings).toHaveCount(0);

        const comment = running.page.locator('.view-line').filter({ hasText: '// note' });
        await expect(comment.locator('span span').first()).toHaveCSS('color', 'rgb(17, 34, 51)');
        const stringLine = running.page.locator('.view-line').filter({ hasText: '"hello"' });
        await expect(stringLine.locator('span span').filter({ hasText: '"hello"' })).toHaveCSS(
            'color',
            'rgb(51, 68, 85)',
        );
        const numberLine = running.page.locator('.view-line').filter({ hasText: '42' });
        await expect(numberLine.locator('span span').filter({ hasText: '42' })).toHaveCSS(
            'color',
            'rgb(68, 85, 102)',
        );
        await expect(stringLine.locator('span span').filter({ hasText: 'export' })).toHaveCSS(
            'color',
            'rgb(34, 51, 68)',
        );

        await running.page.keyboard.press('Meta+,');
        settings = running.page.getByRole('dialog');
        await settings.getByRole('tab', { name: 'Theme', exact: true }).click();
        await settings.getByRole('button', { name: 'Import Theme' }).click();
        await expect(settings.getByText('Syntax colors were not imported.')).toBeVisible();
        await expect
            .poll(
                async () =>
                    (await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get')).value,
            )
            .toMatchObject({ source: 'vscode', editor: { comment: '#6272a4' } });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test('theme import warnings can be dismissed and do not return after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-warning-e2e-'));
    const root = join(directory, 'project');
    const userData = join(directory, 'user-data');
    const themePath = join(directory, 'semantic-theme.json');
    await mkdir(root);
    await writeFile(
        themePath,
        JSON.stringify({
            name: 'Semantic Theme',
            type: 'dark',
            colors: { 'editor.background': '#1e1e1e' },
            semanticTokenColors: { comment: '#6a9955' },
        }),
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    let isFirstClosed = false;
    let restarted: Awaited<ReturnType<typeof launchCaxri>> | undefined;
    try {
        await running.app.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
        }, themePath);
        await createProjectSession(running.page);
        await running.page.keyboard.press('Meta+,');
        const settings = running.page.getByRole('dialog');
        await settings.getByRole('tab', { name: 'Theme', exact: true }).click();
        await settings.getByRole('button', { name: 'Import Theme' }).click();
        const warning = settings
            .getByRole('alert')
            .filter({ hasText: 'Semantic token colors were not imported.' });
        await expect(warning).toBeVisible();
        expect(
            (await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get')).value,
        ).not.toHaveProperty('warnings');
        const saved: unknown = JSON.parse(
            await readFile(join(userData, 'config', 'theme.json'), 'utf8'),
        );
        expect(saved).not.toHaveProperty('warnings');
        await warning.getByRole('button', { name: 'Dismiss warning' }).click();
        await expect(warning).toHaveCount(0);
        await settings.getByRole('tab', { name: 'Settings', exact: true }).click();
        await settings.getByRole('tab', { name: 'Theme', exact: true }).click();
        await expect(settings.getByText('Semantic token colors were not imported.')).toHaveCount(0);

        await running.app.close();
        isFirstClosed = true;
        restarted = await launchCaxri({ userDataDir: userData, testRootPath: root });
        await restarted.page.keyboard.press('Meta+,');
        const reopened = restarted.page.getByRole('dialog');
        await reopened.getByRole('tab', { name: 'Theme', exact: true }).click();
        await expect(reopened.getByText('Semantic token colors were not imported.')).toHaveCount(0);
        expect(
            (await pageRequest<{ value: ThemeTokens }>(restarted.page, 'theme.get')).value,
        ).not.toHaveProperty('warnings');
    } finally {
        await restarted?.app.close();
        if (!isFirstClosed) await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring for its fixture argument
test('theme import contrast failure names the color roles and measured ratio', async ({}, testInfo) => {
    allowE2EErrors([
        { source: 'renderer', event: 'toast', code: 'ERROR_TOAST', count: 1 },
        { source: 'server-core', event: 'ipc.request_failed', code: 'VALIDATION', count: 1 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-theme-contrast-e2e-'));
    const root = join(directory, 'project');
    const themePath = join(directory, 'low-contrast.json');
    await mkdir(root);
    const importedTheme = structuredClone(draculaTheme);
    importedTheme.colors.muted = importedTheme.colors.background;
    await writeFile(themePath, JSON.stringify(importedTheme));

    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: root,
    });
    try {
        await running.app.evaluate(({ dialog }, path) => {
            dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
        }, themePath);
        await createProjectSession(running.page);
        const before = await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get');
        await running.page.keyboard.press('Meta+,');
        const settings = running.page.getByRole('dialog');
        await settings.getByRole('tab', { name: 'Theme', exact: true }).click();
        await settings.getByRole('button', { name: 'Import Theme' }).click();

        const toast = running.page.locator('.toast', { hasText: 'Theme import failed.' });
        await expect(toast).toContainText(
            '--muted has 1.00:1 contrast against --background; at least 4.5:1 is required.',
        );
        await expect(toast).not.toContainText(directory);
        await toast.screenshot({ path: testInfo.outputPath('theme-contrast-failure.png') });
        await expect
            .poll(
                async () =>
                    (await pageRequest<{ value: ThemeTokens }>(running.page, 'theme.get')).value,
            )
            .toEqual(before.value);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
