import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';
import type { Page } from '@playwright/test';
import Database from 'better-sqlite3';

import { highlightedText, isActiveFindMatchInView } from './support/agent-chat-find.ts';
import { fakeClaudeChatAgentMode } from './support/agent-chat-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
    VISIBLE_SESSION,
} from './support/helpers.ts';

const HELD = '4c2e8a1f-6b3d-4e7a-9f10-2d5c8b7a6e41';
const ARCHIVED = '5d3f9b2a-7c4e-4f8b-8a21-3e6d9c8b7f52';
const EXTERNAL = '6e4a0c3b-8d5f-4a9c-9b32-4f7e0d9c8a63';
const CHAT = '7f5b1d4c-9e60-4b0d-8c43-5a8f1e0d9b74';
const OTHER_APP = '806c2e5d-a071-4c1e-9d54-6b9a2f1e0c85';

/**
 * A Claude transcript as the CLI writes it: the first real prompt becomes the conversation's title.
 */
async function writeClaudeTranscript(
    configDirectory: string,
    cwd: string,
    sessionId: string,
    messages: readonly [user: string, assistant: string],
    entrypoint = 'cli',
): Promise<void> {
    const path = join(
        configDirectory,
        'projects',
        cwd.replaceAll(/[^a-z0-9]/giu, '-'),
        `${sessionId}.jsonl`,
    );
    const base = { cwd, entrypoint, isSidechain: false, sessionId };
    const records = [
        { ...base, type: 'user', message: { role: 'user', content: messages[0] } },
        {
            ...base,
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: messages[1] }] },
        },
    ];
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

/**
 * A long Claude transcript whose only mention of `needle` is in its first reply, so Chat loads it behind several
 * older-history pages (a live window of 1000 items, then pages of 200).
 */
async function writeLongClaudeTranscript(
    configDirectory: string,
    cwd: string,
    sessionId: string,
    turns: number,
    needle: string,
): Promise<void> {
    const path = join(
        configDirectory,
        'projects',
        cwd.replaceAll(/[^a-z0-9]/giu, '-'),
        `${sessionId}.jsonl`,
    );
    const base = { cwd, entrypoint: 'sdk-ts', isSidechain: false, sessionId };
    const records = Array.from({ length: turns }, (_, index) => [
        { ...base, type: 'user', message: { role: 'user', content: `Question ${index}` } },
        {
            ...base,
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: index === 0 ? needle : `Routine answer number ${index}.`,
                    },
                ],
            },
        },
    ]).flat();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

async function openSearch(page: Page) {
    await page.keyboard.press('Meta+Shift+S');
    const dialog = page.getByRole('dialog', { name: 'Search Sessions', exact: true });
    await expect(dialog).toBeVisible();
    return {
        dialog,
        input: dialog.getByRole('combobox', { name: 'Search Sessions', exact: true }),
        results: dialog.getByRole('listbox', { name: 'Session search results' }),
    };
}

