import { access, constants } from 'node:fs/promises';

import type { AgentLaunchSettings, AgentProvider } from '../../shared/agents';
import type { AgentMessagingCapability } from '../../shared/ipc/agent-endpoint-contract';
import { readE2EAgentPolicy } from '../../shared/node/e2e-agent-policy';
/** Runtime domains expose public root barrels by architecture contract; deep imports are rejected
 * by `src/runtime/__tests__/structure.test.ts`. */
// oxlint-disable-next-line react-doctor/no-barrel-import
import { discoverExecutable, readVersion } from '../agents';

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

const VERIFIED_PROVIDER_RANGE = {
    claude: { major: 2, minimum: [2, 1, 80] as const },
    codex: { major: 0, minimum: [0, 147, 0] as const },
} satisfies Record<AgentProvider, { major: number; minimum: readonly [number, number, number] }>;

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

function parseVersion(source: string): [number, number, number] | undefined {
    const match = /(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/u.exec(source);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(
    candidate: readonly [number, number, number],
    minimum: readonly [number, number, number],
): boolean {
    for (let index = 0; index < minimum.length; index += 1) {
        if (candidate[index] !== minimum[index]) return candidate[index] > minimum[index];
    }
    return true;
}

async function defaultCliAvailable(path: string): Promise<boolean> {
    try {
        await access(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

async function defaultProbe(
    provider: AgentProvider,
    launch: AgentLaunchSettings,
): Promise<ProbeResult> {
    const executable = await discoverExecutable(provider, launch.executable);
    return {
        executable,
        ...(executable ? { version: await readVersion(provider, executable) } : {}),
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
        ...(providerVersion ? { providerVersion } : {}),
    };
}

/** Bounded, cached capability probe. Unknown Provider versions fail closed without blocking PTY. */
export class AgentMessagingCapabilityProbe {
    private readonly cache = new Map<string, CachedCapability>();
    private readonly cliAvailable: (path: string) => Promise<boolean>;
    private readonly cliPath?: string;
    private readonly fixtureMode: boolean;
    private readonly now: () => number;
    private readonly probe: AgentMessagingProbeOptions['probe'];
    private readonly timeoutMs: number;

    constructor(options: AgentMessagingProbeOptions = {}) {
        this.cliAvailable = options.cliAvailable ?? defaultCliAvailable;
        this.cliPath = options.cliPath;
        this.fixtureMode = options.fixtureMode ?? readE2EAgentPolicy()?.mode === 'fake';
        this.now = options.now ?? Date.now;
        this.probe = options.probe ?? defaultProbe;
        this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    }

    invalidate(provider?: AgentProvider): void {
        if (!provider) this.cache.clear();
        else
            for (const key of this.cache.keys()) {
                if (key.startsWith(`${provider}:`)) this.cache.delete(key);
            }
    }

    async check(input: AgentMessagingProbeInput): Promise<AgentMessagingCapability> {
        const checkedAt = this.now();
        if (!input.enabled) return unavailable(checkedAt, 'integration_disabled');
        if (!this.cliPath || !(await this.cliAvailable(this.cliPath)))
            return unavailable(checkedAt, 'adapter_unavailable');
        const key = `${input.provider}:${JSON.stringify(input.launch)}`;
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > checkedAt) return cached.capability;

        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
            timer.unref();
        });
        let result: ProbeResult | 'timeout';
        try {
            result = await Promise.race([this.probe!(input.provider, input.launch), timeout]);
        } catch {
            result = {};
        } finally {
            if (timer) clearTimeout(timer);
        }

        let capability: AgentMessagingCapability;
        if (result === 'timeout') capability = unavailable(checkedAt, 'probe_timeout');
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
                version && version[0] === supported.major && atLeast(version, supported.minimum)
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
}
