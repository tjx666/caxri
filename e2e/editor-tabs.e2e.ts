import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pressNewTerminal } from './support/helpers.ts';
import { chooseContextMenuItem, isContextMenuItemEnabled } from './support/native-context-menu.ts';

interface EditorPresenceEvent {
    ariaHidden?: string;
    identity?: string;
    kind: 'added' | 'exiting' | 'removed';
    maxWidth: string;
    opacity: string;
}

async function startEditorPresenceProbe(page: Page): Promise<void> {
    await page.evaluate(() => {
        const events: EditorPresenceEvent[] = [];
        const observer = new MutationObserver((records) => {
            for (const record of records) {
                if (
                    record.type === 'attributes' &&
                    record.target instanceof HTMLElement &&
                    record.target.matches('.work-tab:not([data-terminal-id])') &&
                    record.target.getAttribute('aria-hidden') === 'true'
                ) {
                    events.push({
                        ariaHidden: 'true',
                        identity: record.target.dataset.motionIdentity,
                        kind: 'exiting',
                        maxWidth: record.target.style.maxWidth,
                        opacity: record.target.style.opacity,
                    });
                    continue;
                }
                for (const [kind, nodes] of [
                    ['added', record.addedNodes],
                    ['removed', record.removedNodes],
                ] as const) {
                    for (const node of nodes) {
                        if (
                            node instanceof HTMLElement &&
                            node.matches('.work-tab:not([data-terminal-id])')
                        ) {
                            events.push({
                                identity: node.dataset.motionIdentity,
                                kind,
                                maxWidth: node.style.maxWidth,
                                opacity: node.style.opacity,
                            });
                        }
                    }
                }
            }
        });
        const strip = document.querySelector('.work-tabs');
        if (!strip) throw new Error('Work tab strip is unavailable');
        observer.observe(strip, {
            attributeFilter: ['aria-hidden'],
            attributes: true,
            childList: true,
            subtree: true,
        });
        Object.defineProperty(globalThis, 'editorPresenceProbe', {
            configurable: true,
            value: { events, observer },
        });
    });
}

async function stopEditorPresenceProbe(page: Page): Promise<EditorPresenceEvent[]> {
    return page.evaluate(() => {
        const probe = (
            globalThis as unknown as {
                editorPresenceProbe?: {
                    events: EditorPresenceEvent[];
                    observer: MutationObserver;
                };
            }
        ).editorPresenceProbe;
        if (!probe) throw new Error('Editor presence probe was not started');
        probe.observer.disconnect();
        return probe.events;
    });
}

async function tabMotionSettleMs(page: Page): Promise<number> {
    return page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const durationMs = (token: string): number => {
            const raw = style.getPropertyValue(token).trim();
            // `raw` is a CSS <time> value like "300ms" or "0.3s": the unit suffix means
            // `Number()` would return NaN, so `Number.parseFloat` is required here.
            // eslint-disable-next-line unicorn/prefer-number-coercion
            return raw.endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1_000;
        };
        return Math.max(durationMs('--motion-tab-enter'), durationMs('--motion-tab-exit'));
    });
}

async function expectTabControlsWorkSurface(page: Page, tab: Locator): Promise<void> {
    const tabId = await tab.getAttribute('id');
    const panelId = await tab.getAttribute('aria-controls');
    expect(tabId).toBeTruthy();
    expect(panelId).toBeTruthy();
    const panel = page.locator(`[id="${panelId}"]`);
    await expect(panel).toHaveAttribute('role', 'tabpanel');
    await expect(panel).toHaveAttribute('aria-labelledby', tabId!);
}

