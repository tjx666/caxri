import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
} from './support/helpers.ts';

const PROJECT_NAMES = ['alpha', 'beta', 'gamma'] as const;

async function closeAppQuietly(app: E2EApp): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

/**
 * The Activity view's projection is unit-tested; what only a real launch can prove is that the Secondary Side Bar
 * actually contributes the container, that the Renderer reads Sessions belonging to Projects other than the selected
 * one, and that selecting and acknowledging from this list reach the Server over IPC.
 */
test('Activity groups every Project’s Sessions attention-first and clears a reminder in place', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-activity-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const roots = PROJECT_NAMES.map((name) => join(testDirectory, name));
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const launchOptions = {
        userDataDir: userData,
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    };
    let running = await launchCaxri(launchOptions);
    try {
        await createProjectSession(running.page);
        const initial = await pageRequest<{ selectedSessionId?: string }>(
            running.page,
            'app.bootstrap',
        );
        if (!initial.selectedSessionId)
            throw new Error('The first Project fixture was not created');
        const sessions = new Map<string, string>([[PROJECT_NAMES[0], initial.selectedSessionId]]);

        for (const [index, name] of PROJECT_NAMES.slice(1).entries()) {
            // Test folder grants are consumed in the order supplied through CAXRI_TEST_ROOT_PATHS.
            // eslint-disable-next-line no-await-in-loop -- each one-shot grant must precede its Project creation
            const root = await pageRequest<string | null>(running.page, 'dialog.selectDirectory');
            if (root !== roots[index + 1]) throw new Error(`Unexpected ${name} Project root`);
            // eslint-disable-next-line no-await-in-loop -- the returned Project id owns the following Session
            const project = await pageRequest<{ id: string }>(running.page, 'project.create', {
                rootPath: root,
            });
            // eslint-disable-next-line no-await-in-loop -- Session identity is needed for the activity fixture
            const created = await pageRequest<{ session: { id: string } }>(
                running.page,
                'session.create',
                { projectId: project.id, defaultAgent: null },
            );
            sessions.set(name, created.session.id);
        }
        for (const [name, sessionId] of sessions) {
            // eslint-disable-next-line no-await-in-loop -- renames must land before the app closes
            await pageRequest(running.page, 'session.rename', {
                displayTitle: `${name} work`,
                sessionId,
            });
        }
        /**
         * The idle Session holds the selection so neither unread fixture is acknowledged by simply being on screen at
         * launch, which is what `useSessionAttentionAcknowledgement` does for the selected Session.
         */
        await pageRequest(running.page, 'session.select', { sessionId: sessions.get('gamma')! });
        await running.app.close();

        const database = new Database(join(userData, 'caxri.db'));
        const activityAt = Date.now();
        database.prepare('UPDATE sessions SET last_session_activity_at = ?').run(activityAt);
        database
            .prepare(
                `UPDATE sessions
                 SET attention_epoch = 1, read_attention_epoch = 0,
                     last_attention_kind = 'completed', last_activity_state = 'completed'
                 WHERE id = ?`,
            )
            .run(sessions.get('alpha'));
        database
            .prepare(
                `UPDATE sessions
                 SET attention_epoch = 1, read_attention_epoch = 0,
                     last_attention_kind = 'waiting', last_activity_state = 'waiting',
                     last_session_activity_at = ?
                 WHERE id = ?`,
            )
            .run(activityAt - 1_000, sessions.get('beta'));
        database.close();

        running = await launchCaxri(launchOptions);
        const page = running.page;
        await page.keyboard.press('Meta+4');
        await expect(
            page
                .getByRole('tablist', { name: 'Secondary Side Bar' })
                .getByRole('tab', { exact: true, name: 'Activity' }),
        ).toHaveAttribute('aria-selected', 'true');

        const tree = page.getByRole('tree', { name: 'Activity' });
        await expect
            .poll(() =>
                tree
                    .locator('.agent-activity-heading')
                    .evaluateAll((headings) =>
                        headings.map((heading) => heading.dataset.activityGroup),
                    ),
            )
            .toEqual(['attention', 'idle']);
        await expect
            .poll(() =>
                tree
                    .locator('.agent-activity-row[data-activity-group="attention"]')
                    .evaluateAll((rows) => rows.map((row) => row.dataset.sessionId)),
            )
            .toEqual([sessions.get('alpha'), sessions.get('beta')]);
        const betaRow = tree.locator(
            `.agent-activity-row[data-session-id="${sessions.get('beta')}"]`,
        );
        await expect(betaRow).toContainText('beta work');
        // The Project cell specifically, not the row: the Session title contains the Project name too, so asserting on
        // the whole row would pass even if the flat list never printed which repository a row belongs to.
        await expect(betaRow.locator('.agent-activity-project')).toHaveText('beta');
        await expect(betaRow).toContainText('Waiting');

        const alphaRow = tree.locator(
            `.agent-activity-row[data-session-id="${sessions.get('alpha')}"]`,
        );
        await alphaRow.hover();
        await page.getByRole('button', { name: 'Mark alpha work as read' }).click();
        await expect(alphaRow).toHaveAttribute('data-activity-group', 'finished');
        expect(await selectedSessionId(page)).toBe(sessions.get('gamma'));

        await page.mouse.move(600, 400);
        await page.keyboard.press('Meta+Shift+n');
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('beta'));

        await alphaRow.click();
        await expect.poll(() => selectedSessionId(page)).toBe(sessions.get('alpha'));
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
