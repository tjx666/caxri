import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { expect, test } from './support/fixtures.ts';
import { launchCaxri, waitForRuntimeReady } from './support/helpers.ts';

const projectRoot = resolve(import.meta.dirname, '..');
/**
 * Mirrors `BASELINE_SCHEMA_VERSION`; the manifest itself imports SQL through `?raw`, which Playwright cannot load. A
 * later migration upgrades this seeded database like any other post-baseline install.
 */
const BASELINE_SCHEMA_VERSION = 54;

async function seedProjects(databasePath: string, roots: string[]): Promise<void> {
    const database = new Database(databasePath);
    const baseline = await readFile(
        join(projectRoot, 'apps/server/src/domains/db/migrations/0000_baseline.sql'),
        'utf8',
    );
    database.exec(baseline.replaceAll('--> statement-breakpoint', ''));
    /**
     * Keep the drag fixture recent so the default idle-collapse policy cannot hide its Session after 500ms.
     */
    const fixtureCreatedAt = Date.now();
    const insert = database.prepare(
        `INSERT INTO projects
         (id, root_path, display_title, order_index, created_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    );
    roots.forEach((root, orderIndex) => {
        const title = root.split('/').at(-1)!;
        insert.run(
            `project-${orderIndex}`,
            root,
            title,
            orderIndex,
            fixtureCreatedAt,
            fixtureCreatedAt,
        );
    });
    database
        .prepare(
            `INSERT INTO sessions
             (id, project_id, created_at, last_opened_at, last_session_activity_at, display_title)
             VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
            'session-0',
            'project-0',
            fixtureCreatedAt,
            fixtureCreatedAt,
            fixtureCreatedAt,
            'Alpha Session',
        );
    database.pragma(`user_version = ${BASELINE_SCHEMA_VERSION}`);
    database.close();
}

