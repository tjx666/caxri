import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';

interface PersistedTerminalGridSnapshot {
    cols: number;
    encodingVersion: number;
    payload: string;
    rows: number;
}

async function typeTerminal(page: Page, command: string): Promise<void> {
    const input = page.locator('.xterm-helper-textarea').last();
    await input.focus();
    await input.pressSequentially(command);
    await input.press('Enter');
}

async function latestAgentGrid(path: string, generation: number): Promise<string | undefined> {
    let text = '';
    try {
        text = await readFile(path, 'utf8');
    } catch {
        // The recording file may not exist yet.
    }
    return text
        .trim()
        .split('\n')
        .findLast((line) => line.startsWith(`${generation}:`))
        ?.slice(`${generation}:`.length);
}

async function firstAgentGrid(path: string, generation: number): Promise<string | undefined> {
    let text = '';
    try {
        text = await readFile(path, 'utf8');
    } catch {
        // The recording file may not exist yet.
    }
    return text
        .trim()
        .split('\n')
        .find((line) => line.startsWith(`${generation}:`))
        ?.slice(`${generation}:`.length);
}

async function hasExpectedAgentScreen(
    page: Page,
    generation: number,
    grid: string,
): Promise<boolean> {
    const [cols, rows] = grid.split('x').map(Number);
    if (!cols || !rows) return false;
    const renderedRows = await page.locator('.xterm-rows > div').allTextContents();
    const horizontal = '─'.repeat(cols - 2);
    return (
        renderedRows.length === rows &&
        renderedRows[0] === `┌${horizontal}┐` &&
        renderedRows[1]?.startsWith(`│GEN ${generation} GRID ${grid} 中`) &&
        renderedRows[1]?.endsWith('│') &&
        renderedRows.at(-1) === `└${horizontal}┘`
    );
}

async function waitForStableAgentGrid(
    page: Page,
    path: string,
    generation: number,
): Promise<string> {
    let candidate: string | undefined;
    let matchingSamples = 0;
    let stableGrid: string | undefined;
    await expect
        .poll(async () => {
            const latest = await latestAgentGrid(path, generation);
            if (
                !latest ||
                latest === '100x30' ||
                !(await hasExpectedAgentScreen(page, generation, latest))
            ) {
                candidate = undefined;
                matchingSamples = 0;
                return;
            }
            if (latest === candidate) matchingSamples += 1;
            else {
                candidate = latest;
                matchingSamples = 1;
            }
            if (matchingSamples < 3) return;
            stableGrid = latest;
            return latest;
        })
        .toMatch(/^\d+x\d+$/);
    return stableGrid!;
}

async function hasPersistedGridFrame(page: Page, terminalId: string): Promise<boolean> {
    const rows = await page
        .locator(`.terminal-pane[data-terminal-id="${terminalId}"] .xterm-rows > div`)
        .allTextContents();
    return (
        rows[0]?.startsWith('+------') === true &&
        rows[1]?.startsWith('|SNAPSHOT_GRID_') === true &&
        rows[2]?.startsWith('|ASCII_CJK_你好_界') === true &&
        rows[3]?.startsWith('    CURSOR_MARK_界') === true
    );
}

async function renderedTerminalGrid(page: Page, terminalId: string): Promise<string | null> {
    return page
        .locator(`.terminal-pane[data-terminal-id="${terminalId}"] .terminal-surface`)
        .evaluate((surface) => (surface as HTMLElement).dataset.terminalGrid ?? null);
}

