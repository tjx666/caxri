import type { StructuredLogger } from '../../shared/node/logger';
import type { AgentProvider, AgentSnapshot } from '../../shared/types';
import { SingleFlight } from '../single-flight';
import { readClaudeState } from './claude';
import { readCodexState } from './codex';
import { discoverExecutable, readVersion } from './discovery';
import {
    defaultAgentStateLocations,
    processStateToAgentActivity,
    type AgentSnapshotContext,
    type AgentStateLocations,
} from './state';

export interface AgentAdapter {
    provider: AgentProvider;
    snapshot(context: AgentSnapshotContext): Promise<AgentSnapshot>;
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
