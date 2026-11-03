import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator, Page } from '@playwright/test';

import { expect } from './fixtures.ts';
import type { RunningCaxri } from './helpers.ts';
import { closeAppQuietly, launchCaxri, pageRequest, sessionCard } from './helpers.ts';
import { runServerDatabase } from './run-server-database.ts';
import type { DelegatedSessionsSeed } from './server-database/delegated-sessions-seed.ts';

/**
 * Titles of the seeded Projects, which are their folder names.
 */
export const HOST_PROJECT = 'host-project';
export const WORKER_PROJECT = 'worker-project';

export interface DelegatedSessionsFixture extends DelegatedSessionsSeed {
    /**
     * Closes the app and removes the profile.
     */
    cleanup(): Promise<void>;
    running: RunningCaxri;
}

/**
 * Seeds a profile with delegated, consulted and handed-off Sessions across two Projects (see
 * `server-database/delegated-sessions-seed.ts`), launches the app on it, and selects the host. Only a Server-side Agent
 * can create a delegated Session, so the profile is seeded before the first launch.
 */
export async function launchDelegatedSessions(
    prefix: string,
    fanOut = 5,
): Promise<DelegatedSessionsFixture> {
    const temporary = await mkdtemp(join(tmpdir(), `${prefix}-`));
    const directory = await realpath(temporary);
    const userData = join(directory, 'profile');
    const roots: [string, string] = [
        join(directory, HOST_PROJECT),
        join(directory, WORKER_PROJECT),
    ];
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    await mkdir(userData, { recursive: true });
    const seed = await runServerDatabase<DelegatedSessionsSeed>('delegated-sessions-seed', {
        userData,
        roots,
        fanOut,
    });
    const running = await launchCaxri({ userDataDir: userData, testRootPath: roots[0] });
    const cleanup = async () => {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    };
    try {
        await selectSession(running.page, seed.host);
    } catch (error) {
        await cleanup();
        throw error;
    }
    return { ...seed, cleanup, running };
}

/**
 * The ids in a stable order, for comparing the members of a group whose row order the test does not pin.
 */
export function sorted(ids: readonly string[]): string[] {
    return ids.toSorted((a, b) => a.localeCompare(b));
}

/**
 * Selects a Session through the Server and waits for the sidebar to mark its row selected.
 */
export async function selectSession(page: Page, sessionId: string): Promise<void> {
    await pageRequest(page, 'session.select', { sessionId });
    await expect(sessionCard(page, sessionId)).toHaveAttribute('aria-selected', 'true');
}

/**
 * The rows nested under a host, as the tree renders them: level-3 Session rows in the host's `Delegated Sessions`
 * group.
 */
export function nestedGroup(page: Page, hostTitle: string): Locator {
    return page.getByRole('group', { name: `Delegated Sessions under ${hostTitle}` });
}

/**
 * The tree row of a nested Session; its id is namespaced so a Session never has two DOM ids.
 */
export function nestedRow(page: Page, sessionId: string): Locator {
    return page.locator(`[data-row-id="delegated-session:${sessionId}"]`);
}

/**
 * The Session ids of the rows in `scope`, top to bottom.
 */
export function sessionIdsIn(scope: Locator): Promise<string[]> {
    return scope
        .locator('.session-card')
        .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.sessionId ?? ''));
}

/**
 * Runs a palette command by its title, such as `Select Next Session`.
 */
export async function runPaletteCommand(page: Page, title: string): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog', { name: 'Command Palette' });
    await palette.getByRole('combobox').fill(title);
    await palette.getByRole('option', { name: new RegExp(`^${title}`, 'u') }).click();
    await expect(palette).toBeHidden();
}

/**
 * Opens a Session from the palette's Session results by its title.
 */
export async function openSessionFromPalette(page: Page, title: string): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog', { name: 'Command Palette' });
    await palette.getByRole('combobox').fill(title);
    await palette
        .getByRole('option', { name: new RegExp(title, 'u') })
        .first()
        .click();
    await expect(palette).toBeHidden();
}
