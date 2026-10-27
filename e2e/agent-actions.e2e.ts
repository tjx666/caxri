import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator } from '@playwright/test';
import Database from 'better-sqlite3';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    pressNewTerminal,
    waitForNewTerminalId,
} from './support/helpers.ts';

async function capturedInputChunks(path: string): Promise<string[]> {
    try {
        return (await readFile(path, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((hex) => Buffer.from(hex, 'hex').toString('utf8'));
    } catch {
        return [];
    }
}

async function capturedInput(path: string): Promise<string> {
    return (await capturedInputChunks(path)).join('');
}

test('Agent skill search reveals the first result after scrolling', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-search-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const names = ['fix-ci', ...Array.from({ length: 20 }, (_, index) => `fix-task-${index}`)];
    await Promise.all(
        names.map(async (name) => {
            const directory = join(root, '.claude', 'skills', name);
            await mkdir(directory, { recursive: true });
            await writeFile(
                join(directory, 'SKILL.md'),
                `---\nname: ${name}\ndescription: Fix a test workflow\n---\nSynthetic search fixture.\n`,
            );
        }),
    );
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: { startupOutput: 'SEARCH_READY\r\n' } },
    });
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        await createProjectSession(running.page, 'claude');
        await expect(running.page.locator('.xterm-rows')).toContainText('SEARCH_READY');
        await running.page.keyboard.press('Meta+Shift+A');
        const picker = running.page.locator('[data-agent-actions-picker]');
        const search = picker.getByPlaceholder(/^Search skills and slash commands/u);
        const list = picker.locator('[cmdk-list]');
        const first = picker.locator('[data-agent-action="/fix-ci"]');
        await search.fill('fi');
        await expect(first).toHaveAttribute('data-selected', 'true');
        await list.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect(first).not.toBeInViewport();
        await search.fill('fix');
        await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(0);
        await expect(first).toBeInViewport();
        await expect(first).toHaveAttribute('data-selected', 'true');
        await picker.screenshot({ path: test.info().outputPath('agent-search.png') });
        await search.press('ArrowDown');
        await expect(first).toHaveAttribute('data-selected', 'false');
        await search.fill('fix-');
        await expect(first).toHaveAttribute('data-selected', 'true');
        await expect(first).toBeInViewport();
        await search.press('Escape');

        await running.page.keyboard.press('Meta+Shift+P');
        const palette = running.page.getByRole('dialog');
        const paletteSearch = palette.getByPlaceholder('Search projects, sessions, and commands…');
        const paletteList = palette.locator('[cmdk-list]');
        await paletteSearch.fill('ter');
        await paletteList.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
        });
        await expect
            .poll(() => paletteList.evaluate((element) => element.scrollTop))
            .toBeGreaterThan(0);
        await paletteSearch.fill('term');
        await expect.poll(() => paletteList.evaluate((element) => element.scrollTop)).toBe(0);
        await expect(palette.locator('[cmdk-item][data-selected="true"]')).toBeInViewport();
        await paletteSearch.press('Escape');
    } finally {
        await running.app.close();
        await rm(testDirectory, { recursive: true, force: true });
    }
});

