import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import type { StructuredLogger } from '../shared/node/logger';
import { safeProcessEnvironment } from '../shared/node/process-environment';
import type { AgentProvider, AgentSnapshot } from '../shared/types';
import {
    defaultAgentStateLocations,
    processStateToAgentActivity,
    readClaudeState,
    readCodexState,
    type AgentSnapshotContext,
    type AgentStateLocations,
} from './agent-state';
import { SingleFlight } from './single-flight';

const execFileAsync = promisify(execFile);

const executableNames: Record<AgentProvider, string> = {
    claude: 'claude',
    codex: 'codex',
};

const executableCache = new Map<AgentProvider, string>();
const executableRequests = new Map<AgentProvider, Promise<string | undefined>>();
const versionCache = new Map<AgentProvider, { executable: string; version: string }>();

async function isExecutable(path: string): Promise<boolean> {
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function clearExecutableCache(): void {
    executableCache.clear();
    executableRequests.clear();
    versionCache.clear();
}

export async function discoverExecutable(name: AgentProvider): Promise<string | undefined> {
    const cached = executableCache.get(name);
    if (cached && (await isExecutable(cached))) return cached;
    executableCache.delete(name);
    const pending = executableRequests.get(name);
    if (pending) return pending;
    const request = findExecutable(name).finally(() => executableRequests.delete(name));
    executableRequests.set(name, request);
    const executable = await request;
    if (executable) executableCache.set(name, executable);
    return executable;
}

async function findExecutable(name: AgentProvider): Promise<string | undefined> {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const candidate = join(directory, executableNames[name]);
        if (await isExecutable(candidate)) return candidate;
    }

    const shell = process.env.SHELL || '/bin/zsh';
    try {
        const { stdout } = await execFileAsync(
            shell,
            ['-lic', `command -v ${executableNames[name]}`],
            {
                env: safeProcessEnvironment(),
                timeout: 5_000,
                maxBuffer: 8 * 1024,
            },
        );
        const candidate = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .at(-1);
        if (!candidate || !isAbsolute(candidate) || !(await isExecutable(candidate)))
            return undefined;
        return candidate;
    } catch {
        return undefined;
    }
}

export interface AgentAdapter {
    provider: AgentProvider;
    snapshot(context: AgentSnapshotContext): Promise<AgentSnapshot>;
}

async function readVersion(
    provider: AgentProvider,
    executable: string,
): Promise<string | undefined> {
    const cached = versionCache.get(provider);
    if (cached?.executable === executable) return cached.version;
    try {
        const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
            env: safeProcessEnvironment(),
            timeout: 5_000,
            maxBuffer: 64 * 1024,
        });
        const version = (stdout || stderr).trim();
        if (version) versionCache.set(provider, { executable, version });
        return version || undefined;
    } catch {
        return undefined;
    }
}

function createCliAdapter(provider: AgentProvider, locations: AgentStateLocations): AgentAdapter {
    return {
        provider,
        async snapshot(context): Promise<AgentSnapshot> {
            const observedAt = Date.now();
            const [executable, localState] = await Promise.all([
                discoverExecutable(provider),
                provider === 'claude'
                    ? readClaudeState(context, locations.claudeConfigDirectory)
                    : readCodexState(context, locations.codexStateDirectories),
            ]);
            const version = executable ? await readVersion(provider, executable) : undefined;
            return {
                provider,
                status: localState?.status ?? processStateToAgentActivity(context.processState),
                observedAt,
                available: Boolean(executable),
                executable,
                version,
                sessionId: localState?.sessionId,
                title: localState?.title,
                usage: localState?.usage,
            };
        },
    };
}

export function createLocalAgentAdapters(
    locations: AgentStateLocations = defaultAgentStateLocations(),
): Record<AgentProvider, AgentAdapter> {
    return {
        claude: createCliAdapter('claude', locations),
        codex: createCliAdapter('codex', locations),
    };
}

export class AgentService {
    private readonly requests = new SingleFlight<string, AgentSnapshot>();

    constructor(
        private readonly logger?: StructuredLogger,
        private readonly adapters: Record<AgentProvider, AgentAdapter> = createLocalAgentAdapters(),
    ) {}

    snapshot(
        provider: AgentProvider,
        context: AgentSnapshotContext = { rootPath: process.cwd() },
    ): Promise<AgentSnapshot> {
        return this.requests.run(
            `${provider}:${context.rootPath}:${context.agentSessionId ?? ''}`,
            async () => {
                const startedAt = performance.now();
                const snapshot = await this.adapters[provider].snapshot(context);
                this.logger?.write('info', 'agent.probe', {
                    durationMs: performance.now() - startedAt,
                    fields: { provider, available: snapshot.available },
                });
                return snapshot;
            },
        );
    }
}
