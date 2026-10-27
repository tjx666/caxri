import {
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StructuredLogger } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaxriDatabase } from '../../db/index';
import {
    formatConversationMarkdown,
    SessionConversationReferenceService,
} from '../conversation-reference';

const AGENT_SESSION_ID = 'abc-1234-5678-9012';

type LogWrite = (
    level: string,
    event: string,
    options: { fields: Record<string, unknown> },
) => void;

function claudeText(type: 'assistant' | 'user', text: string): string {
    return JSON.stringify({ type, message: { content: [{ type: 'text', text }] } });
}

function claudeToolUse(command: string): string {
    return JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] },
    });
}

function claudeToolResult(output: string): string {
    return JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: output }] },
    });
}

describe('SessionConversationReferenceService', () => {
    let home: string;
    let directory: string;
    let cwd: string;
    let transcript: string;
    let write: ReturnType<typeof vi.fn<LogWrite>>;
    let session: Record<string, unknown> | undefined;
    let terminal: Record<string, unknown> | undefined;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-conversation-reference-'));
        directory = join(home, 'references');
        cwd = join(home, 'project');
        const projects = join(home, '.claude', 'projects', cwd.replaceAll(/[^a-z\d]/gi, '-'));
        await mkdir(projects, { recursive: true });
        transcript = join(projects, `${AGENT_SESSION_ID}.jsonl`);
        session = { id: 's1', title: 'Fix login', primaryAgentTerminalId: 't1' };
        terminal = { id: 't1', provider: 'claude', agentSessionId: AGENT_SESSION_ID, cwd };
        write = vi.fn<LogWrite>();
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    function service(now = Date.now): SessionConversationReferenceService {
        let next = 0;
        return new SessionConversationReferenceService(
            directory,
            {
                getSession: () => session,
                getTerminal: () => terminal,
            } as unknown as CaxriDatabase,
            { write } as unknown as StructuredLogger,
            { homeDirectory: home, variables: {} },
            now,
            () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
        );
    }

    it('writes only user and Agent text to an owner-only file', async () => {
        await writeFile(
            transcript,
            [
                claudeText('user', 'Why does login fail?'),
                claudeToolUse('cat secret-config.json'),
                claudeToolResult('TOKEN=tool-output-must-not-appear'),
                claudeText('assistant', 'The session cookie expired.'),
                claudeText('assistant', 'I renewed it on refresh.'),
                claudeText('user', '<system-reminder>injected guide</system-reminder>'),
                claudeText('user', 'Thanks'),
                '',
            ].join('\n'),
        );
        const reference = await service().prepare('s1');
        expect(reference.filePath.startsWith(directory)).toBe(true);
        expect(reference.filePath).not.toMatch(/\s/);
        expect(reference).toMatchObject({
            title: 'Fix login',
            messageCount: 3,
            omittedMessageCount: 0,
        });
        const markdown = await readFile(reference.filePath, 'utf8');
        expect(markdown).toContain('# Conversation from Session "Fix login"');
        expect(markdown).toContain('## User\n\nWhy does login fail?');
        expect(markdown).toContain(
            '## Agent (Claude)\n\nThe session cookie expired.\n\nI renewed it on refresh.',
        );
        expect(markdown).toContain('## User\n\nThanks');
        expect(markdown).not.toContain('secret-config');
        expect(markdown).not.toContain('tool-output-must-not-appear');
        expect(markdown).not.toContain('injected guide');
        expect((await stat(reference.filePath)).mode & 0o777).toBe(0o600);
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        // The log records counts, never the conversation.
        expect(JSON.stringify(write.mock.calls)).not.toContain('cookie');
        const prepared = write.mock.calls.find(
            ([, event]) => event === 'session_context.reference_prepared',
        );
        expect(prepared?.[2].fields).toMatchObject({ messageCount: 3, sessionId: 's1' });
    });

    it('refuses a Session without an Agent and one whose transcript holds no messages', async () => {
        terminal = undefined;
        await expect(service().prepare('s1')).rejects.toMatchObject({ code: 'CONFLICT' });
        terminal = { id: 't1', provider: 'claude', agentSessionId: AGENT_SESSION_ID, cwd };
        await writeFile(transcript, `${claudeToolUse('ls')}\n`);
        await expect(service().prepare('s1')).rejects.toMatchObject({ code: 'CONFLICT' });
        session = undefined;
        await expect(service().prepare('s1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(write.mock.calls.map((call) => call[2].fields.reason)).toEqual([
            'noAgent',
            'empty',
            'sessionMissing',
        ]);
    });

    it('refuses to write through a symlink planted in place of the directory', async () => {
        await writeFile(transcript, `${claudeText('user', 'hello')}\n`);
        const elsewhere = join(home, 'elsewhere');
        await mkdir(elsewhere);
        await symlink(elsewhere, directory);
        await expect(service().prepare('s1')).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(await readdir(elsewhere)).toEqual([]);
    });

    it('drops expired reference files and leaves unrelated files alone', async () => {
        await writeFile(transcript, `${claudeText('user', 'hello')}\n`);
        await mkdir(directory, { recursive: true });
        const expired = join(
            directory,
            'session-20260101T000000-00000000-0000-4000-8000-000000000099.md',
        );
        await writeFile(expired, 'old');
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
        await utimes(expired, old, old);
        await writeFile(join(directory, 'notes.md'), 'mine');
        const reference = await service().prepare('s1');
        expect(
            (await readdir(directory)).toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(
            [reference.filePath.slice(directory.length + 1), 'notes.md'].toSorted((left, right) =>
                left.localeCompare(right),
            ),
        );
    });
});

describe('formatConversationMarkdown', () => {
    it('keeps the most recent whole messages within the byte budget and says how many it omitted', () => {
        const messages = Array.from({ length: 10 }, (_, index) => ({
            role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
            text: `message ${index} ${'x'.repeat(100)}`,
        }));
        const result = formatConversationMarkdown(
            { messages, omittedMessageCount: 2, provider: 'codex', title: 'Plan' },
            900,
        );
        expect(new TextEncoder().encode(result.markdown).byteLength).toBeLessThanOrEqual(900);
        expect(result.messageCount).toBeGreaterThan(0);
        expect(result.messageCount).toBeLessThan(10);
        expect(result.omittedMessageCount).toBe(2 + 10 - result.messageCount);
        expect(result.markdown).toContain(
            `> ${result.omittedMessageCount} earlier messages were omitted`,
        );
        expect(result.markdown).toContain('message 9');
        expect(result.markdown).not.toContain('message 0 ');
        expect(result.markdown).toContain('## Agent (Codex)');
        expect(result.markdown).not.toContain('only its most recent part was read');
        const tail = formatConversationMarkdown(
            {
                messages,
                omittedMessageCount: 0,
                provider: 'codex',
                title: 'Plan',
                isTailOnly: true,
            },
            900,
        );
        expect(new TextEncoder().encode(tail.markdown).byteLength).toBeLessThanOrEqual(900);
        expect(tail.markdown).toContain('only its most recent part was read');
    });
});
