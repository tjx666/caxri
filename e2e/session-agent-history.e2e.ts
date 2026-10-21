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

test("a Session's hover card lists its past conversations and reopens a closed one", async () => {
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
        await sessionCard(page, sessionId).hover();
        const history = page.locator('.session-agent-history');
        await expect(history).toBeVisible();
        const entries = history.locator('.session-agent-history-entry');
        await expect(entries).toHaveCount(2);
        await expect(entries.first()).toHaveAttribute('data-open', 'true');
        const closed = history.getByRole('button', { name: /^Reopen conversation/u });
        await expect(closed).toHaveCount(1);
        // Titles come from Session search's index, which the first hover after launch starts filling.
        await expect(async () => {
            await page.mouse.move(800, 600);
            await expect(history).toHaveCount(0);
            await sessionCard(page, sessionId).hover();
            await expect(closed).toContainText('Fix invoice rounding', { timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await expect(entries.first()).toContainText('Add a refund ledger');
        await page
            .locator('.session-activity-card')
            .screenshot({ path: test.info().outputPath('session-agent-history.png') });
        // At rest the long title fades out right before the row's edge.
        await page.mouse.move(800, 600);
        await expect(history).toHaveCount(0);
        await sessionCard(page, sessionId).screenshot({
            path: test.info().outputPath('session-row-at-rest.png'),
        });
        await sessionCard(page, sessionId).hover();
        await expect(closed).toBeVisible();

        await closed.click();
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
