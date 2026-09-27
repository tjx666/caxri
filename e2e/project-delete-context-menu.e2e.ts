import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MessageBoxOptions } from 'electron';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

test('the Project row menu deletes its own Project even when another Session is selected', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-row-delete-'));
    const roots = ['first-project', 'second-project'].map((name) => join(directory, name));
    await Promise.all(roots.map((root) => mkdir(root)));
    await Promise.all(roots.map((root) => writeFile(join(root, 'keep.txt'), 'kept\n')));

    const running = await launchCaxri({
        userDataDir: join(directory, 'user-data'),
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    });
    try {
        const firstSessionId = await createProjectSession(running.page);
        const secondSessionId = await createProjectSession(running.page);
        const state = await pageRequest<{
            projects: Array<{ id: string; displayTitle: string }>;
            sessions: Array<{ id: string; projectId: string }>;
        }>(running.page, 'app.bootstrap');
        const firstProjectId = state.sessions.find(
            (session) => session.id === firstSessionId,
        )?.projectId;
        const secondProjectId = state.sessions.find(
            (session) => session.id === secondSessionId,
        )?.projectId;
        const secondProject = state.projects.find((project) => project.id === secondProjectId);
        if (!firstProjectId || !secondProjectId || !secondProject)
            throw new Error('Two Project fixture was not created');

        const selectedSession = running.page.locator(
            `.session-card[data-session-id="${firstSessionId}"]`,
        );
        await selectedSession.click();
        await expect
            .poll(() => pageRequest<{ selectedSessionId?: string }>(running.page, 'app.bootstrap'))
            .toMatchObject({ selectedSessionId: firstSessionId });
        await expect(selectedSession).toHaveAttribute('aria-selected', 'true');
        await expect(
            running.page.locator(
                `.workbench-session[data-workbench-session-id="${firstSessionId}"] .xterm-helper-textarea`,
            ),
        ).toBeFocused();

        const secondGroup = running.page.locator(
            `.project-group[data-project-id="${secondProjectId}"]`,
        );
        const firstGroup = running.page.locator(
            `.project-group[data-project-id="${firstProjectId}"]`,
        );
        await running.app.evaluate(({ dialog }) => {
            const probe = globalThis as typeof globalThis & {
                caxriProjectDeleteProbe?: { messages: string[]; response: number };
            };
            probe.caxriProjectDeleteProbe = { messages: [], response: 1 };
            dialog.showMessageBox = (
                windowOrOptions: unknown,
                maybeOptions?: MessageBoxOptions,
            ) => {
                const options = maybeOptions ?? (windowOrOptions as MessageBoxOptions);
                probe.caxriProjectDeleteProbe!.messages.push(options.message);
                return Promise.resolve({
                    response: probe.caxriProjectDeleteProbe!.response,
                    checkboxChecked: false,
                });
            };
        });

        const projectRow = secondGroup.locator('.project-select');
        await projectRow.focus();
        await expect(projectRow).toBeFocused();
        await running.page.keyboard.press('Shift+F10');
        await chooseContextMenuItem(running.app, 'Delete Project…');
        await expect
            .poll(() =>
                running.app.evaluate(
                    () =>
                        (
                            globalThis as typeof globalThis & {
                                caxriProjectDeleteProbe?: { messages: string[] };
                            }
                        ).caxriProjectDeleteProbe?.messages[0],
                ),
            )
            .toContain(`Delete '${secondProject.displayTitle}'`);
        await expect(secondGroup).toBeVisible();
        await expect(firstGroup).toBeVisible();

        await running.app.evaluate(() => {
            (
                globalThis as typeof globalThis & {
                    caxriProjectDeleteProbe?: { response: number };
                }
            ).caxriProjectDeleteProbe!.response = 0;
        });
        await secondGroup.locator('.project-heading').click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Delete Project…');

        await expect(secondGroup).toHaveCount(0);
        await expect(firstGroup).toBeVisible();
        await expect(
            running.page.locator(`.session-card[data-session-id="${firstSessionId}"]`),
        ).toBeVisible();
        await expect.poll(() => readFile(join(roots[0], 'keep.txt'), 'utf8')).toBe('kept\n');
        await expect.poll(() => readFile(join(roots[1], 'keep.txt'), 'utf8')).toBe('kept\n');
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
