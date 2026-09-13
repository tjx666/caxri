import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ThemeTokens } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
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
