import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { unwrapShellCommand } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { fixture } from './chat-service-fixture';
import { fakeCodexChatExecutableSource } from './fixtures/fake-chat-executables';
import type { FakeCodexScript } from './fixtures/fake-codex-script';
import { parseFakeCodexScript } from './fixtures/fake-codex-script';

const runFile = promisify(execFile);

/**
 * Writes `script` (or raw text) to a temporary file and points the fake Codex at it for this test. The fixture's
 * provider environment inherits `process.env`, so the variables must be set before the Chat's first read starts it.
 */
async function useScript(
    script: FakeCodexScript | string,
    options: { hasControlDirectory?: boolean } = {},
) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-script-'));
    onTestFinished(async () => {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
    });
    const file = join(directory, 'script.json');
    await writeFile(file, typeof script === 'string' ? script : JSON.stringify(script));
    vi.stubEnv('FAKE_CODEX_SCRIPT', file);
    const control = join(directory, 'control');
    await mkdir(control);
    if (options.hasControlDirectory) vi.stubEnv('FAKE_CODEX_CONTROL_DIR', control);
    return { control, directory, file };
}

const PRODUCT_SCRIPT: FakeCodexScript = {
    model: { id: 'gpt-5.5', displayName: 'GPT-5.5' },
    turns: [
        {
            prompt: '  Greet people by name.  ',
            durationMs: 95_000,
            steps: [
                {
                    kind: 'reasoning',
                    summary: [
                        '**Reading the greeting**\n\nCheck where it is built.',
                        'Plan the edit.',
                    ],
                },
                {
                    kind: 'plan',
                    plan: [
                        { step: 'Read {{cwd}}/src', status: 'completed' },
                        { step: 'Edit the greeting', status: 'inProgress' },
                        { step: 'Run the tests', status: 'pending' },
                    ],
                },
                {
                    kind: 'command',
                    command: 'rg -n "greet" src',
                    output: 'src/greeting.ts:1:export function greet\n',
                    durationMs: 340,
                },
                {
                    kind: 'fileChange',
                    changes: [
                        {
                            path: '{{cwd}}/src/greeting.ts',
                            kind: 'update',
                            diff: '@@ -1,2 +1,2 @@\n-export const greet = () => "hi";\n+export const greet = (name: string) => `hi ${name}`;\n',
                        },
                        { path: 'docs/greeting.md', kind: 'add', diff: '# Greeting\n' },
                    ],
                },
                { kind: 'command', command: 'npm test', output: '1 failing\n', exitCode: 1 },
                { kind: 'message', text: 'Greetings now take a **name**; one test still fails.' },
            ],
        },
    ],
};

