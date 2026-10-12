import type {
    AgentProvider,
    ProjectRecord,
    SessionRecord,
    UsageDay,
    UsageLimit,
    UsageProjectRow,
    UsagePullRequestRow,
    UsageReport,
    UsageReportParameters,
    UsageSessionRow,
    UsageTokenBreakdown,
} from '@caxri/protocol';
import { agentProviderIds, CaxriError, shiftLocalDate } from '@caxri/protocol';

import type { AgentSessionUsageRow, ExternalAgentUsageRow, PullRequestOutcomeRow } from '../db';
import type { PricingSource } from './pricing';
import { parsePullRequestUrl } from './pull-requests';
import type { UsageRecord } from './record';
import type { ModelPriceLookup, PricedUsageBucket } from './summary';
import { addToBreakdown, emptyTokenBreakdown, pricedUsageBuckets } from './summary';

/**
 * 53 full weeks, so the heatmap always has a complete leading column.
 */
const ACTIVITY_DAYS = 371;
const RANGE_DAYS: Record<UsageReportParameters['range'], number | undefined> = {
    '7d': 7,
    '30d': 30,
    '90d': 90,
    '365d': 365,
    'all': undefined,
};
const MAX_PROJECTS = 500;
const MAX_SESSIONS = 200;
const MAX_MODELS = 200;
const MAX_PULL_REQUESTS = 50;
const MAX_UNPRICED_MODELS = 50;
export const DELETED_SESSION_TITLE = 'Deleted Session';
const REMOVED_PROJECT_TITLE = 'Removed Project';
export const OUTSIDE_CAXRI_TITLE = 'Outside Caxri';
const OUTSIDE_CAXRI_PROJECT_ID = 'outside-caxri';
const UNKNOWN_FOLDER_TITLE = 'Unknown folder';

export interface UsageLedgerEntry {
    row: AgentSessionUsageRow;
    record?: UsageRecord;
}

/**
 * A transcript found outside the ledger. Several files of one reverted Codex thread share an Agent Session.
 */
export interface OutsideUsageEntry {
    row: ExternalAgentUsageRow;
    record?: UsageRecord;
}

/**
 * One transcript's usage with the owner it is attributed to: the Caxri Session that first hosted it, or (outside Caxri)
 * its Agent Session alone.
 */
type UsageContribution =
    | { kind: 'hosted'; provider: AgentProvider; row: AgentSessionUsageRow; record?: UsageRecord }
    | {
          kind: 'outside';
          provider: AgentProvider;
          row: ExternalAgentUsageRow;
          record?: UsageRecord;
      };

function ownerKey(contribution: UsageContribution): string {
    return contribution.kind === 'hosted'
        ? contribution.row.sessionId
        : `outside:${contribution.provider}:${contribution.row.agentSessionId}`;
}

function folderName(cwd: string | null): string {
    return cwd?.split('/').findLast(Boolean) ?? UNKNOWN_FOLDER_TITLE;
}

export interface UsageReportInput {
    params: UsageReportParameters;
    now: number;
    entries: readonly UsageLedgerEntry[];
    /**
     * Transcripts outside the ledger; read only for the `all` scope.
     */
    outside?: {
        entries: readonly OutsideUsageEntry[];
        pendingScans: number;
    };
    sessions: readonly SessionRecord[];
    projects: readonly ProjectRecord[];
    pullRequests: readonly PullRequestOutcomeRow[];
    priceOf: ModelPriceLookup;
    pricing: { source: PricingSource; updatedAt?: number };
    /**
     * Ledger rows the background scan has not read yet.
     */
    pendingScans?: number;
}

/**
 * One formatter per time zone, reused across reports; a Client sends the same zone on every poll.
 */
const localHourFormats = new Map<string, Intl.DateTimeFormat>();

function localHourFormat(timeZone: string): Intl.DateTimeFormat {
    const cached = localHourFormats.get(timeZone);
    if (cached) return cached;
    let format: Intl.DateTimeFormat;
    try {
        format = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            hourCycle: 'h23',
        });
    } catch {
        throw new CaxriError('VALIDATION', 'Unknown time zone');
    }
    // Only valid zones are cached, and there are a few hundred of them, so the map stays bounded.
    localHourFormats.set(timeZone, format);
    return format;
}

