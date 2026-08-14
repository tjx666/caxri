import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Page } from '@playwright/test';

import { expect, test } from './support/fixtures.ts';

import { createProjectSession, launchCaxri } from './support/helpers.ts';

const execFileAsync = promisify(execFile);

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
                            !(node instanceof HTMLElement) ||
                            !node.matches('.work-tab:not([data-terminal-id])')
                        )
                            continue;
                        events.push({
                            identity: node.dataset.motionIdentity,
                            kind,
                            maxWidth: node.style.maxWidth,
                            opacity: node.style.opacity,
                        });
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
        (
            window as unknown as {
                editorPresenceProbe: { events: EditorPresenceEvent[]; observer: MutationObserver };
            }
        ).editorPresenceProbe = { events, observer };
    });
}

async function stopEditorPresenceProbe(page: Page): Promise<EditorPresenceEvent[]> {
    return page.evaluate(() => {
        const probe = (
            window as unknown as {
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
            return raw.endsWith('ms') ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1_000;
        };
        return Math.max(durationMs('--motion-tab-enter'), durationMs('--motion-tab-exit'));
    });
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
        // (`editor.confirmDiscard`, see `document-actions.ts`), so `dialog.showMessageBox` must be
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
        await expect(bTab.locator('[data-file-icon="javascript"]')).toBeVisible();
        await expect(bTab).toHaveAttribute('data-preview', 'true');
        await bTab.getByRole('tab').dblclick();
        await expect(bTab).not.toHaveAttribute('data-preview');

        /** Reproduces the custom tokenizer race seen on loaded GitHub-hosted runners. */
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

        expect(
            await running.page
                .locator('.work-tabs')
                .evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').height),
        ).toBe('3px');

        await cTab.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Close to the Right' }).click();
        await expect(dTab).toHaveCount(0);
        await expect(bTab).toBeVisible();
        await expect(cTab).toBeVisible();

        await running.page.getByRole('treeitem', { name: 'a.js', exact: true }).dblclick();
        await cTab.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Close Others' }).click();
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(1);
        await expect(cTab).toBeVisible();

        await expect(cTab).toContainText('●');
        await cTab.click({ button: 'right' });
        await running.page.getByRole('menuitem', { name: 'Close All' }).click();
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(0);
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(1);
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
        await running.app.close().catch(() => undefined);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
