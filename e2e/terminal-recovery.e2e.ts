import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { Page } from './support/fixtures.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

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

test('startup failure uses a compact danger status without covering output', async () => {
    allowE2EErrors([
        {
            source: 'runtime',
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
