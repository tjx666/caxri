import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { fixture } from './chat-service-fixture';
import { fakeClaudeChatExecutableSource } from './fixtures/fake-chat-executables';
import type { FakeClaudeScript } from './fixtures/fake-claude-script';

const runFile = promisify(execFile);

/**
 * Writes `script` (or raw text) to a temporary file and points the fake Claude at it for this test. The fixture's
 * provider environment inherits `process.env`, so the variable must be set before the Chat's first read starts it.
 */
async function writeScript(script: FakeClaudeScript | string) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-script-'));
    onTestFinished(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    const file = join(directory, 'script.json');
    await writeFile(file, typeof script === 'string' ? script : JSON.stringify(script));
    vi.stubEnv('FAKE_CLAUDE_SCRIPT', file);
    return { directory, file };
}

const GREETING_SOURCE = [
    '// Greeting helpers',
    'export function greet() {',
    '    return "hi";',
    '}',
    '',
    'export function farewell() {',
    '    return "bye";',
    '}',
    '',
].join('\n');

const SCRIPT: FakeClaudeScript = {
    model: { value: 'claude-opus-4-7', displayName: 'Opus 4.7' },
    turns: [
        {
            prompt: '  Make greet() take a name.  ',
            steps: [
                { kind: 'thinking', text: 'Find where greet() is defined, then change it.' },
                {
                    kind: 'todos',
                    todos: [
                        {
                            content: 'Find greet()',
                            status: 'completed',
                            activeForm: 'Finding greet()',
                        },
                        {
                            content: 'Add the name',
                            status: 'in_progress',
                            activeForm: 'Adding the name',
                        },
                        {
                            content: 'Run the tests',
                            status: 'pending',
                            activeForm: 'Running the tests',
                        },
                    ],
                },
                {
                    kind: 'tool',
                    name: 'Bash',
                    input: { command: 'rg -n greet src', description: 'Find the greeting' },
                    output: 'src/greeting.ts:2:export function greet() {',
                    durationMs: 20,
                },
                {
                    kind: 'tool',
                    name: 'Edit',
                    input: {
                        file_path: '{{cwd}}/src/greeting.ts',
                        old_string: 'export function greet() {\n    return "hi";',
                        new_string:
                            'export function greet(name: string) {\n    return `hi ${name}`;',
                    },
                    output: 'The file {{cwd}}/src/greeting.ts has been updated successfully.',
                    durationMs: 20,
                },
                { kind: 'text', text: 'greet() takes a **name** now.', chunkDelayMs: 0 },
            ],
        },
        {
            prompt: 'Run the tests',
            steps: [
                {
                    kind: 'approval',
                    name: 'Bash',
                    input: { command: 'bun run test', description: 'Run the tests' },
                    output: '12 passed',
                },
                { kind: 'text', text: 'All 12 tests pass.', chunkDelayMs: 0 },
            ],
        },
        {
            prompt: 'Wait for the gate',
            steps: [
                { kind: 'hold', file: 'gate' },
                { kind: 'text', text: 'The gate opened.', chunkDelayMs: 0 },
            ],
        },
        {
            prompt: 'Break the build',
            steps: [
                { kind: 'text', text: 'Building now.', chunkDelayMs: 0 },
                { kind: 'fail', message: 'The fake model is overloaded.' },
            ],
        },
    ],
};

async function startClaude() {
    await writeScript(SCRIPT);
    const context = await fixture({ provider: 'claude' });
    await mkdir(join(context.terminal.cwd, 'src'));
    await writeFile(join(context.terminal.cwd, 'src', 'greeting.ts'), GREETING_SOURCE);
    return context;
}