describe('Codex Chat with scripted fake turns', () => {
    it('plays a scripted turn as the Chat shows a real one, under the renamed model, and keeps it after a restart', async () => {
        await useScript(PRODUCT_SCRIPT);
        const { service, terminal, until } = await fixture();
        const ready = await until((snapshot) => snapshot.models !== undefined);
        expect(ready.model).toBe('gpt-5.5');
        expect(ready.models?.[0]).toMatchObject({ id: 'gpt-5.5', displayName: 'GPT-5.5' });

        await service.send(terminal.id, { text: 'Greet people by name.' });
        const done = await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
        );
        expect(done.items.map((item) => item.type)).toEqual([
            'userMessage',
            'reasoning',
            'command',
            'fileChange',
            'command',
            'agentMessage',
        ]);
        expect(done.items[1]).toMatchObject({
            text: '**Reading the greeting**\n\nCheck where it is built.\n\nPlan the edit.',
        });
        expect(done.plan?.steps).toEqual([
            { step: `Read ${terminal.cwd}/src`, status: 'completed' },
            { step: 'Edit the greeting', status: 'inProgress' },
            { step: 'Run the tests', status: 'pending' },
        ]);
        const [search, tests] = done.items.filter((item) => item.type === 'command');
        expect(search).toMatchObject({
            status: 'completed',
            output: 'src/greeting.ts:1:export function greet\n',
            exitCode: 0,
            durationMs: 340,
        });
        // Codex words a command as the login-shell invocation, which the Chat unwraps for its row.
        expect(unwrapShellCommand(search.command)).toBe('rg -n "greet" src');
        expect(tests).toMatchObject({ status: 'failed', output: '1 failing\n', exitCode: 1 });
        expect(done.items[3]).toMatchObject({
            type: 'fileChange',
            status: 'completed',
            changes: [
                { path: join(terminal.cwd, 'src', 'greeting.ts'), kind: 'update' },
                {
                    path: join(terminal.cwd, 'docs', 'greeting.md'),
                    kind: 'add',
                    diff: '# Greeting\n',
                },
            ],
        });
        expect(done.items.at(-1)).toMatchObject({
            text: 'Greetings now take a **name**; one test still fails.',
            streaming: false,
        });
        expect(done.turns.at(-1)?.durationMs).toBe(95_000);
        expect(done.usage?.contextWindow).toBe(272_000);
        expect(done.usage?.totalTokens).toBeGreaterThan(14_000);

        // The turn persists in the thread state like any other, so a resumed Chat reads the same history back.
        await service.restart(terminal.id);
        const resumed = await until(
            (snapshot) =>
                snapshot.status === 'ready' && snapshot.items.length === done.items.length,
        );
        expect(resumed.model).toBe('gpt-5.5');
        expect(resumed.items.map((item) => item.type)).toEqual(done.items.map((item) => item.type));
        expect(resumed.items.at(-1)).toMatchObject({
            text: 'Greetings now take a **name**; one test still fails.',
        });
        expect(resumed.turns.at(-1)?.durationMs).toBe(95_000);
    });

    it('keeps the canned reply for a message no turn scripts', async () => {
        await useScript(PRODUCT_SCRIPT);
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'something else' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({
            type: 'agentMessage',
            text: 'Hello from fake Codex. You said: something else',
        });
        expect(done.plan?.steps).toHaveLength(2);
        expect(done.model).toBe('gpt-5.5');
    });

    it('plays a scripted prompt that contains a keyword of the canned scenarios', async () => {
        await useScript({
            turns: [
                { prompt: 'Fix the lost install.', steps: [{ kind: 'message', text: 'Fixed.' }] },
            ],
        });
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'Fix the lost install.' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.at(-1)).toMatchObject({ type: 'agentMessage', text: 'Fixed.' });
    });

    it('waits for an approval, then runs the command and goes on, or stops when it is declined', async () => {
        await useScript({
            turns: [
                {
                    prompt: 'Install it.',
                    steps: [
                        { kind: 'reasoning', summary: ['Needs a package.'] },
                        {
                            kind: 'approval',
                            command: 'npm install left-pad',
                            output: 'added 1 package\n',
                        },
                        { kind: 'message', text: 'Installed.' },
                    ],
                },
            ],
        });
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'Install it.' });
        const pending = await until((snapshot) => snapshot.requests.length === 1);
        const request = pending.requests[0];
        expect(request).toMatchObject({ kind: 'command' });
        expect(request.kind === 'command' && unwrapShellCommand(request.command ?? '')).toBe(
            'npm install left-pad',
        );
        expect(pending.activeTurnId).toBeTruthy();
        expect(pending.items.map((item) => item.type)).toEqual([
            'userMessage',
            'reasoning',
            'command',
        ]);
        expect(pending.items[2]).toMatchObject({ status: 'running' });

        service.respond(terminal.id, request.id, { kind: 'decision', decision: 'accept' });
        const done = await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(done.items.find((item) => item.type === 'command')).toMatchObject({
            status: 'completed',
            output: 'added 1 package\n',
            exitCode: 0,
        });
        expect(done.items.at(-1)).toMatchObject({ text: 'Installed.' });

        await service.send(terminal.id, { text: 'Install it.' });
        const second = await until((snapshot) => snapshot.requests.length === 1);
        service.respond(terminal.id, second.requests[0].id, {
            kind: 'decision',
            decision: 'decline',
        });
        const declined = await until(
            (snapshot) =>
                snapshot.turns.at(-1)?.status === 'completed' && snapshot.turns.length === 2,
        );
        expect(declined.items.findLast((item) => item.type === 'command')).toMatchObject({
            status: 'declined',
        });
        // The Agent stops where the user said no, so the scripted message after the approval never plays.
        expect(declined.items.at(-1)).toMatchObject({ text: 'The command was declined.' });
    });

    it('holds a turn in progress while its control file exists and ends a failing turn with the provider error', async () => {
        const { control } = await useScript(
            {
                turns: [
                    {
                        prompt: 'Keep going.',
                        steps: [
                            { kind: 'reasoning', summary: ['Working.'] },
                            { kind: 'hold', file: 'release' },
                            { kind: 'fail', message: 'The model is overloaded.' },
                        ],
                    },
                ],
            },
            { hasControlDirectory: true },
        );
        await writeFile(join(control, 'release'), '');
        const { service, terminal, until } = await fixture();
        await service.send(terminal.id, { text: 'Keep going.' });
        await until((snapshot) => snapshot.items.some((item) => item.type === 'reasoning'));
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(service.read(terminal.id).activeTurnId).toBeTruthy();

        await rm(join(control, 'release'));
        const failed = await until((snapshot) => snapshot.turns.at(-1)?.status === 'failed');
        expect(failed.items.at(-1)).toMatchObject({
            type: 'notice',
            kind: 'error',
            message: 'The model is overloaded.',
        });
    });
});