test('Session search finds open, archived, and external conversations and acts on each', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-search-e2e-'));
    const userData = join(directory, 'profile');
    const roots = ['workspace', 'billing'].map((name) => join(directory, name));
    await Promise.all(roots.map((root) => mkdir(root, { recursive: true })));
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: { claude: {} },
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
        const billingRoot = await pageRequest<string>(running.page, 'dialog.selectDirectory');
        const project = await pageRequest<{ id: string }>(running.page, 'project.create', {
            rootPath: billingRoot,
        });
        const sessions: Record<string, string> = {};
        /* eslint-disable no-await-in-loop -- Session creation is ordered */
        for (const [agentSessionId, title] of [
            [HELD, 'Invoice rounding'],
            [ARCHIVED, 'Refund ledger'],
        ] as const) {
            const created = await pageRequest<{ session: { id: string } }>(
                running.page,
                'session.create',
                { projectId: project.id, defaultAgent: 'shell' },
            );
            sessions[agentSessionId] = created.session.id;
            await pageRequest(running.page, 'session.rename', {
                sessionId: created.session.id,
                title,
            });
        }
        /* eslint-enable no-await-in-loop */
        await pageRequest(running.page, 'session.select', { sessionId: shellId });
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        await running.app.close();

        const claudeHome = agentMode.environment.CLAUDE_CONFIG_DIR!;
        await writeClaudeTranscript(claudeHome, billingRoot, HELD, [
            'Why does the invoice total drift by a cent?',
            'Rounding happens per line item before tax.',
        ]);
        await writeClaudeTranscript(claudeHome, billingRoot, ARCHIVED, [
            'Reconcile the refund ledger',
            'Each refund now references its original invoice.',
        ]);
        // Run in the same folder but never in Caxri.
        await writeClaudeTranscript(claudeHome, billingRoot, EXTERNAL, [
            'Draft the overdue invoice reminder email',
            'Here is a short, friendly reminder.',
        ]);
        const database = new Database(join(userData, 'caxri.db'));
        try {
            for (const agentSessionId of [HELD, ARCHIVED]) {
                const sessionId = sessions[agentSessionId];
                const terminal = bootstrap.terminals.find((entry) => entry.sessionId === sessionId);
                if (!terminal) throw new Error('Synthetic Terminal missing');
                database
                    .prepare(
                        'UPDATE terminals SET kind = ?, agent_session_id = ?, last_process_state = ? WHERE id = ?',
                    )
                    .run('claude', agentSessionId, 'stopped', terminal.id);
                database
                    .prepare('UPDATE sessions SET primary_agent_terminal_id = ? WHERE id = ?')
                    .run(terminal.id, sessionId);
            }
            database
                .prepare('UPDATE sessions SET archived_at = ? WHERE id = ?')
                .run(Date.now(), sessions[ARCHIVED]);
        } finally {
            database.close();
        }

        running = await launchCaxri(options);
        const { page } = running;
        let search = await openSearch(page);
        await search.input.fill('invoice');
        const row = (agentSessionId: string) =>
            search.results.locator(`[data-session-search-key$="${agentSessionId}"]`);
        await expect(search.results.getByRole('option')).toHaveCount(3);
        await expect(row(HELD)).toHaveAttribute('data-session-search-status', 'open');
        await expect(row(ARCHIVED)).toHaveAttribute('data-session-search-status', 'archived');
        await expect(row(EXTERNAL)).toHaveAttribute('data-session-search-status', 'external');
        // A message match quotes the message with the query highlighted.
        await expect(row(ARCHIVED).locator('mark')).toHaveText('invoice');
        // Diagnostic artifacts must not carry Terminal content, so the Session's shell stays masked.
        await page.screenshot({
            path: test.info().outputPath('session-search-results.png'),
            mask: [page.locator('.xterm')],
        });

        // Operators in the query become removable chips; dismissing one deletes it from the query text.
        await search.input.fill('agent:claude invoice before:2000-01-01');
        const operators = search.dialog.getByRole('group', { name: 'Parsed filters' });
        await expect(operators).toContainText('Agent: Claude');
        await expect(operators).toContainText('Before 2000-01-01');
        await expect(search.results.getByRole('option')).toHaveCount(0);
        await search.dialog
            .getByRole('button', { name: 'Remove filter Before 2000-01-01', exact: true })
            .click();
        await expect(search.input).toHaveValue('agent:claude invoice');
        await expect(search.results.getByRole('option')).toHaveCount(3);
        await search.dialog
            .getByRole('button', { name: 'Remove filter Agent: Claude', exact: true })
            .click();
        await expect(search.input).toHaveValue('invoice');
        await expect(operators).toHaveCount(0);

        // Words found apart rather than as a phrase, then only some of the words, each say how the search loosened.
        const relaxation = search.dialog.locator('[data-session-search-relaxation]');
        await search.input.fill('invoice refund');
        await expect(relaxation).toHaveText(
            'No exact phrase match; showing results containing all words',
        );
        await search.input.fill('invoice zebra');
        await expect(relaxation).toHaveText(
            'No result contains every word; showing results containing any word',
        );
        await search.input.fill('invoice');
        await expect(relaxation).toHaveCount(0);
        await expect(search.results.getByRole('option')).toHaveCount(3);

        // Sort and Project scope switch from the filter bar or with Option+S and Option+P.
        const sortRecent = search.dialog.locator('[data-session-search-sort="recent"]');
        const sortRelevance = search.dialog.locator('[data-session-search-sort="relevance"]');
        await expect(sortRelevance).toHaveAttribute('aria-pressed', 'true');
        await sortRecent.click();
        await expect(sortRecent).toHaveAttribute('aria-pressed', 'true');
        await expect(search.results.getByRole('option')).toHaveCount(3);
        await search.input.press('Alt+S');
        await expect(sortRelevance).toHaveAttribute('aria-pressed', 'true');
        const currentProjectScope = search.dialog.locator(
            '[data-session-search-scope="currentProject"]',
        );
        const allProjectsScope = search.dialog.locator('[data-session-search-scope="allProjects"]');
        await expect(currentProjectScope).toHaveAttribute('aria-pressed', 'true');
        await allProjectsScope.click();
        await expect(allProjectsScope).toHaveAttribute('aria-pressed', 'true');
        await search.input.press('Alt+P');
        await expect(currentProjectScope).toHaveAttribute('aria-pressed', 'true');
        await expect(search.results.getByRole('option')).toHaveCount(3);

        await search.dialog.locator('[data-session-search-status-filter="external"]').click();
        await expect(search.results.getByRole('option')).toHaveCount(1);
        await expect(row(EXTERNAL)).toBeVisible();

        // The selected result previews its messages without adding the conversation to Caxri.
        const preview = search.dialog.getByRole('region', { name: 'Conversation preview' });
        await expect(preview).toContainText('Not in Caxri yet. Previewing does not add it.');
        await expect(preview).toContainText('Draft the overdue invoice reminder email');
        await expect(preview.locator('[data-session-search-preview-match]')).toContainText(
            'invoice',
        );
        await expect(preview.locator('mark')).toHaveText('invoice');
        expect(
            (await pageRequest<BootstrapState>(page, 'app.bootstrap')).terminals.some(
                (entry) => entry.agentSessionId === EXTERNAL,
            ),
        ).toBe(false);
        await page.screenshot({
            path: test.info().outputPath('session-search-preview.png'),
            mask: [page.locator('.xterm')],
        });

        // An ID prefix finds the conversation; Enter adds it to Caxri and opens it.
        await search.input.fill(EXTERNAL.slice(0, 8));
        await expect(search.results.getByRole('option').first()).toHaveAttribute(
            'data-session-search-key',
            `claude:${EXTERNAL}`,
        );
        await search.input.press('Enter');
        await expect(search.dialog).toHaveCount(0);
        await expect
            .poll(async () => {
                const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
                const terminal = state.terminals.find((entry) => entry.agentSessionId === EXTERNAL);
                const session = state.sessions.find((entry) => entry.id === terminal?.sessionId);
                return session && { projectId: session.projectId, title: session.title };
            })
            .toEqual({ projectId: project.id, title: 'Draft the overdue invoice reminder email' });
        const importedId = (
            await pageRequest<BootstrapState>(page, 'app.bootstrap')
        ).terminals.find((entry) => entry.agentSessionId === EXTERNAL)!.sessionId;
        await expect.poll(() => selectedSessionId(page)).toBe(importedId);

        // An archived conversation restores in place and opens.
        search = await openSearch(page);
        await search.input.fill('refund ledger');
        await expect(search.results.getByRole('option').first()).toHaveAttribute(
            'data-session-search-status',
            'archived',
        );
        await search.input.press('Enter');
        await expect.poll(() => selectedSessionId(page)).toBe(sessions[ARCHIVED]);
        expect(
            (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
                (session) => session.id === sessions[ARCHIVED],
            )?.archivedAt,
        ).toBeUndefined();
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * Agent Chat runs Claude through the Agent SDK, so its transcript starts with an `sdk-ts` entry point. Such a
 * conversation is searchable by content while a Session holds it, and opening the match lands find on the message.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Session search finds an Agent Chat conversation by message text and opens find on the match', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-search-chat-e2e-'));
    const userData = join(directory, 'profile');
    const root = join(directory, 'workspace');
    await mkdir(root, { recursive: true });
    // The SDK fake lets the reopened Chat resume and render the synthetic transcript's history.
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const options = { agentMode, userDataDir: userData, testRootPath: root };
    let running = await launchCaxri(options);
    try {
        await createProjectSession(running.page);
        const sessionId = await selectedSessionId(running.page);
        await pageRequest(running.page, 'session.rename', {
            sessionId,
            title: 'Vendor note',
        });
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const cwd = bootstrap.sessions.find((session) => session.id === sessionId)!.rootPath;
        await running.app.close();

        const claudeHome = agentMode.environment.CLAUDE_CONFIG_DIR!;
        await writeClaudeTranscript(
            claudeHome,
            cwd,
            CHAT,
            [
                'Draft a latency note for the vendor',
                'Even a **probe** with only 21 tokens often waits 30 to 190 seconds.',
            ],
            'sdk-ts',
        );
        // Another application's SDK run in the same folder is not the user's conversation.
        await writeClaudeTranscript(
            claudeHome,
            cwd,
            OTHER_APP,
            ['Classify this email', 'A probe with only 21 tokens is spam.'],
            'sdk-ts',
        );
        const terminal = bootstrap.terminals.find((entry) => entry.sessionId === sessionId);
        if (!terminal) throw new Error('Synthetic Terminal missing');
        const database = new Database(join(userData, 'caxri.db'));
        try {
            database
                .prepare(
                    'UPDATE terminals SET kind = ?, agent_session_id = ?, last_process_state = ?, surface = ? WHERE id = ?',
                )
                .run('claude', CHAT, 'stopped', 'chat', terminal.id);
            database
                .prepare('UPDATE sessions SET primary_agent_terminal_id = ? WHERE id = ?')
                .run(terminal.id, sessionId);
        } finally {
            database.close();
        }

        running = await launchCaxri(options);
        const { page } = running;
        const search = await openSearch(page);
        await search.input.fill('probe with only 21');
        const rows = search.results.getByRole('option');
        await expect(rows).toHaveCount(1);
        await expect(rows.first()).toHaveAttribute('data-session-search-status', 'open');
        await expect(rows.first().locator('.session-search-snippet')).toContainText(
            'Claude: Even a probe with only 21 tokens',
        );
        await page.screenshot({ path: testInfo.outputPath('session-search-chat-match.png') });

        await search.input.press('Enter');
        await expect(search.dialog).toHaveCount(0);
        const find = page.locator(VISIBLE_SESSION).getByRole('search', { name: 'Find in Chat' });
        await expect(find.getByRole('textbox', { name: 'Find in Chat' })).toHaveValue(
            'probe with only 21',
        );
        await expect(find.getByText('1/1')).toBeVisible();
        await expect
            .poll(() => highlightedText(page, 'agent-chat-find-active'))
            .toEqual(['probe with only 21']);
        await page.screenshot({ path: testInfo.outputPath('session-search-chat-find.png') });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

/**
 * A match in older history that Chat has not loaded: opening the result pages the history back until find lands on it,
 * without the user clicking Search earlier messages.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('Session search result in unloaded older Chat history loads it and lands on the match', async ({}, testInfo) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-search-older-e2e-'));
    const userData = join(directory, 'profile');
    const root = join(directory, 'workspace');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeClaudeChatAgentMode(userData);
    const options = { agentMode, userDataDir: userData, testRootPath: root };
    let running = await launchCaxri(options);
    try {
        await createProjectSession(running.page);
        const sessionId = await selectedSessionId(running.page);
        await pageRequest(running.page, 'session.rename', { sessionId, title: 'Long audit' });
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const cwd = bootstrap.sessions.find((session) => session.id === sessionId)!.rootPath;
        await running.app.close();

        await writeLongClaudeTranscript(
            agentMode.environment.CLAUDE_CONFIG_DIR!,
            cwd,
            CHAT,
            1500,
            'The zebra quota was raised during the first week.',
        );
        const terminal = bootstrap.terminals.find((entry) => entry.sessionId === sessionId);
        if (!terminal) throw new Error('Synthetic Terminal missing');
        const database = new Database(join(userData, 'caxri.db'));
        try {
            database
                .prepare(
                    'UPDATE terminals SET kind = ?, agent_session_id = ?, last_process_state = ?, surface = ? WHERE id = ?',
                )
                .run('claude', CHAT, 'stopped', 'chat', terminal.id);
            database
                .prepare('UPDATE sessions SET primary_agent_terminal_id = ? WHERE id = ?')
                .run(terminal.id, sessionId);
        } finally {
            database.close();
        }

        running = await launchCaxri(options);
        const { page } = running;
        const search = await openSearch(page);
        await search.input.fill('zebra quota was raised');
        // The long transcript is indexed in the background, so the row first matches on metadata alone.
        await expect(search.results.locator('.session-search-snippet')).toContainText(
            'zebra quota was raised',
            { timeout: 60_000 },
        );
        await page.screenshot({ path: testInfo.outputPath('session-search-older-match.png') });
        await search.input.press('Enter');
        await expect(search.dialog).toHaveCount(0);
        const find = page.locator(VISIBLE_SESSION).getByRole('search', { name: 'Find in Chat' });
        await expect(find.getByText('1/1')).toBeVisible({ timeout: 30_000 });
        await expect
            .poll(() => highlightedText(page, 'agent-chat-find-active'))
            .toEqual(['zebra quota was raised']);
        await expect.poll(() => isActiveFindMatchInView(page)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('session-search-older-find.png') });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
