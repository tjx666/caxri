import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState, GitSummary } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest, typeTerminal } from './support/helpers.ts';

async function initializeRepo(root: string): Promise<void> {
    await mkdir(root, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'caxri@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Caxri E2E'], { cwd: root });
    await writeFile(join(root, 'owner.ts'), 'export const owner = true;\n', 'utf8');
    await execFileAsync('git', ['add', 'owner.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });
}

async function expectWorkbenchRoot(
    page: Page,
    sessionId: string,
    rootPath: string,
    branch: string,
): Promise<void> {
    await expect
        .poll(async () => {
            const bootstrap = await pageRequest<BootstrapState>(page, 'app.bootstrap');
            return bootstrap.sessions.find((session) => session.id === sessionId)?.rootPath;
        })
        .toBe(rootPath);
    /**
     * Session persistence and Git summary refresh complete through separate request paths. Wait for both so a busy
     * desktop runner cannot observe the new Session root with the preceding repository summary.
     */
    await expect
        .poll(async () => {
            const summary = await pageRequest<GitSummary>(page, 'git.summary', { sessionId });
            return {
                isRepository: summary.isRepository,
                primary: summary.repositories.find((repo) => repo.kind === 'primary'),
            };
        })
        .toMatchObject({
            isRepository: true,
            primary: { branch, rootPath },
        });
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires destructuring for its fixture argument.
test('Agent Bash hook attribution after manual resume prompts, authorizes, and switches one Session', async ({}, testInfo) => {
    const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-hook-e2e-'));
    const testDirectory = await realpath(createdDirectory);
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'owner');
    const worktree = join(testDirectory, 'worktree');
    await initializeRepo(root);
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
function signalShellTool(event, command, cwd = process.cwd()) {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const group = hooks.hooks[event].find((candidate) => candidate.matcher === '^Bash$');
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify({
      cwd,
      session_id: 'workbench-e2e-session',
      tool_input: { command },
      tool_response: 'private fixture output',
      tool_use_id: 'workbench-operation-' + step,
    }),
  });
}
let step = 0;
process.stdin.setRawMode?.(true);
process.stdin.on('data', (chunk) => {
  if (chunk.toString() === 'x') process.exit(0);
  step += 1;
  if (step === 1) {
    signalShellTool('PreToolUse', "rtk git -C '/repo with spaces' worktree add -b feature/workbench ../worktree");
    childProcess.execFileSync('git', ['worktree', 'add', '-b', 'feature/workbench', ${JSON.stringify(worktree)}], { cwd: ${JSON.stringify(root)} });
    fs.writeFileSync(path.join(${JSON.stringify(worktree)}, 'worktree-only.txt'), 'worktree context\n');
    // The same hook reports creation and the new cwd, so the visible candidate receives both observations.
    signalShellTool('PostToolUse', "rtk git -C '/repo with spaces' worktree add -b feature/workbench ../worktree", ${JSON.stringify(worktree)});
  } else if (step === 2) {
    signalShellTool('PreToolUse', 'git worktree remove --force ../worktree');
    childProcess.execFileSync('git', ['worktree', 'remove', '--force', ${JSON.stringify(worktree)}], { cwd: ${JSON.stringify(root)} });
    signalShellTool('PostToolUse', 'git worktree remove --force ../worktree');
  } else if (step === 3) {
    signalShellTool('PreToolUse', 'git worktree add ../worktree feature/workbench');
    childProcess.execFileSync('git', ['worktree', 'add', ${JSON.stringify(worktree)}, 'feature/workbench'], { cwd: ${JSON.stringify(root)} });
    fs.writeFileSync(path.join(${JSON.stringify(worktree)}, 'worktree-only.txt'), 'worktree context restored\n');
    signalShellTool('PostToolUse', 'git worktree add ../worktree feature/workbench');
  } else {
    return;
  }
  process.stdout.write('Workbench operation finished ' + step + '\r\n');
});
process.stdin.resume();
process.stdout.write('Workbench Agent ready\r\n');
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
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings, null, 2),
        });
        const sessionId = await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText('Workbench Agent ready');
        // The exited managed child restores Shell hooks; manual resume bypasses managed launch priming.
        await running.page.locator('.xterm-helper-textarea').press('x');
        await expect
            .poll(async () => {
                const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
                return state.terminals.find((terminal) => terminal.sessionId === sessionId)
                    ?.lastAgentProcessState;
            })
            .toBe('stopped');
        await typeTerminal(running.page, 'codex resume workbench-e2e-session');
        await expect
            .poll(async () => {
                const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
                return state.terminals.find((terminal) => terminal.sessionId === sessionId)
                    ?.lastAgentProcessState;
            })
            .toBe('running');
        await running.page.getByRole('treeitem', { name: 'owner.ts', exact: true }).click();
        await expect(
            running.page.getByRole('tab', { name: 'owner.ts', exact: true }),
        ).toHaveAttribute('aria-selected', 'true');
        const editor = running.page.locator('.monaco-editor').first();
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('owner dirty buffer');
        await expect(
            running.page.locator('.work-tab:not([inert])', { hasText: 'owner.ts' }),
        ).toContainText('●');
        await running.page.getByRole('tab', { name: 'Codex', exact: true }).click();
        await pageRequest(running.page, 'session.workbenchRoots', { sessionId });
        const before = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const terminalBefore = before.terminals.find(
            (terminal) => terminal.sessionId === sessionId,
        );
        expect(terminalBefore).toBeTruthy();

        await expect(running.page.locator('.project-group')).toHaveCount(1);

        await running.page.locator('.xterm-helper-textarea').press('g');
        const prompt = running.page.getByRole('status', { name: 'New Git worktree' });
        await expect(prompt).toContainText('A new Git worktree was created for this Session.');
        await expect(prompt).toContainText(worktree);
        await prompt.screenshot({ path: testInfo.outputPath('manual-resume-worktree-prompt.png') });
        /**
         * Continue must work without a second picker grant for the already detected directory.
         */
        await prompt.getByRole('button', { name: 'Continue Session in Worktree' }).click();

        await expectWorkbenchRoot(running.page, sessionId, worktree, 'feature/workbench');
        /**
         * Authorization registered the worktree as a full Project, but presentation is separate: the PrimarySidebar
         * keeps exactly the checkouts the user added, and the Session row names the worktree instead (GitHub issue
         * #576).
         */
        await expect(running.page.locator('.project-group')).toHaveCount(1);
        await expect(
            running.page.locator(`.session-card[data-session-id="${sessionId}"]`),
        ).toHaveAccessibleDescription(/Working in worktree worktree\./);
        await expect(
            running.page.getByRole('treeitem', { name: 'worktree-only.txt' }),
        ).toBeVisible();
        await running.page
            .getByRole('treeitem', { name: 'worktree-only.txt', exact: true })
            .click();
        const worktreeFileTab = running.page.getByRole('tab', {
            name: 'worktree-only.txt',
            exact: true,
        });
        await expect(worktreeFileTab).toHaveAttribute('aria-selected', 'true');
        await editor.click({ position: { x: 120, y: 24 } });
        await running.page.keyboard.press('Meta+A');
        await running.page.keyboard.insertText('worktree dirty buffer');
        await expect(
            running.page.getByRole('combobox', {
                name: 'Switch Workbench Root from worktree, branch feature/workbench',
            }),
        ).toBeVisible();
        const after = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(
            after.terminals.find((terminal) => terminal.id === terminalBefore?.id),
        ).toMatchObject({
            id: terminalBefore?.id,
            cwd: terminalBefore?.cwd,
            createdAt: terminalBefore?.createdAt,
            lastProcessState: terminalBefore?.lastProcessState,
        });

        const selector = running.page.getByRole('combobox', {
            name: 'Switch Workbench Root from worktree, branch feature/workbench',
        });
        await selector.click();
        await running.page
            .getByRole('option', { name: 'main, Main worktree', exact: true })
            .click();
        await expectWorkbenchRoot(running.page, sessionId, root, 'main');
        // Back on its own root, the Session row names no worktree.
        await expect(
            running.page.locator(`.session-card[data-session-id="${sessionId}"]`),
        ).not.toHaveAccessibleDescription(/Working in worktree/);
        await running.page.getByRole('tab', { name: 'owner.ts', exact: true }).click();
        await expect(running.page.locator('.view-lines')).toContainText('owner dirty buffer');
        await expect(
            running.page.getByRole('combobox', {
                name: 'Switch Workbench Root from owner, branch main',
            }),
        ).toBeVisible();

        const ownerSelector = running.page.getByRole('combobox', {
            name: 'Switch Workbench Root from owner, branch main',
        });
        await ownerSelector.click();
        await running.page.getByRole('option', { name: 'feature/workbench', exact: true }).click();
        await expectWorkbenchRoot(running.page, sessionId, worktree, 'feature/workbench');
        await running.page.getByRole('tab', { name: 'worktree-only.txt', exact: true }).click();
        await expect(running.page.locator('.view-lines')).toContainText('worktree dirty buffer');

        await running.page.getByRole('tab', { name: 'Codex', exact: true }).click();
        await running.page.locator('.xterm-helper-textarea').press('r');
        await expectWorkbenchRoot(running.page, sessionId, root, 'main');
        await expect(
            running.page.getByRole('treeitem', { name: 'owner.ts', exact: true }),
        ).toBeVisible();
        await expect(
            running.page.getByText('Unable to read directory', { exact: true }),
        ).toHaveCount(0);
        await expect(
            running.page.getByText(
                'The active worktree is no longer available. Returned to owner.',
                { exact: true },
            ),
        ).toBeVisible();

        await running.page.getByRole('tab', { name: 'Codex', exact: true }).click();
        await running.page.locator('.xterm-helper-textarea').press('a');
        await expect(prompt).toBeVisible();
        await prompt.getByRole('button', { name: 'Continue Session in Worktree' }).click();
        await expectWorkbenchRoot(running.page, sessionId, worktree, 'feature/workbench');
        await running.page.getByRole('tab', { name: 'worktree-only.txt', exact: true }).click();
        await expect(running.page.locator('.view-lines')).toContainText('worktree dirty buffer');

        const final = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const terminalAfter = final.terminals.find(
            (terminal) => terminal.id === terminalBefore?.id,
        );
        expect(terminalAfter?.processId).toBe(terminalBefore?.processId);
        expect(terminalAfter?.cwd).toBe(terminalBefore?.cwd);
        expect(terminalAfter?.agentSessionId).toBe(terminalBefore?.agentSessionId);
        expect(terminalAfter?.lastProcessState).toBe(terminalBefore?.lastProcessState);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(createdDirectory, { recursive: true, force: true });
    }
});

