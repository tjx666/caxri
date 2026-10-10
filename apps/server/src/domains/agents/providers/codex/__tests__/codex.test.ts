import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearExecutableCache } from '../../../discovery';
import { AgentService, createLocalAgentAdapters } from '../../../service';
import { codexProvider, codexSessionIdsFromOpenFiles } from '..';
import { findCodexStateDatabases, MAX_CODEX_STATE_DATABASES } from '../state-databases';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    clearExecutableCache();
    vi.unstubAllEnvs();
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Codex provider', () => {
    it('accepts writable rollouts below the canonical sessions root', () => {
        const sessionsRoot = '/Users/dev/.codex/sessions';
        const sessionId = '01931f2e-7b0a-7abc-8def-0123456789ab';
        const rollout = `rollout-2026-09-07T12-34-56-${sessionId}.jsonl`;
        const rolloutPath = join(sessionsRoot, '2026', '09', '07', rollout);

        expect(
            codexSessionIdsFromOpenFiles(
                [{ access: 'u', path: rolloutPath, pid: 42 }],
                sessionsRoot,
            ),
        ).toEqual([sessionId]);
        expect(
            codexSessionIdsFromOpenFiles(
                [{ access: 'r', path: rolloutPath, pid: 42 }],
                sessionsRoot,
            ),
        ).toEqual([]);
        expect(
            codexSessionIdsFromOpenFiles(
                [{ access: 'u', path: `/private/tmp/${rollout}`, pid: 42 }],
                sessionsRoot,
            ),
        ).toEqual([]);
    });

    /**
     * `/new` leaves the retired conversation open for minutes while Codex writes the replacement, so the two rollouts
     * overlap. The newer thread id has to win, or the Terminal keeps a conversation the user already left.
     */
    it('orders concurrently open rollouts by thread creation time, newest first', () => {
        const sessionsRoot = '/Users/dev/.codex/sessions';
        const retired = '01931f2e-7b0a-7abc-8def-0123456789ab';
        const current = '01931f30-0001-7abc-8def-0123456789aa';
        const openFile = (sessionId: string, stamp: string) => ({
            access: 'u',
            path: join(
                sessionsRoot,
                '2026',
                '09',
                '07',
                `rollout-2026-09-07T${stamp}-${sessionId}.jsonl`,
            ),
            pid: 42,
        });

        expect(
            codexSessionIdsFromOpenFiles(
                [openFile(retired, '12-34-56'), openFile(current, '12-40-01')],
                sessionsRoot,
            ),
        ).toEqual([current, retired]);
    });

    it.each([
        ['AGENTS.md', false],
        ['AGENTS.override.md', false],
        ['AGENTS.md', true],
        ['AGENTS.override.md', true],
    ] as const)(
        'uses the low-cost model and blocks %s (symlink: %s)',
        async (instructionName, isSymlink) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-low-cost-command-'));
            temporaryDirectories.push(directory);
            const executable = join(directory, 'codex.cjs');
            const argumentsPath = join(directory, 'arguments.json');
            const cwdPath = join(directory, 'cwd.txt');
            const exposurePath = join(directory, 'exposure.json');
            const inputPath = join(directory, 'input.txt');
            const projectDirectory = join(directory, 'project');
            const codexHome = join(directory, 'codex-home');
            const instructionPath = join(codexHome, instructionName);
            const instructionTarget = isSymlink
                ? join(directory, 'external-instructions.md')
                : instructionPath;
            const projectMarker = join(projectDirectory, 'private-source.txt');
            await Promise.all([mkdir(projectDirectory), mkdir(codexHome)]);
            await Promise.all([
                writeFile(projectMarker, 'PROJECT_SOURCE_MARKER'),
                writeFile(instructionTarget, 'GLOBAL_INSTRUCTION_MARKER'),
            ]);
            if (isSymlink) await symlink(instructionTarget, instructionPath);
            await writeFile(
                executable,
                String.raw`#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(cwdPath)}, process.cwd());
const readMarker = (path) => { try { return readFileSync(path, 'utf8'); } catch { return 'blocked'; } };
writeFileSync(${JSON.stringify(exposurePath)}, JSON.stringify({
    globalInstructions: readMarker(${JSON.stringify(instructionTarget)}),
    instructionEntry: readMarker(${JSON.stringify(instructionPath)}),
    projectSource: readMarker(${JSON.stringify(projectMarker)}),
}));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    writeFileSync(${JSON.stringify(inputPath)}, input);
    process.stdout.write(JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Compact session title' },
    }) + '\n');
});
`,
                'utf8',
            );
            await chmod(executable, 0o700);

            await expect(
                codexProvider.generateTitle?.({
                    cwd: projectDirectory,
                    environment: {
                        homeDirectory: directory,
                        variables: { CODEX_HOME: codexHome },
                    },
                    executable,
                    prompt: 'session title fixture',
                    version: 'codex-cli 0.122.0',
                }),
            ).resolves.toBe('Compact session title');
            const arguments_ = JSON.parse(await readFile(argumentsPath, 'utf8')) as string[];
            expect(arguments_).toEqual(
                expect.arrayContaining([
                    '-m',
                    'gpt-5.6-luna',
                    '--ephemeral',
                    '--ignore-user-config',
                ]),
            );
            expect(arguments_).toEqual(
                expect.arrayContaining([
                    '--disable',
                    'codex_hooks',
                    '--disable',
                    'shell_tool',
                    'project_doc_max_bytes=0',
                    'web_search="disabled"',
                ]),
            );
            expect(arguments_.join(' ')).not.toContain('session title fixture');
            const generatedInput = await readFile(inputPath, 'utf8');
            expect(generatedInput).toContain('session title fixture');
            expect(generatedInput).toContain(
                'Generate a concise coding-session title from the conversation below.',
            );
            expect(await readFile(cwdPath, 'utf8')).not.toBe(projectDirectory);
            const exposure = JSON.parse(await readFile(exposurePath, 'utf8')) as {
                globalInstructions: string;
                instructionEntry: string;
                projectSource: string;
            };
            expect(exposure.globalInstructions).toBe('blocked');
            expect(exposure.instructionEntry).toBe('blocked');
            expect(exposure.projectSource).toBe('blocked');
        },
    );

    it('rejects Codex versions before the required low-cost generation flags were introduced', async () => {
        await expect(
            codexProvider.generateTitle?.({
                cwd: '/project',
                environment: { homeDirectory: '/missing', variables: {} },
                executable: '/missing/codex',
                prompt: 'session title fixture',
                version: 'codex-cli 0.121.9',
            }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('bounds provider state database candidates before synchronous probing', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-state-budget-'));
        temporaryDirectories.push(directory);
        await Promise.all(
            Array.from({ length: MAX_CODEX_STATE_DATABASES + 12 }, (_, index) =>
                writeFile(join(directory, `state_${index}.sqlite`), ''),
            ),
        );

        const candidates = await findCodexStateDatabases([directory]);

        expect(candidates).toHaveLength(MAX_CODEX_STATE_DATABASES);
        expect(candidates[0]).toBe(
            join(directory, `state_${MAX_CODEX_STATE_DATABASES + 11}.sqlite`),
        );
    });

    it('preserves configured Codex state-root priority before database recency', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-state-priority-'));
        temporaryDirectories.push(directory);
        const configured = join(directory, 'configured');
        const fallback = join(directory, 'fallback');
        await Promise.all([mkdir(configured), mkdir(fallback)]);
        await Promise.all([
            writeFile(join(configured, 'state_1.sqlite'), ''),
            writeFile(join(fallback, 'state_999.sqlite'), ''),
        ]);

        const candidates = await findCodexStateDatabases([configured, fallback]);

        expect(candidates).toEqual([
            join(configured, 'state_1.sqlite'),
            join(fallback, 'state_999.sqlite'),
        ]);
    });

    it('declares current and compatibility skill roots with Codex invocation syntax', () => {
        const roots = codexProvider.actions?.roots(
            { projectRoot: '/repo', cwd: '/repo/packages/app' },
            { homeDirectory: '/Users/dev', variables: { CODEX_HOME: '/custom/codex' } },
        );

        expect(roots?.slice(0, 4)).toEqual([
            {
                directory: '/custom/codex/skills',
                kind: 'skills',
                scope: 'legacy',
            },
            {
                directory: '/Users/dev/.agents/skills',
                kind: 'skills',
                scope: 'global',
            },
            {
                boundaryDirectory: '/repo',
                directory: '/repo/.codex/skills',
                kind: 'skills',
                scope: 'legacy',
            },
            {
                boundaryDirectory: '/repo',
                directory: '/repo/.agents/skills',
                kind: 'skills',
                scope: 'project',
            },
        ]);
        expect(roots).toEqual(
            expect.arrayContaining([
                {
                    directory: '/Users/dev/.agents/skills',
                    kind: 'skills',
                    scope: 'global',
                },
                {
                    directory: '/custom/codex/skills',
                    kind: 'skills',
                    scope: 'legacy',
                },
                {
                    boundaryDirectory: '/repo',
                    directory: '/repo/.agents/skills',
                    kind: 'skills',
                    scope: 'project',
                },
                {
                    boundaryDirectory: '/repo',
                    directory: '/repo/packages/app/.codex/skills',
                    kind: 'skills',
                    scope: 'legacy',
                },
            ]),
        );
        expect(codexProvider.actions?.skillInvocation('commit')).toBe('$commit');
    });

    it('capability-detects the Codex thread index and exposes bounded metadata', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-codex-state-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const state = join(directory, 'codex-state');
        const bin = join(directory, 'bin');
        await Promise.all([mkdir(root), mkdir(state), mkdir(bin)]);
        const executable = join(bin, 'codex');
        await writeFile(executable, '#!/bin/sh\nprintf "codex 1.0\\n"\n', 'utf8');
        await chmod(executable, 0o700);
        const startedAt = Date.now();
        const database = new Database(join(state, 'state_9.sqlite'));
        database.exec(
            'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER)',
        );
        database.exec(
            'CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)',
        );
        database
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-older',
                root,
                '$debug https://github.com/example/project/issues/1',
                null,
                startedAt - 60_000,
                startedAt - 60_000,
                42,
                0,
            );
        database
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-legacy-history',
                root,
                'Legacy history prompt',
                null,
                startedAt - 30_000,
                startedAt - 30_000,
                0,
                0,
            );
        database
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-child',
                root,
                'Synthetic child prompt',
                null,
                startedAt - 15_000,
                startedAt - 15_000,
                0,
                0,
            );
        database
            .prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)')
            .run('codex-session-older', 'codex-session-child', 'active');
        database.close();
        const turnHistory = new Database(join(state, 'thread_history_1.sqlite'));
        turnHistory.exec(
            'CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, completed_at INTEGER)',
        );
        const insertTurn = turnHistory.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)');
        insertTurn.run('codex-session-older', 'turn-1', 1, 'completed', Date.now());
        insertTurn.run('codex-session-older', 'turn-running', 2, 'inProgress', null);
        insertTurn.run('codex-session-older', 'turn-interrupted', 3, 'interrupted', Date.now());
        insertTurn.run('codex-session-older', 'turn-failed', 4, 'failed', Date.now());
        insertTurn.run('codex-session-older', 'turn-resumed', 5, 'inProgress', null);
        turnHistory.close();
        const legacyTurnHistory = new Database(join(state, 'thread_history_2.sqlite'));
        legacyTurnHistory.exec(
            'CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, status TEXT, completed_at INTEGER)',
        );
        const insertLegacyTurn = legacyTurnHistory.prepare(
            'INSERT INTO thread_turns VALUES (?, ?, ?, ?)',
        );
        insertLegacyTurn.run(
            'codex-session-legacy-history',
            'legacy-completed',
            'completed',
            Date.now(),
        );
        insertLegacyTurn.run('codex-session-legacy-history', 'legacy-running', 'inProgress', null);
        legacyTurnHistory.close();
        vi.stubEnv('PATH', bin);
        vi.stubEnv('SHELL', '/usr/bin/false');
        const service = new AgentService(
            undefined,
            createLocalAgentAdapters({
                homeDirectory: directory,
                variables: {
                    CLAUDE_CONFIG_DIR: join(directory, 'missing'),
                    CODEX_HOME: join(directory, 'missing-codex-home'),
                    CODEX_SQLITE_HOME: state,
                },
            }),
        );

        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-older',
                rootPath: root,
                processState: 'running',
                startedAt,
            }),
        ).resolves.toMatchObject({
            activitySource: 'latestTurn',
            activityTurnId: 'turn-resumed',
            sessionId: 'codex-session-older',
            sessionIsSubagent: false,
            status: 'running',
            title: undefined,
        });
        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-child',
                rootPath: root,
                processState: 'running',
                startedAt,
            }),
        ).resolves.toMatchObject({
            sessionId: 'codex-session-child',
            sessionIsSubagent: true,
        });
        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-legacy-history',
                rootPath: root,
                processState: 'running',
                startedAt,
            }),
        ).resolves.toMatchObject({
            activitySource: 'latestTurn',
            activityTurnId: 'legacy-running',
            sessionId: 'codex-session-legacy-history',
            status: 'running',
        });

        await expect(
            service.snapshot('codex', { rootPath: root, processState: 'running', startedAt }),
        ).resolves.toMatchObject({
            available: true,
            status: 'unknown',
            sessionId: undefined,
            title: undefined,
        });

        const writableDatabase = new Database(join(state, 'state_9.sqlite'));
        writableDatabase
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-1',
                root,
                'Raw first prompt',
                'Finish Phase 1',
                startedAt + 1,
                startedAt + 1,
                12_345,
                0,
            );
        writableDatabase
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-2',
                root,
                'Second prompt',
                'Keep this Terminal',
                startedAt + 2,
                startedAt + 2,
                24,
                0,
            );
        const longPrompt =
            '\u{A0}Please\tinvestigate the Terminal restore behavior and fix ownership';
        writableDatabase
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-indistinguishable-name',
                root,
                '  Fix\tlogin\nbug  ',
                'Fix login bug',
                startedAt + 3,
                startedAt + 3,
                0,
                0,
            );
        writableDatabase
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-long-provisional',
                root,
                longPrompt,
                longPrompt.replaceAll(/\s+/gu, ' ').trim().slice(0, 36),
                startedAt + 4,
                startedAt + 4,
                0,
                0,
            );
        writableDatabase
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-36-character-final',
                root,
                'Unrelated raw prompt',
                'Thirty Six Character Native Title OK',
                startedAt + 5,
                startedAt + 5,
                0,
                0,
            );
        writableDatabase
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-session-trimmed-provisional',
                root,
                `${'a'.repeat(35)} b`,
                'a'.repeat(35),
                startedAt + 6,
                startedAt + 6,
                0,
                0,
            );
        writableDatabase.close();

        await expect(
            service.snapshot('codex', { rootPath: root, processState: 'running', startedAt }),
        ).resolves.toMatchObject({
            available: true,
            sessionId: 'codex-session-1',
            status: 'unknown',
            title: 'Finish Phase 1',
            // Deliberately absent: Codex records no writer for a thread name, so a title it reports can be an upstream
            // AI name or one the user typed at the CLI. Declaring either source would let automatic naming claim or
            // surrender a Session name on a guess (issue #671).
            titleSource: undefined,
            usage: [{ label: 'Tokens', value: '12,345' }],
            version: 'codex 1.0',
        });
        await expect(
            service.snapshot('codex', {
                excludedAgentSessionIds: ['codex-session-1'],
                rootPath: root,
                processState: 'running',
                startedAt,
            }),
        ).resolves.toMatchObject({
            sessionId: 'codex-session-2',
            title: 'Keep this Terminal',
        });
        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-older',
                agentTurnId: 'turn-1',
                rootPath: root,
                processState: 'running',
            }),
        ).resolves.toMatchObject({
            activitySource: 'exactTurn',
            activityTurnId: 'turn-1',
            attentionKind: 'completed',
            sessionId: 'codex-session-older',
            status: 'completed',
            title: undefined,
            usage: [{ label: 'Tokens', value: '42' }],
        });
        // Codex persists no source for the second write, so an identical generated name stays
        // indistinguishable from the raw-prompt preview and remains hidden.
        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-indistinguishable-name',
                rootPath: root,
                processState: 'running',
            }),
        ).resolves.toMatchObject({ title: undefined });
        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-long-provisional',
                rootPath: root,
                processState: 'running',
            }),
        ).resolves.toMatchObject({ title: undefined });
        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-36-character-final',
                rootPath: root,
                processState: 'running',
            }),
        ).resolves.toMatchObject({ title: 'Thirty Six Character Native Title OK' });
        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-session-trimmed-provisional',
                rootPath: root,
                processState: 'running',
            }),
        ).resolves.toMatchObject({ title: undefined });

        const statusSnapshots = await Promise.all(
            ['turn-running', 'turn-interrupted', 'turn-failed'].map((agentTurnId) =>
                service.snapshot('codex', {
                    agentSessionId: 'codex-session-older',
                    agentTurnId,
                    rootPath: root,
                    processState: 'running',
                }),
            ),
        );
        expect(statusSnapshots.map((snapshot) => snapshot.status)).toEqual([
            'running',
            'completed',
            'failed',
        ]);
        expect(statusSnapshots.map((snapshot) => snapshot.activityTurnId)).toEqual([
            'turn-running',
            'turn-interrupted',
            'turn-failed',
        ]);
    });

    it('reads the exact resumed thread after Codex moves its cwd into a worktree', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-codex-resume-worktree-'));
        temporaryDirectories.push(directory);
        const launchRoot = join(directory, 'project');
        const worktreeRoot = join(directory, 'project-worktree');
        const state = join(directory, 'codex-state');
        await Promise.all([mkdir(launchRoot), mkdir(worktreeRoot), mkdir(state)]);

        const database = new Database(join(state, 'state_1.sqlite'));
        database.exec(
            'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER)',
        );
        database
            .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                'codex-resumed-worktree',
                worktreeRoot,
                'Private resumed prompt',
                'Resume this worktree session',
                Date.now() - 1_000,
                Date.now(),
                0,
                0,
            );
        database.close();

        const service = new AgentService(
            undefined,
            createLocalAgentAdapters({
                homeDirectory: directory,
                variables: { CODEX_SQLITE_HOME: state },
            }),
        );

        await expect(
            service.snapshot('codex', {
                agentSessionId: 'codex-resumed-worktree',
                rootPath: launchRoot,
                processState: 'running',
            }),
        ).resolves.toMatchObject({
            sessionId: 'codex-resumed-worktree',
            title: 'Resume this worktree session',
        });
    });
});