describe('AgentChatService with scripted fake Claude turns', () => {
    it('plays a scripted turn as the Chat shows a real one, under the renamed model, and keeps it after a restart', async () => {
        const { service, terminal, until } = await startClaude();
        const ready = await until((snapshot) => snapshot.status === 'ready');
        expect(ready.models?.[0]).toMatchObject({ id: 'claude-opus-4-7', displayName: 'Opus 4.7' });

        await service.send(terminal.id, { text: 'Make greet() take a name.' });
        const done = await until(
            (snapshot) =>
                snapshot.turns.at(-1)?.status === 'completed' &&
                !snapshot.activeTurnId &&
                snapshot.usage?.breakdown !== undefined,
        );
        /**
         * What a reopened Chat keeps; the live rows also carry timings the transcript does not.
         */
        const shown = (snapshot: typeof done) => {
            const command = snapshot.items.find((item) => item.type === 'command');
            const edit = snapshot.items.find((item) => item.type === 'fileChange');
            const reply = snapshot.items.at(-1);
            return {
                types: snapshot.items.map((item) => item.type),
                plan: snapshot.plan?.steps,
                command: command?.type === 'command' ? command : undefined,
                edit: edit?.type === 'fileChange' ? edit : undefined,
                reply: reply?.type === 'agentMessage' ? reply.text : undefined,
            };
        };
        const live = shown(done);
        expect(done.model).toBe('claude-opus-4-7');
        expect(live.types).toEqual([
            'userMessage',
            'reasoning',
            'command',
            'fileChange',
            'agentMessage',
        ]);
        expect(done.items[1]).toMatchObject({
            text: 'Find where greet() is defined, then change it.',
        });
        expect(live.plan).toEqual([
            { step: 'Find greet()', status: 'completed' },
            { step: 'Add the name', status: 'inProgress' },
            { step: 'Run the tests', status: 'pending' },
        ]);
        expect(live.command).toMatchObject({
            command: 'rg -n greet src',
            status: 'completed',
            output: 'src/greeting.ts:2:export function greet() {',
            exitCode: 0,
            durationMs: expect.any(Number) as number,
        });
        // The patch has the file's own line numbers and three lines of context, as Claude Code reports it.
        expect(live.edit).toMatchObject({
            status: 'completed',
            changes: [
                {
                    path: join(terminal.cwd, 'src', 'greeting.ts'),
                    kind: 'update',
                    diff: [
                        '@@ -1,6 +1,6 @@',
                        ' // Greeting helpers',
                        '-export function greet() {',
                        '-    return "hi";',
                        '+export function greet(name: string) {',
                        '+    return `hi ${name}`;',
                        ' }',
                        ' ',
                        ' export function farewell() {',
                    ].join('\n'),
                },
            ],
        });
        expect(live.reply).toBe('greet() takes a **name** now.');
        // The context meter follows the scripted usage: a base context plus what the turn added, not the fixed total.
        expect(done.usage?.totalTokens).toBeGreaterThan(24_000);
        expect(done.usage?.breakdown?.reduce((sum, row) => sum + row.tokens, 0)).toBe(
            done.usage?.totalTokens,
        );

        await service.restart(terminal.id);
        const resumed = service.read(terminal.id);
        const { command, edit, ...kept } = shown(resumed);
        expect(kept).toEqual({
            types: live.types,
            plan: live.plan,
            reply: live.reply,
        });
        expect(command).toMatchObject({ output: live.command?.output, exitCode: 0 });
        expect(edit?.changes).toEqual(live.edit?.changes);
        expect(resumed.models?.[0]).toMatchObject({ id: 'claude-opus-4-7' });
    });

    it('keeps the keyword replies for a message that is no turn prompt', async () => {
        const { service, terminal, until } = await startClaude();
        await service.send(terminal.id, { text: 'hello there' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({
            text: 'Hello from fake Claude. You said: hello there',
        });
        expect(done.model).toBe('claude-opus-4-7');
    });

    it('waits on an approval step and carries on once it is accepted', async () => {
        const { service, terminal, until } = await startClaude();
        await service.send(terminal.id, { text: 'Run the tests' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({
            kind: 'command',
            command: 'bun run test',
            decisions: ['accept', 'acceptForSession', 'decline'],
            // The card reads the command's own description, not the keyword scenarios' "Fake Bash approval" reason.
            reason: 'Run the tests',
        });
        expect(pending.activeTurnId).toBeDefined();
        expect(pending.items.some((item) => item.type === 'agentMessage')).toBe(false);

        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.type === 'command')).toMatchObject({
            id: request.id,
            status: 'completed',
            output: '12 passed',
        });
        expect(done.items.at(-1)).toMatchObject({ text: 'All 12 tests pass.' });
    });

    it('ends the turn instead of playing on when an approval step is declined', async () => {
        const { service, terminal, until } = await startClaude();
        await service.send(terminal.id, { text: 'Run the tests' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, pending.requests[0].id, {
            kind: 'decision',
            decision: 'decline',
        });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.type === 'command')).toMatchObject({
            status: 'declined',
        });
        expect(done.items.at(-1)).toMatchObject({ text: 'Understood, I skipped that step.' });
        expect(JSON.stringify(done.items)).not.toContain('All 12 tests pass.');
    });

    it('holds a turn while its control file exists, then carries on', async () => {
        const { claudeConfigDirectory, service, terminal, until } = await startClaude();
        await mkdir(claudeConfigDirectory, { recursive: true });
        await writeFile(join(claudeConfigDirectory, 'gate'), '');
        await service.send(terminal.id, { text: 'Wait for the gate' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(service.read(terminal.id).items.some((item) => item.type === 'agentMessage')).toBe(
            false,
        );
        expect(service.read(terminal.id).activeTurnId).toBeDefined();

        await rm(join(claudeConfigDirectory, 'gate'));
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({ text: 'The gate opened.' });
    });

    it("fails the turn with the fail step's own error", async () => {
        const { service, terminal, until } = await startClaude();
        await service.send(terminal.id, { text: 'Break the build' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'failed');
        expect(done.items.map((item) => item.type)).toEqual([
            'userMessage',
            'agentMessage',
            'notice',
        ]);
        expect(done.items.at(-1)).toMatchObject({
            kind: 'error',
            message: 'The fake model is overloaded.',
        });
    });
});

describe('a fake Claude started with a malformed script', () => {
    /**
     * Starts the fake the way the Server does (a stream-json session), without the Server, and returns how it ended.
     */
    async function startFake(executable: string, directory: string, scriptPath?: string) {
        try {
            await runFile(executable, ['--session-id', crypto.randomUUID()], {
                cwd: directory,
                env: {
                    ...process.env,
                    CLAUDE_CONFIG_DIR: join(directory, 'claude'),
                    ...(scriptPath && { FAKE_CLAUDE_SCRIPT: scriptPath }),
                },
                timeout: 10_000,
            });
            return { code: 0, stderr: '' };
        } catch (error) {
            const { code, stderr } = error as { code?: number; stderr?: string };
            return { code, stderr: stderr ?? '' };
        }
    }

    async function writeExecutable(directory: string, scriptPath?: string) {
        const executable = join(directory, 'claude');
        await writeFile(executable, fakeClaudeChatExecutableSource({ scriptPath }));
        await chmod(executable, 0o755);
        return executable;
    }

    it('exits at startup naming the problem instead of falling back to canned replies', async () => {
        const { directory, file } = await writeScript(
            JSON.stringify({ turns: [{ prompt: 'Go', steps: [{ kind: 'speak', text: 'hi' }] }] }),
        );
        const outcome = await startFake(await writeExecutable(directory), directory, file);
        expect(outcome.code).toBe(1);
        expect(outcome.stderr).toContain(`invalid FAKE_CLAUDE_SCRIPT ${file}`);
        expect(outcome.stderr).toContain('turns[0].steps[0].kind');
    });

    it('wires the script path through the generated executable', async () => {
        const { directory, file } = await writeScript('{ not json');
        // No environment variable here: only the executable source can have told the fake which script to read.
        vi.unstubAllEnvs();
        const outcome = await startFake(await writeExecutable(directory, file), directory);
        expect(outcome.code).toBe(1);
        expect(outcome.stderr).toContain(`invalid FAKE_CLAUDE_SCRIPT ${file}`);
    });

    it('exits at startup when the script file is missing', async () => {
        const { directory } = await writeScript('{}');
        const missing = join(directory, 'missing.json');
        const outcome = await startFake(await writeExecutable(directory), directory, missing);
        expect(outcome.code).toBe(1);
        expect(outcome.stderr).toContain('ENOENT');
    });
});