test('external worktree creation stays silent while one Agent Session is running', async () => {
    const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-external-e2e-'));
    const testDirectory = await realpath(createdDirectory);
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'owner');
    const worktree = join(testDirectory, 'external-worktree');
    await initializeRepo(root);
    await execFileAsync('git', ['worktree', 'add', '-b', 'feature/external', worktree], {
        cwd: root,
    });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { codex: { startupOutput: 'External provenance Agent ready\r\n' } },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify([root, worktree]) },
    });
    try {
        const selectedOwner = await pageRequest<string | null>(
            running.page,
            'dialog.selectDirectory',
        );
        expect(selectedOwner).toBe(root);
        const owner = await pageRequest<{ id: string }>(running.page, 'project.create', {
            rootPath: selectedOwner,
        });
        const selectedWorktree = await pageRequest<string | null>(
            running.page,
            'dialog.selectDirectory',
        );
        expect(selectedWorktree).toBe(worktree);
        await pageRequest(running.page, 'project.create', { rootPath: selectedWorktree });
        await execFileAsync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
        const currentSettings = await pageRequest<{ value: AppSettings }>(
            running.page,
            'settings.get',
        );
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({
                ...currentSettings.value,
                'workbench.newWorktreeBehavior': 'continueWhenAuthorized',
            }),
        });
        const createdSession = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            { projectId: owner.id, defaultAgent: 'codex' },
        );
        const sessionId = createdSession.session.id;
        await expect(running.page.locator('.xterm-rows')).toContainText(
            'External provenance Agent ready',
        );

        await execFileAsync('git', ['worktree', 'add', worktree, 'feature/external'], {
            cwd: root,
        });
        await pageRequest(running.page, 'session.workbenchRoots', { sessionId });

        await expect(running.page.getByRole('status', { name: 'New Git worktree' })).toHaveCount(0);
        // Both roots were added by the user, so both stay top-level even though one is a linked worktree.
        await expect(running.page.locator('.project-group')).toHaveCount(2);
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(bootstrap.sessions.find((session) => session.id === sessionId)).toMatchObject({
            rootPath: root,
        });
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(createdDirectory, { recursive: true, force: true });
    }
});

