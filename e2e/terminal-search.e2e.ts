import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createShellSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
    typeTerminal,
    VISIBLE_SESSION,
} from './support/helpers.ts';

test('Terminal search highlights and navigates matches without intercepting Editor Find', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-search-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);
    await writeFile(
        join(root, 'search-fixture.zsh'),
        "printf 'needle NEEDLE needled\\nneedle\\n'\n",
        'utf8',
    );
    await writeFile(join(root, 'searchable.ts'), 'const needle = true;\n', 'utf8');

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const firstSessionId = await selectedSessionId(running.page);
        await typeTerminal(running.page, 'zsh search-fixture.zsh');
        const terminalRows = running.page.locator(`${VISIBLE_SESSION} .xterm-rows`);
        const terminalInput = running.page.locator(`${VISIBLE_SESSION} .xterm-helper-textarea`);
        await expect(terminalRows).toContainText('needle NEEDLE needled');
        await running.clipboard.writeText('CLIPBOARD_SENTINEL');

        await terminalInput.press('Meta+f');
        const search = running.page.getByRole('search', { name: 'Terminal buffer search' });
        const searchInput = search.getByRole('textbox', { name: 'Find in Terminal' });
        await expect(search).toBeVisible();
        await expect(searchInput).toBeFocused();
        await searchInput.fill('needle');
        await expect(search).toContainText('1/4');

        const decorations = running.page.locator(
            '.workbench-pane.active .xterm-decoration-container .xterm-decoration:not(.terminal-command-decoration)',
        );
        /**
         * SearchAddon renders one decoration per match plus a top-layer active-match overlay; shell-integration status
         * decorations share xterm's container and are excluded here.
         */
        await expect(decorations).toHaveCount(5);
        const decorationEvidence = await decorations.evaluateAll((elements) =>
            elements.map((element) => ({
                color: getComputedStyle(element).outlineColor,
                height: element.getBoundingClientRect().height,
                width: element.getBoundingClientRect().width,
            })),
        );
        expect(decorationEvidence.every(({ height, width }) => height > 0 && width > 0)).toBe(true);
        expect(new Set(decorationEvidence.map(({ color }) => color)).size).toBeGreaterThan(1);
        expect(await running.clipboard.textEquals('CLIPBOARD_SENTINEL')).toBe(true);

        await searchInput.press('Enter');
        await expect(search).toContainText('2/4');
        await searchInput.press('Shift+Enter');
        await expect(search).toContainText('1/4');

        const matchCase = search.getByRole('button', { name: 'Match Case' });
        const wholeWord = search.getByRole('button', { name: 'Match Whole Word' });
        const regex = search.getByRole('button', { name: 'Use Regular Expression' });
        await matchCase.click();
        await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
        await expect(search).toContainText('1/3');
        await wholeWord.click();
        await expect(wholeWord).toHaveAttribute('aria-pressed', 'true');
        await expect(search).toContainText('1/2');

        /**
         * The VS Code Match Case/Whole Word/Regex chords fire from anywhere inside the search bar, not only while the
         * query input is focused, so this toggles both off from the input.
         */
        await searchInput.press('Alt+C');
        await expect(matchCase).toHaveAttribute('aria-pressed', 'false');
        await searchInput.press('Alt+W');
        await expect(wholeWord).toHaveAttribute('aria-pressed', 'false');
        await expect(search).toContainText('1/4');
        await searchInput.fill('n.e+dle');
        await expect(search).toContainText('No results');
        await searchInput.press('Alt+R');
        await expect(regex).toHaveAttribute('aria-pressed', 'true');
        await expect(search).toContainText('1/4');
        await searchInput.fill('(');
        await expect(search).toContainText('Invalid regular expression');

        await createAdditionalShellSession(running.page);
        await expect(search).toHaveCount(0);
        const firstSession = sessionCard(running.page, firstSessionId);
        await firstSession.click();
        await expect(firstSession).toHaveClass(/active/);
        /**
         * Session keep-alive holds the pane across a switch, so coming back finds the search bar exactly as it was left
         * (open, still in regex mode, still complaining about the same query) rather than reset by a remount the user
         * never asked for. Matching VS Code, where the Terminal find widget belongs to the Terminal.
         */
        await expect(search).toBeVisible();
        await expect(searchInput).toHaveValue('(');
        await expect(search).toContainText('Invalid regular expression');

        await terminalInput.press('Meta+f');
        await expect(searchInput).toBeFocused();
        await searchInput.fill('needle');
        await searchInput.press('Escape');
        await expect(search).toHaveCount(0);
        await expect(terminalInput).toBeFocused();
        expect(await running.clipboard.textEquals('CLIPBOARD_SENTINEL')).toBe(true);

        await running.page.getByRole('treeitem', { name: 'searchable.ts', exact: true }).click();
        const editor = running.page.locator(`${VISIBLE_SESSION} .monaco-editor`).first();
        await expect(editor).toBeVisible();
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+f');
        await expect(editor.locator('.find-widget')).toBeVisible();
        await expect(running.page.locator(`${VISIBLE_SESSION} .terminal-search`)).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
