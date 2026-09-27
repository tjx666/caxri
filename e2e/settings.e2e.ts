import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';

import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import type { RunningCaxriWithClipboard } from './support/helpers.ts';
import {
    launchCaxri,
    openSettingsTab,
    pageRequest,
    revealSettingsSection,
} from './support/helpers.ts';

/**
 * The Monaco container for a config kind, located by `data-config-source` rather than by accessible name.
 * `ConfigurationEditor` deliberately passes the label through Monaco's `options.ariaLabel` so it lands on the textarea
 * a screen reader actually focuses, instead of on a role-less wrapper `<div>` where assistive tech ignores it.
 * `.monaco-editor` and `.view-lines` are that textarea's siblings, so anything scoped to the editor has to start from
 * this hook. The accessible name is asserted on its own below, so moving it back would still fail.
 */
function configSource(container: Locator, kind: 'keybindings' | 'settings' | 'theme'): Locator {
    return container.locator(`[data-config-source="${kind}"]`);
}

async function replaceMonacoText(
    running: RunningCaxriWithClipboard,
    page: Page,
    editor: Locator,
    source: string,
): Promise<void> {
    await running.clipboard.writeText(source);
    await editor.locator('.monaco-editor').click({ position: { x: 120, y: 24 } });
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Meta+V');
}