test('Workbench Root selector authorizes a linked worktree when hooks are disabled', async () => {
    const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-manual-e2e-'));
    const testDirectory = await realpath(createdDirectory);
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'owner');
    const worktree = join(testDirectory, 'manual-worktree');
    await initializeRepo(root);
    await execFileAsync('git', ['worktree', 'add', '-b', 'feature/manual', worktree], {
        cwd: root,
    });
    for (let index = 0; index < 7; index += 1) {
        // Git writes separate pointer birth times; the oldest target should remain discoverable through Show all.
        // eslint-disable-next-line no-await-in-loop -- preserve deterministic creation order.
        await execFileAsync(
            'git',
            [
                'worktree',
                'add',
                '-b',
                `feature/recent-${index}`,
                join(testDirectory, `recent-${index}`),
            ],
            { cwd: root },
        );
    }
    const running = await launchCaxri({
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        const sessionId = await createProjectSession(running.page, 'shell');
        const selector = running.page.getByRole('combobox', {
            name: 'Switch Workbench Root from owner, branch main',
        });
        await selector.click();
        const popup = running.page.getByRole('dialog', { name: 'Workbench Roots', exact: true });
        await expect(
            running.page.getByRole('option', { name: 'feature/recent-6, Authorize', exact: true }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('option', { name: 'feature/manual, Authorize', exact: true }),
        ).toHaveCount(0);
        await expect(popup.getByRole('option')).toHaveCount(7);
        await popup.screenshot({ path: test.info().outputPath('worktree-recent.png') });
        const search = running.page.getByRole('combobox', {
            name: 'Search worktrees',
            exact: true,
        });
        await expect(search).toBeFocused();
        // Typing reaches a root the compact list hides, without expanding it first.
        await search.fill('feature/manual');
        await expect(popup.getByRole('option')).toHaveCount(1);
        // The expand row is an answer to "show me everything", so an active query retires it.
        await expect(running.page.getByRole('option', { name: /Show all worktrees/ })).toHaveCount(
            0,
        );
        await popup.screenshot({ path: test.info().outputPath('worktree-search.png') });
        await running.page
            .getByRole('option', { name: 'feature/manual, Authorize', exact: true })
            .click();

        const confirmation = running.page.getByRole('dialog', { name: 'Authorize worktree?' });
        await expect(confirmation).toContainText(worktree);
        await confirmation.screenshot({ path: test.info().outputPath('worktree-authorize.png') });
        await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
        const beforeAuthorization = await pageRequest<BootstrapState>(
            running.page,
            'app.bootstrap',
        );
        expect(beforeAuthorization.projects.length).toBe(1);
        await running.page
            .getByRole('option', { name: 'feature/manual, Authorize', exact: true })
            .click();
        await confirmation
            .getByRole('button', { name: 'Authorize and switch', exact: true })
            .click();

        await expectWorkbenchRoot(running.page, sessionId, worktree, 'feature/manual');
        const authorizedSelector = running.page.getByRole('combobox', {
            name: 'Switch Workbench Root from manual-worktree, branch feature/manual',
        });
        await expect(authorizedSelector).toBeVisible();
        /**
         * Authorizing through the picker must not add a second top-level entry for the same repository; the Session row
         * names the worktree instead, and the picker keeps listing both roots (GitHub issue #576).
         */
        await expect(running.page.locator('.project-group')).toHaveCount(1);
        await expect(
            running.page.locator(`.session-card[data-session-id="${sessionId}"]`),
        ).toHaveAccessibleDescription(/Working in worktree manual-worktree\./);
        await authorizedSelector.click();
        await running.page.getByRole('option', { name: /Show all worktrees/ }).click();
        await expect(
            running.page.getByRole('option', { name: 'main, Main worktree', exact: true }),
        ).toBeVisible();
        await expect(
            running.page.getByRole('option', {
                name: 'feature/manual',
                exact: true,
            }),
        ).toBeVisible();
        await running.page.keyboard.press('Escape');
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const ownerId = bootstrap.sessions.find((session) => session.id === sessionId)!.projectId;
        await pageRequest(running.page, 'session.create', {
            projectId: ownerId,
            defaultAgent: 'shell',
        });
        const next = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const other = next.sessions.find((session) => session.id !== sessionId)!;
        await running.page.locator(`.session-card[data-session-id="${sessionId}"]`).click();
        await expect(authorizedSelector).toBeVisible();
        await running.page.locator(`.session-card[data-session-id="${other.id}"]`).click();
        await expect(selector).toBeVisible();
        await expectWorkbenchRoot(running.page, other.id, root, 'main');
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(createdDirectory, { recursive: true, force: true });
    }
});