test('editor previews pin and expose the standard close actions', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-tabs-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await Promise.all(
        ['a.js', 'b.js', 'c.js', 'd.js'].map((name) =>
            writeFile(join(root, name), `export const ${name[0]} = true;\n`, 'utf8'),
        ),
    );
    await writeFile(join(root, '.env'), '# Caxri\nCAXRI_TOKEN="enabled"\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        // Typing into c.js below leaves it dirty when "Close All" closes it later in this test;
        // closing a dirty tab now shows the native Save/Don't Save/Cancel sheet
        // (`editor.confirmDiscard`, see `document-commands.ts`), so `dialog.showMessageBox` must be
        // stubbed before that happens or the close would hang waiting for real user input.
        // `response: 1` is "Don't Save". The call count is tracked so the "Close All" assertion
        // below can prove the dirty tab actually went through confirmation instead of silently
        // closing the way it used to before `tab.dirty` was inspected.
        await running.app.evaluate(({ dialog }) => {
            Reflect.set(globalThis, '__caxriConfirmDiscardCalls', 0);
            dialog.showMessageBox = () => {
                const calls = Number(Reflect.get(globalThis, '__caxriConfirmDiscardCalls') ?? 0);
                Reflect.set(globalThis, '__caxriConfirmDiscardCalls', calls + 1);
                return Promise.resolve({ response: 1, checkboxChecked: false });
            };
        });
        await createProjectSession(running.page);
        const editorTabs = running.page.locator('.work-tab[data-preview]');
        await running.page.getByRole('treeitem', { name: 'a.js', exact: true }).click();
        await expect(editorTabs).toHaveCount(1);
        await expect(editorTabs).toContainText('a.js');
        const aTab = running.page.locator('.work-tab', { hasText: 'a.js' });
        const previewIdentity = await aTab.getAttribute('data-motion-identity');
        expect(previewIdentity).toBeTruthy();
        await aTab.evaluate((element) => {
            element.dataset.previewSlotProbe = 'stable';
        });

        await startEditorPresenceProbe(running.page);
        await running.page.getByRole('treeitem', { name: 'b.js', exact: true }).click();
        await expect(running.page.locator('.work-tab', { hasText: 'a.js' })).toHaveCount(0);
        const bTab = running.page.locator('.work-tab', { hasText: 'b.js' });
        await running.page.waitForTimeout((await tabMotionSettleMs(running.page)) + 50);
        expect(await stopEditorPresenceProbe(running.page)).toEqual([]);
        await expect(bTab).toHaveAttribute('data-motion-identity', previewIdentity!);
        await expect(bTab).toHaveAttribute('data-preview-slot-probe', 'stable');
        await expect(bTab.locator('[data-file-icon="file_type_js"]')).toBeVisible();
        await expect(bTab).toHaveAttribute('data-preview', 'true');
        await bTab.getByRole('tab').dblclick();
        await expect(bTab).not.toHaveAttribute('data-preview');

        /**
         * Reproduces the custom tokenizer race seen on loaded GitHub-hosted runners.
         */
        const cdp = await running.page.context().newCDPSession(running.page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
        await startEditorPresenceProbe(running.page);
        await running.page.getByRole('treeitem', { name: '.env', exact: true }).click();
        const environmentTab = running.page.locator('.work-tab', { hasText: '.env' });
        await expect(environmentTab).toBeVisible();
        const addedPreviewEvents = await stopEditorPresenceProbe(running.page);
        expect(addedPreviewEvents).toHaveLength(1);
        expect(addedPreviewEvents[0]).toMatchObject({
            kind: 'added',
            maxWidth: '0px',
            opacity: '0',
        });
        expect(addedPreviewEvents[0]?.identity).not.toBe(previewIdentity);
        await environmentTab.evaluate((element) => {
            element.dataset.previewSlotProbe = 'next';
        });
        const environmentLine = running.page
            .locator('.view-line')
            .filter({ hasText: 'CAXRI_TOKEN' });
        await expect
            .poll(() =>
                environmentLine.locator('span span').evaluateAll((tokens) => {
                    const colors = new Set(tokens.map((token) => getComputedStyle(token).color));
                    return tokens.length > 1 && colors.size > 1;
                }),
            )
            .toBe(true);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        await cdp.detach();

        const nextPreviewIdentity = await environmentTab.getAttribute('data-motion-identity');
        await startEditorPresenceProbe(running.page);
        await running.page.getByRole('treeitem', { name: 'c.js', exact: true }).click();
        const cTab = running.page.locator('.work-tab', { hasText: 'c.js' });
        await running.page.waitForTimeout((await tabMotionSettleMs(running.page)) + 50);
        expect(await stopEditorPresenceProbe(running.page)).toEqual([]);
        await expect(cTab).toHaveAttribute('data-motion-identity', nextPreviewIdentity!);
        await expect(cTab).toHaveAttribute('data-preview-slot-probe', 'next');
        await expect(cTab).toHaveAttribute('data-preview', 'true');
        await running.page.locator('.monaco-editor').click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.type(' ');
        await expect(cTab).not.toHaveAttribute('data-preview');

        await startEditorPresenceProbe(running.page);
        await running.page.getByRole('treeitem', { name: 'd.js', exact: true }).click();
        const dTab = running.page.locator('.work-tab', { hasText: 'd.js' });
        await expect(dTab).toHaveAttribute('data-preview', 'true');
        const addedAfterDirtyEvents = await stopEditorPresenceProbe(running.page);
        expect(addedAfterDirtyEvents).toHaveLength(1);
        expect(addedAfterDirtyEvents[0]).toMatchObject({
            kind: 'added',
            maxWidth: '0px',
            opacity: '0',
        });
        await dTab.getByRole('tab').dblclick();
        await expect(dTab).not.toHaveAttribute('data-preview');

        // The quiet scrollbar belongs to the inner rail that actually overflows, not to the outer strip
        // row that also holds New Terminal and the window drag gap.
        expect(
            await running.page
                .locator('.work-tab-scroll')
                .evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').height),
        ).toBe('3px');

        await cTab.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Close to the Right');
        await expect(dTab).toHaveCount(0);
        await expect(bTab).toBeVisible();
        await expect(cTab).toBeVisible();

        await running.page.getByRole('treeitem', { name: 'a.js', exact: true }).dblclick();
        await cTab.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Close Others');
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(1);
        await expect(cTab).toBeVisible();

        await expect(cTab).toContainText('●');
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
        await cTab.click({ button: 'right' });
        expect(await isContextMenuItemEnabled(running.app, 'Close Others')).toBe(false);
        await chooseContextMenuItem(running.app, 'Close All');
        // Editor bulk closes preserve the default Terminal even when it shares the same pane.
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(0);
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
        await running.page.screenshot({
            path: test.info().outputPath('editor-close-all-preserves-terminal.png'),
            mask: [running.page.locator('.terminal-surface')],
        });
        // c.js was still dirty (typed a space above, never saved): "Close All" must route it
        // through the native discard confirmation rather than silently dropping unsaved work, so
        // the stubbed `dialog.showMessageBox` must have actually been invoked once.
        expect(
            await running.app.evaluate(() =>
                Number(Reflect.get(globalThis, '__caxriConfirmDiscardCalls') ?? 0),
            ),
        ).toBe(1);

        await running.page.getByRole('treeitem', { name: 'a.js', exact: true }).dblclick();
        await running.page.locator('.monaco-editor').click({ position: { x: 120, y: 24 } });
        await startEditorPresenceProbe(running.page);
        await running.page.keyboard.press('Meta+W');
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(0);
        const closeEvents = await stopEditorPresenceProbe(running.page);
        expect(closeEvents.map((event) => event.kind)).toEqual(['exiting', 'removed']);
        expect(closeEvents[0]).toMatchObject({ ariaHidden: 'true', kind: 'exiting' });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Open Work tabs provide roving keyboard navigation and dirty editor state', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-work-tabs-a11y-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);
    await writeFile(join(root, 'accessible.ts'), 'export const accessible = true;\n', 'utf8');

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page);
        const strip = running.page.getByRole('tablist', { name: 'Open tabs in pane 1' });
        const tabs = strip.getByRole('tab');
        await pressNewTerminal(running.page);
        await expect(tabs).toHaveCount(2);
        await running.page.getByRole('treeitem', { name: 'accessible.ts', exact: true }).click();
        await expect(tabs).toHaveCount(3);

        const firstTerminal = tabs.nth(0);
        const secondTerminal = tabs.nth(1);
        const editor = tabs.nth(2);
        await running.page.locator('.monaco-editor').click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.insertText(' ');

        await expect
            .poll(() => tabs.evaluateAll((elements) => elements.map((tab) => tab.tabIndex)))
            .toEqual([-1, -1, 0]);
        const editorDescriptionId = await editor.getAttribute('aria-describedby');
        expect(editorDescriptionId).toBeTruthy();
        await expect(running.page.locator(`[id="${editorDescriptionId}"]`)).toHaveText(
            'Unsaved changes.',
        );
        await expectTabControlsWorkSurface(running.page, editor);

        await editor.focus();
        await running.page.keyboard.press('ArrowLeft');
        await expect(secondTerminal).toBeFocused();
        await expect(secondTerminal).toHaveAttribute('aria-selected', 'true');
        const secondTerminalId = await secondTerminal
            .locator('xpath=..')
            .getAttribute('data-terminal-id');
        expect(secondTerminalId).toBeTruthy();
        await expect(
            running.page.locator(
                `.terminal-pane[data-terminal-id="${secondTerminalId}"] .terminal-surface[data-terminal-attached="true"]`,
            ),
        ).toBeVisible();
        await running.page.evaluate(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                ),
        );
        await expect(secondTerminal).toBeFocused();
        await expectTabControlsWorkSurface(running.page, secondTerminal);

        await secondTerminal.press('Home');
        await expect(firstTerminal).toBeFocused();
        await expect(firstTerminal).toHaveAttribute('aria-selected', 'true');
        await firstTerminal.press('End');
        await expect(editor).toBeFocused();
        await expect(editor).toHaveAttribute('aria-selected', 'true');
        await editor.press('ArrowRight');
        await expect(firstTerminal).toBeFocused();
        await expect(firstTerminal).toHaveAttribute('aria-selected', 'true');
        await expectTabControlsWorkSurface(running.page, firstTerminal);

        await firstTerminal.press('Tab');
        await expect(
            running.page.getByRole('button', { name: 'New Terminal', exact: true }),
        ).toBeFocused();
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('external replacement refreshes every open workspace alias model', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-editor-alias-model-e2e-'));
    const root = join(testDirectory, 'project');
    const shared = join(testDirectory, 'shared');
    await Promise.all([mkdir(root), mkdir(shared)]);
    const target = join(shared, 'note.txt');
    await writeFile(target, 'initial external fixture\n');
    await Promise.all([
        symlink('../shared/note.txt', join(root, 'linked-note.txt')),
        symlink('../shared/note.txt', join(root, 'alias-note.txt')),
    ]);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'profile'),
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page);
        const tree = running.page.getByRole('tree', { name: 'Files' });
        await tree.getByRole('treeitem', { name: /^linked-note\.txt/ }).dblclick();
        const editor = running.page.locator('.monaco-editor').last();
        await expect(editor.locator('.view-lines')).toContainText('initial external fixture');
        await tree.getByRole('treeitem', { name: /^alias-note\.txt/ }).dblclick();
        const linkedTab = running.page.locator('.work-tab', { hasText: 'linked-note.txt' });
        const aliasTab = running.page.locator('.work-tab', { hasText: 'alias-note.txt' });
        await expect(linkedTab).toBeVisible();
        await expect(aliasTab).toBeVisible();
        await expect(editor.locator('.view-lines')).toContainText('initial external fixture');

        await linkedTab.click();
        await editor.click();
        await running.page.keyboard.press('Meta+End');
        await running.page.keyboard.insertText('unsaved local fixture');
        await expect(linkedTab).toContainText('●');

        const replacement = join(shared, 'note.next.txt');
        await writeFile(replacement, 'external change takes precedence\n');
        await rename(replacement, target);
        await expect(editor.locator('.view-lines')).toContainText(
            'external change takes precedence',
        );
        await expect(linkedTab).not.toContainText('●');
        await expect(
            running.page.getByText(/reloaded from disk; external changes take precedence/),
        ).toBeVisible();

        await aliasTab.click();
        await expect(editor.locator('.view-lines')).toContainText(
            'external change takes precedence',
        );
        await expect(aliasTab).not.toContainText('●');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close errors during test cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
