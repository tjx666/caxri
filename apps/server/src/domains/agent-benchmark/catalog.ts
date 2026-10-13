import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    AgentChatModel,
    AgentLaunchSettings,
    AgentProvider,
    BenchmarkCatalog,
    BenchmarkCatalogProvider,
} from '@caxri/protocol';
import { agentProviderIds, GROK_REASONING_EFFORTS, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentChatProviderSession } from '../agent-chat';
import { agentChatDrivers, AgentChatStartError, prepareChatLaunch } from '../agent-chat';
import { createHeadlessHost } from './headless-host';
import type { HeadlessTurnDependencies } from './headless-turn';
import { probeLaunchSettings } from './launch';

const CATALOG_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 45_000;

/**
 * What each Agent offers for a Benchmark, read from the provider itself: a short-lived Chat driver process starts in an
 * empty folder, reports its models, and stops before any turn. Listing only what the installed CLI and the signed-in
 * account offer keeps the picker from proposing a model the run would reject. Cached for {@link CATALOG_TTL_MS}.
 */
export class BenchmarkCatalogProbe {
    private cached?: BenchmarkCatalog;
    private pending?: Promise<BenchmarkCatalog>;

    constructor(
        private readonly options: {
            directory: string;
            dependencies: HeadlessTurnDependencies;
            launchSettings(provider: AgentProvider): AgentLaunchSettings;
            logger: StructuredLogger;
            now?: () => number;
        },
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    /**
     * One probe of every provider, shared by every reader that asks while it runs.
     */
    private async probeOnce(): Promise<BenchmarkCatalog> {
        try {
            return await this.probeAll();
        } finally {
            this.pending = undefined;
        }
    }

    private async probeAll(): Promise<BenchmarkCatalog> {
        const providers = await Promise.all(
            agentProviderIds
                .filter((provider) => agentChatDrivers[provider])
                .map((provider) => this.probe(provider)),
        );
        this.cached = { providers, checkedAt: this.now() };
        return this.cached;
    }

    private async probe(provider: AgentProvider): Promise<BenchmarkCatalogProvider> {
        const startedAt = this.now();
        const result = await this.probeProvider(provider);
        this.options.logger.write('info', logEventCatalog.benchmark.catalogProbed, {
            fields: {
                provider,
                status: result.status,
                models: result.models.length,
                durationMs: this.now() - startedAt,
            },
        });
        return result;
    }

    private async probeProvider(provider: AgentProvider): Promise<BenchmarkCatalogProvider> {
        const driver = agentChatDrivers[provider];
        if (!driver) return { provider, status: 'failed', models: [] };
        const cwd = join(this.options.directory, provider);
        const launch = probeLaunchSettings(provider, this.options.launchSettings(provider));
        let session: AgentChatProviderSession | undefined;
        let timer: NodeJS.Timeout | undefined;
        try {
            await mkdir(cwd, { recursive: true });
            const prepared = await prepareChatLaunch(
                this.options.dependencies.launch,
                provider,
                launch,
                cwd,
            );
            const headless = createHeadlessHost(
                `benchmark-probe-${provider}`,
                prepared,
                launch,
                this.options.dependencies,
            );
            session = driver.create(headless.host);
            await Promise.race([
                session.start(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('The Agent did not start in time')),
                        PROBE_TIMEOUT_MS,
                    );
                }),
            ]);
            const snapshot = headless.snapshot();
            return {
                provider,
                status: 'ready',
                ...(snapshot.model && { defaultModel: snapshot.model }),
                models: withBenchmarkEfforts(provider, snapshot.models ?? []).slice(0, 100),
            };
        } catch (error) {
            if (error instanceof AgentChatStartError && error.reason === 'executable_not_found')
                return { provider, status: 'missing', models: [] };
            const message =
                error instanceof AgentChatStartError
                    ? (error.detail ?? 'The Agent did not start')
                    : error instanceof Error
                      ? error.message
                      : 'The Agent did not start';
            return { provider, status: 'failed', message: message.slice(0, 500), models: [] };
        } finally {
            clearTimeout(timer);
            try {
                await session?.close();
            } catch {
                // The probe already has its answer; a provider that fails to close cleanly changes nothing.
            }
        }
    }

    read(shouldRefresh = false): Promise<BenchmarkCatalog> {
        if (!shouldRefresh && this.cached && this.now() - this.cached.checkedAt < CATALOG_TTL_MS)
            return Promise.resolve(this.cached);
        this.pending ??= this.probeOnce();
        return this.pending;
    }
}

/**
 * Fills in efforts a provider accepts but does not list, so every model offers the efforts a run can apply.
 */
function withBenchmarkEfforts(provider: AgentProvider, models: AgentChatModel[]): AgentChatModel[] {
    if (provider !== 'grok') return models;
    return models.map((model) =>
        model.efforts.length > 0 ? model : { ...model, efforts: [...GROK_REASONING_EFFORTS] },
    );
}
