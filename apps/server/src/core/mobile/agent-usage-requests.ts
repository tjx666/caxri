import process from 'node:process';

import type {
    AgentProvider,
    AgentProviderStatus,
    AgentThroughput,
    MobileAgentThroughput,
    MobileAgentUsageProvider,
    Principal,
    SessionQueryResult,
    TerminalQueryResult,
    UsageLimit,
} from '@caxri/protocol';
import {
    MOBILE_AGENT_USAGE_INCIDENT_UPDATE_CHARS,
    MOBILE_AGENT_USAGE_INCIDENTS,
    MOBILE_AGENT_USAGE_PROVIDERS,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { createAgentProviderStatus, createE2EStatusPageFetch } from '@caxri/system';

import type { ServerDomainService } from '../domain-service';

type Session = SessionQueryResult['sessions'][number];
type Terminal = TerminalQueryResult['terminals'][number];
type StatusPageFetch = Parameters<typeof createAgentProviderStatus>[0]['fetch'];

/**
 * Agent Terminals tried per provider before the screen shows no speed: a Session's newest Agent may not have finished a
 * measured response yet while the one before it has.
 */
const THROUGHPUT_CANDIDATES = 3;
const SESSION_TITLE_CHARS = 200;

export interface ThroughputSource {
    terminalId: string;
    session: Session;
}

/**
 * The provider's Agent Terminals in the Sessions this device may see, most recently active Session first, a Session's
 * primary Agent before its other Agents. Archived Sessions are left out: their speed is history, not the current one.
 */
export function throughputSources(input: {
    provider: AgentProvider;
    sessions: readonly Session[];
    terminals: readonly Terminal[];
    grantedProjectIds?: ReadonlySet<string>;
}): ThroughputSource[] {
    const sessions = new Map(
        input.sessions
            .filter(
                (session) =>
                    session.archivedAt === undefined &&
                    (!input.grantedProjectIds || input.grantedProjectIds.has(session.projectId)),
            )
            .map((session) => [session.id, session]),
    );
    return input.terminals
        .flatMap((terminal) => {
            const session = sessions.get(terminal.sessionId);
            return session && terminal.kind === input.provider
                ? [{ terminalId: terminal.id, session }]
                : [];
        })
        .toSorted(
            (a, b) =>
                b.session.sessionActivityAt - a.session.sessionActivityAt ||
                Number(b.session.primaryAgentTerminalId === b.terminalId) -
                    Number(a.session.primaryAgentTerminalId === a.terminalId),
        )
        .slice(0, THROUGHPUT_CANDIDATES);
}

/**
 * The status bar's headline rate (the last few responses), or nothing for an Agent that has not finished a measured
 * response.
 */
function mobileThroughput(
    throughput: AgentThroughput | null | undefined,
    session: Session,
): MobileAgentThroughput | undefined {
    const last = throughput?.samples.at(-1);
    if (!throughput || !last || throughput.recent.responseCount === 0) return undefined;
    return {
        ...throughput.recent,
        lastResponseAt: last.completedAt,
        ...(last.model && { model: last.model }),
        sessionId: session.id,
        sessionTitle: session.title.slice(0, SESSION_TITLE_CHARS),
    };
}

/**
 * The status page as the phone shows it: current state and incidents, without the 90-day uptime history Desktop draws
 * as a strip, and with the incident list and each newest update clipped.
 */
export function mobileServiceStatus(status: AgentProviderStatus): AgentProviderStatus {
    if (status.state === 'unavailable') return status;
    return {
        ...status,
        components: status.components.map(({ name, status: componentStatus }) => ({
            name,
            status: componentStatus,
        })),
        incidents: status.incidents.slice(0, MOBILE_AGENT_USAGE_INCIDENTS).map((incident) =>
            incident.latestUpdate === undefined
                ? incident
                : {
                      ...incident,
                      latestUpdate: incident.latestUpdate.slice(
                          0,
                          MOBILE_AGENT_USAGE_INCIDENT_UPDATE_CHARS,
                      ),
                  },
        ),
    };
}

/**
 * Every provider the screen lists: the fixed pair first, then any other that has reported a plan limit.
 */
function mobileAgentUsageProviders(limits: readonly UsageLimit[]): AgentProvider[] {
    return [
        ...new Set<AgentProvider>([
            ...MOBILE_AGENT_USAGE_PROVIDERS,
            ...limits.map(({ provider }) => provider),
        ]),
    ];
}

/**
 * One part of the answer that failed reads as absent rather than failing the whole screen.
 */
async function orNull<T>(read: Promise<T>): Promise<T | null> {
    try {
        return await read;
    } catch {
        return null;
    }
}

/**
 * Server Core's status-page transport: Node's `fetch`, which reaches the page directly and ignores the macOS system
 * proxy (Desktop Main reads through Chromium for its own Agent status tab). An E2E or Acceptance launch reads the
 * fixture directory instead and never leaves the machine.
 */
function statusPageFetch(): StatusPageFetch {
    return process.env.CAXRI_E2E === '1'
        ? createE2EStatusPageFetch(process.env.CAXRI_E2E_PROVIDER_STATUS_DIR)
        : (url, init) => fetch(url, init);
}

/**
 * `mobile.agentUsage.read`. Plan limits come from `usage.limits` after each provider's newest Agent has been read once,
 * because reading a running Claude Code Chat is what asks it for a fresh `/usage` reading (`PlanLimitRefresh`); that
 * answer reaches the following poll. Every part degrades on its own: a failed read leaves only that field absent.
 */
export function createMobileAgentUsageRequests(options: {
    logger?: Pick<StructuredLogger, 'write'>;
    fetch?: StatusPageFetch;
}) {
    const readServiceStatus = createAgentProviderStatus({
        fetch: options.fetch ?? statusPageFetch(),
        logger: () => options.logger,
    });

    const readThroughput = async (
        domainService: ServerDomainService,
        sources: readonly ThroughputSource[],
    ): Promise<MobileAgentThroughput | undefined> => {
        for (const source of sources) {
            // eslint-disable-next-line no-await-in-loop -- the next candidate is read only when this one measured nothing
            const throughput = await orNull(
                domainService.request('terminal.agentThroughput', {
                    terminalId: source.terminalId,
                }),
            );
            const projected = mobileThroughput(throughput, source.session);
            if (projected) return projected;
        }
        return undefined;
    };

    return async (
        domainService: ServerDomainService,
        principal: Principal,
    ): Promise<{ providers: MobileAgentUsageProvider[] }> => {
        const [sessions, terminals] = await Promise.all([
            domainService.request('session.queryForPrincipal', {
                principal,
                query: { mode: 'list' },
            }),
            domainService.request('terminal.queryForPrincipal', {
                principal,
                query: { mode: 'list' },
            }),
        ]);
        const grantedProjectIds =
            principal.kind === 'paired-device' ? new Set(principal.projectIds) : undefined;
        const sourcesOf = (provider: AgentProvider) =>
            throughputSources({
                provider,
                sessions: sessions.sessions,
                terminals: terminals.terminals,
                ...(grantedProjectIds && { grantedProjectIds }),
            });
        const fixed = await Promise.all(
            MOBILE_AGENT_USAGE_PROVIDERS.map(async (provider) => {
                const sources = sourcesOf(provider);
                const newest = sources.at(0);
                const [throughput] = await Promise.all([
                    readThroughput(domainService, sources),
                    // Read for its side effect only: it asks a running Claude Code Chat to refresh the plan reading.
                    newest &&
                        orNull(
                            domainService.request('terminal.agentUsage', {
                                terminalId: newest.terminalId,
                            }),
                        ),
                ]);
                return { provider, throughput };
            }),
        );
        const limits = (await orNull(domainService.request('usage.limits', {}))) ?? [];
        return {
            providers: await Promise.all(
                mobileAgentUsageProviders(limits).map(async (provider) => {
                    const limit = limits.find((reading) => reading.provider === provider);
                    const throughput = fixed.find(
                        (entry) => entry.provider === provider,
                    )?.throughput;
                    const serviceStatus = await orNull(readServiceStatus(provider));
                    return {
                        provider,
                        ...(limit && { limit }),
                        ...(throughput && { throughput }),
                        ...(serviceStatus && { serviceStatus: mobileServiceStatus(serviceStatus) }),
                    };
                }),
            ),
        };
    };
}