test('Settings keeps actions visible and provides highlighted editors and live Theme preview', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-settings-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
    });
    const pageErrors: string[] = [];
    running.page.on('pageerror', (error) => {
        pageErrors.push(error.message);
    });
    try {
        const settingsTab = await openSettingsTab(running.page);
        await expect(settingsTab.locator('.monaco-editor')).toHaveCount(0);
        await settingsTab.getByRole('button', { name: 'Source' }).click();
        const settingsEditor = configSource(settingsTab, 'settings');
        /**
         * Monaco first paints plain source spans and applies token colors asynchronously. Wait for the observable
         * highlighted state without pinning the assertion to a setting whose position moves as the schema grows.
         */
        await expect(settingsEditor.locator('.view-lines span').first()).toBeVisible();
        // The accessible name has to sit on Monaco's own textarea, the surface a screen reader
        // focuses. On the role-less wrapper `<div>` it announces nothing, which is why the
        // container above is located by `data-config-source` instead of by label.
        await expect(settingsEditor.getByLabel('settings.jsonc source')).toHaveCount(1);

        await expect
            .poll(async () => {
                const tokenColors = await settingsEditor
                    .locator('.view-lines span')
                    .evaluateAll((spans) => [
                        ...new Set(spans.map((span) => getComputedStyle(span).color)),
                    ]);
                return tokenColors.length;
            })
            .toBeGreaterThan(1);
        await settingsTab.getByRole('button', { name: 'UI' }).click();
        await expect(settingsTab.getByLabel('Search settings')).toBeVisible();
        const defaultAgent = settingsTab.getByRole('combobox', {
            name: 'Default agent',
        });
        await expect(defaultAgent).toContainText('Ask each time');
        await expect(defaultAgent.locator('[data-agent-icon="unknown"]')).toBeVisible();
        await defaultAgent.click();
        await Promise.all(
            (
                [
                    ['Claude Code', 'claude'],
                    ['Codex', 'codex'],
                    ['Shell', 'shell'],
                ] as const
            ).map(([name, icon]) =>
                expect(
                    running.page
                        .getByRole('option', { name, exact: true })
                        .locator(`[data-agent-icon="${icon}"]`),
                ).toBeVisible(),
            ),
        );
        // Dismisses the "Default agent" dropdown popup, not Settings itself — Settings is a
        // persistent Workbench tab now and Escape has nothing of its own to close here.
        await running.page.keyboard.press('Escape');

        // Rows outside the viewport are not in the DOM (virtual rendering): reveal each provider
        // through the table of contents before asserting on its rows.
        await revealSettingsSection(settingsTab, 'Claude Code');
        await expect(settingsTab.getByLabel('Claude Code executable')).toHaveValue('claude');
        // Lifecycle hooks default to enabled. E2E launches with Agent discovery `blocked`, so the
        // CLI is deliberately absent: the hook waits instead of installing, and the caption appends
        // the Server's own reason once instead of restating a generic install hint.
        await expect(
            settingsTab.getByRole('switch', { name: 'Claude Code lifecycle hooks' }),
        ).toBeChecked();
        await expect(
            settingsTab.getByRole('switch', { name: 'Claude Code peer messaging' }),
        ).toBeChecked();
        await expect(
            settingsTab.locator('[data-setting-row="agents.claude.hooks"]').getByRole('status'),
        ).toContainText('Not in effect — Lifecycle hook installation is unavailable in this mode.');
        await expect(settingsTab.getByLabel('Claude Code initial arguments')).toBeVisible();
        await expect(
            settingsTab.locator('[data-agent-provider="claude"] [data-agent-icon="claude"]'),
        ).toBeVisible();

        await revealSettingsSection(settingsTab, 'Codex');
        await expect(settingsTab.getByLabel('Codex executable')).toHaveValue('codex');
        await expect(
            settingsTab.getByRole('switch', { name: 'Codex lifecycle hooks' }),
        ).toBeChecked();
        await expect(
            settingsTab.getByRole('switch', { name: 'Codex peer messaging' }),
        ).toBeChecked();
        await expect(
            settingsTab.locator('[data-agent-provider="codex"] [data-agent-icon="codex"]'),
        ).toBeVisible();

        await revealSettingsSection(settingsTab, 'Terminal');
        await expect(settingsTab.getByLabel('New Terminal working directory')).toHaveValue('');
        await expect(settingsTab.locator('input[type="number"]').first()).toHaveCSS(
            'appearance',
            'none',
        );
        const workingDirectoryWidth = await settingsTab
            .getByLabel('New Terminal working directory')
            .evaluate((element) => element.getBoundingClientRect().width);
        const scalarWidth = await settingsTab
            .getByRole('spinbutton', { name: 'Terminal Font size' })
            .evaluate((element) => element.getBoundingClientRect().width);
        expect(workingDirectoryWidth).toBeGreaterThan(scalarWidth + 100);

        await settingsTab.getByRole('spinbutton', { name: 'Terminal Font size' }).fill('14');
        await revealSettingsSection(settingsTab, 'Claude Code');
        // The toggle starts enabled, so round-trip it off and back on to exercise the write path
        // in each direction.
        await settingsTab.getByRole('switch', { name: 'Claude Code lifecycle hooks' }).uncheck();
        await expect(
            settingsTab.locator('[data-setting-row="agents.claude.hooks"]').getByRole('status'),
        ).toHaveText('Disabled');
        await settingsTab.getByRole('switch', { name: 'Claude Code lifecycle hooks' }).check();
        await expect(settingsTab.locator('[data-setting-row="agents.claude.hooks"]')).toContainText(
            'Restart Agent Terminals opened before lifecycle hooks were enabled.',
        );
        // Structured controls write immediately (debounced) now that the Apply button is gone, so
        // the health caption leaves 'Disabled' on its own — no Apply click in between. It settles
        // on the discovery-dependent state rather than 'Installed': E2E launches with Agent
        // discovery `blocked`, so the CLI is deliberately absent and the hook cannot install. The
        // durable proof that the write landed is the persisted `hooks.enabled` assertion below;
        // this only pins that the toggle reached the Runtime. Matched on the caption alone because
        // `hookHealthLabel` appends the adapter's own advisory message.
        await expect(
            settingsTab.locator('[data-setting-row="agents.claude.hooks"]').getByRole('status'),
        ).toContainText('Not in effect — Lifecycle hook installation is unavailable in this mode.');
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(14);
        await expect
            .poll(async () => {
                const providerSettings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            claude: {
                                actions: { items: Record<string, unknown> };
                                hooks: { enabled: boolean };
                                launch: { executable: string; args: string[] };
                                messaging: { enabled: boolean };
                                recovery: {
                                    enabled: boolean;
                                    patterns: string[];
                                    settleDelayMs: number;
                                    continueDelayMs: number;
                                };
                            };
                        };
                    };
                }>(running.page, 'settings.get');
                return providerSettings.value['agents.providers'].claude;
            })
            .toEqual({
                actions: { items: {}, recent: { version: 1, invocations: [] } },
                hooks: { enabled: true },
                launch: {
                    executable: 'claude',
                    args: defaultAgentProviderSettings.claude.launch.args,
                },
                messaging: { enabled: true },
                recovery: {
                    enabled: false,
                    patterns: [],
                    settleDelayMs: 1_000,
                    continueDelayMs: 1_000,
                },
            });

        // Settings search: AND-token filtering narrows the virtual list and the TOC shows
        // per-category match counts; clearing restores the full list.
        const searchInput = settingsTab.getByLabel('Search settings');
        await searchInput.fill('font size');
        await expect(
            settingsTab.getByRole('spinbutton', { name: 'Terminal Font size' }),
        ).toBeVisible();
        await expect(settingsTab.getByRole('combobox', { name: 'Default agent' })).toHaveCount(0);
        await searchInput.fill('no-setting-matches-this');
        await expect(settingsTab.getByText(/No settings match/)).toBeVisible();
        await settingsTab.getByRole('button', { name: 'Clear settings search' }).click();
        await expect(settingsTab.getByRole('combobox', { name: 'Default agent' })).toBeVisible();

        // "Keeps actions visible" now means the header's UI/Source toggle stays pinned above the
        // scrollable tab content instead of scrolling out of view with it (there is no footer).
        const toggle = settingsTab.getByRole('button', { name: 'Source' });
        const settingsTabBox = await settingsTab.boundingBox();
        const toggleBox = await toggle.boundingBox();
        expect(settingsTabBox).not.toBeNull();
        expect(toggleBox).not.toBeNull();
        expect(toggleBox!.y + toggleBox!.height).toBeLessThanOrEqual(
            settingsTabBox!.y + settingsTabBox!.height + 1,
        );

        await settingsTab.getByRole('tab', { name: 'Theme', exact: true }).click();
        const preview = settingsTab.getByLabel('Theme preview');
        await expect(preview).toBeVisible();
        const backgroundInput = settingsTab
            .locator('.theme-editor fieldset')
            .nth(1)
            .getByLabel('terminal background color');
        await backgroundInput.fill('#101820');
        await expect
            .poll(() =>
                preview.evaluate((element) =>
                    element.style.getPropertyValue('--preview-background'),
                ),
            )
            .toBe('#101820');

        await settingsTab.locator('.structured-editor').evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        // "Keeps actions visible" now means the header's UI/Source toggle (Apply is gone) stays
        // pinned instead of scrolling out of view with the content.
        await expect(settingsTab.getByRole('button', { name: 'Source' })).toBeVisible();
        expect(pageErrors).toEqual([]);
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Settings source mode preserves drafts across tabs and discards an invalid edit instead of persisting it', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-settings-source-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        clipboard: true,
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        const initial = await pageRequest<{ source: string }>(running.page, 'settings.get');
        const legalSource = initial.source
            .replace(/"terminal\.fontSize":\s*\d+/, '"terminal.fontSize": 17')
            .replace(/\n\}\s*$/, '\n  // keep-source-comment\n}\n');

        // `settingsTab` stays valid for the whole test: unlike the former dialog, this Workbench
        // tab is never actually closed below, only navigated within (UI/Source view, Settings /
        // Keybindings / Theme sub-tabs), so the same locator keeps resolving to it throughout.
        const settingsTab = await openSettingsTab(running.page);
        await expect(settingsTab.locator('.monaco-editor')).toHaveCount(0);

        await settingsTab.getByRole('button', { name: 'Source' }).click();
        let sourceEditor = configSource(settingsTab, 'settings');
        await replaceMonacoText(running, running.page, sourceEditor, legalSource);
        await expect(settingsTab.getByRole('alert')).toHaveCount(0);
        await expect(sourceEditor.locator('.view-lines')).toContainText('keep-source-comment');
        await settingsTab.getByRole('button', { name: 'UI' }).click();
        await revealSettingsSection(settingsTab, 'Terminal');
        await expect(
            settingsTab.getByRole('spinbutton', { name: 'Terminal Font size' }),
        ).toHaveValue('17');
        // The source editor commits on blur/leaving the view instead of behind Apply, and there is
        // no per-section dirty marker anymore — the persisted value already reflects the edit.
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(17);

        await settingsTab.getByRole('button', { name: 'Source' }).click();
        sourceEditor = configSource(settingsTab, 'settings');
        await replaceMonacoText(
            running,
            running.page,
            sourceEditor,
            '{\n  "terminal.fontSize": nope\n}',
        );
        await expect(settingsTab.getByRole('alert')).toContainText(/settings\.jsonc: .*line 2/);
        // Leaving the source view no longer requires fixing the error first (there is no Apply gate
        // to block on): it discards the uncommitted invalid edit and the structured UI reverts to
        // the last-known-good value instead of showing something broken.
        await settingsTab.getByRole('button', { name: 'UI' }).click();
        await revealSettingsSection(settingsTab, 'Terminal');
        await expect(
            settingsTab.getByRole('spinbutton', { name: 'Terminal Font size' }),
        ).toHaveValue('17');
        await expect(settingsTab.locator('.monaco-editor')).toHaveCount(0);
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(17);

        await settingsTab.getByRole('button', { name: 'Source' }).click();
        sourceEditor = configSource(settingsTab, 'settings');
        await replaceMonacoText(
            running,
            running.page,
            sourceEditor,
            '{\n  "terminal.fontSize": 17',
        );
        await expect(settingsTab.getByRole('alert')).toContainText('A closing brace } is missing');
        await sourceEditor.locator('.monaco-editor').click();
        await running.page.keyboard.press('Meta+ArrowUp');
        await settingsTab.getByRole('button', { name: 'Go to line 2' }).click();
        await running.page.keyboard.type('// jump');
        await expect(sourceEditor.locator('.view-line').nth(1)).toContainText('// jump');
        await settingsTab.getByRole('button', { name: 'Revert changes' }).click();
        await expect(settingsTab.getByRole('alert')).toHaveCount(0);
        await sourceEditor.locator('.monaco-editor').click();
        await running.page.keyboard.press('Meta+ArrowDown');
        await expect(sourceEditor.locator('.view-lines')).toContainText('keep-source-comment');
        await settingsTab.getByRole('button', { name: 'UI' }).click();

        // Re-enter source mode and fix it while still in the view, then confirm the fix survives a
        // tab switch away and back (the "preserves drafts across tabs" half of this test).
        await settingsTab.getByRole('button', { name: 'Source' }).click();
        sourceEditor = configSource(settingsTab, 'settings');
        await replaceMonacoText(running, running.page, sourceEditor, legalSource);
        await expect(settingsTab.getByRole('alert')).toHaveCount(0);
        await settingsTab.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        await expect(configSource(settingsTab, 'keybindings')).toBeVisible();
        await settingsTab.getByRole('tab', { name: 'Theme', exact: true }).click();
        await expect(settingsTab.getByLabel('theme.json source')).toBeVisible();
        await settingsTab.getByRole('tab', { name: 'Settings', exact: true }).click();
        const restoredSettingsSource = configSource(settingsTab, 'settings');
        await restoredSettingsSource
            .locator('.monaco-editor')
            .click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+ArrowDown');
        await expect(restoredSettingsSource.locator('.view-lines')).toContainText(
            'keep-source-comment',
        );

        // Settings is a Workbench tab now, not a modal, so there is nothing for Escape to dismiss
        // (issue caxri#1289): the "close and reopen" round trip that used to force a remount
        // — and, with it, reset the UI/Source view toggle to its default — becomes an explicit
        // switch back to the UI view instead. `openSettingsTab` still works afterward: re-pressing
        // `Cmd+,` while the tab is already open and active is a harmless no-op refocus, which this
        // also exercises.
        await settingsTab.getByRole('button', { name: 'UI' }).click();
        await openSettingsTab(running.page);
        await revealSettingsSection(settingsTab, 'Terminal');
        await expect(
            settingsTab.getByRole('spinbutton', { name: 'Terminal Font size' }),
        ).toHaveValue('17');
        await expect(settingsTab.locator('.monaco-editor')).toHaveCount(0);
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(17);

        // The command palette is still a real dialog; only Settings itself stopped being one, so
        // there is nothing left to dismiss before opening the palette.
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Open Settings JSON');
        await palette.getByRole('option').filter({ hasText: 'Open Settings (JSON)' }).click();
        await expect(
            settingsTab.getByRole('tab', { name: 'Settings', exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(configSource(settingsTab, 'settings')).toBeVisible();

        await settingsTab.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        const keybindingsEditor = configSource(settingsTab, 'keybindings');
        await replaceMonacoText(running, running.page, keybindingsEditor, '[ invalid');
        await expect(settingsTab.getByRole('alert')).toContainText('keybindings.jsonc');

        // Reissuing "Open Settings (JSON)" jumps straight back to the Settings source tab even
        // though the Keybindings source is still invalid: an unresolved parse error is local to the
        // view it was made in and never blocks navigating elsewhere in the tab.
        await running.page.keyboard.press('Meta+Shift+P');
        const reopenPalette = running.page.getByRole('dialog');
        await reopenPalette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Open Settings JSON');
        await reopenPalette.getByRole('option').filter({ hasText: 'Open Settings (JSON)' }).click();
        await expect(
            settingsTab.getByRole('tab', { name: 'Settings', exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
        await expect(configSource(settingsTab, 'settings')).toBeVisible();

        // The invalid keybindings edit was discarded, not persisted: the on-disk file still holds
        // the untouched default binding this test never committed a change to.
        await expect
            .poll(async () => {
                const result = await pageRequest<{
                    value: Array<{ command: string; key: string }>;
                }>(running.page, 'keybindings.get');
                return result.value.find((binding) => binding.command === 'secondarySidebar.toggle')
                    ?.key;
            })
            .toBe('cmd+]');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('application menu registers the native macOS Command+H Hide command', async () => {
    test.skip(process.platform !== 'darwin', 'macOS application shortcut');
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-hide-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        const hideItem = await running.app.evaluate(({ Menu }) => {
            const item = Menu.getApplicationMenu()?.getMenuItemById('app.hide');
            return item ? { accelerator: item.accelerator, role: item.role } : undefined;
        });
        expect(hideItem).toEqual({ accelerator: 'Command+H', role: 'hide' });
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});
