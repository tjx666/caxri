import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentChatSnapshot, ServerEvent } from '@caxri/protocol';
import { applyAgentChatPatch, defaultAgentProviderSettings } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { expect, onTestFinished, vi } from 'vitest';

import type { AgentLifecycleSignal } from '../../agents';
import { CaxriDatabase } from '../../db';
import { AgentChatService } from '../service';
import type { AgentChatEndpoint, AgentChatServiceOptions } from '../service-options';

const FAKE_APP_SERVER = join(import.meta.dirname, 'fixtures', 'fake-codex-app-server.ts');
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude-cli.ts');
const FAKE_GROK = join(import.meta.dirname, 'fixtures', 'fake-grok-acp.ts');
const FAKE_CLIS = { claude: FAKE_CLAUDE, codex: FAKE_APP_SERVER, grok: FAKE_GROK } as const;

/**
 * Builds an AgentChatService over a temporary database that spawns the fake Codex app-server, Claude Code CLI, or Grok
 * Build ACP agent.
 */
export async function fixture(
    options: {
        /**
         * A function is read at every provider start, so a test can change Settings between starts.
         */
        launchArgs?: string[] | (() => string[]);
        provider?: keyof typeof FAKE_CLIS;
        turnRequestTimeoutMs?: number;
        endpoint?: AgentChatEndpoint;
        onAgentStateChanged?: AgentChatServiceOptions['onAgentStateChanged'];
        delegation?: AgentChatServiceOptions['delegation'];
        /**
         * Also receives every lifecycle signal, after `signals` records it, as the Server's coordinator would.
         */
        observeLifecycleSignal?: (signal: AgentLifecycleSignal) => void;
    } = {},
) {
    const provider = options.provider ?? 'codex';
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-agent-chat-`));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const projectRoot = join(directory, 'project');
    const stateDirectory = join(directory, 'codex');
    const claudeConfigDirectory = join(directory, 'claude');
    const grokStateDirectory = join(directory, 'grok');
    await mkdir(projectRoot);
    const project = database.createProject(projectRoot);
    const { session } = database.createSession(project.id, null);
    const terminal = database.createTerminal(session.id, provider, projectRoot, 'chat');
    const events: ServerEvent[] = [];
    const signals: AgentLifecycleSignal[] = [];
    const coordinator = {
        beginTerminalLaunch: vi.fn<() => void>(),
        endTerminalLaunch: vi.fn<() => void>(),
        probeTerminal: vi.fn<() => void>(),
        prepareTerminalStart: vi.fn<() => void>(),
    };
    const logWrite = vi.fn<StructuredLogger['write']>();
    const logger = { write: logWrite } as unknown as StructuredLogger;
    const agentEnvironment = {
        homeDirectory: directory,
        variables: { CLAUDE_CONFIG_DIR: claudeConfigDirectory },
    };
    const spawnProcess = vi.fn(
        (_executable: string, arguments_: string[], spawnOptions: SpawnOptionsWithoutStdio) =>
            spawn(process.execPath, [FAKE_CLIS[provider], ...arguments_], spawnOptions),
    );
    const service = new AgentChatService({
        database,
        logger,
        send: (event) => events.push(event),
        environment: () =>
            Promise.resolve({
                ...process.env,
                FAKE_CODEX_STATE_DIR: stateDirectory,
                FAKE_GROK_STATE_DIR: grokStateDirectory,
                CLAUDE_CONFIG_DIR: claudeConfigDirectory,
                FAKE_CLAUDE_CONTROL_DIR: claudeConfigDirectory,
            }),
        launchSettings: () => ({
            ...defaultAgentProviderSettings[provider].launch,
            args:
                typeof options.launchArgs === 'function'
                    ? options.launchArgs()
                    : (options.launchArgs ?? []),
        }),
        resolveExecutable: () => Promise.resolve(`/fake/${provider}`),
        coordinator,
        observeLifecycleSignal: (signal) => {
            signals.push(signal);
            options.observeLifecycleSignal?.(signal);
            return Promise.resolve('accepted');
        },
        clientVersion: '0.0.0-test',
        agentEnvironment,
        spawnProcess,
        ...(options.turnRequestTimeoutMs !== undefined && {
            turnRequestTimeoutMs: options.turnRequestTimeoutMs,
        }),
        ...(options.endpoint && { endpoint: options.endpoint }),
        onAgentStateChanged: options.onAgentStateChanged,
        delegation: options.delegation,
    });
    onTestFinished(async () => {
        await service.shutdown();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    /**
     * Mirrors a Client: one read, then every patch applied with the shared reducer, re-reading on a revision gap.
     */
    let mirror: AgentChatSnapshot | undefined;
    function client(): AgentChatSnapshot {
        mirror ??= service.read(terminal.id);
        const pending = [...events];
        events.length = 0;
        for (const event of pending) {
            if (event.event !== 'agentChat.patch') continue;
            const patch = event.payload;
            if (patch.revision <= mirror.revision) continue;
            mirror = applyAgentChatPatch(mirror, patch) ?? service.read(terminal.id);
        }
        return mirror;
    }
    /**
     * Waits for the mirrored snapshot to reach a state. A timeout names the Chat, turn, and task states it last saw, so
     * a flaky wait says what it was stuck on instead of only "expected false to be true".
     */
    async function until(isReached: (snapshot: AgentChatSnapshot) => boolean) {
        await vi.waitFor(
            () => {
                const snapshot = client();
                const { status, activeTurnId, turns, tasks } = snapshot;
                expect(
                    isReached(snapshot),
                    `last snapshot: ${JSON.stringify({
                        status,
                        activeTurnId,
                        turns: turns.map((turn) => turn.status),
                        tasks: tasks?.map(({ kind, status: taskStatus }) => ({ kind, taskStatus })),
                    })}`,
                ).toBe(true);
            },
            { timeout: 5_000, interval: 10 },
        );
        return client();
    }
    const threadOpens = async () =>
        (await readFile(join(stateDirectory, 'thread-opens.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    /**
     * Makes the fake Codex refuse to resume `threadId`, as when another client still holds its writer.
     */
    const holdCodexThreadWriter = async (threadId: string) => {
        await mkdir(stateDirectory, { recursive: true });
        await writeFile(join(stateDirectory, `${threadId}.writer-held`), '');
    };
    /**
     * Sets the `[sandbox_workspace_write]` table the fake Codex reports through `config/read`.
     */
    const setCodexWorkspaceWriteConfig = async (table: Record<string, unknown>) => {
        await mkdir(stateDirectory, { recursive: true });
        await writeFile(
            join(stateDirectory, 'config-sandbox-workspace-write.json'),
            JSON.stringify(table),
        );
    };
    /**
     * Makes the fake Codex answer `thread/unsubscribe` with an error.
     */
    const failCodexUnsubscribe = async () => {
        await mkdir(stateDirectory, { recursive: true });
        await writeFile(join(stateDirectory, 'unsubscribe-fails'), '');
    };
    /**
     * Makes the active Claude/Codex turn reject Stop without ending or interrupting itself.
     */
    const rejectInterrupt = async () => {
        const root = provider === 'claude' ? claudeConfigDirectory : stateDirectory;
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'reject-interrupt'), '');
    };
    const sessionOpens = async () =>
        (await readFile(join(grokStateDirectory, 'session-opens.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { method: string; args: string[] });
    /**
     * Reads a JSON-lines log a fake provider wrote, or `[]` when it wrote none.
     */
    const fakeLog = async (
        owner: 'claude' | 'codex' | 'grok',
        name: string,
    ): Promise<Array<Record<string, unknown>>> => {
        const roots = {
            claude: claudeConfigDirectory,
            codex: stateDirectory,
            grok: grokStateDirectory,
        };
        let text: string;
        try {
            text = await readFile(join(roots[owner], name), 'utf8');
        } catch {
            return [];
        }
        return text
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    return {
        database,
        agentEnvironment,
        logWrite,
        claudeConfigDirectory,
        fakeLog,
        service,
        terminal,
        signals,
        coordinator,
        spawnProcess,
        client,
        until,
        threadOpens,
        holdCodexThreadWriter,
        failCodexUnsubscribe,
        rejectInterrupt,
        setCodexWorkspaceWriteConfig,
        sessionOpens,
    };
}
