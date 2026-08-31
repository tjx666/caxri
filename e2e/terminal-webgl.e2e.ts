import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { E2EApp } from './support/electron-app.ts';
import type { Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createShellSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    revealSettingsSection,
    splitTerminalToRight,
    typeTerminal,
    waitForNewTerminalId,
} from './support/helpers.ts';
import {
    createTerminalGlyphFixture,
    terminalEdgeGlyphEvidence,
} from './support/terminal-glyph-evidence.ts';

type GpuPreference = 'Auto' | 'On' | 'Off';

const GPU_RESTART_STUB_KEY = '__caxriE2EGpuRestartStub';

interface GpuRestartStubState {
    didQuit: boolean;
    didRelaunch: boolean;
}

async function stubGpuSafeModeRestart(app: E2EApp): Promise<void> {
    await app.evaluate(({ app: electronApp }, key) => {
        const scope = globalThis as Record<string, unknown>;
        if (scope[key]) throw new Error('GPU restart lifecycle is already stubbed');
        const state = {
            didQuit: false,
            didRelaunch: false,
            quitDescriptor: Object.getOwnPropertyDescriptor(electronApp, 'quit'),
            relaunchDescriptor: Object.getOwnPropertyDescriptor(electronApp, 'relaunch'),
        };
        scope[key] = state;
        Object.defineProperties(electronApp, {
            quit: {
                configurable: true,
                value: () => {
                    state.didQuit = true;
                },
            },
            relaunch: {
                configurable: true,
                value: () => {
                    state.didRelaunch = true;
                },
            },
        });
    }, GPU_RESTART_STUB_KEY);
}

async function readGpuSafeModeRestart(app: E2EApp): Promise<GpuRestartStubState> {
    return app.evaluate((_, key) => {
        const state = (globalThis as Record<string, unknown>)[key] as
            GpuRestartStubState | undefined;
        if (!state) throw new Error('GPU restart lifecycle is not stubbed');
        return { didQuit: state.didQuit, didRelaunch: state.didRelaunch };
    }, GPU_RESTART_STUB_KEY);
}

async function restoreGpuSafeModeRestart(app: E2EApp): Promise<void> {
    await app.evaluate(({ app: electronApp }, key) => {
        const scope = globalThis as Record<string, unknown>;
        const state = scope[key] as
            | (GpuRestartStubState & {
                  quitDescriptor?: PropertyDescriptor;
                  relaunchDescriptor?: PropertyDescriptor;
              })
            | undefined;
        if (!state) throw new Error('GPU restart lifecycle is not stubbed');
        if (state.quitDescriptor) Object.defineProperty(electronApp, 'quit', state.quitDescriptor);
        else Reflect.deleteProperty(electronApp, 'quit');
        if (state.relaunchDescriptor)
            Object.defineProperty(electronApp, 'relaunch', state.relaunchDescriptor);
        else Reflect.deleteProperty(electronApp, 'relaunch');
        Reflect.deleteProperty(scope, key);
    }, GPU_RESTART_STUB_KEY);
}