test('Project drag ordering shows feedback and persists across reload', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-order-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const roots = ['alpha', 'beta', 'gamma'].map((name) => join(testDirectory, name));
    await Promise.all([mkdir(userData), ...roots.map((root) => mkdir(root))]);
    await seedProjects(join(userData, 'caxri.db'), roots);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: roots[0] });
    const projectTitles = () => running.page.locator('.project-select strong').allTextContents();
    try {
        await expect.poll(projectTitles).toEqual(['alpha', 'beta', 'gamma']);
        // Session rows hydrate after Project headings; the drag target must exist before dispatching events.
        await expect(
            running.page.locator(
                '.project-group[data-project-id="project-0"] [data-session-id="session-0"]',
            ),
        ).toBeVisible();

        await running.page.evaluate(() => {
            const source = document.querySelector<HTMLElement>(
                '.project-heading[data-project-id="project-2"]',
            );
            const target = document.querySelector<HTMLElement>(
                '.project-group[data-project-id="project-0"]',
            );
            const targetHeading = target?.querySelector<HTMLElement>('.project-heading');
            if (!source || !target || !targetHeading)
                throw new Error('Project drag fixtures not found');
            const transfer = new DataTransfer();
            // Assigning onto `globalThis` is the deliberate bridge that lets the later
            // `page.evaluate` calls in this test recover the same DataTransfer instance.
            Object.defineProperty(globalThis, 'projectDragTransfer', {
                configurable: true,
                value: transfer,
                writable: true,
            });
            source.dispatchEvent(
                new DragEvent('dragstart', {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer: transfer,
                }),
            );
            const session = target.querySelector<HTMLElement>('[data-session-id="session-0"]');
            if (!session) throw new Error('Project Session drag fixture not found');
            const bounds = session.getBoundingClientRect();
            session.dispatchEvent(
                new DragEvent('dragover', {
                    bubbles: true,
                    cancelable: true,
                    clientY: bounds.top + bounds.height / 2,
                    dataTransfer: transfer,
                }),
            );
        });

        await expect(running.page.locator('.project-drop-marker')).toHaveCount(0);

        await running.page.evaluate(() => {
            const targetHeading = document.querySelector<HTMLElement>(
                '.project-heading[data-project-id="project-0"]',
            );
            const transfer = (globalThis as unknown as { projectDragTransfer?: DataTransfer })
                .projectDragTransfer;
            if (!targetHeading || !transfer) throw new Error('Project drag target not found');
            const bounds = targetHeading.getBoundingClientRect();
            targetHeading.dispatchEvent(
                new DragEvent('dragover', {
                    bubbles: true,
                    cancelable: true,
                    clientY: bounds.top + 1,
                    dataTransfer: transfer,
                }),
            );
        });

        await expect(
            running.page.locator(
                '.project-group[data-project-id="project-0"] .project-drop-marker',
            ),
        ).toHaveAttribute('data-drop-edge', 'before');
        await expect(running.page.locator('.project-group[data-project-id="project-2"]')).toHaveCSS(
            'opacity',
            '0.4',
        );

        await running.page.evaluate(() => {
            const session = document.querySelector<HTMLElement>('[data-session-id="session-0"]');
            const transfer = (globalThis as unknown as { projectDragTransfer?: DataTransfer })
                .projectDragTransfer;
            if (!session || !transfer) throw new Error('Project Session drag fixture not found');
            const bounds = session.getBoundingClientRect();
            session.dispatchEvent(
                new DragEvent('dragover', {
                    bubbles: true,
                    cancelable: true,
                    clientY: bounds.top + bounds.height / 2,
                    dataTransfer: transfer,
                }),
            );
        });

        await expect(running.page.locator('.project-drop-marker')).toHaveCount(0);

        await running.page.evaluate(() => {
            const targetHeading = document.querySelector<HTMLElement>(
                '.project-heading[data-project-id="project-0"]',
            );
            const transfer = (globalThis as unknown as { projectDragTransfer?: DataTransfer })
                .projectDragTransfer;
            if (!targetHeading || !transfer) throw new Error('Project drop fixtures not found');
            const bounds = targetHeading.getBoundingClientRect();
            targetHeading.dispatchEvent(
                new DragEvent('dragover', {
                    bubbles: true,
                    cancelable: true,
                    clientY: bounds.top + 1,
                    dataTransfer: transfer,
                }),
            );
            targetHeading.dispatchEvent(
                new DragEvent('drop', {
                    bubbles: true,
                    cancelable: true,
                    clientY: bounds.top + 1,
                    dataTransfer: transfer,
                }),
            );
        });

        await expect.poll(projectTitles).toEqual(['gamma', 'alpha', 'beta']);
        await running.page.reload();
        await waitForRuntimeReady(running.page);
        await expect.poll(projectTitles).toEqual(['gamma', 'alpha', 'beta']);

        const gamma = running.page
            .locator('.project-group[data-project-id="project-2"]')
            .locator('.project-select');
        await gamma.focus();
        await gamma.press('Alt+ArrowDown');
        await expect.poll(projectTitles).toEqual(['alpha', 'gamma', 'beta']);
        await expect(running.page.locator('.project-order-announcement')).toContainText(
            'Moved gamma to position 2 of 3',
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('rapid keyboard Project moves preserve every intended step', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-order-keys-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const roots = ['alpha', 'beta', 'gamma'].map((name) => join(testDirectory, name));
    await Promise.all([mkdir(userData), ...roots.map((root) => mkdir(root))]);
    await seedProjects(join(userData, 'caxri.db'), roots);

    const running = await launchCaxri({ userDataDir: userData, testRootPath: roots[0] });
    const projectTitles = () => running.page.locator('.project-select strong').allTextContents();
    try {
        await expect.poll(projectTitles).toEqual(['alpha', 'beta', 'gamma']);
        await running.page
            .locator('.project-group[data-project-id="project-0"] .project-select')
            .evaluate((element) => {
                const options = { altKey: true, bubbles: true, key: 'ArrowDown' };
                element.dispatchEvent(new KeyboardEvent('keydown', options));
                element.dispatchEvent(new KeyboardEvent('keydown', options));
            });

        await expect.poll(projectTitles).toEqual(['beta', 'gamma', 'alpha']);
        await expect(running.page.locator('.project-order-announcement')).toContainText(
            'Moved alpha to position 3 of 3',
        );
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
