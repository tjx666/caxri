import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import Database from 'better-sqlite3';

import type { E2EApp } from './support/electron-app.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

async function closeAppQuietly(app: E2EApp): Promise<void> {
    try {
        await app.close();
    } catch {
        // Ignore close failures during cleanup.
    }
}

test('manual Project collapse persists across an app relaunch', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-collapse-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    await execFileAsync('mkdir', ['-p', root]);

    const launchOptions = { userDataDir: userData, testRootPath: root };
    let running = await launchCaxri(launchOptions);
    try {
        await createProjectSession(running.page);
        await running.page
            .locator('.project-heading')
            .getByRole('button', { name: 'Collapse project' })
            .click();
        await expect(
            running.page
                .locator('.project-heading')
                .getByRole('button', { name: 'Expand project' }),
        ).toBeVisible();

        await running.app.close();
        running = await launchCaxri(launchOptions);
        await expect(
            running.page
                .locator('.project-heading')
                .getByRole('button', { name: 'Expand project' }),
        ).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('selecting a Session from outside the sidebar expands its manually collapsed Project', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-reveal-e2e-'));
    const root = join(testDirectory, 'project');
    await mkdir(root);
    const running = await launchCaxri({
        userDataDir: join(testDirectory, 'user-data'),
        testRootPath: root,
    });
    try {
        const firstSessionId = await createProjectSession(running.page);
        const { projects } = await pageRequest<{ projects: Array<{ id: string }> }>(
            running.page,
            'app.bootstrap',
        );
        const { session: second } = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            { projectId: projects[0].id, defaultAgent: null },
        );
        const heading = running.page.locator('.project-heading');
        await heading.getByRole('button', { name: 'Collapse project' }).click();
        await expect(heading.getByRole('button', { name: 'Expand project' })).toBeVisible();

        // Caxri Bot board, a notification, and history navigation all select through the Server like this.
        await pageRequest(running.page, 'session.select', { sessionId: firstSessionId });
        await expect(heading.getByRole('button', { name: 'Collapse project' })).toBeVisible();
        await expect(running.page.locator(`[data-row-id="${firstSessionId}"]`)).toBeVisible();

        // Collapsing again around the same selection is the user's decision and holds until the selection changes.
        await heading.getByRole('button', { name: 'Collapse project' }).click();
        await expect(heading.getByRole('button', { name: 'Expand project' })).toBeVisible();
        await pageRequest(running.page, 'session.select', { sessionId: second.id });
        await expect(heading.getByRole('button', { name: 'Collapse project' })).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('auto-collapse protects active, running, unread, and manually expanded Projects', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-project-auto-collapse-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const roots = ['active', 'running', 'unread', 'idle'].map((name) => join(testDirectory, name));
    await Promise.all(roots.map((root) => mkdir(root)));
    const launchOptions = {
        userDataDir: userData,
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    };
    let running = await launchCaxri(launchOptions);
    try {
        await createProjectSession(running.page);
        const initial = await pageRequest<{
            projects: Array<{ id: string; rootPath: string }>;
            selectedSessionId?: string;
        }>(running.page, 'app.bootstrap');
        if (!initial.selectedSessionId || initial.projects.length !== 1)
            throw new Error('Active Project fixture was not created');
        const activeProject = initial.projects[0];
        const sessionIds = new Map<string, string>([['active', initial.selectedSessionId]]);
        const projectIds = new Map<string, string>([['active', activeProject.id]]);

        for (const [index, name] of ['running', 'unread', 'idle'].entries()) {
            // Test folder grants are consumed in the same order supplied through CAXRI_TEST_ROOT_PATHS.
            // eslint-disable-next-line no-await-in-loop -- each one-shot grant must precede its Project creation
            const root = await pageRequest<string | null>(running.page, 'dialog.selectDirectory');
            if (root !== roots[index + 1]) throw new Error(`Unexpected ${name} Project root`);
            // eslint-disable-next-line no-await-in-loop -- the returned Project id owns the following Session
            const createdProject = await pageRequest<{ id: string }>(
                running.page,
                'project.create',
                { rootPath: root },
            );
            // eslint-disable-next-line no-await-in-loop -- Session identity is needed for the activity fixture
            const createdSession = await pageRequest<{ session: { id: string } }>(
                running.page,
                'session.create',
                { projectId: createdProject.id, defaultAgent: null },
            );
            projectIds.set(name, createdProject.id);
            sessionIds.set(name, createdSession.session.id);
        }
        await pageRequest(running.page, 'session.select', { sessionId: sessionIds.get('active')! });
        await running.app.close();

        const database = new Database(join(userData, 'caxri.db'));
        const staleAt = Date.now() - 3 * 60 * 60 * 1000;
        database.prepare('UPDATE projects SET last_visited_at = ?').run(staleAt);
        database.prepare('UPDATE sessions SET last_visited_at = ?').run(staleAt);
        database
            .prepare("UPDATE sessions SET agent_activity_state = 'running' WHERE id = ?")
            .run(sessionIds.get('running'));
        database
            .prepare(
                "UPDATE sessions SET attention_generation = 1, acknowledged_attention_generation = 0, last_attention_kind = 'completed' WHERE id = ?",
            )
            .run(sessionIds.get('unread'));
        database.close();
        await mkdir(join(userData, 'config'), { recursive: true });
        await writeFile(
            join(userData, 'config', 'settings.jsonc'),
            `${JSON.stringify({ 'primarySidebar.autoCollapseProjects': '30m' }, null, 2)}\n`,
        );

        running = await launchCaxri(launchOptions);
        await running.page.mouse.move(600, 400);
        const disclosure = (name: string, action: 'Collapse' | 'Expand') =>
            running.page
                .locator(`.project-heading[data-project-id="${projectIds.get(name)}"]`)
                .getByRole('button', { name: new RegExp(`^${action} `) });
        await expect(disclosure('idle', 'Expand')).toBeVisible();
        await expect(disclosure('active', 'Collapse')).toBeVisible();
        await expect(disclosure('running', 'Collapse')).toBeVisible();
        await expect(disclosure('unread', 'Collapse')).toBeVisible();

        await disclosure('idle', 'Expand').click();
        await pageRequest(running.page, 'session.select', {
            sessionId: sessionIds.get('running')!,
        });
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({ 'primarySidebar.autoCollapseProjects': 'off' }),
        });
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({ 'primarySidebar.autoCollapseProjects': '30m' }),
        });
        await running.page.getByRole('tab', { name: 'Files' }).focus();
        await running.page.mouse.move(600, 400);
        await expect(disclosure('active', 'Expand')).toBeVisible();
        await expect(disclosure('idle', 'Collapse')).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(testDirectory, { recursive: true, force: true });
    }
});
