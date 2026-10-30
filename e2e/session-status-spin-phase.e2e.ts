import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings } from '@caxri/protocol';
import type { Page } from '@playwright/test';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    waitForCreatedSession,
} from './support/helpers.ts';
import { openProjectNewSessionMenu } from './support/project-new-session-menu.ts';

async function readFileIfPresent(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return '';
        throw error;
    }
}

/**
 * Fires one fake Claude hook through whichever fake process has not fired it yet, then waits for its receipt. Every
 * fake Claude polls the same config directory, so each one fires a trigger at most once: firing it again reaches the
 * Session started after the first one.
 */
async function fireHook(config: string, name: string): Promise<void> {
    await rm(join(config, `${name}.receipt`), { force: true });
    await writeFile(join(config, name), '', 'utf8');
    await expect
        .poll(async () => {
            const receipt = await readFileIfPresent(join(config, `${name}.receipt`));
            if (receipt === 'failed') throw new Error('Fake Claude hook invocation failed');
            return receipt;
        })
        .toBe('done');
}

/**
 * Every ring's rotation phase in turns, sampled in one task so all of them read the same timeline moment. A ring with
 * no animation (reduced motion) reports `null`.
 */
function sampleRingPhases(page: Page, selector: string): Promise<Array<number | null>> {
    return page.evaluate(
        (ringSelector) =>
            [...document.querySelectorAll(ringSelector)].map((ring) => {
                const animation = ring.getAnimations().at(0);
                const time = animation?.currentTime;
                const period = animation?.effect?.getComputedTiming().duration;
                if (typeof time !== 'number' || typeof period !== 'number') return null;
                return (time % period) / period;
            }),
        selector,
    );
}

/**
 * The shortest distance between two phases on the circle, in turns.
 */
function phaseDistance(first: number, second: number): number {
    const distance = Math.abs(first - second) % 1;
    return Math.min(distance, 1 - distance);
}

/**
 * About one millisecond of a 1 s turn: rings on the shared phase read the same angle up to float rounding.
 */
const PHASE_TOLERANCE = 0.002;

async function expectRingsInPhase(page: Page, selector: string): Promise<void> {
    const phases = await sampleRingPhases(page, selector);
    expect(phases).toHaveLength(2);
    const [first, second] = phases;
    if (first === null || second === null) throw new Error('A status ring is not animating');
    expect(phaseDistance(first, second)).toBeLessThan(PHASE_TOLERANCE);
}

/**
 * Waits until a ring has advanced at least `milliseconds` since it was sampled, so the next ring mounts at another
 * phase.
 */
async function waitForRingToAdvance(
    page: Page,
    selector: string,
    milliseconds: number,
): Promise<void> {
    const start = await page.evaluate(
        (ringSelector) => document.querySelector(ringSelector)?.getAnimations()[0]?.currentTime,
        selector,
    );
    if (typeof start !== 'number') throw new Error('The first status ring is not animating');
    await expect
        .poll(() =>
            page.evaluate(
                (ringSelector) =>
                    document.querySelector(ringSelector)?.getAnimations()[0]?.currentTime,
                selector,
            ),
        )
        .toBeGreaterThan(start + milliseconds);
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('Session status rings started at different moments turn on one shared phase', async ({}, testInfo) => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-spin-phase-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const config = join(userData, 'e2e-agents', 'claude');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.296 (Claude Code)\n');
  process.exit(0);
}
const config = process.env.CLAUDE_CONFIG_DIR;
function invokeHook(event, payload) {
  const settings = JSON.parse(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'));
  const group = settings.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify(payload),
  });
}
const actions = [
  ['turn-started', 'UserPromptSubmit', {}],
  ['finished-with-background', 'Stop', {
    background_tasks: [{ id: 'agent-1', type: 'subagent', status: 'running' }],
  }],
];
const fired = new Set();
setInterval(() => {
  for (const [name, event, payload] of actions) {
    const trigger = path.join(config, name);
    if (fired.has(name) || !fs.existsSync(trigger)) continue;
    try {
      fs.rmSync(trigger);
    } catch {
      continue;
    }
    fired.add(name);
    try {
      invokeHook(event, payload);
      fs.writeFileSync(trigger + '.receipt', 'done');
    } catch {
      fs.writeFileSync(trigger + '.receipt', 'failed');
    }
  }
}, 25);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write('Fake Claude spin phase ready\r\n');
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        testRootPath: root,
        userDataDir: userData,
    });
    const { page } = running;
    const arcs = '.session-status [data-session-status-arc]';
    const backgroundRings = '.session-status [data-session-status-background]';

    try {
        const current = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
        const settings = structuredClone(current.value);
        settings['agents.providers'].claude.hooks.enabled = true;
        await pageRequest(page, 'settings.update', { source: JSON.stringify(settings, null, 2) });
        await expect
            .poll(() => readFileIfPresent(join(config, 'settings.json')))
            .toContain('UserPromptSubmit');

        const firstId = await createProjectSession(page, 'claude');
        await expect(page.locator('.xterm-rows').last()).toContainText(
            'Fake Claude spin phase ready',
        );
        const firstStatus = page.locator(`[data-session-id="${firstId}"] .session-status`);
        await fireHook(config, 'turn-started');
        await expect(firstStatus.locator('[data-session-status-arc]')).toBeVisible();

        await openProjectNewSessionMenu(page);
        await chooseTerminalFromCreateMenu(page, 'Claude');
        await page.mouse.move(900, 600);
        const secondId = await waitForCreatedSession(page, firstId);
        await expect(page.locator('.workbench-session:not([hidden]) .xterm-rows')).toContainText(
            'Fake Claude spin phase ready',
        );
        const secondStatus = page.locator(`[data-session-id="${secondId}"] .session-status`);

        /**
         * Half a turn on top of the creation work keeps the second arc's own mount time well away from the first's
         * phase, which is what an arc animated from its own mount moment would keep forever.
         */
        await waitForRingToAdvance(page, arcs, 500);
        await fireHook(config, 'turn-started');
        await expect(secondStatus.locator('[data-session-status-arc]')).toBeVisible();
        await expectRingsInPhase(page, arcs);
        await waitForRingToAdvance(page, arcs, 1250);
        await expectRingsInPhase(page, arcs);

        // Reduced motion stills every ring; turning motion back on creates fresh animations, which rejoin the phase.
        await page.emulateMedia({ reducedMotion: 'reduce' });
        expect(await sampleRingPhases(page, arcs)).toEqual([null, null]);
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect
            .poll(async () => (await sampleRingPhases(page, arcs)).includes(null))
            .toBe(false);
        await expectRingsInPhase(page, arcs);

        // The slower background ring keeps its own 3 s period and its own shared phase. Both fake Claude processes watch
        // the same trigger, so either Session may be the one whose turn finishes first.
        await fireHook(config, 'finished-with-background');
        await expect(page.locator(backgroundRings)).toHaveCount(1);
        await waitForRingToAdvance(page, backgroundRings, 1500);
        await fireHook(config, 'finished-with-background');
        await expect(firstStatus.locator('[data-session-status-background]')).toBeVisible();
        await expect(secondStatus.locator('[data-session-status-background]')).toBeVisible();
        expect(
            await page.evaluate(
                (selector) =>
                    [...document.querySelectorAll(selector)].map(
                        (ring) => ring.getAnimations()[0]?.effect?.getComputedTiming().duration,
                    ),
                backgroundRings,
            ),
        ).toEqual([3000, 3000]);
        await expectRingsInPhase(page, backgroundRings);
        await page.screenshot({ path: testInfo.outputPath('spin-phase.png') });
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