async function applyGpuPreference(page: Page, preference: GpuPreference): Promise<void> {
    await page.keyboard.press('Meta+,');
    const dialog = page.getByRole('dialog');
    await revealSettingsSection(dialog, 'Terminal');
    await dialog.getByRole('combobox', { name: 'GPU acceleration' }).click();
    await page.getByRole('option', { name: preference, exact: true }).click();
    /**
     * Settings apply immediately (there is no Apply button); the observable invariant is the Runtime actually
     * persisting the change, not an arbitrary wait.
     */
    await expect
        .poll(async () => {
            const settings = await pageRequest<{
                value: { 'terminal.gpuAcceleration': string };
            }>(page, 'settings.get');
            return settings.value['terminal.gpuAcceleration'];
        })
        .toBe(preference.toLowerCase());
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

/**
 * Verifies the Renderer-owned xterm grid against the live shell's PTY grid after a renderer transition. Reading only
 * `data-terminal-grid` would miss the GPU fallback bug where xterm changed locally without sending terminal.resize.
 */
async function waitForSynchronizedTerminalGrid(page: Page, terminalId: string): Promise<string> {
    const pane = page.locator(`.terminal-pane[data-terminal-id="${terminalId}"]`);
    const surface = pane.locator('.terminal-surface');
    const input = pane.locator('.xterm-helper-textarea');
    const rows = pane.locator('.xterm-rows');
    const marker = `CAXRI_WEBGL_GRID_${Date.now()}_`;
    let candidate: string | undefined;
    let matchingSamples = 0;
    let probeSequence = 0;
    let synchronizedGrid: string | undefined;

    await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
    await expect
        .poll(async () => {
            const sampleMarker = `${marker}${probeSequence}_`;
            probeSequence += 1;
            const probe = String.raw`printf '${sampleMarker}%sx%s\n' "$(tput cols)" "$(tput lines)"`;
            await input.focus();
            await input.pressSequentially(probe);
            await input.press('Enter');
            await expect(rows).toContainText(new RegExp(String.raw`${sampleMarker}\d+x\d+`, 'u'));
            const [rendererGrid, terminalText] = await Promise.all([
                surface.evaluate(
                    (element) => (element as HTMLElement).dataset.terminalGrid ?? null,
                ),
                rows.textContent(),
            ]);
            const ptyGrid = (terminalText ?? '').match(
                new RegExp(String.raw`${sampleMarker}(\d+x\d+)`, 'u'),
            )?.[1];
            if (!rendererGrid || rendererGrid !== ptyGrid) {
                candidate = undefined;
                matchingSamples = 0;
                return false;
            }
            if (rendererGrid === candidate) matchingSamples += 1;
            else {
                candidate = rendererGrid;
                matchingSamples = 1;
            }
            if (matchingSamples < 3) return false;
            synchronizedGrid = rendererGrid;
            return true;
        })
        .toBe(true);

    return synchronizedGrid!;
}

test('WebGL modes hot-switch and every Terminal recovers from one GPU process loss', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'gpu.process_gone', code: 'GPU_PROCESS_GONE', count: 1 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-webgl-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const glyphOutput = await createTerminalGlyphFixture(testDirectory);
    await mkdir(root);

    const running = await launchCaxri({
        gpuMode: 'enabled',
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        const pane = running.page.locator('.terminal-pane');
        const surface = pane.locator('.terminal-surface');
        let terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'disabled');

        await applyGpuPreference(running.page, 'Auto');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'active');

        const redrawsBeforeRestore = Number(
            (await surface.getAttribute('data-terminal-renderer-redraws')) ?? 0,
        );
        await running.page.evaluate(() => dispatchEvent(new Event('focus')));
        await expect
            .poll(async () =>
                Number((await surface.getAttribute('data-terminal-renderer-redraws')) ?? 0),
            )
            .toBeGreaterThan(redrawsBeforeRestore);

        await applyGpuPreference(running.page, 'Off');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'disabled');

        await applyGpuPreference(running.page, 'On');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl');
        const completedBeforeScrollback = Number(
            (await surface.getAttribute('data-terminal-command-completed-count')) ?? 0,
        );
        await typeTerminal(running.page, String.raw`printf 'FIRST_PANE_SCROLLBACK\n'`);
        await expect(surface).toHaveAttribute(
            'data-terminal-command-completed-count',
            String(completedBeforeScrollback + 1),
        );
        terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered after mode changes');

        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [terminalId]);
        await splitTerminalToRight(running.page, secondTerminalId);
        const surfaces = running.page.locator('.terminal-surface');
        const firstPane = running.page.locator(`.terminal-pane[data-terminal-id="${terminalId}"]`);
        const firstRows = firstPane.locator('.xterm-rows');
        const secondRows = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .xterm-rows`,
        );
        await expect(surfaces).toHaveCount(2);
        await expect(surfaces.nth(0)).toHaveAttribute('data-terminal-renderer', 'webgl');
        await expect(surfaces.nth(1)).toHaveAttribute('data-terminal-renderer', 'webgl');
        const runningBeforeLoss = await pageRequest<number>(running.page, 'terminal.runningCount');
        /**
         * Playwright escapes non-ASCII static text inside `String.raw`; runtime substitutions keep the PTY glyphs.
         */
        const continuityGlyphs = [0x75_4c, 0x1_f600].map((value) => String.fromCodePoint(value));
        const atlasGlyphs = [0x25_03, 0xe0_a0, 0x25_88]
            .map((value) => String.fromCodePoint(value))
            .join(' ');
        await typeTerminal(
            running.page,
            String.raw`printf 'WEBGL_CONTINUITY_${continuityGlyphs.join('_')}\n'; for value in {1..160}; do printf 'atlas-%03d ${atlasGlyphs}\n' "$value"; done`,
        );

        const focusedTerminalId = await running.page
            .locator('.terminal-pane:has(.xterm-helper-textarea:focus)')
            .getAttribute('data-terminal-id');
        const incident = await pageRequest<{ correlationId: string }>(
            running.page,
            'gpu.testInjectContextLoss',
        );
        expect(incident.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
        /**
         * Main and both mounted Terminals observe the same correlated GPU incident. The coordinator must collapse those
         * three signals into one transient, actionable notification before the durable renderer state is checked.
         */
        const recoveryNotification = running.page.getByText(
            'A GPU process crash interrupted rendering. Caxri switched affected Terminals to software rendering.',
            { exact: true },
        );
        await expect(recoveryNotification).toHaveCount(1, { timeout: 8_000 });
        await expect(
            running.page.getByRole('button', { name: 'Restart in GPU Safe Mode' }),
        ).toHaveCount(1);
        await expect(recoveryNotification).toHaveCount(0, { timeout: 6_000 });
        await expect(surfaces.nth(0)).toHaveAttribute('data-terminal-renderer', 'dom', {
            timeout: 8_000,
        });
        await expect(surfaces.nth(1)).toHaveAttribute('data-terminal-renderer', 'dom', {
            timeout: 8_000,
        });
        await expect(surfaces.nth(0)).toHaveAttribute(
            'data-terminal-renderer-reason',
            'context-loss',
        );
        await expect(surfaces.nth(1)).toHaveAttribute(
            'data-terminal-renderer-reason',
            'context-loss',
        );
        await expect(firstPane).toHaveAttribute('data-terminal-id', terminalId);
        await expect(
            running.page.locator(`.terminal-pane[data-terminal-id="${secondTerminalId}"]`),
        ).toBeAttached();
        expect(
            await running.page
                .locator('.terminal-pane:has(.xterm-helper-textarea:focus)')
                .getAttribute('data-terminal-id'),
        ).toBe(focusedTerminalId);
        await expect
            .poll(() => pageRequest<number>(running.page, 'terminal.runningCount'))
            .toBe(runningBeforeLoss);
        const synchronizedGrids = [
            await waitForSynchronizedTerminalGrid(running.page, terminalId),
            await waitForSynchronizedTerminalGrid(running.page, secondTerminalId),
        ];
        expect(synchronizedGrids.every((grid) => /^\d+x\d+$/u.test(grid))).toBe(true);
        await expect(secondRows).toContainText('atlas-160');
        await expect(firstRows).toContainText('FIRST_PANE_SCROLLBACK');

        await typeTerminal(running.page, String.raw`printf 'AFTER_WEBGL_FALLBACK\n'`);
        await expect(secondRows).toContainText('AFTER_WEBGL_FALLBACK');
        for (const id of [terminalId, secondTerminalId]) {
            // eslint-disable-next-line no-await-in-loop -- one pane must finish its shell fixture before focus moves.
            const { alignedAscii, alignedCjk } = await terminalEdgeGlyphEvidence(
                running.app,
                running.page,
                id,
                glyphOutput,
            );
            const evidence = JSON.stringify({ alignedAscii, alignedCjk, terminalId: id });
            expect(alignedAscii.edge.foregroundPixels, evidence).toBeGreaterThanOrEqual(
                alignedAscii.reference.foregroundPixels * 0.95,
            );
            expect(alignedCjk.edge.foregroundPixels, evidence).toBeGreaterThanOrEqual(
                alignedCjk.reference.foregroundPixels * 0.95,
            );
        }
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('repeated context losses preserve user choice and explicit GPU Safe Mode persists it', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'gpu.process_gone', code: 'GPU_PROCESS_GONE', count: 3 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-gpu-user-choice-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root);

    let running = await launchCaxri({
        quitDecisionOnClose: 'keep-running',
        gpuMode: 'enabled',
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createShellSession(running.page);
        await pageRequest(running.page, 'gpu.testInjectContextLoss');
        await pageRequest(running.page, 'gpu.testInjectContextLoss');
        const afterRepeatedIncidents = await pageRequest<{
            value: { hardwareAcceleration: boolean };
        }>(running.page, 'argv.get');
        expect(afterRepeatedIncidents.value.hardwareAcceleration).toBe(true);

        await running.app.close();
        running = await launchCaxri({
            quitDecisionOnClose: 'keep-running',
            gpuMode: 'enabled',
            userDataDir: userData,
            testRootPath: root,
        });
        await expect(
            running.page.getByText(
                'Caxri disabled hardware acceleration after repeated GPU crashes.',
                { exact: true },
            ),
        ).toHaveCount(0);
        const afterRelaunch = await pageRequest<{
            value: { hardwareAcceleration: boolean };
        }>(running.page, 'argv.get');
        expect(afterRelaunch.value.hardwareAcceleration).toBe(true);

        await applyGpuPreference(running.page, 'On');
        await stubGpuSafeModeRestart(running.app);
        try {
            await pageRequest(running.page, 'gpu.testInjectContextLoss');
            const restart = running.page.getByRole('button', {
                name: 'Restart in GPU Safe Mode',
            });
            await expect(restart).toBeVisible();
            await restart.click();
            await expect
                .poll(async () => {
                    const result = await pageRequest<{
                        value: { hardwareAcceleration: boolean };
                    }>(running.page, 'argv.get');
                    return result.value.hardwareAcceleration;
                })
                .toBe(false);
            await expect
                .poll(() => readGpuSafeModeRestart(running.app))
                .toEqual({
                    didQuit: true,
                    didRelaunch: true,
                });
        } finally {
            await restoreGpuSafeModeRestart(running.app);
        }

        await running.app.close();
        running = await launchCaxri({
            gpuMode: 'enabled',
            userDataDir: userData,
            testRootPath: root,
        });
        const explicitSafeMode = await pageRequest<{
            value: { hardwareAcceleration: boolean };
        }>(running.page, 'argv.get');
        expect(explicitSafeMode.value.hardwareAcceleration).toBe(false);
        const persistedSettings = await pageRequest<{
            value: { 'terminal.gpuAcceleration': string };
        }>(running.page, 'settings.get');
        expect(persistedSettings.value['terminal.gpuAcceleration']).toBe('on');

        await running.page.keyboard.press('Meta+,');
        const dialog = running.page.getByRole('dialog');
        await revealSettingsSection(dialog, 'General');
        const acceleration = dialog.getByRole('switch', { name: 'Hardware acceleration' });
        await expect(acceleration).not.toBeChecked();
        await dialog.getByRole('button', { name: 'Close', exact: true }).click();
        const surface = running.page.locator('.terminal-surface');
        await expect(surface).toBeVisible();
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'unsupported');
        await expect(
            running.page.getByText(
                'GPU rendering failed in a Terminal. Caxri switched it to software rendering.',
                { exact: true },
            ),
        ).toHaveCount(0);
        await typeTerminal(running.page, String.raw`printf 'GPU_SETTING_STAYED_ON\n'`);
        await expect(running.page.locator('.xterm-rows')).toContainText('GPU_SETTING_STAYED_ON');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
