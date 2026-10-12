import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';
import Database from 'better-sqlite3';

import { fakeCodexChatProvider, openAgentChat } from './support/agent-chat-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import {
    chooseTerminalFromCreateMenu,
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    VISIBLE_SESSION,
    waitForNewTerminalId,
} from './support/helpers.ts';

const CITED_TITLE = 'Login bug investigation';
const CITED_AGENT_SESSION = 'synthetic-cited-claude';
/**
 * A cited reference ends with `<path> contains the conversation from Session "<title>".`; the path is the only part the
 * Server chooses.
 */
const REFERENCE = new RegExp(
    String.raw`^@(/\S+/caxri-session-references/session-[^\s/]+\.md) contains the conversation from Session "${CITED_TITLE}"\.`,
    'u',
);

function claudeRecord(type: 'assistant' | 'user', content: unknown): string {
    return JSON.stringify({ type, message: { content } });
}

async function capturedInput(path: string): Promise<string> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch {
        return '';
    }
    return text
        .split('\n')
        .filter(Boolean)
        .map((hex) => Buffer.from(hex, 'hex').toString('utf8'))
        .join('');
}

/**
 * Asserts the condensed file kept the user and Agent text and dropped the tool traffic, then removes it so the shared
 * temporary directory keeps nothing from the run.
 */
