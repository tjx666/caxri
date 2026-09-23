import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AgentProvider, BootstrapState } from '@caxri/protocol';
import type { Page } from '@playwright/test';
import Database from 'better-sqlite3';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
} from './support/helpers.ts';

const THREAD = '019e676d-8740-7bb2-8bcb-f189c8260607';
const PROVIDERS = ['claude', 'codex', 'grok'] as const;

async function openSearch(page: Page): Promise<void> {
    await page.keyboard.press('Meta+Shift+P');
    const palette = page.getByRole('dialog', { name: 'Command Palette' });
    await palette.getByRole('combobox').fill('Search Session Content');
    await palette.getByText('Search Session Content', { exact: true }).click();
    await expect(
        page.getByRole('dialog', { name: 'Search Session Content', exact: true }),
    ).toBeVisible();
}

async function writeTranscript(
    provider: AgentProvider,
    cwd: string,
    environment: NodeJS.ProcessEnv,
): Promise<string> {
    const agentSessionId = provider === 'codex' ? THREAD : `synthetic-${provider}`;
    let path: string;
    let records: unknown[];
    if (provider === 'claude') {
        path = join(
            environment.CLAUDE_CONFIG_DIR!,
            'projects',
            cwd.replaceAll(/[^a-z0-9]/giu, '-'),
            `${agentSessionId}.jsonl`,
        );
        records = [
            { type: 'user', message: { content: 'Investigate shared needle in Claude' } },
            {
                type: 'user',
                message: { content: [{ type: 'tool_result', content: 'excluded-tool-marker' }] },
            },
        ];
    } else if (provider === 'codex') {
        const date = new Date(0x019e676d8740);
        const segments = [
            String(date.getFullYear()),
            String(date.getMonth() + 1).padStart(2, '0'),
            String(date.getDate()).padStart(2, '0'),
        ];
        path = join(
            environment.CODEX_HOME!,
            'sessions',
            ...segments,
            `rollout-${segments.join('-')}T00-00-00-${THREAD}.jsonl`,
        );
        records = [
            {
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Archived shared needle discussion' }],
                },
            },
        ];
    } else {
        path = join(
            environment.GROK_HOME!,
            'sessions',
            encodeURIComponent(cwd),
            agentSessionId,
            'updates.jsonl',
        );
        records = ['Shared nee', 'dle and grok-only-marker'].map((text) => ({
            method: 'session/update',
            params: {
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
            },
        }));
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    return agentSessionId;
}

test('Session content search finds provider messages and requires explicit archive restore', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-content-search-e2e-'));
    const userData = join(directory, 'profile');
    const roots = ['workspace', ...PROVIDERS].map((name) => join(directory, name));
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: {}, codex: {}, grok: {} },
    });
    const options = {
        agentMode,
        userDataDir: userData,
        testRootPath: roots[0],
        env: { CAXRI_TEST_ROOT_PATHS: JSON.stringify(roots) },
    };
    let running = await launchCaxri(options);
    try {
        await createProjectSession(running.page);
        const shellId = await selectedSessionId(running.page);
        const ids: Partial<Record<AgentProvider, string>> = {};
        /* eslint-disable no-await-in-loop -- native test grants and Session creation are ordered */
        for (const provider of PROVIDERS) {
            const root = await pageRequest<string>(running.page, 'dialog.selectDirectory');
            const project = await pageRequest<{ id: string }>(running.page, 'project.create', {
                rootPath: root,
            });
            const created = await pageRequest<{ session: { id: string } }>(
                running.page,
                'session.create',
                { projectId: project.id, defaultAgent: 'shell' },
            );
            ids[provider] = created.session.id;
            await pageRequest(running.page, 'session.rename', {
                sessionId: created.session.id,
                displayTitle: `${provider} discussion`,
            });
        }
        await pageRequest(running.page, 'session.select', { sessionId: shellId });
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        await running.app.close();
        const database = new Database(join(userData, 'caxri.db'));
        try {
            for (const provider of PROVIDERS) {
                const terminal = bootstrap.terminals.find(
                    (entry) => entry.sessionId === ids[provider],
                );
                if (!terminal) throw new Error('Synthetic Terminal missing');
                const agentSessionId = await writeTranscript(
                    provider,
                    terminal.cwd,
                    agentMode.environment,
                );
                database
                    .prepare(
                        'UPDATE terminals SET kind = ?, provider = ?, agent_session_id = ?, last_process_state = ? WHERE id = ?',
                    )
                    .run(provider, provider, agentSessionId, 'stopped', terminal.id);
                database
                    .prepare('UPDATE sessions SET primary_agent_terminal_id = ? WHERE id = ?')
                    .run(terminal.id, ids[provider]);
            }
            database
                .prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
                .run(Date.now(), ids.codex);
        } finally {
            database.close();
        }
        /* eslint-enable no-await-in-loop */
        running = await launchCaxri(options);
        const page = running.page;
        await openSearch(page);
        const dialog = page.getByRole('dialog', { name: 'Search Session Content', exact: true });
        const input = dialog.getByRole('textbox', { name: 'Search Session Content', exact: true });
        await input.fill('NEEDLE');
        const results = dialog.getByRole('list', { name: 'Session content results' });
        await expect(results.getByRole('button')).toHaveCount(3);
        await expect(dialog.getByRole('status')).toContainText('Partial results');
        await expect(dialog.getByRole('status')).toContainText('3 of 4');
        await expect(results.getByRole('button', { name: /^codex discussion/u })).toContainText(
            'Archived',
        );
        // Diagnostic artifacts must not carry Terminal content, so the Session's shell stays masked.
        await page.screenshot({
            path: test.info().outputPath('content-search-results.png'),
            mask: [page.locator('.xterm')],
        });
        await input.fill('excluded-tool-marker');
        await expect(results.getByRole('button')).toHaveCount(0);
        await expect(dialog.getByText('No matches in the searched content.')).toBeVisible();
        await input.fill('needle');
        await input.fill('grok-only-marker');
        await expect(results.getByRole('button')).toHaveCount(1);
        await expect(results.getByRole('button')).toContainText('grok discussion');
        await input.fill('needle');
        const active = results.getByRole('button', { name: /^claude discussion/u });
        await active.focus();
        await page.keyboard.press('Enter');
        await expect.poll(() => selectedSessionId(page)).toBe(ids.claude);
        await openSearch(page);
        await input.fill('needle');
        await results.getByRole('button', { name: /^codex discussion/u }).click();
        const archived = page.getByRole('dialog', { name: 'Archived Sessions', exact: true });
        await expect(
            archived.getByRole('button', { name: 'Restore codex discussion' }),
        ).toBeVisible();
        expect(
            (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
                (session) => session.id === ids.codex,
            )?.archivedAt,
        ).toBeDefined();
        await expect(
            page
                .locator('[data-slot="dialog-title"]')
                .filter({ hasText: /^Search Session Content$/u }),
        ).toHaveCount(0);
        await page.screenshot({
            path: test.info().outputPath('content-search-explicit-restore.png'),
            mask: [page.locator('.xterm')],
        });
        await archived.getByRole('button', { name: 'Restore codex discussion' }).click();
        await expect
            .poll(
                async () =>
                    (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
                        (session) => session.id === ids.codex,
                    )?.archivedAt,
            )
            .toBeUndefined();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
