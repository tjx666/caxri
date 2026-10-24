import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';
import Database from 'better-sqlite3';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    sessionCard,
} from './support/helpers.ts';
import {
    chooseContextMenuItem,
    dismissContextMenu,
    waitForContextMenu,
} from './support/native-context-menu.ts';

const CLOSED = '7f5b1d4c-9e6a-4b0d-8c43-5a8f1e0d9b74';
const CURRENT = '8a6c2e5d-0f7b-4c1e-9d54-6b9a2f1e0c85';

/**
 * A Claude transcript as the CLI writes it: the first real prompt becomes the conversation's title.
 */
async function writeClaudeTranscript(
    configDirectory: string,
    cwd: string,
    sessionId: string,
    prompt: string,
): Promise<void> {
    const path = join(
        configDirectory,
        'projects',
        cwd.replaceAll(/[^a-z0-9]/giu, '-'),
        `${sessionId}.jsonl`,
    );
    const base = { cwd, entrypoint: 'cli', isSidechain: false, sessionId };
    const records = [
        { ...base, type: 'user', message: { role: 'user', content: prompt } },
        {
            ...base,
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
        },
    ];
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test("a Session's context menu reopens a closed past conversation", async () => {
    const created = await mkdtemp(join(tmpdir(), 'caxri-session-agent-history-e2e-'));
    const directory = await realpath(created);
    const userData = join(directory, 'profile');
    const root = join(directory, 'billing');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: {} },
    });
    const options = { agentMode, userDataDir: userData, testRootPath: root };
    let running = await launchCaxri(options);
    try {
        const sessionId = await createProjectSession(running.page);
        await pageRequest(running.page, 'session.rename', {
            sessionId,
            displayTitle: 'Reconcile the invoice rounding drift across every billing export',
        });
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const session = bootstrap.sessions.find(({ id }) => id === sessionId)!;
        const terminal = bootstrap.terminals.find((entry) => entry.sessionId === sessionId)!;
        await running.app.close();

        const claudeHome = agentMode.environment.CLAUDE_CONFIG_DIR!;
        await writeClaudeTranscript(claudeHome, root, CLOSED, 'Fix invoice rounding');
        await writeClaudeTranscript(claudeHome, root, CURRENT, 'Add a refund ledger');
        // The Terminal now holds CURRENT; CLOSED is the conversation it held before `/clear`, known only to the ledger.
        const database = new Database(join(userData, 'caxri.db'));
        try {
            database
                .prepare(
                    'UPDATE terminals SET kind = ?, provider = ?, agent_session_id = ?, last_process_state = ? WHERE id = ?',
                )
                .run('claude', 'claude', CURRENT, 'stopped', terminal.id);
            database
                .prepare('UPDATE sessions SET primary_agent_terminal_id = ? WHERE id = ?')
                .run(terminal.id, sessionId);
            const insert = database.prepare(
                'INSERT INTO agent_session_usage (provider, agent_session_id, session_id, project_id, terminal_id, cwd, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            );
            const now = Date.now();
            insert.run(
                'claude',
                CLOSED,
                sessionId,
                session.projectId,
                terminal.id,
                root,
                now - 3_600_000,
            );
            insert.run(
                'claude',
                CURRENT,
                sessionId,
                session.projectId,
                terminal.id,
                root,
                now - 60_000,
            );
        } finally {
            database.close();
        }

        running = await launchCaxri(options);
        const { page } = running;
        await createAdditionalShellSession(page);
        const menuPath = ['Reopen previous conversation', 'Fix invoice rounding'];
        // Titles come from Session search's index, which the first history read after launch starts filling.
        await expect(async () => {
            await sessionCard(page, sessionId).click({ button: 'right' });
            try {
                const items = await waitForContextMenu(running.app);
                const submenu = items.find((item) => item.label === menuPath[0])?.submenu ?? [];
                // Only the closed conversation is offered; the open one is already a tab of the Session.
                expect(submenu.map((item) => item.label)).toEqual([menuPath[1]]);
            } catch (error) {
                await dismissContextMenu(running.app);
                throw error;
            }
        }).toPass({ timeout: 30_000 });
        await chooseContextMenuItem(running.app, menuPath);
        await expect.poll(() => selectedSessionId(page)).toBe(sessionId);
        await expect
            .poll(async () => {
                const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
                return state.terminals
                    .filter((entry) => entry.sessionId === sessionId && entry.provider === 'claude')
                    .map(({ agentSessionId }) => agentSessionId);
            })
            .toEqual(expect.arrayContaining([CLOSED, CURRENT]));
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