async function expectCondensedConversation(path: string): Promise<void> {
    const markdown = await readFile(path, 'utf8');
    await rm(path, { force: true });
    expect(markdown).toContain(`# Conversation from Session "${CITED_TITLE}"`);
    expect(markdown).toContain('## User\n\nWhy does the login form reject valid passwords?');
    expect(markdown).toContain('## Agent (Claude)\n\nThe password field trims trailing spaces.');
    expect(markdown).not.toContain('tool-call-marker');
    expect(markdown).not.toContain('tool-output-marker');
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('typing @ cites another Session from Agent Chat and from the Agent Commands & Skills picker', async ({}, testInfo) => {
    // Claude Code keys its transcript directory by its real working directory, so the Project root must be resolved.
    const created = await mkdtemp(join(tmpdir(), 'caxri-session-reference-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    const capture = join(directory, 'claude-input.hex');
    await mkdir(root, { recursive: true });
    await writeFile(capture, '');
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                startupOutput: 'REFERENCE_READY\r\n',
                inputCapture: { path: capture, encoding: 'hex', echoPrefix: 'INPUT:' },
            },
            codex: fakeCodexChatProvider(directory),
        },
    });
    const options = { agentMode, userDataDir: userData, testRootPath: root };
    let running = await launchCaxri(options);
    try {
        const shellId = await createProjectSession(running.page, 'shell');
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const projectId = bootstrap.sessions.find((session) => session.id === shellId)?.projectId;
        const cited = await pageRequest<{ session: { id: string } }>(
            running.page,
            'session.create',
            { projectId, defaultAgent: 'shell' },
        );
        const citedId = cited.session.id;
        await pageRequest(running.page, 'session.rename', {
            sessionId: citedId,
            displayTitle: CITED_TITLE,
        });
        await pageRequest(running.page, 'session.select', { sessionId: shellId });
        const seeded = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        await closeAppQuietly(running.app);

        // Turn the cited Session's Shell into a stopped Claude Code Terminal with a synthetic transcript.
        const citedTerminal = seeded.terminals.find((terminal) => terminal.sessionId === citedId);
        if (!citedTerminal) throw new Error('Cited Session Terminal missing');
        const transcript = join(
            agentMode.environment.CLAUDE_CONFIG_DIR!,
            'projects',
            citedTerminal.cwd.replaceAll(/[^a-z0-9]/giu, '-'),
            `${CITED_AGENT_SESSION}.jsonl`,
        );
        await mkdir(dirname(transcript), { recursive: true });
        await writeFile(
            transcript,
            `${[
                claudeRecord('user', 'Why does the login form reject valid passwords?'),
                claudeRecord('assistant', [
                    {
                        type: 'tool_use',
                        id: 't1',
                        name: 'Bash',
                        input: { command: 'tool-call-marker' },
                    },
                ]),
                claudeRecord('user', [
                    { type: 'tool_result', tool_use_id: 't1', content: 'tool-output-marker' },
                ]),
                claudeRecord('assistant', [
                    { type: 'text', text: 'The password field trims trailing spaces.' },
                ]),
            ].join('\n')}\n`,
        );
        const database = new Database(join(userData, 'caxri.db'));
        try {
            database
                .prepare(
                    'UPDATE terminals SET kind = ?, provider = ?, agent_session_id = ?, last_process_state = ? WHERE id = ?',
                )
                .run('claude', 'claude', CITED_AGENT_SESSION, 'stopped', citedTerminal.id);
            database
                .prepare('UPDATE sessions SET primary_agent_terminal_id = ? WHERE id = ?')
                .run(citedTerminal.id, citedId);
        } finally {
            database.close();
        }

        running = await launchCaxri(options);
        const { page } = running;

        // Terminal: the Agent CLI owns its own `@` list, so Sessions are cited from Caxri's picker.
        await page
            .locator('.project-heading')
            .filter({ has: page.getByRole('button', { name: /^New Session in /u }) })
            .hover();
        await page.getByRole('button', { name: /^New Session in /u }).click();
        await chooseTerminalFromCreateMenu(page, 'Claude');
        const citingTerminalId = await waitForNewTerminalId(
            page,
            seeded.terminals.map(({ id }) => id),
        );
        const citingTerminal = page.locator(
            `.terminal-pane[data-terminal-id="${citingTerminalId}"]`,
        );
        await expect(citingTerminal.locator('.xterm-rows')).toContainText('REFERENCE_READY');
        // The picker opens only once the Agent reports itself running.
        await expect
            .poll(
                async () =>
                    (await pageRequest<BootstrapState>(page, 'app.bootstrap')).terminals.find(
                        (terminal) => terminal.id === citingTerminalId,
                    )?.lastAgentProcessState,
            )
            .toBe('running');
        await citingTerminal.locator('.xterm-helper-textarea').focus();
        await page.keyboard.press('Meta+Shift+A');
        const picker = page.locator('[data-agent-actions-picker]');
        await picker
            .getByPlaceholder('Search skills and slash commands, or type @ for Sessions…')
            .fill('@login');
        const sessions = picker.locator('[data-agent-action-group="session"]');
        await expect(sessions.locator('[data-session-reference]')).toHaveCount(1);
        await expect(sessions.locator(`[data-session-reference="${citedId}"]`)).toContainText(
            CITED_TITLE,
        );
        await expect(picker.locator('[data-agent-action]')).toHaveCount(0);
        await page.screenshot({
            path: testInfo.outputPath('terminal-session-reference.png'),
            mask: [page.locator('.xterm')],
        });
        await page.keyboard.press('Enter');
        await expect(picker).not.toBeVisible();
        let terminalReference = '';
        await expect
            .poll(async () => {
                terminalReference = await capturedInput(capture);
                return REFERENCE.test(terminalReference);
            })
            .toBe(true);
        // The reference is typed, not submitted: the user finishes the prompt.
        expect(terminalReference).not.toContain('\r');
        await expectCondensedConversation(REFERENCE.exec(terminalReference)![1]);

        // Agent Chat: `@` in the composer opens the Sessions list at the caret.
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(VISIBLE_SESSION);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await expect(message).toBeVisible();
        await message.fill('@log');
        const list = chat.getByRole('listbox', { name: 'Sessions' });
        await expect(list.getByRole('option')).toHaveText([new RegExp(`^${CITED_TITLE}`, 'u')]);
        await page.screenshot({
            path: testInfo.outputPath('chat-session-reference.png'),
            mask: [page.locator('.xterm')],
        });
        await message.press('Enter');
        await expect(list).toHaveCount(0);
        await expect(message).toHaveValue(REFERENCE);
        const chatReference = await message.inputValue();
        await expectCondensedConversation(REFERENCE.exec(chatReference)![1]);
        // Escape dismisses the list until the draft changes.
        await message.fill('@log');
        await expect(list).toBeVisible();
        await message.press('Escape');
        await expect(list).toHaveCount(0);
        // Coming back to a draft that ends in `@word` waits for the user again, as a restored draft does: the composer
        // is reused across Sessions, so the caret it followed before the switch must not reopen the list.
        await message.fill('@lo');
        await expect(list).toBeVisible();
        const citingSessionId = (
            await pageRequest<BootstrapState>(page, 'app.bootstrap')
        ).terminals.find((terminal) => terminal.id === citingTerminalId)?.sessionId;
        await pageRequest(page, 'session.select', { sessionId: shellId });
        await expect(message).toBeHidden();
        await pageRequest(page, 'session.select', { sessionId: citingSessionId });
        await expect(message).toHaveValue('@lo');
        await expect(list).toHaveCount(0);
        await message.click();
        await expect(list).toBeVisible();
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});
