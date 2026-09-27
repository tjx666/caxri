import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState, ProjectRecord } from '@caxri/protocol';

import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';
import { readFileForPoll } from './support/result-file-polling.ts';

function quotePath(path: string): string {
    return `'${path.replaceAll("'", String.raw`'\''`)}'`;
}

test('Project path actions work without Sessions and drag absolute shell-safe roots into Terminal', async () => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-project-path-commands-'));
    const directory = await realpath(created);
    const root = join(directory, "project with 'quotes'");
    const emptyRoot = join(directory, 'empty-project');
    await Promise.all([mkdir(root), mkdir(emptyRoot)]);
    const editorReceipt = join(directory, 'editor-arguments.json');
    const editorExecutable = join(directory, 'editor-fixture');
    await writeFile(
        editorExecutable,
        `#!${process.execPath}\n// 记录测试编辑器收到的参数，写入隔离测试回执文件。\nrequire('node:fs').writeFileSync(${JSON.stringify(editorReceipt)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    await chmod(editorExecutable, 0o700);
    const running = await launchCaxri({
        userDataDir: join(directory, 'profile'),
        testRootPath: root,
        clipboard: true,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root, emptyRoot]) },
    });
    try {
        const sessionId = await createProjectSession(running.page);
        const pickedRoot = await pageRequest<string>(running.page, 'dialog.selectDirectory');
        const empty = await pageRequest<ProjectRecord>(running.page, 'project.create', {
            rootPath: pickedRoot,
        });
        await pageRequest(running.page, 'session.select', { sessionId });
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        settings.value['workbench.externalEditor'] = editorExecutable;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings.value),
        });
        await running.app.evaluate(({ shell }) => {
            shell.showItemInFolder = (path) => {
                Reflect.set(globalThis, '__projectRevealPath', path);
            };
        });
        const emptyHeading = running.page.locator(
            `.project-heading[data-project-id="${empty.id}"]`,
        );
        await expect(emptyHeading).toBeVisible();
        await emptyHeading.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Copy Path');
        await expect.poll(() => running.clipboard.textEquals(emptyRoot)).toBe(true);
        await running.clipboard.claimText(emptyRoot);
        await emptyHeading.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Reveal in Finder');
        await expect
            .poll(() =>
                running.app.evaluate(() => String(Reflect.get(globalThis, '__projectRevealPath'))),
            )
            .toBe(emptyRoot);
        await emptyHeading.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Open Project in Editor');
        await expect
            .poll(() => readFileForPoll(() => readFile(editorReceipt, 'utf8')))
            .toBe(JSON.stringify([emptyRoot]));
        const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(state.sessions.filter((session) => session.projectId === empty.id)).toHaveLength(0);
        expect(state.selectedSessionId).toBe(sessionId);

        const owner = state.projects.find((project) => project.rootPath === root)!;
        const heading = running.page.locator(`.project-heading[data-project-id="${owner.id}"]`);
        const input = running.page.locator('.xterm-helper-textarea');
        const receipt = join(directory, 'drop-result');
        await input.click();
        await running.page.keyboard.type("printf '%s' ");
        await heading.dragTo(running.page.locator('.terminal-surface'));
        await expect(input).toBeFocused();
        await expect(access(receipt)).rejects.toThrow();
        await running.page.keyboard.type(` > ${quotePath(receipt)}`);
        await running.page.keyboard.press('Enter');
        await expect.poll(() => readFileForPoll(() => readFile(receipt, 'utf8'))).toBe(root);
        await expect(running.page.locator('.workbench-pane')).toHaveCount(1);
    } finally {
        await running.app.close();
        await rm(created, { recursive: true, force: true });
    }
});
