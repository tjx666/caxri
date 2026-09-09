import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { defaultAgentProviderSettings } from '@caxri/protocol';

import type { Locator, Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import type { RunningCaxriWithClipboard } from './support/helpers.ts';
import { launchCaxri, pageRequest, revealSettingsSection } from './support/helpers.ts';

/**
 * The Monaco container for a config kind, located by `data-config-source` rather than by accessible name.
 * `ConfigurationEditor` deliberately passes the label through Monaco's `options.ariaLabel` so it lands on the textarea
 * a screen reader actually focuses, instead of on a role-less wrapper `<div>` where assistive tech ignores it.
 * `.monaco-editor` and `.view-lines` are that textarea's siblings, so anything scoped to the editor has to start from
 * this hook. The accessible name is asserted on its own below, so moving it back would still fail.
 */
function configSource(dialog: Locator, kind: 'keybindings' | 'settings' | 'theme'): Locator {
    return dialog.locator(`[data-config-source="${kind}"]`);
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
        await running.page.keyboard.press('Meta+,');
        const dialog = running.page.getByRole('dialog');
        await expect(dialog.locator('.monaco-editor')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Source' }).click();
        const settingsEditor = configSource(dialog, 'settings');
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
        await dialog.getByRole('button', { name: 'UI' }).click();
        await expect(dialog.getByLabel('Search settings')).toBeVisible();
        const defaultAgent = dialog.getByRole('combobox', {
            name: 'Default agent for new sessions',
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
        await running.page.keyboard.press('Escape');

        // Rows outside the viewport are not in the DOM (virtual rendering): reveal each provider
        // through the table of contents before asserting on its rows.
        await revealSettingsSection(dialog, 'Claude Code');
        await expect(dialog.getByLabel('Claude Code executable')).toHaveValue('claude');
        // Lifecycle hooks default to enabled. E2E launches with Agent discovery `blocked`, so the
        // CLI is deliberately absent: the hook waits instead of installing, and the caption carries
        // the install hint.
        await expect(
            dialog.getByRole('switch', { name: 'Claude Code lifecycle hooks' }),
        ).toBeChecked();
        await expect(
            dialog.getByRole('switch', { name: 'Claude Code peer messaging' }),
        ).toBeChecked();
        await expect(
            dialog.locator('[data-setting-row="agents.claude.hooks"]').getByRole('status'),
        ).toContainText('Waiting for the agent CLI to be installed');
        await expect(dialog.getByLabel('Claude Code initial arguments')).toBeVisible();
        await expect(
            dialog.locator('[data-agent-provider="claude"] [data-agent-icon="claude"]'),
        ).toBeVisible();

        await revealSettingsSection(dialog, 'Codex');
        await expect(dialog.getByLabel('Codex executable')).toHaveValue('codex');
        await expect(dialog.getByRole('switch', { name: 'Codex lifecycle hooks' })).toBeChecked();
        await expect(dialog.getByRole('switch', { name: 'Codex peer messaging' })).toBeChecked();
        await expect(
            dialog.locator('[data-agent-provider="codex"] [data-agent-icon="codex"]'),
        ).toBeVisible();

        await revealSettingsSection(dialog, 'Terminal');
        await expect(dialog.getByLabel('New Terminal working directory')).toHaveValue('');
        await expect(dialog.locator('input[type="number"]').first()).toHaveCSS(
            'appearance',
            'none',
        );
        const workingDirectoryWidth = await dialog
            .getByLabel('New Terminal working directory')
            .evaluate((element) => element.getBoundingClientRect().width);
        const scalarWidth = await dialog
            .getByRole('spinbutton', { name: 'Font size' })
            .evaluate((element) => element.getBoundingClientRect().width);
        expect(workingDirectoryWidth).toBeGreaterThan(scalarWidth + 100);

        await dialog.getByRole('spinbutton', { name: 'Font size' }).fill('14');
        await revealSettingsSection(dialog, 'Claude Code');
        // The toggle starts enabled, so round-trip it off and back on to exercise the write path
        // in each direction.
        await dialog.getByRole('switch', { name: 'Claude Code lifecycle hooks' }).uncheck();
        await expect(
            dialog.locator('[data-setting-row="agents.claude.hooks"]').getByRole('status'),
        ).toHaveText('Disabled');
        await dialog.getByRole('switch', { name: 'Claude Code lifecycle hooks' }).check();
        await expect(dialog.locator('[data-setting-row="agents.claude.hooks"]')).toContainText(
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
            dialog.locator('[data-setting-row="agents.claude.hooks"]').getByRole('status'),
        ).toContainText('Waiting for the agent CLI to be installed');
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
                                pasteSummary: { enabled: boolean };
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
                pasteSummary: { enabled: true },
                recovery: {
                    enabled: false,
                    patterns: [],
                    settleDelayMs: 1_000,
                    continueDelayMs: 1_000,
                },
            });

        // Settings search: AND-token filtering narrows the virtual list and the TOC shows
        // per-category match counts; clearing restores the full list.
        const searchInput = dialog.getByLabel('Search settings');
        await searchInput.fill('font size');
        await expect(dialog.getByRole('spinbutton', { name: 'Font size' })).toBeVisible();
        await expect(
            dialog.getByRole('combobox', { name: 'Default agent for new sessions' }),
        ).toHaveCount(0);
        await searchInput.fill('no-setting-matches-this');
        await expect(dialog.getByText(/No settings match/)).toBeVisible();
        await dialog.getByRole('button', { name: 'Clear settings search' }).click();
        await expect(
            dialog.getByRole('combobox', { name: 'Default agent for new sessions' }),
        ).toBeVisible();

        // "Keeps actions visible" now means the header's UI/Source toggle stays pinned above the
        // scrollable tab content instead of scrolling out of view with it (there is no footer).
        const toggle = dialog.getByRole('button', { name: 'Source' });
        const dialogBox = await dialog.boundingBox();
        const toggleBox = await toggle.boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(toggleBox).not.toBeNull();
        expect(toggleBox!.y + toggleBox!.height).toBeLessThanOrEqual(
            dialogBox!.y + dialogBox!.height + 1,
        );

        await dialog.getByRole('tab', { name: 'Theme', exact: true }).click();
        const preview = dialog.getByLabel('Theme preview');
        await expect(preview).toBeVisible();
        const backgroundInput = dialog
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

        await dialog.locator('.structured-editor').evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        // "Keeps actions visible" now means the header's UI/Source toggle (Apply is gone) stays
        // pinned instead of scrolling out of view with the content.
        await expect(dialog.getByRole('button', { name: 'Source' })).toBeVisible();
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

        await running.page.keyboard.press('Meta+,');
        let dialog = running.page.getByRole('dialog');
        await expect(dialog.locator('.monaco-editor')).toHaveCount(0);

        await dialog.getByRole('button', { name: 'Source' }).click();
        let sourceEditor = configSource(dialog, 'settings');
        await replaceMonacoText(running, running.page, sourceEditor, legalSource);
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(sourceEditor.locator('.view-lines')).toContainText('keep-source-comment');
        await dialog.getByRole('button', { name: 'UI' }).click();
        await revealSettingsSection(dialog, 'Terminal');
        await expect(dialog.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('17');
        // The source editor commits on blur/leaving the view instead of behind Apply, and there is
        // no per-tab dirty marker anymore — the persisted value already reflects the edit.
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(17);

        await dialog.getByRole('button', { name: 'Source' }).click();
        sourceEditor = configSource(dialog, 'settings');
        await replaceMonacoText(
            running,
            running.page,
            sourceEditor,
            '{\n  "terminal.fontSize": nope\n}',
        );
        await expect(dialog.getByRole('alert')).toContainText(/settings\.jsonc: .*line 2/);
        // Leaving the source view no longer requires fixing the error first (there is no Apply gate
        // to block on): it discards the uncommitted invalid edit and the structured UI reverts to
        // the last-known-good value instead of showing something broken.
        await dialog.getByRole('button', { name: 'UI' }).click();
        await revealSettingsSection(dialog, 'Terminal');
        await expect(dialog.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('17');
        await expect(dialog.locator('.monaco-editor')).toHaveCount(0);
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(17);

        // Re-enter source mode and fix it while still in the view, then confirm the fix survives a
        // tab switch away and back (the "preserves drafts across tabs" half of this test).
        await dialog.getByRole('button', { name: 'Source' }).click();
        sourceEditor = configSource(dialog, 'settings');
        await replaceMonacoText(running, running.page, sourceEditor, legalSource);
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await dialog.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        await expect(configSource(dialog, 'keybindings')).toBeVisible();
        await dialog.getByRole('tab', { name: 'Theme', exact: true }).click();
        await expect(dialog.getByLabel('theme.json source')).toBeVisible();
        await dialog.getByRole('tab', { name: 'Settings', exact: true }).click();
        const restoredSettingsSource = configSource(dialog, 'settings');
        await restoredSettingsSource
            .locator('.monaco-editor')
            .click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+ArrowDown');
        await expect(restoredSettingsSource.locator('.view-lines')).toContainText(
            'keep-source-comment',
        );

        await running.page.keyboard.press('Escape');
        await running.page.keyboard.press('Meta+,');
        dialog = running.page.getByRole('dialog');
        await revealSettingsSection(dialog, 'Terminal');
        await expect(dialog.getByRole('spinbutton', { name: 'Font size' })).toHaveValue('17');
        await expect(dialog.locator('.monaco-editor')).toHaveCount(0);
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.fontSize': number };
                }>(running.page, 'settings.get');
                return settings.value['terminal.fontSize'];
            })
            .toBe(17);

        await running.page.keyboard.press('Escape');
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Open Settings JSON');
        await palette.getByRole('option').filter({ hasText: 'Open Settings (JSON)' }).click();
        dialog = running.page.getByRole('dialog');
        await expect(dialog.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(configSource(dialog, 'settings')).toBeVisible();

        await dialog.getByRole('tab', { name: 'Keybindings', exact: true }).click();
        const keybindingsEditor = configSource(dialog, 'keybindings');
        await replaceMonacoText(running, running.page, keybindingsEditor, '[ invalid');
        await expect(dialog.getByRole('alert')).toContainText('keybindings.jsonc');

        // Reissuing "Open Settings (JSON)" jumps straight back to the Settings source tab even
        // though the Keybindings source is still invalid: an unresolved parse error is local to the
        // view it was made in and never blocks navigating elsewhere in the dialog.
        await running.page.keyboard.press('Escape');
        await running.page.keyboard.press('Meta+Shift+P');
        const reopenPalette = running.page.getByRole('dialog');
        await reopenPalette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Open Settings JSON');
        await reopenPalette.getByRole('option').filter({ hasText: 'Open Settings (JSON)' }).click();
        dialog = running.page.getByRole('dialog');
        await expect(dialog.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        await expect(configSource(dialog, 'settings')).toBeVisible();

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