function backpressureAgentFixture(): string {
    return String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('caxri-fake-codex 1.0.0\n');
  process.exit(0);
}
const escape = '\x1b';
const burst = (escape + '[H' + 'X'.repeat(192)).repeat(6144);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  const input = chunk.toString('utf8');
  if (input.includes('b')) {
    process.stdout.write(
      escape + '[?1049h' + escape + '[2J' + burst +
      escape + '[2J' + escape + '[HBACKPRESSURE_SCREEN_READY'
    );
  }
  if (input.includes('i')) process.stdout.write('\r\nBACKPRESSURE_INPUT_READY\r\n');
});
process.stdout.write('BACKPRESSURE_FIXTURE_READY\r\n');
`;
}

test('live Terminal restores the authoritative screen after Renderer output backpressure', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-backpressure-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { executableSource: backpressureAgentFixture() } },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: {
            /**
             * Keep the production 256 KiB ceiling while making the fixture's 1.1 MiB burst accumulate in one coalescing
             * window. The ordinary 16 ms window can drain fast enough on an idle runner to avoid the backpressure this
             * behavior-level test is required to exercise.
             */
            CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS: '1000',
        },
    });
    try {
        await createProjectSession(running.page, 'codex');
        const pane = running.page.locator('.terminal-pane');
        const rows = pane.locator('.xterm-rows');
        const input = pane.locator('.xterm-helper-textarea');
        const terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        await expect(rows).toContainText('BACKPRESSURE_FIXTURE_READY');
        const before = await pageRequest<{
            terminals: Array<{ id: string; processId?: number }>;
        }>(running.page, 'app.bootstrap');
        const processId = before.terminals.find(({ id }) => id === terminalId)?.processId;
        expect(typeof processId).toBe('number');

        await input.focus();
        await input.press('b');
        let droppedBytes = 0;
        await expect
            .poll(async () => {
                try {
                    const records = (
                        await readFile(join(userData, 'logs', 'terminal-host.jsonl'), 'utf8')
                    )
                        .trim()
                        .split('\n')
                        .map((line) => JSON.parse(line) as Record<string, unknown>);
                    const throughput = records.findLast((record) => {
                        const fields = record.fields as Record<string, unknown> | undefined;
                        return (
                            record.event === 'pty.throughput' &&
                            fields?.terminalId === terminalId &&
                            Number(fields.droppedBytes) > 0
                        );
                    });
                    const fields = throughput?.fields as Record<string, unknown> | undefined;
                    droppedBytes = Number(fields?.droppedBytes) || 0;
                    return droppedBytes;
                } catch {
                    return 0;
                }
            })
            .toBeGreaterThan(0);
        console.log(`CAXRI_E2E_TERMINAL_BACKPRESSURE ${JSON.stringify({ droppedBytes })}`);
        await expect(rows).toContainText('BACKPRESSURE_SCREEN_READY');
        await expect(rows).not.toContainText('dropped by output backpressure');

        await input.focus();
        await input.press('i');
        await expect(rows).toContainText('BACKPRESSURE_INPUT_READY');
        await expect(pane).toHaveAttribute('data-terminal-id', terminalId);
        const after = await pageRequest<{
            terminals: Array<{ id: string; processId?: number }>;
        }>(running.page, 'app.bootstrap');
        expect(after.terminals.find(({ id }) => id === terminalId)?.processId).toBe(processId);
        await expect.poll(() => pageRequest<number>(running.page, 'terminal.runningCount')).toBe(1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('normal exit stays neutral and restart preserves one durable Terminal', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-recovery-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page, 'shell');
        const pane = running.page.locator('.terminal-pane');
        const terminalId = await pane.getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        const tabCount = await running.page.locator('.work-tab[data-terminal-id]').count();

        await typeTerminal(running.page, String.raw`printf 'FINAL_OUTPUT_IS_VISIBLE\n'; exit`);
        const stopped = running.page.locator('[data-terminal-exit-state="stopped"]');
        await expect(stopped).toContainText('Process exited normally');
        await expect(stopped).toHaveClass(/terminal-recovery-neutral/);
        await expect(running.page.locator('.xterm-rows')).toContainText('FINAL_OUTPUT_IS_VISIBLE');

        const [surfaceBox, recoveryBox] = await Promise.all([
            running.page.locator('.terminal-surface').boundingBox(),
            stopped.boundingBox(),
        ]);
        if (!surfaceBox || !recoveryBox) throw new Error('Terminal recovery layout is missing');
        expect(surfaceBox.y + surfaceBox.height).toBeLessThanOrEqual(recoveryBox.y + 1);

        const restart = stopped.getByRole('button', { name: 'Restart Terminal' });
        await restart.focus();
        await running.page.keyboard.press('Enter');
        await expect(stopped).toHaveCount(0);
        await expect(running.page.locator('.process-running')).toBeVisible();
        await expect(running.page.locator('.work-tab[data-terminal-id]')).toHaveCount(tabCount);
        await expect(pane).toHaveAttribute('data-terminal-id', terminalId);
        await expect.poll(() => pageRequest<number>(running.page, 'terminal.runningCount')).toBe(1);

        await typeTerminal(running.page, 'kill -9 $$');
        const dead = running.page.locator('[data-terminal-exit-state="dead"]');
        await expect(dead).toContainText('Terminal stopped unexpectedly');
        await expect(dead).toHaveClass(/terminal-recovery-danger/);

        await running.page.keyboard.press('Meta+Shift+R');
        await expect(dead).toHaveCount(0);
        await expect(running.page.locator('.process-running')).toBeVisible();
        await expect(pane).toHaveAttribute('data-terminal-id', terminalId);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('stopped Terminal snapshots restore at their source grid before fitting a changed pane width', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-stopped-grid-restore-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });
    await writeFile(
        join(root, 'stopped-grid-fixture.zsh'),
        String.raw`cols=$(tput cols)