/**
 * Maps epoch milliseconds to the Client's local calendar date and hour. Formatting is the expensive part, and usage is
 * bucketed by hour, so results are memoized per hour.
 */
export class LocalClock {
    private readonly format: Intl.DateTimeFormat;
    private readonly hours = new Map<number, { date: string; hour: number }>();

    constructor(timeZone: string) {
        this.format = localHourFormat(timeZone);
    }

    at(epochMs: number): { date: string; hour: number } {
        const hourKey = Math.floor(epochMs / 3_600_000);
        const cached = this.hours.get(hourKey);
        if (cached) return cached;
        const parts = Object.fromEntries(
            this.format.formatToParts(epochMs).map((part) => [part.type, part.value]),
        );
        const local = {
            date: `${parts.year}-${parts.month}-${parts.day}`,
            hour: Number(parts.hour) % 24,
        };
        this.hours.set(hourKey, local);
        return local;
    }
}

interface ProjectAccumulator extends Omit<UsageProjectRow, 'sessions'> {
    sessions: Set<string>;
}

interface SessionAccumulator extends Omit<UsageSessionRow, 'providers'> {
    providers: Set<AgentProvider>;
}

interface ModelAccumulator {
    model: string;
    provider: AgentProvider;
    costUsd: number;
    tokens: UsageTokenBreakdown;
    isPriced: boolean;
}

/**
 * Pure aggregation of the usage ledger into the report the Usage page renders. Usage is attributed to the Session that
 * first hosted each Agent Session and grouped under the top-level Project that owns it, so a linked worktree's spend
 * counts toward its repository.
 */
