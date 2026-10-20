import { constants } from 'node:fs';

import type { AgentLaunchSettings, AgentMessagingCapability, AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import { isAccessible, readE2EAgentPolicy, SingleFlight } from '@caxri/system';

/**
 * Server domains expose public root barrels by architecture contract; deep imports are rejected by
 * `apps/server/src/domains/__tests__/structure.test.ts`.
 */
// oxlint-disable-next-line react-doctor/no-barrel-import
import { discoverExecutable, readVersion } from '../agents';

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

const VERIFIED_PROVIDER_RANGE: Record<
    AgentProvider,
    { major: number; minimum: readonly [number, number, number] } | null
> = {
    grok: null,
    claude: { major: 2, minimum: [2, 1, 80] as const },
    codex: { major: 0, minimum: [0, 147, 0] as const },
};

interface ProbeResult {
    executable?: string;
    version?: string;
}

export interface AgentMessagingProbeInput {
    enabled: boolean;
    launch: AgentLaunchSettings;
    provider: AgentProvider;
}

export interface AgentMessagingProbeOptions {
    cliAvailable?: (path: string) => Promise<boolean>;
    cliPath?: string;
    fixtureMode?: boolean;
    now?: () => number;
    probe?: (provider: AgentProvider, launch: AgentLaunchSettings) => Promise<ProbeResult>;
    timeoutMs?: number;
}

interface CachedCapability {
    capability: AgentMessagingCapability;
    expiresAt: number;
}

function normalizedLaunchKey(provider: AgentProvider, launch: AgentLaunchSettings): string {
    /**
     * Positional serialization makes independently allocated but equivalent launch settings share one probe.
     */
    return JSON.stringify([provider, launch.executable, ...launch.args]);
}

function parseVersion(source: string): [number, number, number] | undefined {
    const match = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/u.exec(source);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isAtLeast(
    candidate: readonly [number, number, number],
    minimum: readonly [number, number, number],
): boolean {
    for (const [index, element] of minimum.entries()) {
        if (candidate[index] !== element) return candidate[index] > element;
    }
    return true;
}

async function isCliAvailableDefault(path: string): Promise<boolean> {
    return isAccessible(path, constants.R_OK);
}

async function defaultProbe(
    provider: AgentProvider,
    launch: AgentLaunchSettings,
): Promise<ProbeResult> {
    const executable = await discoverExecutable(provider, launch.executable);
    return {
        executable,
        ...(executable && { version: await readVersion(provider, executable) }),
    };
}

function unavailable(
    checkedAt: number,
    reason: Extract<
        AgentMessagingCapability['reason'],
        | 'adapter_unavailable'
        | 'integration_disabled'
        | 'probe_failed'
        | 'probe_timeout'
        | 'provider_missing'
        | 'version_unsupported'
    >,
    providerVersion?: string,
): AgentMessagingCapability {
    const health = reason === 'integration_disabled' ? 'disabled' : 'unsupported';
    const nextAction =
        reason === 'integration_disabled'
            ? 'enable_integration'
            : reason === 'provider_missing'
              ? 'install_provider'
              : reason === 'version_unsupported'
                ? 'upgrade_provider'
                : reason === 'adapter_unavailable'
                  ? 'restart_terminal'
                  : 'fix_configuration';
    return {
        deliveryMode: 'unavailable',
        health,
        reason,
        checkedAt,
        nextAction,
        ...(providerVersion && { providerVersion }),
    };
}

/**
 * A prepared Endpoint is not visible yet. Once activated it can be listed and authenticated, but messaging remains
 * unavailable until this capability probe finishes.
 */
export function pendingMessagingCapability(checkedAt = Date.now()): AgentMessagingCapability {
    return {
        deliveryMode: 'unavailable',
        health: 'degraded',
        reason: 'probe_pending',
        checkedAt,
        nextAction: 'none',
    };
}

/**
 * Bounded, cached capability probe. Unknown Provider versions fail closed without blocking PTY.
 */
export class AgentMessagingCapabilityProbe {
    private readonly cache = new Map<string, CachedCapability>();
    private readonly inFlight = new SingleFlight<string, AgentMessagingCapability>();
    private readonly providerEpochs = new Map<AgentProvider, number>();
    private readonly cliAvailable: (path: string) => Promise<boolean>;
    private readonly cliPath?: string;
    private readonly fixtureMode: boolean;
    private readonly now: () => number;
    private readonly probe: AgentMessagingProbeOptions['probe'];
    private readonly timeoutMs: number;

    constructor(options: AgentMessagingProbeOptions = {}) {
        this.cliAvailable = options.cliAvailable ?? isCliAvailableDefault;
        this.cliPath = options.cliPath;
        this.fixtureMode = options.fixtureMode ?? readE2EAgentPolicy()?.mode === 'fake';
        this.now = options.now ?? Date.now;
        this.probe = options.probe ?? defaultProbe;
        this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    }

    private async checkOnce(
        input: AgentMessagingProbeInput,
        checkedAt: number,
        key: string,
    ): Promise<AgentMessagingCapability> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
            timer.unref();
        });
        const probe = async (): Promise<ProbeResult | 'adapter-unavailable'> => {
            if (!this.cliPath || !(await this.cliAvailable(this.cliPath)))
                return 'adapter-unavailable';
            return this.probe!(input.provider, input.launch);
        };
        let result: ProbeResult | 'adapter-unavailable' | 'timeout';
        try {
            result = await Promise.race([probe(), timeout]);
        } catch {
            result = {};
        } finally {
            if (timer) clearTimeout(timer);
        }

        let capability: AgentMessagingCapability;
        if (result === 'timeout') capability = unavailable(checkedAt, 'probe_timeout');
        else if (result === 'adapter-unavailable')
            capability = unavailable(checkedAt, 'adapter_unavailable');
        else if (!result.executable) capability = unavailable(checkedAt, 'provider_missing');
        else if (!result.version) capability = unavailable(checkedAt, 'probe_failed');
        else if (this.fixtureMode) {
            capability = {
                deliveryMode: 'pull',
                health: 'ready',
                reason: 'fixture_pull_ready',
                checkedAt,
                nextAction: 'use_pull',
                providerVersion: result.version,
            };
        } else {
            const version = parseVersion(result.version);
            const supported = VERIFIED_PROVIDER_RANGE[input.provider];
            capability =
                version &&
                supported &&
                version[0] === supported.major &&
                isAtLeast(version, supported.minimum)
                    ? {
                          deliveryMode: 'pull',
                          health: 'ready',
                          reason: 'pull_ready',
                          checkedAt,
                          nextAction: 'use_pull',
                          providerVersion: result.version,
                      }
                    : unavailable(checkedAt, 'version_unsupported', result.version);
        }
        this.cache.set(key, { capability, expiresAt: checkedAt + CACHE_TTL_MS });
        return capability;
    }

    invalidate(provider?: AgentProvider): void {
        const providers: readonly AgentProvider[] = provider ? [provider] : agentProviderIds;
        for (const current of providers) {
            this.providerEpochs.set(current, (this.providerEpochs.get(current) ?? 0) + 1);
            for (const key of this.cache.keys()) {
                if (key.startsWith(`${current}\u{0}`)) this.cache.delete(key);
            }
        }
    }

    async check(input: AgentMessagingProbeInput): Promise<AgentMessagingCapability> {
        const checkedAt = this.now();
        if (!input.enabled) return unavailable(checkedAt, 'integration_disabled');
        if (!VERIFIED_PROVIDER_RANGE[input.provider])
            return unavailable(checkedAt, 'adapter_unavailable');
        const epoch = this.providerEpochs.get(input.provider) ?? 0;
        const key = `${input.provider}\u{0}${epoch}\u{0}${normalizedLaunchKey(input.provider, input.launch)}`;
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > checkedAt) return cached.capability;
        return this.inFlight.run(key, () => this.checkOnce(input, checkedAt, key));
    }
}
