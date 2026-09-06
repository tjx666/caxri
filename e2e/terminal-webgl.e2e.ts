import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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

interface StructuredLogRecord {
    correlationId?: string;
    event: string;
    fields?: Record<string, unknown>;
}

interface ResizeReceiptBaseline {
    desktopRecordCount: number;
}

async function readStructuredLog(path: string): Promise<StructuredLogRecord[]> {
    try {
        const content = await readFile(path, 'utf8');
        const completeContent = content.endsWith('\n')
            ? content
            : content.slice(0, content.lastIndexOf('\n') + 1);
        return completeContent
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as StructuredLogRecord);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
}

/**
 * Requires a fresh Renderer receipt after recovery, then compares it with the Terminal Host's latest applied grid. The
 * Host intentionally emits no new receipt when recovery preserves the existing PTY dimensions.
 */
async function waitForSynchronizedResizeReceipts(
    userData: string,
    terminalId: string,
    expectedGrid: string,
    baseline: ResizeReceiptBaseline,
): Promise<void> {
    const [expectedCols, expectedRows] = expectedGrid.split('x').map(Number);
    await expect
        .poll(async () => {
            const [allDesktopRecords, hostRecords] = await Promise.all([
                readStructuredLog(join(userData, 'logs', 'desktop.jsonl')),
                readStructuredLog(join(userData, 'logs', 'terminal-host.jsonl')),
            ]);
            const desktopRecords = allDesktopRecords.slice(baseline.desktopRecordCount);
            const isExpectedGrid = (record: StructuredLogRecord): boolean =>
                record.fields?.terminalId === terminalId &&
                record.fields.finalCols === expectedCols &&
                record.fields.finalRows === expectedRows;
            const latestHostResize = hostRecords.findLast(
                (record) =>
                    record.event === 'pty.resize_burst' && record.fields?.terminalId === terminalId,
            );
            return (
                desktopRecords.some(
                    (record) =>
                        record.event === 'renderer.terminal_resize_burst' && isExpectedGrid(record),
                ) && Boolean(latestHostResize && isExpectedGrid(latestHostResize))
            );
        })
        .toBe(true);
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
    const lastObservation: { ptyGrid?: string; rendererGrid: string | null } = {
        rendererGrid: null,
    };
    let matchingSamples = 0;
    let probeSequence = 0;
    let synchronizedGrid: string | undefined;

    await expect(surface).toHaveAttribute('data-terminal-attached', 'true');
    try {
        await expect
            .poll(async () => {
                const sampleMarker = `${marker}${probeSequence}_`;
                probeSequence += 1;
                const probe = String.raw`printf '${sampleMarker}%sx%s\n' "$(tput cols)" "$(tput lines)"`;
                await input.focus();
                await input.pressSequentially(probe);
                await input.press('Enter');
                await expect(rows).toContainText(
                    new RegExp(String.raw`${sampleMarker}\d+x\d+`, 'u'),
                );
                const [rendererGrid, terminalText] = await Promise.all([
                    surface.evaluate(
                        (element) => (element as HTMLElement).dataset.terminalGrid ?? null,
                    ),
                    rows.textContent(),
                ]);
                const ptyGrid = (terminalText ?? '').match(
                    new RegExp(String.raw`${sampleMarker}(\d+x\d+)`, 'u'),
                )?.[1];
                lastObservation.rendererGrid = rendererGrid;
                lastObservation.ptyGrid = ptyGrid;
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
    } catch (error) {
        throw new Error(
            `Terminal grid did not converge (renderer=${lastObservation.rendererGrid ?? 'missing'}, pty=${lastObservation.ptyGrid ?? 'missing'})`,
            { cause: error },
        );
    }

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
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl');
        await applyGpuPreference(running.page, 'Off');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'disabled');

        /**
         * The status bar chip is the shortest route out of the DOM renderer, so it must survive as a real button with a
         * confirmation in front of the settings write — not just as a tooltip that explains the slowdown.
         */
        const rendererChip = running.page.locator('button.statusbar-terminal-renderer');
        await expect(rendererChip).toHaveAttribute(
            'aria-label',
            'Turn on GPU acceleration? — Terminal renderer: DOM. GPU acceleration is turned off in Settings.',
        );
        await rendererChip.click();
        const confirmation = running.page.locator('.confirmation-dialog');
        await expect(confirmation).toContainText('Turn on GPU acceleration?');
        await running.page.keyboard.press('Escape');
        await expect(confirmation).toHaveCount(0);
        expect(
            (
                await pageRequest<{ value: { 'terminal.gpuAcceleration': string } }>(
                    running.page,
                    'settings.get',
                )
            ).value['terminal.gpuAcceleration'],
        ).toBe('off');

        await rendererChip.click();
        await confirmation.getByRole('button', { name: 'Turn On', exact: true }).click();
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: { 'terminal.gpuAcceleration': string };
                }>(running.page, 'settings.get');
                return settings.value['terminal.gpuAcceleration'];
            })
            .toBe('on');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl');
        await expect(rendererChip).toHaveCount(0);

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
        const desktopRecordsBeforeLoss = await readStructuredLog(
            join(userData, 'logs', 'desktop.jsonl'),
        );
        const resizeReceiptBaseline: ResizeReceiptBaseline = {
            desktopRecordCount: desktopRecordsBeforeLoss.length,
        };
        const incident = await pageRequest<{ correlationId: string }>(
            running.page,
            'gpu.testInjectContextLoss',
        );
        expect(incident.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
        await expect(surfaces.nth(0)).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surfaces.nth(1)).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surfaces.nth(0)).toHaveAttribute(
            'data-terminal-renderer-retry-state',
            'scheduled',
        );
        await expect(surfaces.nth(1)).toHaveAttribute(
            'data-terminal-renderer-retry-state',
            'scheduled',
        );
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
        await expect(surfaces.nth(0)).toHaveAttribute('data-terminal-renderer', 'webgl', {
            timeout: 8_000,
        });
        await expect(surfaces.nth(1)).toHaveAttribute('data-terminal-renderer', 'webgl', {
            timeout: 8_000,
        });
        await expect(surfaces.nth(0)).toHaveAttribute('data-terminal-renderer-reason', 'active');
        await expect(surfaces.nth(1)).toHaveAttribute('data-terminal-renderer-reason', 'active');
        await expect(surfaces.nth(0)).toHaveAttribute(
            'data-terminal-renderer-retry-state',
            'succeeded',
        );
        await expect(surfaces.nth(1)).toHaveAttribute(
            'data-terminal-renderer-retry-state',
            'succeeded',
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
        let retryRecords: StructuredLogRecord[] = [];
        await expect
            .poll(async () => {
                const records = await readStructuredLog(join(userData, 'logs', 'desktop.jsonl'));
                retryRecords = records.filter(
                    (record) =>
                        record.event === 'renderer.terminal_renderer_status' &&
                        record.correlationId === incident.correlationId,
                );
                return [terminalId, secondTerminalId].every((id) => {
                    const triggers = new Set(
                        retryRecords
                            .filter((record) => record.fields?.terminalId === id)
                            .map((record) => record.fields?.trigger),
                    );
                    return (
                        triggers.has('gpu-process-recovery') &&
                        triggers.has('webgl-retry-attempt') &&
                        triggers.has('webgl-retry-succeeded')
                    );
                });
            })
            .toBe(true);
        const retryReceipt = JSON.stringify(retryRecords);
        expect(retryReceipt).not.toContain('WEBGL_CONTINUITY');
        expect(retryReceipt).not.toContain('FIRST_PANE_SCROLLBACK');
        expect(retryReceipt).not.toContain('AFTER_WEBGL_FALLBACK');
        for (const record of retryRecords) {
            expect(record.fields).not.toHaveProperty('terminalOutput');
            expect(record.fields).not.toHaveProperty('command');
            expect(record.fields).not.toHaveProperty('path');
            expect(record.fields).not.toHaveProperty('environment');
        }

        const recoveredGrids = await Promise.all(
            [terminalId, secondTerminalId].map(async (id) => {
                const grid = await running.page
                    .locator(`.terminal-pane[data-terminal-id="${id}"] .terminal-surface`)
                    .getAttribute('data-terminal-grid');
                if (!grid || !/^\d+x\d+$/u.test(grid))
                    throw new Error(`Recovered Terminal ${id} has no bounded grid receipt`);
                await waitForSynchronizedResizeReceipts(userData, id, grid, resizeReceiptBaseline);
                return grid;
            }),
        );
        expect(recoveredGrids).toHaveLength(2);

        /**
         * WebGL renders to a canvas, so `.xterm-rows` exists only after switching back to DOM. Keep the original live
         * shell probe from #515 here while the structured receipts above prove the WebGL recovery transition itself.
         */
        await applyGpuPreference(running.page, 'Off');
        const synchronizedGrids = [
            await waitForSynchronizedTerminalGrid(running.page, terminalId),
            await waitForSynchronizedTerminalGrid(running.page, secondTerminalId),
        ];
        expect(synchronizedGrids.every((grid) => /^\d+x\d+$/u.test(grid))).toBe(true);
        await expect(secondRows).toContainText('atlas-160');
        await expect(firstRows).toContainText('FIRST_PANE_SCROLLBACK');

        await typeTerminal(running.page, String.raw`printf 'AFTER_WEBGL_RECOVERY\n'`);
        await expect(secondRows).toContainText('AFTER_WEBGL_RECOVERY');
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

test('repeated GPU incidents pin the session to DOM until the preference changes', async () => {
    allowE2EErrors([
        { source: 'desktop', event: 'gpu.process_gone', code: 'GPU_PROCESS_GONE', count: 3 },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-gpu-incident-budget-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
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
        const terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        await applyGpuPreference(running.page, 'On');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl');

        /**
         * Two incidents stay inside the session budget: each one falls back and the bounded retry chain brings WebGL
         * back. The third pins the whole session, so the retry chain ends with a closed reason instead of re-arming.
         */
        const injectRecoverableIncident = async (): Promise<void> => {
            await pageRequest(running.page, 'gpu.testInjectContextLoss');
            await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
            await expect(surface).toHaveAttribute('data-terminal-renderer', 'webgl', {
                timeout: 10_000,
            });
            await expect(surface).toHaveAttribute('data-terminal-renderer-reason', 'active');
        };
        await injectRecoverableIncident();
        await injectRecoverableIncident();
        await pageRequest(running.page, 'gpu.testInjectContextLoss');
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute(
            'data-terminal-renderer-reason',
            'context-loss-limit',
            { timeout: 10_000 },
        );
        await expect(surface).toHaveAttribute('data-terminal-renderer-retry-state', 'idle');
        const rendererChip = running.page.locator('.statusbar-terminal-renderer');
        await expect(rendererChip).toHaveAttribute(
            'aria-label',
            'Terminal renderer: DOM. WebGL was lost repeatedly (GPU process exits or context losses); it stays off until GPU acceleration is changed in Settings or Caxri restarts.',
        );
        await typeTerminal(running.page, String.raw`printf 'PINNED_DOM_STILL_LIVE\n'`);
        await expect(pane.locator('.xterm-rows')).toContainText('PINNED_DOM_STILL_LIVE');

        /**
         * The pin suppresses WebGL rebuilds, not the restore itself: one window restore (focus, visibilitychange, and
         * pageshow in the same task) still produces exactly one content redraw, and its diagnostic is recorded below.
         */
        const redrawsBeforePinnedRestore = Number(
            (await surface.getAttribute('data-terminal-renderer-redraws')) ?? 0,
        );
        await running.page.evaluate(() => {
            dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
            dispatchEvent(new Event('pageshow'));
        });
        await expect
            .poll(async () =>
                Number((await surface.getAttribute('data-terminal-renderer-redraws')) ?? 0),
            )
            .toBe(redrawsBeforePinnedRestore + 1);
        await expect(surface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(surface).toHaveAttribute(
            'data-terminal-renderer-reason',
            'context-loss-limit',
        );

        // A pane mounted after the budget tripped never creates a WebGL context either.
        await pressNewTerminal(running.page);
        const secondTerminalId = await waitForNewTerminalId(running.page, [terminalId]);
        const secondSurface = running.page.locator(
            `.terminal-pane[data-terminal-id="${secondTerminalId}"] .terminal-surface`,
        );
        await expect(secondSurface).toHaveAttribute('data-terminal-renderer', 'dom');
        await expect(secondSurface).toHaveAttribute(
            'data-terminal-renderer-reason',
            'context-loss-limit',
        );
        await expect(secondSurface).toHaveAttribute('data-terminal-webgl-context-losses', '0');

        // Changing the preference is the user's request to try again and clears the session budget.
        await applyGpuPreference(running.page, 'Auto');
        await expect(secondSurface).toHaveAttribute('data-terminal-renderer', 'webgl');
        await expect(secondSurface).toHaveAttribute('data-terminal-renderer-reason', 'active');

        const desktopRecords = await readStructuredLog(join(userData, 'logs', 'desktop.jsonl'));
        const limitRecords = desktopRecords.filter(
            (record) =>
                record.event === 'renderer.terminal_renderer_status' &&
                record.fields?.trigger === 'gpu-incident-limit',
        );
        expect(limitRecords.length).toBeGreaterThan(0);
        expect(limitRecords.every((record) => record.fields?.reason === 'context-loss-limit')).toBe(
            true,
        );

        // The third incident pins the session once, with that incident's correlation; the preference change resets it.
        const incidentIds = desktopRecords
            .filter((record) => record.event === 'gpu.process_gone')
            .map((record) => record.correlationId);
        expect(incidentIds).toHaveLength(3);
        const budgetRecords = desktopRecords.filter(
            (record) => record.event === 'gpu.session_budget',
        );
        expect(
            budgetRecords.map((record) => [
                record.fields?.transition,
                record.fields?.cause,
                record.fields?.incidentCount,
            ]),
        ).toEqual([
            ['pinned', 'gpu-incident', 3],
            ['reset', 'preference-change', 3],
        ]);
        expect(budgetRecords[0]?.correlationId).toBe(incidentIds[2]);

        // The restore after the pin is still measured, and its three events were merged into one restore.
        const pinnedRestores = desktopRecords.filter(
            (record) =>
                record.event === 'renderer.terminal_renderer_status' &&
                record.fields?.trigger === 'visibility-restore' &&
                record.fields.reason === 'context-loss-limit',
        );
        expect(pinnedRestores.length).toBeGreaterThan(0);
        expect(
            Number(pinnedRestores.at(-1)?.fields?.visibilityRestoreCoalescedCount),
        ).toBeGreaterThanOrEqual(2);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
