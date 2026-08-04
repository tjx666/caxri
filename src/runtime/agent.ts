import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import type { AgentProvider, AgentSnapshot } from '../shared/types';
import type { StructuredLogger } from './logger';
import { SingleFlight } from './single-flight';

const execFileAsync = promisify(execFile);

const executableNames: Record<AgentProvider, string> = {
    claude: 'claude',
    codex: 'codex',
};

export async function discoverExecutable(name: AgentProvider): Promise<string | undefined> {
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
        const candidate = join(directory, executableNames[name]);
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        } catch {
            // A GUI-launched macOS app commonly has a minimal PATH; try the login shell next.
        }
    }

    const shell = process.env.SHELL || '/bin/zsh';
    try {
        const { stdout } = await execFileAsync(
            shell,
            ['-lic', `command -v ${executableNames[name]}`],
            {
                timeout: 5_000,
                maxBuffer: 8 * 1024,
            },
        );
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

export interface AgentAdapter {
    provider: AgentProvider;
    snapshot(): Promise<AgentSnapshot>;
}

function createCliAdapter(provider: AgentProvider): AgentAdapter {
    return {
        provider,
        async snapshot(): Promise<AgentSnapshot> {
            const observedAt = Date.now();
            const executable = await discoverExecutable(provider);
            if (!executable) return { provider, status: 'unknown', observedAt, available: false };

            try {
                const { stdout, stderr } = await execFileAsync(executable, ['--version'], {
                    timeout: 5_000,
                    maxBuffer: 64 * 1024,
                });
                return {
                    provider,
                    status: 'unknown',
                    observedAt,
                    available: true,
                    executable,
                    version: (stdout || stderr).trim(),
                };
            } catch {
                return { provider, status: 'unknown', observedAt, available: true, executable };
            }
        },
    };
}

const agentAdapters: Record<AgentProvider, AgentAdapter> = {
    claude: createCliAdapter('claude'),
    codex: createCliAdapter('codex'),
};

export class AgentService {
    private readonly requests = new SingleFlight<AgentProvider, AgentSnapshot>();

    constructor(
        private readonly logger?: StructuredLogger,
        private readonly adapters: Record<AgentProvider, AgentAdapter> = agentAdapters,
    ) {}

    snapshot(provider: AgentProvider): Promise<AgentSnapshot> {
        return this.requests.run(provider, async () => {
            const startedAt = performance.now();
            const snapshot = await this.adapters[provider].snapshot();
            this.logger?.write('debug', 'agent.probe', {
                durationMs: performance.now() - startedAt,
                fields: { provider, available: snapshot.available },
            });
            return snapshot;
        });
    }
}