rows=$(tput lines)
horizontal=$(printf '%*s' "$((cols - 2))" '' | tr ' ' '-')
printf '\033[?1049h\033[2J\033[H'
printf '\033[1;1H+%s+' "$horizontal"
printf '\033[2;1H|SNAPSHOT_GRID_%sx%s_中' "$cols" "$rows"
printf '\033[2;%sH|' "$cols"
printf '\033[3;1H|ASCII_CJK_你好_界'
printf '\033[3;%sH|' "$cols"
printf '\033[%s;1H+%s+' "$rows" "$horizontal"
printf '\033[4;5HCURSOR_MARK_界'
`,
        'utf8',
    );

    const running = await launchCaxri({ userDataDir: userData, testRootPath: root });
    try {
        await running.page.setViewportSize({ height: 800, width: 1_200 });
        await createProjectSession(running.page, 'shell');
        const firstSessionId = await selectedSessionId(running.page);
        const terminalId = await running.page
            .locator('.terminal-pane[data-terminal-id]')
            .getAttribute('data-terminal-id');
        if (!terminalId) throw new Error('Terminal identity was not rendered');
        await expect
            .poll(() => renderedTerminalGrid(running.page, terminalId))
            .toMatch(/^\d+x\d+$/);
        const sourceGrid = await renderedTerminalGrid(running.page, terminalId);
        if (!sourceGrid) throw new Error('Source Terminal grid was not published');
        const [sourceCols] = sourceGrid.split('x').map(Number);

        await typeTerminal(running.page, 'exec zsh stopped-grid-fixture.zsh');
        await expect(running.page.locator('[data-terminal-exit-state="stopped"]')).toBeVisible();
        const snapshot = await pageRequest<PersistedTerminalGridSnapshot | null>(
            running.page,
            'terminal.snapshot',
            { terminalId },
        );
        expect(snapshot).toMatchObject({ cols: sourceCols, encodingVersion: 3 });

        await createAdditionalShellSession(running.page);
        const secondSessionId = await selectedSessionId(running.page);
        const firstSession = sessionCard(running.page, firstSessionId);
        const secondSession = sessionCard(running.page, secondSessionId);

        for (const width of [1_200, 720, 1_600]) {
            // eslint-disable-next-line no-await-in-loop -- each width must mount and finish its persisted replay before the next one starts
            await running.page.setViewportSize({ height: 800, width });
            // eslint-disable-next-line no-await-in-loop -- Session switches are the user action that remounts the stopped xterm
            await firstSession.click();
            // eslint-disable-next-line no-await-in-loop -- the replay transaction publishes its final fitted grid only after xterm.write completes
            await expect
                .poll(() => renderedTerminalGrid(running.page, terminalId))
                .toMatch(/^\d+x\d+$/);
            // eslint-disable-next-line no-await-in-loop -- read back the grid that the replay transaction just published
            const finalGrid = await renderedTerminalGrid(running.page, terminalId);
            if (!finalGrid) throw new Error('Final Terminal grid was not published');
            const [finalCols] = finalGrid.split('x').map(Number);
            if (width === 1_200) expect(finalCols).toBe(sourceCols);
            else if (width < 1_200) expect(finalCols).toBeLessThan(sourceCols);
            else expect(finalCols).toBeGreaterThan(sourceCols);
            // eslint-disable-next-line no-await-in-loop -- frame parsing must settle after the source-grid replay and final fit
            await expect.poll(() => hasPersistedGridFrame(running.page, terminalId)).toBe(true);
            // eslint-disable-next-line no-await-in-loop -- switch away so the next width forces a fresh persisted attachment
            await secondSession.click();
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

test('startup failure uses a compact danger status without covering output', async () => {
    allowE2EErrors([
        {
            source: 'server-core',
            event: 'pty.spawn_failed',
            code: 'UNAVAILABLE',
            count: 1,
        },
    ]);
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-terminal-failed-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await mkdir(root, { recursive: true });

    const running = await launchCaxri({
        agentMode: { mode: 'blocked' },
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: '/caxri-e2e-missing', SHELL: '/usr/bin/false' },
    });
    try {
        await createProjectSession(running.page, 'codex');
        const failed = running.page.locator('[data-terminal-exit-state="failed"]');
        await expect(failed).toContainText('Agent CLI executable was not found');
        await expect(failed).toHaveClass(/terminal-recovery-danger/);
        await expect(failed.getByRole('button', { name: 'Restart Terminal' })).toBeVisible();

        const [surfaceBox, recoveryBox] = await Promise.all([
            running.page.locator('.terminal-surface').boundingBox(),
            failed.boundingBox(),
        ]);
        if (!surfaceBox || !recoveryBox) throw new Error('Terminal failure layout is missing');
        expect(surfaceBox.y + surfaceBox.height).toBeLessThanOrEqual(recoveryBox.y + 1);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

for (const agent of [
    { kind: 'codex', name: 'Codex' },
    { kind: 'claude', name: 'Claude Code' },
] as const) {
    test(`restored ${agent.name} Terminal renders its cursor-addressed first screen at the visible grid`, async () => {
        const testDirectory = await mkdtemp(join(tmpdir(), `caxri-${agent.kind}-grid-e2e-`));
        const userData = join(testDirectory, 'user-data');
        const root = join(testDirectory, 'project');
        const generationFile = join(testDirectory, 'generation');
        const gridLog = join(testDirectory, 'grid.log');
        await mkdir(root, { recursive: true });
        const agentMode = await createFakeAgentMode({
            userDataDir: userData,
            providers: {
                [agent.kind]: {
                    executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log(${JSON.stringify(`${agent.kind}-grid-test 1.0`)});
  process.exit(0);
}
const generationPath = ${JSON.stringify(generationFile)};
const gridLog = ${JSON.stringify(gridLog)};
const generation = fs.existsSync(generationPath)
  ? Number(fs.readFileSync(generationPath, 'utf8')) + 1
  : 1;
fs.writeFileSync(generationPath, String(generation));
const escape = '\x1b';
let redrawTimer;
function render() {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  const grid = cols + 'x' + rows;
  fs.appendFileSync(gridLog, generation + ':' + grid + '\n');
  const label = 'GEN ' + generation + ' GRID ' + grid + ' ';
  const horizontal = '─'.repeat(Math.max(0, cols - 2));
  const contentPadding = ' '.repeat(Math.max(0, cols - 2 - label.length - 2));
  process.stdout.write(
    escape + '[?1049h' + escape + '[2J' +
    escape + '[1;1H┌' + horizontal + '┐' +
    escape + '[2;1H│' + label + '中' + contentPadding + '│' +
    escape + '[' + rows + ';1H└' + horizontal + '┘' +
    escape + '[3;2H'
  );
}
function scheduleRender() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(render, 10);
}
process.on('SIGWINCH', scheduleRender);
process.stdin.resume();
render();
`,
                },
            },
        });
        const launchOptions = {
            agentMode,
            userDataDir: userData,
            testRootPath: root,
        };

        let running = await launchCaxri(launchOptions);
        try {
            await createProjectSession(running.page, agent.kind);
            await expect(running.page.locator('.process-running')).toBeVisible();
            await running.app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1200, height: 800 }),
            );
            const intermediateGrid = await waitForStableAgentGrid(running.page, gridLog, 1);
            await running.app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]?.setBounds({ width: 960, height: 640 }),
            );
            await expect.poll(() => latestAgentGrid(gridLog, 1)).not.toBe(intermediateGrid);
            const expectedGrid = await waitForStableAgentGrid(running.page, gridLog, 1);

            await running.app.close();
            running = await launchCaxri(launchOptions);
            await expect(running.page.locator('.process-running')).toBeVisible();
            await expect.poll(() => firstAgentGrid(gridLog, 2)).toBe(expectedGrid);
            expect(await waitForStableAgentGrid(running.page, gridLog, 2)).toBe(expectedGrid);
        } finally {
            try {
                await running.app.close();
            } catch {
                // Ignore close failures during cleanup.
            }
            await rm(testDirectory, { recursive: true, force: true });
        }
    });
}
