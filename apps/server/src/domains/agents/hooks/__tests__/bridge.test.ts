import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { stageAgentHookBridge } from '../bridge';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

async function sharedDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-bridge-'));
    temporaryDirectories.push(directory);
    return directory;
}

describe('stageAgentHookBridge', () => {
    it.each(
        [
            { size: 16, enabled: false, event: 'Stop' },
            { size: 90_000, enabled: false, event: 'Stop' },
            { size: 16, enabled: true, event: 'Stop' },
            { size: 90_000, enabled: true, event: 'Stop' },
            { size: 1_100_000, enabled: true, event: 'Stop' },
            { size: 16, enabled: true, event: 'StopFailure' },
            { size: 16, enabled: true, event: 'UserPromptSubmit' },
            { size: 16, enabled: true, event: 'Stop', scoped: true },
            { size: 16, enabled: true, event: 'Stop', clipped: true },
            { size: 16, enabled: true, event: 'Stop', continued: true },
            { size: 16, enabled: true, event: 'Stop', missingAnswer: true },
        ].flatMap((entry) =>
            (entry.scoped || entry.clipped || entry.continued || entry.missingAnswer
                ? ['grok']
                : entry.event === 'StopFailure'
                  ? ['claude', 'grok']
                  : ['claude', 'codex', 'grok']
            ).map((provider) => ({
                ...entry,
                provider,
            })),
        ),
    )(
        'preserves provider identity and opt-in digests without content: %j',
        async ({ size, enabled, event, provider, scoped, clipped, continued, missingAnswer }) => {
            const answer =
                'synthetic'.repeat(Math.ceil(size / 9)) + (clipped ? '… [+42 chars]' : '');
            const sharedPath = await sharedDirectory();
            const bridgePath = await stageAgentHookBridge(sharedPath);
            const socketPath = join(sharedPath, 'prompt.sock');
            const packets: Array<Record<string, unknown>> = [];
            const server = createServer((socket) => {
                socket.setEncoding('utf8');
                let source = '';
                socket.on('data', (chunk: string) => {
                    source += chunk;
                });
                socket.on('end', () => {
                    packets.push(JSON.parse(source) as Record<string, unknown>);
                    socket.end('{"ok":true}\n');
                });
            });
            server.listen(socketPath);
            await once(server, 'listening');
            try {
                const invocation = execFileAsync(
                    bridgePath,
                    [
                        '--provider',
                        provider,
                        '--phase',
                        event === 'UserPromptSubmit'
                            ? 'turnStarted'
                            : event === 'StopFailure'
                              ? 'turnFailed'
                              : 'turnFinished',
                    ],
                    {
                        env: {
                            CAXRI_HOOK_LAUNCH_ID: 'fixture-launch',
                            CAXRI_HOOK_RUNTIME: process.execPath,
                            CAXRI_HOOK_SOCKET: socketPath,
                            CAXRI_HOOK_TERMINAL_ID: 'fixture-terminal',
                            CAXRI_HOOK_TOKEN: 'fixture-token',
                            CAXRI_HOOK_DIGEST: enabled ? '1' : undefined,
                            PATH: process.env.PATH,
                        },
                    },
                );
                /**
                 * The bridge stops reading as soon as the payload passes its limit (`bridge.ts` truncates and finishes,
                 * then pauses stdin), so an oversized payload leaves this write unfinished when the child exits. The
                 * resulting `EPIPE` is the expected shape of overflow rather than a failure, but Node surfaces an
                 * unhandled stream error as an uncaught exception, which fails the whole run even though every
                 * assertion passed.
                 */
                invocation.child.stdin?.on('error', (cause: NodeJS.ErrnoException) => {
                    if (cause.code !== 'EPIPE') throw cause;
                });
                invocation.child.stdin?.end(
                    JSON.stringify({
                        session_id: 'fixture-session',
                        sessionId: 'fixture-session',
                        prompt_id: 'fixture-prompt',
                        turn_id: 'fixture-prompt',
                        promptId: 'fixture-prompt',
                        hook_event_name: event,
                        reason: 'end_turn',
                        ...(continued && { backgroundTasks: [{ status: 'running' }] }),
                        error: 'rate_limit',
                        last_assistant_message: answer,
                        ...(provider === 'grok' &&
                            !missingAnswer && { lastAssistantMessage: answer }),
                        prompt: answer,
                        ...(scoped && { subagentType: 'explorer' }),
                    }),
                );
                if (provider === 'grok' && (size > 1_048_576 || (!enabled && size > 65_536))) {
                    expect((await invocation).stderr).toContain('payload_scope_unavailable');
                    expect(packets).toHaveLength(0);
                    return;
                }
                await invocation;
                if (scoped) {
                    expect(packets).toHaveLength(0);
                    return;
                }
                expect(packets).toHaveLength(1);
                expect(packets[0]).toMatchObject({
                    agentSessionId: 'fixture-session',
                    agentTurnId: 'fixture-prompt',
                });
                expect(packets[0]).not.toHaveProperty('last_assistant_message');
                expect(JSON.stringify(packets)).not.toContain('synthetic');
                if (provider === 'grok' && enabled && event === 'Stop') {
                    expect(packets[0]?.agentResponseStop).toBe(true);
                    expect(packets[0]?.agentResponseByteLength).toBe(
                        missingAnswer ? undefined : Buffer.byteLength(answer),
                    );
                } else expect(packets[0]).not.toHaveProperty('agentResponseStop');
                if (clipped) expect(packets[0]?.agentContentOverflow).toBe(true);
                if (continued) expect(packets[0]?.agentTurnContinues).toBe(true);
                if (!missingAnswer && enabled && event === 'Stop' && size < 1_048_576)
                    expect(packets[0]?.agentResponseDigest).toBe(
                        createHash('sha256').update(answer).digest('hex'),
                    );
                else expect(packets[0]).not.toHaveProperty('agentResponseDigest');
                if (event === 'UserPromptSubmit')
                    expect(packets[0]?.agentPromptDigest).toBe(
                        createHash('sha256').update(answer).digest('hex'),
                    );
                if (enabled && event === 'StopFailure')
                    expect(packets[0]?.agentFailure).toBe('rate_limit');
                if (enabled && size > 1_048_576)
                    expect(packets[0]?.agentContentOverflow).toBe(true);
            } finally {
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        },
    );

    it('stages an executable bridge wrapper, its script, and a manifest on first run', async () => {
        const sharedPath = await sharedDirectory();

        const bridgePath = await stageAgentHookBridge(sharedPath);

        expect(bridgePath).toBe(join(sharedPath, 'bin', 'caxri-agent-hook-bridge'));
        const [wrapperSource, bridgeScript, manifestSource, wrapperStats] = await Promise.all([
            readFile(bridgePath, 'utf8'),
            readFile(join(sharedPath, 'bin', 'bridge.cjs'), 'utf8'),
            readFile(join(sharedPath, 'bin', 'manifest.json'), 'utf8'),
            stat(bridgePath),
        ]);
        expect(wrapperSource).toContain('#!/bin/sh');
        expect(bridgeScript).toContain("require('node:net')");
        expect(JSON.parse(manifestSource)).toEqual({ bridgeVersion: 27 });
        expect(wrapperStats.mode & 0o777).toBe(0o700);
    });

    it('is idempotent when re-staged with the same version', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const bridgeScriptPath = join(sharedPath, 'bin', 'bridge.cjs');
        const manifestPath = join(sharedPath, 'bin', 'manifest.json');
        const [wrapperBefore, scriptBefore, manifestBefore] = await Promise.all([
            stat(bridgePath),
            stat(bridgeScriptPath),
            stat(manifestPath),
        ]);

        const restagedPath = await stageAgentHookBridge(sharedPath);

        expect(restagedPath).toBe(bridgePath);
        const [wrapperAfter, scriptAfter, manifestAfter] = await Promise.all([
            stat(bridgePath),
            stat(bridgeScriptPath),
            stat(manifestPath),
        ]);
        // An unchanged staged bridge is never rewritten, so the inode identity of every file survives.
        expect(wrapperAfter.ino).toBe(wrapperBefore.ino);
        expect(scriptAfter.ino).toBe(scriptBefore.ino);
        expect(manifestAfter.ino).toBe(manifestBefore.ino);
    });

    it('never downgrades a bridge already staged by a newer Caxri build', async () => {
        const sharedPath = await sharedDirectory();
        const binDirectory = join(sharedPath, 'bin');
        await mkdir(binDirectory, { recursive: true });
        const bridgePath = join(binDirectory, 'caxri-agent-hook-bridge');
        const futureWrapper = '#!/bin/sh\necho "from-the-future"\n';
        const futureScript = "'use strict';\nconsole.log('from-the-future');\n";
        await Promise.all([
            writeFile(bridgePath, futureWrapper, { mode: 0o700 }),
            writeFile(join(binDirectory, 'bridge.cjs'), futureScript, { mode: 0o600 }),
            writeFile(
                join(binDirectory, 'manifest.json'),
                `${JSON.stringify({ bridgeVersion: 999 }, null, 2)}\n`,
                'utf8',
            ),
        ]);

        const returnedPath = await stageAgentHookBridge(sharedPath);

        expect(returnedPath).toBe(bridgePath);
        const [wrapperSource, scriptSource, manifestSource] = await Promise.all([
            readFile(bridgePath, 'utf8'),
            readFile(join(binDirectory, 'bridge.cjs'), 'utf8'),
            readFile(join(binDirectory, 'manifest.json'), 'utf8'),
        ]);
        expect(wrapperSource).toBe(futureWrapper);
        expect(scriptSource).toBe(futureScript);
        expect(JSON.parse(manifestSource)).toEqual({ bridgeVersion: 999 });
    });

    it('repairs staging when the manifest is corrupt or unparsable', async () => {
        const sharedPath = await sharedDirectory();
        const binDirectory = join(sharedPath, 'bin');
        await mkdir(binDirectory, { recursive: true });
        await writeFile(join(binDirectory, 'manifest.json'), '{ not valid json', 'utf8');

        const bridgePath = await stageAgentHookBridge(sharedPath);

        const [manifestSource, wrapperSource, scriptSource] = await Promise.all([
            readFile(join(binDirectory, 'manifest.json'), 'utf8'),
            readFile(bridgePath, 'utf8'),
            readFile(join(binDirectory, 'bridge.cjs'), 'utf8'),
        ]);
        expect(JSON.parse(manifestSource)).toEqual({ bridgeVersion: 27 });
        expect(wrapperSource).toContain('#!/bin/sh');
        expect(scriptSource).toContain("require('node:net')");
    });

    it('stays silent outside a Caxri-launched Terminal', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);

        const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
            env: { PATH: process.env.PATH },
        });

        expect(result.stderr).toBe('');
    });

    it('stays silent when inherited Caxri context no longer has a launch runtime', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);

        const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
            env: { CAXRI_HOOK_TOKEN: 'launch-context', PATH: process.env.PATH },
        });

        expect(result.stderr).toBe('');
    });

    it('stays silent when inherited Caxri context points to a retired socket', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);

        const result = await execFileAsync(
            bridgePath,
            ['--provider', 'codex', '--phase', 'sessionIdentified'],
            {
                env: {
                    CAXRI_HOOK_LAUNCH_ID: 'retired-launch',
                    CAXRI_HOOK_RUNTIME: process.execPath,
                    CAXRI_HOOK_SOCKET: join(sharedPath, 'retired.sock'),
                    CAXRI_HOOK_TERMINAL_ID: 'retired-terminal',
                    CAXRI_HOOK_TOKEN: 'retired-token',
                    PATH: process.env.PATH,
                },
            },
        );

        expect(result.stderr).toBe('');
    });

    it('stays silent when partial inherited context has no live Caxri socket', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);

        const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
            env: { CAXRI_HOOK_RUNTIME: process.execPath, PATH: process.env.PATH },
        });

        expect(result.stderr).toBe('');
    });

    it('reports incomplete launch context when a live Caxri socket exists', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'live.sock');
        const server = createServer();
        server.listen(socketPath);
        await once(server, 'listening');

        try {
            const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
                env: {
                    CAXRI_HOOK_LAUNCH_ID: 'launch-without-token',
                    CAXRI_HOOK_RUNTIME: process.execPath,
                    CAXRI_HOOK_SOCKET: socketPath,
                    CAXRI_HOOK_TERMINAL_ID: 'terminal-1',
                    PATH: process.env.PATH,
                },
            });

            expect(result.stderr).toBe('caxri-hook: launch_context_unavailable\n');
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('does not send a bridge receipt to an older launch context that did not opt in', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'compatible.sock');
        const packets: Array<Record<string, unknown>> = [];
        const server = createServer((socket) => {
            socket.setEncoding('utf8');
            let source = '';
            socket.on('data', (chunk: string) => {
                source += chunk;
            });
            socket.on('end', () => {
                packets.push(JSON.parse(source) as Record<string, unknown>);
                socket.end('{"ok":true}\n');
            });
        });
        server.listen(socketPath);
        await once(server, 'listening');

        try {
            const invocation = execFileAsync(
                bridgePath,
                ['--provider', 'codex', '--phase', 'sessionIdentified'],
                {
                    env: {
                        CAXRI_HOOK_LAUNCH_ID: 'older-launch',
                        CAXRI_HOOK_RUNTIME: process.execPath,
                        CAXRI_HOOK_SOCKET: socketPath,
                        CAXRI_HOOK_TERMINAL_ID: 'older-terminal',
                        CAXRI_HOOK_TOKEN: 'older-token',
                        PATH: process.env.PATH,
                    },
                },
            );
            invocation.child.stdin?.end(
                JSON.stringify({
                    agent_id: 'agent-opaque',
                    session_id: 'opaque-session',
                }),
            );
            await invocation;

            expect(packets).toHaveLength(1);
            expect(packets[0]).not.toHaveProperty('kind');
            expect(packets[0]).toMatchObject({
                agentId: 'agent-opaque',
                agentSessionId: 'opaque-session',
            });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('takes the schema version from the launch environment of the invoked provider', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'schema.sock');
        const packets: Array<Record<string, unknown>> = [];
        const server = createServer((socket) => {
            socket.setEncoding('utf8');
            let source = '';
            socket.on('data', (chunk: string) => {
                source += chunk;
            });
            socket.on('end', () => {
                packets.push(JSON.parse(source) as Record<string, unknown>);
                socket.end('{"ok":true}\n');
            });
        });
        server.listen(socketPath);
        await once(server, 'listening');
        const launch = {
            CAXRI_HOOK_LAUNCH_ID: 'schema-launch',
            CAXRI_HOOK_RUNTIME: process.execPath,
            CAXRI_HOOK_SCHEMA_CLAUDE: '4',
            CAXRI_HOOK_SCHEMA_CODEX: '9',
            CAXRI_HOOK_SOCKET: socketPath,
            CAXRI_HOOK_TERMINAL_ID: 'schema-terminal',
            CAXRI_HOOK_TOKEN: 'schema-token',
            PATH: process.env.PATH,
        };

        try {
            const codex = execFileAsync(
                bridgePath,
                ['--provider', 'codex', '--phase', 'turnFinished'],
                {
                    env: launch,
                },
            );
            codex.child.stdin?.end('{}');
            await codex;
            const claude = execFileAsync(
                bridgePath,
                ['--provider', 'claude', '--phase', 'turnFinished'],
                {
                    env: launch,
                },
            );
            claude.child.stdin?.end('{}');
            await claude;
            const bare = execFileAsync(
                bridgePath,
                ['--provider', 'codex', '--phase', 'turnFinished'],
                {
                    env: { ...launch, CAXRI_HOOK_SCHEMA_CODEX: undefined },
                },
            );
            bare.child.stdin?.end('{}');
            await bare;

            expect(packets.map((packet) => packet.schemaVersion)).toEqual([9, 4, 0]);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('delivers a tool-batch phase even when provider results exceed the payload read bound', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'large-batch.sock');
        const packets: Array<Record<string, unknown>> = [];
        const server = createServer((socket) => {
            socket.setEncoding('utf8');
            let source = '';
            socket.on('data', (chunk: string) => {
                source += chunk;
            });
            socket.on('end', () => {
                packets.push(JSON.parse(source) as Record<string, unknown>);
                socket.end('{"ok":true}\n');
            });
        });
        server.listen(socketPath);
        await once(server, 'listening');

        try {
            const invocation = execFileAsync(
                bridgePath,
                ['--provider', 'claude', '--phase', 'toolBatchFinished'],
                {
                    env: {
                        CAXRI_HOOK_LAUNCH_ID: 'large-batch-launch',
                        CAXRI_HOOK_RUNTIME: process.execPath,
                        CAXRI_HOOK_SOCKET: socketPath,
                        CAXRI_HOOK_TERMINAL_ID: 'large-batch-terminal',
                        CAXRI_HOOK_TOKEN: 'large-batch-token',
                        PATH: process.env.PATH,
                    },
                },
            );
            invocation.child.stdin?.end(
                JSON.stringify(
                    {
                        agent_id: 'must-not-leak-after-bound',
                        tool_calls: [{ tool_response: 'private-result'.repeat(8_000) }],
                    },
                    null,
                    2,
                ),
            );
            await invocation;

            const mainInvocation = execFileAsync(
                bridgePath,
                ['--provider', 'claude', '--phase', 'toolBatchFinished'],
                {
                    env: {
                        CAXRI_HOOK_LAUNCH_ID: 'large-main-batch-launch',
                        CAXRI_HOOK_RUNTIME: process.execPath,
                        CAXRI_HOOK_SOCKET: socketPath,
                        CAXRI_HOOK_TERMINAL_ID: 'large-main-batch-terminal',
                        CAXRI_HOOK_TOKEN: 'large-main-batch-token',
                        PATH: process.env.PATH,
                    },
                },
            );
            mainInvocation.child.stdin?.end(
                JSON.stringify({
                    tool_calls: [
                        {
                            agent_id: 'nested-content-must-not-become-scope',
                            tool_response: 'private-result'.repeat(8_000),
                        },
                    ],
                }),
            );
            await mainInvocation;

            expect(packets).toHaveLength(2);
            expect(packets[0]).toMatchObject({ phase: 'toolBatchFinished' });
            expect(packets[0]).toMatchObject({ agentId: 'must-not-leak-after-bound' });
            expect(JSON.stringify(packets[0])).not.toContain('private-result');
            expect(packets[1]).toMatchObject({ phase: 'toolBatchFinished' });
            expect(packets[1]).not.toHaveProperty('agentId');
            expect(JSON.stringify(packets[1])).not.toContain('nested-content');
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('classifies a Bash worktree creation before execution without forwarding command or tool output', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'worktree.sock');
        const packets: Array<Record<string, unknown>> = [];
        const server = createServer((socket) => {
            socket.setEncoding('utf8');
            let source = '';
            socket.on('data', (chunk: string) => {
                source += chunk;
            });
            socket.on('end', () => {
                packets.push(JSON.parse(source) as Record<string, unknown>);
                socket.end('{"ok":true}\n');
            });
        });
        server.listen(socketPath);
        await once(server, 'listening');

        try {
            const invocation = execFileAsync(
                bridgePath,
                ['--provider', 'codex', '--phase', 'shellToolStarted'],
                {
                    env: {
                        CAXRI_HOOK_LAUNCH_ID: 'worktree-launch',
                        CAXRI_HOOK_RUNTIME: process.execPath,
                        CAXRI_HOOK_SOCKET: socketPath,
                        CAXRI_HOOK_TERMINAL_ID: 'worktree-terminal',
                        CAXRI_HOOK_TOKEN: 'worktree-token',
                        PATH: process.env.PATH,
                    },
                },
            );
            invocation.child.stdin?.end(
                JSON.stringify({
                    session_id: 'opaque-session',
                    tool_input: {
                        command: 'git -C /repo worktree add /repo-feature feature/test',
                    },
                    tool_response: 'private terminal output',
                    tool_use_id: 'tool-call-1',
                }),
            );
            await invocation;

            expect(packets).toHaveLength(1);
            expect(packets[0]).toMatchObject({
                agentSessionId: 'opaque-session',
                agentToolUseId: 'tool-call-1',
                worktreeCreateIntent: true,
            });
            expect(packets[0]).not.toHaveProperty('tool_input');
            expect(packets[0]).not.toHaveProperty('tool_response');
            expect(JSON.stringify(packets[0])).not.toContain('/repo');
            expect(JSON.stringify(packets[0])).not.toContain('private terminal output');
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it.each([
        {
            shape: 'an absolute path',
            cwd: '/repo-worktrees/feature',
            expected: '/repo-worktrees/feature',
        },
        { shape: 'a relative path', cwd: 'repo-worktrees/feature', expected: undefined },
        { shape: 'an empty string', cwd: '', expected: undefined },
        { shape: 'a path containing NUL', cwd: '/repo\u{0}/etc', expected: undefined },
        { shape: 'an overlong path', cwd: `/${'x'.repeat(1_024)}`, expected: undefined },
        { shape: 'a non-string value', cwd: 42, expected: undefined },
    ])('forwards the event working directory only when it is $shape', async ({ cwd, expected }) => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'cwd.sock');
        const packets: Array<Record<string, unknown>> = [];
        const server = createServer((socket) => {
            socket.setEncoding('utf8');
            let source = '';
            socket.on('data', (chunk: string) => {
                source += chunk;
            });
            socket.on('end', () => {
                packets.push(JSON.parse(source) as Record<string, unknown>);
                socket.end('{"ok":true}\n');
            });
        });
        server.listen(socketPath);
        await once(server, 'listening');

        try {
            const invocation = execFileAsync(
                bridgePath,
                ['--provider', 'claude', '--phase', 'turnStarted'],
                {
                    env: {
                        CAXRI_HOOK_LAUNCH_ID: 'cwd-launch',
                        CAXRI_HOOK_RUNTIME: process.execPath,
                        CAXRI_HOOK_SOCKET: socketPath,
                        CAXRI_HOOK_TERMINAL_ID: 'cwd-terminal',
                        CAXRI_HOOK_TOKEN: 'cwd-token',
                        PATH: process.env.PATH,
                    },
                },
            );
            invocation.child.stdin?.end(
                JSON.stringify({ cwd, prompt: 'private prompt text', session_id: 'opaque' }),
            );
            await invocation;

            expect(packets).toHaveLength(1);
            expect(packets[0].agentCwd).toBe(expected);
            expect(packets[0]).not.toHaveProperty('prompt');
            expect(JSON.stringify(packets[0])).not.toContain('private prompt text');
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it.each([
        ['git worktree add ../feature feature/test', true],
        ['git -C "/repo with spaces" worktree add ../feature feature/test', true],
        ['cd /repo && rtk git worktree add ../feature feature/test', true],
        ['env GIT_CONFIG_NOSYSTEM=1 /usr/bin/git --no-pager worktree add ../feature', true],
        ['echo "git worktree add /private/path"', false],
        ["printf 'git worktree add /private/path'", false],
        ['git worktree remove /private/path', false],
        ['git status && echo git worktree add /private/path', false],
    ])('classifies only an executed git worktree add command: %s', async (command, expected) => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'classification.sock');
        const packets: Array<Record<string, unknown>> = [];
        const server = createServer((socket) => {
            socket.setEncoding('utf8');
            let source = '';
            socket.on('data', (chunk: string) => {
                source += chunk;
            });
            socket.on('end', () => {
                packets.push(JSON.parse(source) as Record<string, unknown>);
                socket.end('{"ok":true}\n');
            });
        });
        server.listen(socketPath);
        await once(server, 'listening');

        try {
            const invocation = execFileAsync(
                bridgePath,
                ['--provider', 'codex', '--phase', 'shellToolFinished'],
                {
                    env: {
                        CAXRI_HOOK_LAUNCH_ID: 'classification-launch',
                        CAXRI_HOOK_RUNTIME: process.execPath,
                        CAXRI_HOOK_SOCKET: socketPath,
                        CAXRI_HOOK_TERMINAL_ID: 'classification-terminal',
                        CAXRI_HOOK_TOKEN: 'classification-token',
                        PATH: process.env.PATH,
                    },
                },
            );
            invocation.child.stdin?.end(
                JSON.stringify({ tool_input: { command }, tool_use_id: 'classified-tool-use' }),
            );
            await invocation;

            expect(packets).toHaveLength(1);
            expect(packets[0]?.worktreeCreateIntent === true).toBe(expected);
            expect(packets[0]?.agentToolUseId).toBe(expected ? 'classified-tool-use' : undefined);
            expect(JSON.stringify(packets[0])).not.toContain(command);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('scrubs arbitrary runtime stderr behind a fixed bridge failure diagnostic', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const failingRuntime = join(sharedPath, 'failing-runtime');
        await writeFile(
            failingRuntime,
            "#!/bin/sh\nprintf 'private stdout detail'\nprintf 'private runtime detail' >&2\nexit 99\n",
            { mode: 0o700 },
        );

        const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
            env: { CAXRI_HOOK_RUNTIME: failingRuntime, PATH: process.env.PATH },
        });

        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('caxri-hook: bridge_runtime_failed\n');
        expect(result.stderr).not.toContain('private runtime detail');
    });
});