test('Agent Commands & Skills stays discoverable, describes its target, and preserves Terminal input', async () => {
    const testDirectory = await mkdtemp(join(tmpdir(), 'caxri-agent-actions-e2e-'));
    const userData = join(testDirectory, 'user-data');
    const root = join(testDirectory, 'project');
    const skillDirectory = join(root, '.agents', 'skills', 'e2e-action');
    const requiredSkillDirectory = join(root, '.agents', 'skills', 'e2e-required');
    const pullRequestSkillDirectory = join(root, '.agents', 'skills', 'pull-request');
    const fixCiSkillDirectory = join(root, '.agents', 'skills', 'fix-ci');
    const codexState = join(userData, 'e2e-agents', 'codex');
    const capture = join(testDirectory, 'agent-input.hex');
    await Promise.all([
        mkdir(skillDirectory, { recursive: true }),
        mkdir(requiredSkillDirectory, { recursive: true }),
        mkdir(pullRequestSkillDirectory, { recursive: true }),
        mkdir(fixCiSkillDirectory, { recursive: true }),
        mkdir(codexState, { recursive: true }),
        writeFile(capture, ''),
    ]);
    const canonicalRoot = await realpath(root);
    const threadIndex = new Database(join(codexState, 'state_1.sqlite'));
    threadIndex.exec(
        'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER)',
    );
    threadIndex
        .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
            'agent-actions-session',
            canonicalRoot,
            'Private first prompt',
            'Codex action thread',
            Date.now() + 60_000,
            Date.now() + 60_000,
            0,
            0,
        );
    threadIndex.close();
    await writeFile(
        join(skillDirectory, 'SKILL.md'),
        '---\nname: e2e-action\ndescription: E2E discovered action\n---\nNever exposed in picker metadata.\n',
    );
    await writeFile(
        join(requiredSkillDirectory, 'SKILL.md'),
        '---\nname: e2e-required\ndescription: E2E action requiring input\nargument-hint: target\n---\nNever exposed in picker metadata.\n',
    );
    await writeFile(
        join(pullRequestSkillDirectory, 'SKILL.md'),
        '---\nname: pull-request\ndescription: Publish the current branch\n---\nNever exposed in picker metadata.\n',
    );
    await writeFile(
        join(fixCiSkillDirectory, 'SKILL.md'),
        '---\nname: fix-ci\ndescription: Make a Cloud or OSS PR mergeable\n---\nNever exposed in picker metadata.\n',
    );
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: { startupOutput: 'CLAUDE_ACTIONS_READY\r\n' },
            codex: {
                startupOutput: 'AGENT_ACTIONS_READY\r\n',
                inputCapture: { path: capture, encoding: 'hex', echoPrefix: 'ACTION_INPUT:' },
            },
        },
    });

    let running = await launchCaxri({
        agentMode,
        quitDecisionOnClose: 'keep-running',
        userDataDir: userData,
        testRootPath: root,
    });
    try {
        await createProjectSession(running.page, 'codex');
        const state = await pageRequest<{
            sessions: Array<{ id: string; title: string; projectId: string }>;
            terminals: Array<{
                agentSessionId?: string;
                id: string;
                provider?: string;
                lastProcessState: string;
                sessionId: string;
                title: string;
            }>;
        }>(running.page, 'app.bootstrap');
        const agentTerminal = state.terminals.find((terminal) => terminal.provider === 'codex');
        if (!agentTerminal) throw new Error('Codex Terminal was not created');
        const agentSession = state.sessions.find(
            (session) => session.id === agentTerminal.sessionId,
        );
        if (!agentSession) throw new Error('Codex Session was not created');
        const recentInvocations = (pickerLocator: Locator) =>
            pickerLocator
                .locator('[data-agent-action-group="recent"] [data-agent-action]')
                .evaluateAll((elements) => elements.map((element) => element.dataset.agentAction));
        const input = running.page.locator(
            `.terminal-pane[data-terminal-id="${agentTerminal.id}"] .xterm-helper-textarea`,
        );
        await expect(running.page.locator('.xterm-rows')).toContainText('AGENT_ACTIONS_READY');
        await expect
            .poll(async () => {
                const current = await pageRequest<{
                    terminals: Array<{ agentSessionId?: string; id: string; title: string }>;
                }>(running.page, 'app.bootstrap');
                const terminal = current.terminals.find(({ id }) => id === agentTerminal.id);
                return `${terminal?.agentSessionId ?? ''}:${terminal?.title ?? ''}`;
            })
            .toBe('agent-actions-session:Codex action thread');
        const agentTerminalTitle = 'Codex action thread';

        const expectPaletteSearch = async (term: string): Promise<void> => {
            await running.page.keyboard.press('Meta+Shift+P');
            const palette = running.page.getByRole('dialog');
            await palette.getByPlaceholder('Search projects, sessions, and commands…').fill(term);
            await expect(
                palette.getByText('Run Agent Command or Skill…', { exact: true }),
            ).toBeVisible();
            await running.page.keyboard.press('Escape');
        };
        await expectPaletteSearch('skills');
        await expectPaletteSearch('slash');
        await expectPaletteSearch('action');
        await expectPaletteSearch('commands');

        await input.focus();
        await input.pressSequentially('draft-');
        await pageRequest(running.page, 'session.rename', {
            sessionId: agentSession.id,
            title: agentTerminalTitle,
        });
        await running.page.keyboard.press('Meta+Shift+A');

        let picker = running.page.locator('[data-agent-actions-picker]');
        await expect(picker).toBeVisible();
        await expect(picker).toHaveAttribute('data-target-terminal-id', agentTerminal.id);
        let target = picker.locator('[data-agent-action-target]');
        await expect(target).toHaveAttribute('data-target-title-kind', 'shared');
        await expect(target.locator('[data-agent-action-target-title]')).toHaveText(
            agentTerminalTitle,
        );
        await expect(target).toHaveAccessibleName(`Target: Codex; ${agentTerminalTitle}`);
        await running.page.keyboard.press('Escape');

        await pageRequest(running.page, 'session.rename', {
            sessionId: agentSession.id,
            title: 'E2E Session Target',
        });
        await expect
            .poll(async () => {
                const current = await pageRequest<{
                    terminals: Array<{ id: string; title: string }>;
                }>(running.page, 'app.bootstrap');
                return current.terminals.find(({ id }) => id === agentTerminal.id)?.title;
            })
            .toBe('E2E Session Target');
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect(picker).toBeVisible();
        target = picker.locator('[data-agent-action-target]');
        await expect(target).toHaveAttribute('data-target-title-kind', 'shared');
        await expect(target.locator('[data-agent-action-target-title]')).toHaveText(
            'E2E Session Target',
        );
        await expect(target).toHaveAccessibleName('Target: Codex; E2E Session Target');
        await expect(picker).toContainText('Codex');
        await expect(picker).toContainText('/status');
        const search = picker.getByPlaceholder(/^Search skills and slash commands/u);
        await expect(search).toHaveAccessibleDescription(
            /Enter runs the selected action\. Command\+Enter inserts it for editing\./,
        );
        const footer = picker.locator('[data-agent-action-footer]');
        await expect(footer.locator('[data-agent-action-mode="run"]')).toContainText('Run');
        await expect(footer.locator('[data-agent-action-mode="insert"]')).toContainText('Insert');
        await search.fill('pr');
        const skillMatches = picker
            .locator('[data-agent-action-group="skill"]')
            .locator('[data-agent-action]:visible');
        await expect(skillMatches.first()).toHaveAttribute('data-agent-action', '$pull-request');
        await expect(picker.locator('[data-agent-action="$pull-request"]')).toHaveAttribute(
            'data-selected',
            'true',
        );
        await expect(picker.locator('[data-agent-action="$fix-ci"]')).toBeVisible();
        await search.fill('zzzz');
        await expect(picker.getByText('No Agent command or skill found.')).toBeVisible();
        await search.fill('e2e action');
        await expect(picker.locator('[data-agent-action="$e2e-action"]')).toContainText(
            'E2E discovered action',
        );
        await search.press('Enter');
        await expect(picker).not.toBeVisible();
        await expect(input).toBeFocused();
        await expect
            .poll(async () => {
                const chunks = await capturedInputChunks(capture);
                const invocationIndex = chunks.lastIndexOf('$e2e-action');
                return chunks.slice(invocationIndex, invocationIndex + 2);
            })
            .toEqual(['$e2e-action', '\t\r']);
        await expect.poll(() => capturedInput(capture)).toContain('draft-$e2e-action\t\r');

        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect(picker).toBeVisible();
        await picker.getByPlaceholder(/^Search skills and slash commands/u).fill('status');
        await expect(picker.locator('[data-agent-action="/status"]')).toBeVisible();
        await running.page.keyboard.press('Meta+Enter');
        await expect(picker).not.toBeVisible();
        await expect(input).toBeFocused();
        await expect.poll(() => capturedInput(capture)).toContain('/status ');
        await running.page.keyboard.type('details');
        await expect.poll(() => capturedInput(capture)).toContain('/status details');
        expect(await capturedInput(capture)).not.toContain('/status \r');

        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        const requiredSearch = picker.getByPlaceholder(/^Search skills and slash commands/u);
        await requiredSearch.fill('e2e required');
        await expect(picker.locator('[data-agent-action="$e2e-required"]')).toBeVisible();
        const beforeRequiredRun = await capturedInput(capture);
        await requiredSearch.press('Enter');
        await expect(picker).toBeVisible();
        await expect(
            running.page.getByText('$e2e-required needs arguments before it can run.'),
        ).toBeVisible();
        await expect.poll(() => capturedInput(capture)).toBe(beforeRequiredRun);
        await expect
            .poll(async () => {
                const currentSettings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            codex: { actions: { recent: { invocations: string[] } } };
                        };
                    };
                }>(running.page, 'settings.get');
                return currentSettings.value['agents.providers'].codex.actions.recent.invocations;
            })
            .toEqual(['/status', '$e2e-action']);
        await running.page.keyboard.press('Meta+Enter');
        await expect(picker).not.toBeVisible();
        await expect(input).toBeFocused();
        await expect.poll(() => capturedInput(capture)).toContain('$e2e-required ');

        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await picker.getByPlaceholder(/^Search skills and slash commands/u).fill('diff');
        await picker.locator('[data-agent-action="/diff"]').click();
        await expect(picker).not.toBeVisible();
        await expect(input).toBeFocused();
        await expect
            .poll(async () => (await capturedInput(capture)).split('/diff\r').length - 1)
            .toBe(1);

        await expect
            .poll(async () => {
                const currentSettings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            codex: { actions: { recent: { invocations: string[] } } };
                        };
                    };
                }>(running.page, 'settings.get');
                return currentSettings.value['agents.providers'].codex.actions.recent.invocations;
            })
            .toEqual(['/diff', '$e2e-required', '/status', '$e2e-action']);

        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect(picker.locator('[data-agent-action-group="recent"]')).toBeVisible();
        await expect
            .poll(() => recentInvocations(picker))
            .toEqual(['/diff', '$e2e-required', '/status', '$e2e-action']);
        await picker.getByPlaceholder(/^Search skills and slash commands/u).fill('diff');
        await expect(picker.locator('[data-agent-action-group="recent"]')).toHaveCount(0);
        await expect(picker.locator('[data-agent-action="/diff"]')).toHaveCount(1);
        await running.page.keyboard.press('Escape');

        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await picker.getByPlaceholder(/^Search skills and slash commands/u).fill('status');
        await running.page.keyboard.press('Enter');
        await expect
            .poll(async () => {
                const currentSettings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            codex: { actions: { recent: { invocations: string[] } } };
                        };
                    };
                }>(running.page, 'settings.get');
                return currentSettings.value['agents.providers'].codex.actions.recent.invocations;
            })
            .toEqual(['/status', '/diff', '$e2e-required', '$e2e-action']);

        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await picker.getByRole('button', { name: 'Manage in Settings…' }).click();
        await expect(picker).not.toBeVisible();
        const settingsTab = running.page.locator('[data-settings-page]');
        const actionsRow = settingsTab.locator('[data-setting-row="agents.codex.actions"]');
        await expect(actionsRow).toBeVisible();
        await actionsRow.getByRole('switch', { name: 'Show /diff' }).uncheck();
        await actionsRow.getByLabel('New command or skill invocation').fill('/goal');
        await actionsRow
            .getByLabel('New command or skill description')
            .fill('Manage a long-running goal');
        await actionsRow.getByRole('button', { name: 'Add command or skill' }).click();
        await expect(actionsRow.getByLabel('Description for /goal')).toHaveValue(
            'Manage a long-running goal',
        );
        await expect
            .poll(async () => {
                const settings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            codex: {
                                actions: {
                                    items: Record<string, { enabled?: boolean }>;
                                    recent: { invocations: string[] };
                                };
                            };
                        };
                    };
                }>(running.page, 'settings.get');
                const actions = settings.value['agents.providers'].codex.actions;
                return {
                    hasGoal: Object.hasOwn(actions.items, '/goal'),
                    diffEnabled: actions.items['/diff']?.enabled,
                    recent: actions.recent.invocations,
                };
            })
            .toEqual({
                hasGoal: true,
                diffEnabled: false,
                recent: ['/status', '/diff', '$e2e-required', '$e2e-action'],
            });
        // Settings is a Workbench tab (issue caxri#1289); `Cmd+W` closes it like any document tab.
        await running.page.keyboard.press('Meta+w');
        await expect(settingsTab).toHaveCount(0);

        await input.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect
            .poll(() => recentInvocations(picker))
            .toEqual(['/status', '$e2e-required', '$e2e-action']);
        await expect(picker.locator('[data-agent-action="/diff"]')).toHaveCount(0);
        await picker.getByRole('button', { name: 'Manage in Settings…' }).click();
        const reopenedActionsRow = settingsTab.locator('[data-setting-row="agents.codex.actions"]');
        await reopenedActionsRow.getByRole('switch', { name: 'Show /diff' }).check();
        await expect
            .poll(async () => {
                const currentSettings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            codex: { actions: { items: Record<string, unknown> } };
                        };
                    };
                }>(running.page, 'settings.get');
                return Object.hasOwn(
                    currentSettings.value['agents.providers'].codex.actions.items,
                    '/diff',
                );
            })
            .toBe(false);
        await running.page.keyboard.press('Meta+w');
        await expect(settingsTab).toHaveCount(0);

        await input.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect
            .poll(() => recentInvocations(picker))
            .toEqual(['/status', '/diff', '$e2e-required', '$e2e-action']);
        await running.page.keyboard.press('Escape');

        await input.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await picker.getByPlaceholder(/^Search skills and slash commands/u).fill('goal');
        await expect(picker.locator('[data-agent-action="/goal"]')).toContainText(
            'Manage a long-running goal',
        );
        await running.page.keyboard.press('Escape');
        await expect(picker).not.toBeVisible();
        await expect(input).toBeFocused();
        await running.page.keyboard.type('-after-escape');
        await expect.poll(() => capturedInput(capture)).toContain('-after-escape');
        await expect
            .poll(async () => {
                const currentSettings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            codex: { actions: { recent: { invocations: string[] } } };
                        };
                    };
                }>(running.page, 'settings.get');
                return currentSettings.value['agents.providers'].codex.actions.recent.invocations;
            })
            .toEqual(['/status', '/diff', '$e2e-required', '$e2e-action']);

        const claudeCreation = await pageRequest<{
            session: { id: string };
            terminal: { id: string };
        }>(running.page, 'session.create', {
            projectId: agentSession.projectId,
            defaultAgent: 'claude',
        });
        await pageRequest(running.page, 'session.select', { sessionId: claudeCreation.session.id });
        await expect
            .poll(async () => {
                const current = await pageRequest<{
                    terminals: Array<{ id: string; lastAgentProcessState?: string }>;
                }>(running.page, 'app.bootstrap');
                return current.terminals.find(({ id }) => id === claudeCreation.terminal.id)
                    ?.lastAgentProcessState;
            })
            .toBe('running');
        const claudeInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${claudeCreation.terminal.id}"] .xterm-helper-textarea`,
        );
        await claudeInput.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect(picker).toContainText('Claude');
        await expect(picker.locator('[data-agent-action-group="recent"]')).toHaveCount(0);
        await picker.getByPlaceholder(/^Search skills and slash commands/u).fill('context');
        await picker.locator('[data-agent-action="/context"]').click();
        await expect
            .poll(async () => {
                const currentSettings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            claude: { actions: { recent: { invocations: string[] } } };
                        };
                    };
                }>(running.page, 'settings.get');
                return currentSettings.value['agents.providers'].claude.actions.recent.invocations;
            })
            .toEqual(['/context']);
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect.poll(() => recentInvocations(picker)).toEqual(['/context']);
        await expect(
            picker.locator('[data-agent-action-group="recent"] [data-agent-action="/status"]'),
        ).toHaveCount(0);
        await running.page.keyboard.press('Escape');

        await pageRequest(running.page, 'session.select', { sessionId: agentSession.id });
        await expect(input).toBeVisible();
        await input.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect
            .poll(() => recentInvocations(picker))
            .toEqual(['/status', '/diff', '$e2e-required', '$e2e-action']);
        await expect(
            picker.locator('[data-agent-action-group="recent"] [data-agent-action="/context"]'),
        ).toHaveCount(0);
        await running.page.keyboard.press('Escape');

        await running.app.close();
        running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
        await pageRequest(running.page, 'session.select', { sessionId: agentSession.id });
        await expect
            .poll(async () => {
                const current = await pageRequest<{
                    terminals: Array<{ id: string; lastAgentProcessState?: string }>;
                }>(running.page, 'app.bootstrap');
                return current.terminals.find(({ id }) => id === agentTerminal.id)
                    ?.lastAgentProcessState;
            })
            .toBe('running');
        await expect
            .poll(async () => {
                const currentSettings = await pageRequest<{
                    value: {
                        'agents.providers': {
                            codex: { actions: { recent: { invocations: string[] } } };
                        };
                    };
                }>(running.page, 'settings.get');
                return currentSettings.value['agents.providers'].codex.actions.recent.invocations;
            })
            .toEqual(['/status', '/diff', '$e2e-required', '$e2e-action']);
        const restoredInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${agentTerminal.id}"] .xterm-helper-textarea`,
        );
        await expect(restoredInput).toBeVisible();
        await restoredInput.focus();
        await expect(restoredInput).toBeFocused();
        await running.page.keyboard.press('Meta+Shift+A');
        picker = running.page.locator('[data-agent-actions-picker]');
        await expect(picker).toBeVisible();
        await expect
            .poll(() => recentInvocations(picker))
            .toEqual(['/status', '/diff', '$e2e-required', '$e2e-action']);
        await running.page.keyboard.press('Escape');

        await pressNewTerminal(running.page);
        const shellTerminalId = await waitForNewTerminalId(running.page, [
            agentTerminal.id,
            claudeCreation.terminal.id,
        ]);
        const shellInput = running.page.locator(
            `.terminal-pane[data-terminal-id="${shellTerminalId}"] .xterm-helper-textarea`,
        );
        await shellInput.focus();
        await running.page.keyboard.press('Meta+Shift+A');
        await expect(running.page.locator('[data-agent-actions-picker]')).toHaveCount(0);
    } finally {
        try {
            await running.app.close();
        } catch {
            // Ignore close failures during cleanup.
        }
        await rm(testDirectory, { recursive: true, force: true });
    }
});