export function buildUsageReport(input: UsageReportInput): UsageReport {
    const { params, now } = input;
    const clock = new LocalClock(params.timeZone);
    const today = clock.at(now).date;
    const rangeDays = RANGE_DAYS[params.range];
    const rangeStart = rangeDays === undefined ? undefined : shiftLocalDate(today, 1 - rangeDays);
    const activityStart = shiftLocalDate(today, 1 - ACTIVITY_DAYS);
    const last7Start = shiftLocalDate(today, -6);
    const last30Start = shiftLocalDate(today, -29);
    const isInRange = (date: string) => rangeStart === undefined || date >= rangeStart;

    const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
    const projectsById = new Map(input.projects.map((project) => [project.id, project]));
    const outcomesByUrl = new Map(input.pullRequests.map((outcome) => [outcome.url, outcome]));
    const isSelected = (provider: AgentProvider) =>
        params.provider === undefined || provider === params.provider;
    const isInSessionFilter = (sessionId: string) =>
        params.sessionId === undefined || sessionId === params.sessionId;
    const entries = input.entries.filter(
        ({ row }) => isSelected(row.provider) && isInSessionFilter(row.sessionId),
    );
    const hostedAgentSessions = new Set(
        input.entries.map(({ row }) => `${row.provider}:${row.agentSessionId}`),
    );
    // A conversation later resumed in a Caxri Session is counted once, from the ledger.
    // A Session filter names a Caxri Session, which no conversation run outside Caxri belongs to.
    const outsideEntries = (input.outside?.entries ?? []).filter(
        ({ row }) =>
            params.sessionId === undefined &&
            isSelected(row.provider) &&
            !hostedAgentSessions.has(`${row.provider}:${row.agentSessionId}`),
    );
    const contributions: UsageContribution[] = [
        ...entries.map(({ row, record }) => ({
            kind: 'hosted' as const,
            provider: row.provider,
            row,
            record,
        })),
        ...outsideEntries.map(({ row, record }) => ({
            kind: 'outside' as const,
            provider: row.provider,
            row,
            record,
        })),
    ];
    /**
     * Deepest root first, so a cwd inside a linked worktree Project matches it before its repository.
     */
    const projectsByDepth = input.projects.toSorted(
        (a, b) => b.rootPath.length - a.rootPath.length,
    );
    const projectContaining = (cwd: string | null) =>
        cwd
            ? projectsByDepth.find(
                  ({ rootPath }) =>
                      cwd === rootPath ||
                      cwd.startsWith(rootPath.endsWith('/') ? rootPath : `${rootPath}/`),
              )
            : undefined;

    const totals = {
        costUsd: 0,
        tokens: emptyTokenBreakdown(),
        cacheSavingsUsd: 0,
        activeMs: 0,
    };
    const windows = {
        today: { costUsd: 0, tokens: 0 },
        last7Days: { costUsd: 0, tokens: 0 },
        last30Days: { costUsd: 0, tokens: 0 },
    };
    const activity = new Map<string, UsageDay>();
    const hourOfDay = Array.from({ length: 24 }, () => 0);
    const providers = new Map<
        AgentProvider,
        { costUsd: number; tokens: UsageTokenBreakdown; sessions: Set<string>; activeMs: number }
    >();
    const models = new Map<string, ModelAccumulator>();
    const projects = new Map<string, ProjectAccumulator>();
    const sessions = new Map<string, SessionAccumulator>();
    const unpriced = new Set<string>();
    const limits = new Map<AgentProvider, UsageLimit>();

    const topProjectOf = (contribution: UsageContribution) => {
        let projectId: string;
        if (contribution.kind === 'hosted') {
            const { row } = contribution;
            projectId = sessionsById.get(row.sessionId)?.projectId ?? row.projectId;
        } else {
            const containing = projectContaining(contribution.row.cwd);
            if (!containing) return { projectId: OUTSIDE_CAXRI_PROJECT_ID, isOutside: true };
            projectId = containing.id;
        }
        const project = projectsById.get(projectId);
        const owner = project?.ownerProjectId
            ? projectsById.get(project.ownerProjectId)
            : undefined;
        return {
            projectId: (owner ?? project)?.id ?? projectId,
            project: owner ?? project,
            isOutside: false,
        };
    };
    const projectFor = (contribution: UsageContribution): ProjectAccumulator => {
        const { projectId, project, isOutside } = topProjectOf(contribution);
        let accumulator = projects.get(projectId);
        if (!accumulator) {
            accumulator = {
                projectId,
                title: isOutside
                    ? OUTSIDE_CAXRI_TITLE
                    : (project?.displayTitle ?? REMOVED_PROJECT_TITLE),
                isRemoved: !isOutside && project === undefined,
                isOutsideCaxri: isOutside,
                costUsd: 0,
                tokens: 0,
                sessions: new Set(),
                activeMs: 0,
                pullRequestsMerged: 0,
            };
            projects.set(projectId, accumulator);
        }
        return accumulator;
    };
    const sessionFor = (contribution: UsageContribution): SessionAccumulator => {
        const key = ownerKey(contribution);
        let accumulator = sessions.get(key);
        if (!accumulator) {
            const session =
                contribution.kind === 'hosted'
                    ? sessionsById.get(contribution.row.sessionId)
                    : undefined;
            const isOutside = contribution.kind === 'outside';
            accumulator = {
                sessionId: key,
                title: isOutside
                    ? folderName(contribution.row.cwd)
                    : (session?.displayTitle ?? DELETED_SESSION_TITLE),
                projectTitle: projectFor(contribution).title,
                isArchived: session?.archivedAt !== undefined,
                isDeleted: !isOutside && session === undefined,
                isOutsideCaxri: isOutside,
                providers: new Set(),
                costUsd: 0,
                tokens: 0,
                activeMs: 0,
                lastActivityAt: 0,
                pullRequestsMerged: 0,
            };
            sessions.set(key, accumulator);
        }
        return accumulator;
    };
    const providerFor = (provider: AgentProvider) => {
        let accumulator = providers.get(provider);
        if (!accumulator) {
            accumulator = {
                costUsd: 0,
                tokens: emptyTokenBreakdown(),
                sessions: new Set(),
                activeMs: 0,
            };
            providers.set(provider, accumulator);
        }
        return accumulator;
    };
    const dayFor = (date: string): UsageDay => {
        let day = activity.get(date);
        if (!day) {
            day = { date, tokens: 0, costUsd: 0, activeMs: 0 };
            activity.set(date, day);
        }
        return day;
    };

    const windowStarts = [
        [today, windows.today],
        [last7Start, windows.last7Days],
        [last30Start, windows.last30Days],
    ] as const;
    /**
     * Usage stamped after `today` (a transcript written on a clock-skewed machine) counts as today, so it neither
     * disappears nor adds a day past the activity window the protocol schema bounds.
     */
    const localAt = (epochMs: number) => {
        const local = clock.at(epochMs);
        return local.date > today ? { ...local, date: today } : local;
    };
    const foldBucket = (contribution: UsageContribution, bucket: PricedUsageBucket) => {
        const key = ownerKey(contribution);
        const { at, model, tokens, total, costUsd: cost } = bucket;
        if (!bucket.isPriced) unpriced.add(model);
        const local = localAt(at);
        if (local.date >= activityStart) {
            const day = dayFor(local.date);
            day.tokens += total;
            day.costUsd += cost;
        }
        for (const [start, window] of windowStarts)
            if (local.date >= start) {
                window.costUsd += cost;
                window.tokens += total;
            }
        if (!isInRange(local.date)) return;
        totals.costUsd += cost;
        addToBreakdown(totals.tokens, tokens);
        totals.cacheSavingsUsd += bucket.cacheSavingsUsd;
        hourOfDay[local.hour] += total;
        const provider = providerFor(contribution.provider);
        provider.costUsd += cost;
        addToBreakdown(provider.tokens, tokens);
        provider.sessions.add(key);
        const modelKey = `${contribution.provider}:${model}`;
        const modelRow = models.get(modelKey) ?? {
            model,
            provider: contribution.provider,
            costUsd: 0,
            tokens: emptyTokenBreakdown(),
            isPriced: bucket.isPriced,
        };
        modelRow.costUsd += cost;
        addToBreakdown(modelRow.tokens, tokens);
        models.set(modelKey, modelRow);
        const project = projectFor(contribution);
        project.costUsd += cost;
        project.tokens += total;
        project.sessions.add(key);
        const session = sessionFor(contribution);
        session.costUsd += cost;
        session.tokens += total;
        session.providers.add(contribution.provider);
        session.lastActivityAt = Math.max(session.lastActivityAt, at);
    };
    const foldActivity = (contribution: UsageContribution, hour: number, activeMs: number) => {
        const local = localAt(hour * 1000);
        if (local.date >= activityStart) dayFor(local.date).activeMs += activeMs;
        if (!isInRange(local.date)) return;
        totals.activeMs += activeMs;
        providerFor(contribution.provider).activeMs += activeMs;
        projectFor(contribution).activeMs += activeMs;
        const session = sessionFor(contribution);
        session.activeMs += activeMs;
        session.providers.add(contribution.provider);
        session.lastActivityAt = Math.max(session.lastActivityAt, hour * 1000);
    };

    for (const contribution of contributions) {
        const { provider, record } = contribution;
        if (!record) continue;
        if (record.rateLimits) {
            const previous = limits.get(provider);
            if (!previous || record.rateLimits.observedAt > previous.observedAt)
                limits.set(provider, { provider, ...record.rateLimits });
        }
        for (const bucket of pricedUsageBuckets(record, input.priceOf))
            foldBucket(contribution, bucket);
        for (const [hour, activeMs] of record.activity) foldActivity(contribution, hour, activeMs);
    }

    const pullRequestOwners = new Map<string, UsageContribution>();
    for (const contribution of contributions) {
        const urls = contribution.record?.pullRequests ?? [];
        for (const url of urls)
            if (!pullRequestOwners.has(url)) pullRequestOwners.set(url, contribution);
    }
    let pullRequestsCreated = 0;
    let pullRequestsMerged = 0;
    let linesAdded = 0;
    let linesDeleted = 0;
    let pendingPullRequests = 0;
    const merged: UsagePullRequestRow[] = [];
    for (const [url, owner] of pullRequestOwners) {
        const outcome = outcomesByUrl.get(url);
        if (!outcome) {
            pendingPullRequests += 1;
            continue;
        }
        if (outcome.state === 'missing') continue;
        if (outcome.createdAt !== null && isInRange(clock.at(outcome.createdAt).date))
            pullRequestsCreated += 1;
        if (
            outcome.state !== 'merged' ||
            outcome.mergedAt === null ||
            !isInRange(clock.at(outcome.mergedAt).date)
        )
            continue;
        pullRequestsMerged += 1;
        linesAdded += outcome.additions;
        linesDeleted += outcome.deletions;
        projectFor(owner).pullRequestsMerged += 1;
        sessionFor(owner).pullRequestsMerged += 1;
        const identity = parsePullRequestUrl(url);
        if (identity)
            merged.push({
                url,
                number: identity.number,
                repository: `${identity.owner}/${identity.repo}`,
                title: outcome.title,
                state: outcome.state,
                mergedAt: outcome.mergedAt,
                ...(owner.kind === 'hosted' && { sessionId: owner.row.sessionId }),
                additions: outcome.additions,
                deletions: outcome.deletions,
            });
    }

    const providerSessionIds = new Set(entries.map(({ row }) => row.sessionId));
    const isCountedSession = (session: SessionRecord) =>
        isInSessionFilter(session.id) &&
        (params.provider === undefined || providerSessionIds.has(session.id));
    let sessionsCreated = 0;
    let sessionsArchived = 0;
    for (const session of input.sessions) {
        if (!isCountedSession(session)) continue;
        if (isInRange(clock.at(session.createdAt).date)) sessionsCreated += 1;
        if (session.archivedAt !== undefined && isInRange(clock.at(session.archivedAt).date))
            sessionsArchived += 1;
    }

    return {
        generatedAt: now,
        timeZone: params.timeZone,
        range: params.range,
        ...(params.provider && { provider: params.provider }),
        ...(params.sessionId && { sessionId: params.sessionId }),
        scope: input.outside ? 'all' : 'caxri',
        today,
        ...(rangeStart && { rangeStart }),
        totals: {
            ...totals,
            activeMs: Math.round(totals.activeMs),
            sessionsCreated,
            sessionsArchived,
            sessionsWithUsage: sessions
                .values()
                .filter((session) => session.tokens > 0 && !session.isOutsideCaxri)
                .toArray().length,
            outsideSessionsWithUsage: sessions
                .values()
                .filter((session) => session.tokens > 0 && session.isOutsideCaxri)
                .toArray().length,
            pullRequestsCreated,
            pullRequestsMerged,
            linesAdded,
            linesDeleted,
        },
        windows,
        activity: activity
            .values()
            .toArray()
            .toSorted((a, b) => a.date.localeCompare(b.date)),
        hourOfDay,
        providers: agentProviderIds.flatMap((provider) => {
            const row = providers.get(provider);
            return row
                ? [
                      {
                          provider,
                          costUsd: row.costUsd,
                          tokens: row.tokens,
                          sessions: row.sessions.size,
                          activeMs: Math.round(row.activeMs),
                      },
                  ]
                : [];
        }),
        models: models
            .values()
            .toArray()
            .toSorted((a, b) => b.costUsd - a.costUsd || b.tokens.total - a.tokens.total)
            .slice(0, MAX_MODELS),
        projects: projects
            .values()
            .map((project) => ({
                ...project,
                sessions: project.sessions.size,
                activeMs: Math.round(project.activeMs),
            }))
            .filter((project) => project.tokens > 0 || project.pullRequestsMerged > 0)
            .toArray()
            .toSorted((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
            .slice(0, MAX_PROJECTS),
        sessions: sessions
            .values()
            .map((session) => ({
                ...session,
                providers: agentProviderIds.filter((provider) => session.providers.has(provider)),
                activeMs: Math.round(session.activeMs),
            }))
            .filter((session) => session.tokens > 0 || session.pullRequestsMerged > 0)
            .toArray()
            .toSorted((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
            .slice(0, MAX_SESSIONS),
        pullRequests: merged
            .toSorted((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))
            .slice(0, MAX_PULL_REQUESTS),
        limits: limits.values().toArray(),
        pricing: input.pricing,
        coverage: {
            agentSessions: entries.length,
            unavailable: entries.filter(({ record }) => !record).length,
            pendingScans: input.pendingScans ?? 0,
            pendingPullRequests,
            unpricedModels: [...unpriced]
                .toSorted((a, b) => a.localeCompare(b))
                .slice(0, MAX_UNPRICED_MODELS),
            ...(input.outside && {
                outsideCaxri: {
                    agentSessions: new Set(
                        outsideEntries.map(({ row }) => `${row.provider}:${row.agentSessionId}`),
                    ).size,
                    pendingScans: input.outside.pendingScans,
                },
            }),
        },
    };
}