describe('Scripted fake Codex validation', () => {
    it('names the field of a malformed script', () => {
        const turn = (steps: unknown) => ({ turns: [{ prompt: 'p', steps }] });
        expect(() => parseFakeCodexScript({ turns: [] })).toThrow(
            /script\.turns: expected a non-empty array/u,
        );
        expect(() => parseFakeCodexScript(turn([{ kind: 'think' }]))).toThrow(
            /script\.turns\[0\]\.steps\[0\]\.kind: expected one of reasoning/u,
        );
        expect(() =>
            parseFakeCodexScript(
                turn([{ kind: 'command', command: 'ls', output: '', exitcode: 1 }]),
            ),
        ).toThrow(/steps\[0\]: unknown field "exitcode"/u);
        expect(() =>
            parseFakeCodexScript(turn([{ kind: 'plan', plan: [{ step: 's', status: 'done' }] }])),
        ).toThrow(/plan\[0\]\.status: expected one of pending, inProgress, completed/u);
        expect(() => parseFakeCodexScript(turn([{ kind: 'hold', file: '../x' }]), '/tmp')).toThrow(
            /plain file name/u,
        );
        expect(() => parseFakeCodexScript(turn([{ kind: 'hold', file: 'x' }]))).toThrow(
            /FAKE_CODEX_CONTROL_DIR/u,
        );
        expect(() =>
            parseFakeCodexScript(
                turn([
                    { kind: 'fail', message: 'down' },
                    { kind: 'message', text: 'after' },
                ]),
            ),
        ).toThrow(/steps\[0\]: a fail step must be the last step/u);
        expect(() =>
            parseFakeCodexScript({
                turns: [
                    { prompt: 'p', steps: [{ kind: 'message', text: 'a' }] },
                    { prompt: ' p ', steps: [{ kind: 'message', text: 'b' }] },
                ],
            }),
        ).toThrow(/turns\[1\]\.prompt: "p" repeats an earlier prompt/u);
        expect(parseFakeCodexScript(turn([{ kind: 'hold', file: 'x' }]), '/tmp')).toEqual(
            turn([{ kind: 'hold', file: 'x' }]),
        );
    });

    it.each([
        ['text that is not JSON', 'not json'],
        [
            'a step of an unknown kind',
            JSON.stringify({ turns: [{ prompt: 'p', steps: [{ kind: 'think' }] }] }),
        ],
        ['a missing file', undefined],
    ])('exits with 1 at startup for %s', async (_name, content) => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-script-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const file = join(directory, 'script.json');
        if (content !== undefined) await writeFile(file, content);
        // Runs the generated `codex` wrapper, as E2E and promo captures do, so its `scriptPath` wiring is covered too.
        const codex = join(directory, 'codex');
        await writeFile(
            codex,
            fakeCodexChatExecutableSource({ stateDirectory: directory, scriptPath: file }),
            { mode: 0o755 },
        );
        let failure: { code?: number; stderr?: string } | undefined;
        try {
            // A script the fake wrongly accepted would leave it waiting on stdin, so the run is bounded.
            await runFile(codex, ['app-server'], { timeout: 10_000 });
        } catch (error) {
            failure = error as { code?: number; stderr?: string };
        }
        expect(failure?.code).toBe(1);
        expect(failure?.stderr).toContain(`fake codex: invalid FAKE_CODEX_SCRIPT ${file}`);
    });
});
