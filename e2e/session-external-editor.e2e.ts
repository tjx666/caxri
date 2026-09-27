import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';
import { readFileForPoll } from './support/result-file-polling.ts';

async function initializeRepo(root: string): Promise<void> {
    await mkdir(root, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'owner.ts'), 'export const owner = true;\n', 'utf8');
    await execFileAsync('git', ['add', 'owner.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
}

async function readEditorArguments(path: string): Promise<string[] | undefined> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as string[];
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function expectWorkbenchRoot(
    page: Parameters<typeof pageRequest>[0],
    sessionId: string,
    rootPath: string,
): Promise<void> {
    await expect
        .poll(async () => {
            const bootstrap = await pageRequest<BootstrapState>(page, 'app.bootstrap');
            const session = bootstrap.sessions.find((candidate) => candidate.id === sessionId);
            return session
                ? bootstrap.projects.find((project) => project.id === session.workbenchProjectId)
                      ?.rootPath
                : undefined;
        })
        .toBe(rootPath);
}

test('Session worktree context drives Terminal file drops and external editor actions', async () => {
    const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-session-external-editor-e2e-'));
    const testDirectory = await realpath(createdDirectory);
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'owner');
    const worktree = join(testDirectory, 'worktree');
    const droppedInput = join(testDirectory, 'dropped-input.txt');
    const editorArguments = join(testDirectory, 'external-editor-argv.json');
    const editorExecutable = join(testDirectory, 'fake-external-editor');
    await initializeRepo(root);
    await writeFile(
        editorExecutable,
        `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(editorArguments)}, JSON.stringify(process.argv.slice(2)));\n`,
        'utf8',
    );
    await chmod(editorExecutable, 0o700);

    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex 0.147.0\n');
  process.exit(0);
}
function signalShellTool(event, command) {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const group = hooks.hooks[event].find((candidate) => candidate.matcher === '^Bash$');
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify({
      session_id: 'session-external-editor-e2e',
      cwd: step > 1 ? ${JSON.stringify(worktree)} : ${JSON.stringify(root)},
      tool_input: { command },
      tool_response: 'private fixture output',
      tool_use_id: 'session-external-editor-operation-' + step,
    }),
  });
}
let step = 0;
process.stdin.setRawMode?.(true);
process.stdin.on('data', (data) => {
  if (++step === 2) {
    signalShellTool('PostToolUse', 'pwd');
    return;
  }
  if (step > 2) {
    fs.appendFileSync(${JSON.stringify(droppedInput)}, data);
    return;
  }
  const command = 'git worktree add -b feature/external-editor ../worktree';
  signalShellTool('PreToolUse', command);
  childProcess.execFileSync('git', ['worktree', 'add', '-b', 'feature/external-editor', ${JSON.stringify(worktree)}], { cwd: ${JSON.stringify(root)} });
  fs.writeFileSync(path.join(${JSON.stringify(worktree)}, 'worktree-only.txt'), 'worktree context\n');
  signalShellTool('PostToolUse', command);
  process.stdout.write('Workbench operation finished\r\n');
});
process.stdin.resume();
process.stdout.write('External editor Agent ready\r\n');
`,
            },
        },
    });

    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: {
            CAXRI_E2E_AGENT_HOOKS: '1',
            CAXRI_TEST_ROOT_PATHS: JSON.stringify([root]),
        },
    });
    try {
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        const settings = structuredClone(currentSettings.value);
        settings['agents.providers'].codex.hooks.enabled = true;
        settings['workbench.externalEditor'] = editorExecutable;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });

        const sessionId = await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'External editor Agent ready',
        );
        await pageRequest(running.page, 'session.workbenchRoots', { sessionId });
        await running.page.locator('.xterm-helper-textarea').press('g');

        const prompt = running.page.getByRole('status', { name: 'New Git worktree' });
        await expect(prompt).toContainText('A new Git worktree was created for this Session.');
        await expect(prompt).toContainText(worktree);
        await prompt.getByRole('button', { name: 'Continue Session in Worktree' }).click();
        await expectWorkbenchRoot(running.page, sessionId, worktree);
        await running.page.locator('.xterm-helper-textarea').press('c');

        await expect
            .poll(() =>
                running.page.evaluate((id) => {
                    const inspector = (
                        globalThis as unknown as {
                            __caxriStores: {
                                getState(name: string): { bootstrap?: BootstrapState } | undefined;
                            };
                        }
                    ).__caxriStores;
                    const terminal = inspector
                        .getState('workbench')
                        ?.bootstrap?.terminals.find((candidate) => candidate.sessionId === id);
                    return {
                        cwd: terminal?.cwd,
                        agentCwd: terminal?.agentCwd,
                        state: terminal?.lastAgentProcessState,
                    };
                }, sessionId),
            )
            .toEqual({ cwd: root, agentCwd: worktree, state: 'running' });
        const fileRow = running.page.locator('.file-list').getByRole('treeitem', {
            name: 'worktree-only.txt',
            exact: true,
        });
        await fileRow.dragTo(running.page.locator('.terminal-surface'));
        await expect
            .poll(() => readFileForPoll(() => readFile(droppedInput, 'utf8')))
            .toBe('worktree-only.txt');
        await expect(running.page.locator('.work-tab:not([data-terminal-id])')).toHaveCount(0);

        const sessionCard = running.page.locator(`.session-card[data-session-id="${sessionId}"]`);
        await sessionCard.click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Open Project in Editor');
        await expect.poll(() => readEditorArguments(editorArguments)).toEqual([worktree]);

        await rm(editorArguments, { force: true });
        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        await palette
            .getByPlaceholder('Search projects, sessions, and commands…')
            .fill('Open Project in External Editor');
        await palette
            .getByRole('option')
            .filter({ hasText: 'Open Project in External Editor' })
            .click();
        await expect.poll(() => readEditorArguments(editorArguments)).toEqual([worktree]);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures; the assertions above already produced the test result.
        }
        await rm(createdDirectory, { recursive: true, force: true });
    }
});
