import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AppSettings,
    GitSummary,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { onTestFinished, vi } from 'vitest';

import { claudeTranscriptPath } from '../../agents/providers/claude/paths';
import type { ExternalStatusRunner } from '../../external-status/index';
import { ExternalStatusCliError } from '../../external-status/index';
import { SessionPullRequestService } from '../session-pull-requests';

export async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

export async function testLogger(): Promise<StructuredLogger> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-session-pr-log-'));
    const instance = new StructuredLogger(directory);
    onTestFinished(async () => {
        await instance.flush();
        await rm(directory, { recursive: true, force: true });
    });
    return instance;
}

export function gitSummary(branch: string, rootPath = '/project'): GitSummary {
    return {
        isRepository: true,
        repositories: [
            {
                id: 'repo-1',
                kind: 'primary',
                name: 'project',
                rootPath,
                branch,
                head: '1234567',
                ahead: 0,
                behind: 0,
                additions: 0,
                deletions: 0,
                generation: 0,
                changedFileCount: 0,
                truncated: false,
                files: [],
            },
        ],
    };
}

export function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
        id: 'session-1',
        projectId: 'project-1',
        workbenchProjectId: 'project-1',
        rootPath: '/project',
        createdAt: 0,
        lastOpenedAt: 0,
        sidebarOrder: 0,
        lastSessionActivityAt: 0,
        lastSessionActivityReason: 'created',
        lastActivityState: 'idle',
        attentionEpoch: 0,
        readAttentionEpoch: 0,
        hasUnread: false,
        displayTitle: 'Session',
        titleMode: 'automatic',
        ...overrides,
    };
}

export function pullRequestJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        number: 19024,
        title: 'feat: migrate search',
        url: 'https://github.com/example/example/pull/19024',
        state: 'MERGED',
        isDraft: false,
        statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
        ...overrides,
    });
}

export interface Harness {
    emitted: ServerEvent[];
    logger: StructuredLogger;
    runner: ReturnType<typeof vi.fn<ExternalStatusRunner>>;
    service: SessionPullRequestService;
    setTranscript: (lines: string[]) => Promise<void>;
    terminal: TerminalRecord;
}

export async function harness(options: {
    branch?: string;
    gh?: (arguments_: readonly string[]) => Promise<string>;
    now?: () => number;
    sessions?: SessionRecord[];
    settings?: () => AppSettings;
    summary?: (sessionId: string) => Promise<GitSummary>;
    onSessionRead?: (sessionId: string) => void;
    /**
     * Answers the `vc` calls behind the delivery badge. Omitted, every one of them fails, which is what a machine with
     * no Vercel CLI looks like and what every test that is not about deployments wants.
     */
    vc?: (arguments_: readonly string[]) => Promise<string>;
}): Promise<Harness> {
    const home = await temporaryDirectory('caxri-session-pr-home-');
    const cwd = '/project';
    const agentSessionId = 'claude-session-1';
    const transcriptPath = claudeTranscriptPath(join(home, '.claude'), cwd, agentSessionId);
    await mkdir(join(transcriptPath, '..'), { recursive: true });
    const terminal = {
        id: 'terminal-1',
        sessionId: 'session-1',
        kind: 'claude',
        provider: 'claude',
        cwd,
        agentSessionId,
    } as unknown as TerminalRecord;
    const sessions = options.sessions ?? [session({ primaryAgentTerminalId: terminal.id })];
    const emitted: ServerEvent[] = [];
    const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
        if (command === 'git') return Promise.resolve('git@github.com:example/example.git\n');
        if (command === 'gh' && options.gh) return options.gh(arguments_);
        if (command === 'vc' && options.vc) return options.vc(arguments_);
        return Promise.reject(new ExternalStatusCliError('gh', 'other', 'no pull requests found'));
    });
    const structuredLogger = await testLogger();
    const service = new SessionPullRequestService(
        {
            getSession: (id) => {
                options.onSessionRead?.(id);
                return sessions.find((candidate) => candidate.id === id);
            },
            getTerminal: (id) => (id === terminal.id ? terminal : undefined),
            listVisibleSessions: () => sessions,
        },
        {
            summary:
                options.summary ?? (() => Promise.resolve(gitSummary(options.branch ?? 'feat/x'))),
        },
        structuredLogger,
        runner,
        {
            agentEnvironment: { homeDirectory: home, variables: {} },
            emit: (event) => emitted.push(event),
            now: options.now,
            settings: options.settings,
        },
    );
    const setTranscript = (lines: string[]): Promise<void> =>
        writeFile(transcriptPath, `${lines.join('\n')}\n`);
    return { emitted, logger: structuredLogger, runner, service, setTranscript, terminal };
}

export const createdPullRequestLines = [
    JSON.stringify({
        type: 'assistant',
        message: {
            content: [
                {
                    type: 'tool_use',
                    id: 'toolu_1',
                    name: 'Bash',
                    input: { command: 'gh pr create' },
                },
            ],
        },
    }),
    JSON.stringify({
        type: 'user',
        message: {
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: 'https://github.com/example/example/pull/19024',
                },
            ],
        },
    }),
];

/**
 * UUIDv7 Codex thread id; its leading 48 bits place the rollout in the local day folder of 2026-05-27.
 */
export const CODEX_THREAD_ID = '019e676d-8740-7bb2-8bcb-f189c8260607';

export async function writeCodexRollout(home: string, lines: string[]): Promise<void> {
    const day = new Date(0x019e676d8740);
    const segments = [
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, '0'),
        String(day.getDate()).padStart(2, '0'),
    ];
    const directory = join(home, '.codex', 'sessions', ...segments);
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, `rollout-${segments.join('-')}T11-14-52-${CODEX_THREAD_ID}.jsonl`),
        `${lines.join('\n')}\n`,
    );
}

export const codexCreatedPullRequestLines = [
    JSON.stringify({
        type: 'response_item',
        payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'gh pr create --fill', workdir: '/project' }),
            call_id: 'call_1',
        },
    }),
    JSON.stringify({
        type: 'response_item',
        payload: {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Output:\nhttps://github.com/example/example/pull/19024\n',
        },
    }),
];
