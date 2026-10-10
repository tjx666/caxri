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

import type { AgentSessionUsageRow, PullRequestOutcomeRow } from '../db';
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

export interface UsageLedgerEntry {
    row: AgentSessionUsageRow;
    record?: UsageRecord;
}

export interface UsageReportInput {
    params: UsageReportParameters;
    now: number;
    entries: readonly UsageLedgerEntry[];
    sessions: readonly SessionRecord[];
    projects: readonly ProjectRecord[];
    pullRequests: readonly PullRequestOutcomeRow[];
    priceOf: ModelPriceLookup;
    pricing: { source: PricingSource; updatedAt?: number };
}

/**
 * Maps epoch milliseconds to the Client's local calendar date and hour. Formatting is the expensive part, and usage is
 * bucketed by hour, so results are memoized per hour.
 */
export class LocalClock {
    private readonly format: Intl.DateTimeFormat;
    private readonly hours = new Map<number, { date: string; hour: number }>();

    constructor(timeZone: string) {
        try {
            this.format = new Intl.DateTimeFormat('en-CA', {
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
    const entries = input.entries.filter(
        ({ row }) => params.provider === undefined || row.provider === params.provider,
    );

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

    const topProjectOf = (row: AgentSessionUsageRow) => {
        const projectId = sessionsById.get(row.sessionId)?.projectId ?? row.projectId;
        const project = projectsById.get(projectId);
        const owner = project?.ownerProjectId
            ? projectsById.get(project.ownerProjectId)
            : undefined;
        return { projectId: (owner ?? project)?.id ?? projectId, project: owner ?? project };
    };
    const projectFor = (row: AgentSessionUsageRow): ProjectAccumulator => {
        const { projectId, project } = topProjectOf(row);
        let accumulator = projects.get(projectId);
        if (!accumulator) {
            accumulator = {
                projectId,
                title: project?.displayTitle ?? REMOVED_PROJECT_TITLE,
                isRemoved: project === undefined,
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
    const sessionFor = (row: AgentSessionUsageRow): SessionAccumulator => {
        let accumulator = sessions.get(row.sessionId);
        if (!accumulator) {
            const session = sessionsById.get(row.sessionId);
            accumulator = {
                sessionId: row.sessionId,
                title: session?.displayTitle ?? DELETED_SESSION_TITLE,
                projectTitle: projectFor(row).title,
                isArchived: session?.archivedAt !== undefined,
                isDeleted: session === undefined,
                providers: new Set(),
                costUsd: 0,
                tokens: 0,
                activeMs: 0,
                lastActivityAt: 0,
                pullRequestsMerged: 0,
            };
            sessions.set(row.sessionId, accumulator);
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
    const foldBucket = (row: AgentSessionUsageRow, bucket: PricedUsageBucket) => {
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
        const provider = providerFor(row.provider);
        provider.costUsd += cost;
        addToBreakdown(provider.tokens, tokens);
        provider.sessions.add(row.sessionId);
        const modelKey = `${row.provider}:${model}`;
        const modelRow = models.get(modelKey) ?? {
            model,
            provider: row.provider,
            costUsd: 0,
            tokens: emptyTokenBreakdown(),
            isPriced: bucket.isPriced,
        };
        modelRow.costUsd += cost;
        addToBreakdown(modelRow.tokens, tokens);
        models.set(modelKey, modelRow);
        const project = projectFor(row);
        project.costUsd += cost;
        project.tokens += total;
        project.sessions.add(row.sessionId);
        const session = sessionFor(row);
        session.costUsd += cost;
        session.tokens += total;
        session.providers.add(row.provider);
        session.lastActivityAt = Math.max(session.lastActivityAt, at);
    };
    const foldActivity = (row: AgentSessionUsageRow, hour: number, activeMs: number) => {
        const local = localAt(hour * 1000);
        if (local.date >= activityStart) dayFor(local.date).activeMs += activeMs;
        if (!isInRange(local.date)) return;
        totals.activeMs += activeMs;
        providerFor(row.provider).activeMs += activeMs;
        projectFor(row).activeMs += activeMs;
        const session = sessionFor(row);
        session.activeMs += activeMs;
        session.providers.add(row.provider);
        session.lastActivityAt = Math.max(session.lastActivityAt, hour * 1000);
    };

    for (const { row, record } of entries) {
        if (!record) continue;
        if (record.rateLimits) {
            const previous = limits.get(row.provider);
            if (!previous || record.rateLimits.observedAt > previous.observedAt)
                limits.set(row.provider, { provider: row.provider, ...record.rateLimits });
        }
        for (const bucket of pricedUsageBuckets(record, input.priceOf)) foldBucket(row, bucket);
        for (const [hour, activeMs] of record.activity) foldActivity(row, hour, activeMs);
    }

    const pullRequestOwners = new Map<string, AgentSessionUsageRow>();
    for (const { row, record } of entries) {
        const urls = record?.pullRequests ?? [];
        for (const url of urls) if (!pullRequestOwners.has(url)) pullRequestOwners.set(url, row);
    }
    let pullRequestsCreated = 0;
    let pullRequestsMerged = 0;
    let linesAdded = 0;
    let linesDeleted = 0;
    let pendingPullRequests = 0;
    const merged: UsagePullRequestRow[] = [];
    for (const [url, row] of pullRequestOwners) {
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
        projectFor(row).pullRequestsMerged += 1;
        sessionFor(row).pullRequestsMerged += 1;
        const identity = parsePullRequestUrl(url);
        if (identity)
            merged.push({
                url,
                number: identity.number,
                repository: `${identity.owner}/${identity.repo}`,
                title: outcome.title,
                state: outcome.state,
                mergedAt: outcome.mergedAt,
                sessionId: row.sessionId,
                additions: outcome.additions,
                deletions: outcome.deletions,
            });
    }

    const providerSessionIds = new Set(entries.map(({ row }) => row.sessionId));
    const isCountedSession = (session: SessionRecord) =>
        params.provider === undefined || providerSessionIds.has(session.id);
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
        today,
        ...(rangeStart && { rangeStart }),
        totals: {
            ...totals,
            activeMs: Math.round(totals.activeMs),
            sessionsCreated,
            sessionsArchived,
            sessionsWithUsage: sessions
                .values()
                .filter((session) => session.tokens > 0)
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
            pendingPullRequests,
            unpricedModels: [...unpriced]
                .toSorted((a, b) => a.localeCompare(b))
                .slice(0, MAX_UNPRICED_MODELS),
        },
    };
}
