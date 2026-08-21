import type { AppSettings, ProjectRecord, SessionRecord } from '@shared/types';

type ProjectCollapseReason = 'automatic' | 'manual';
export type ProjectCollapseState = Partial<Record<string, ProjectCollapseReason>>;

const AUTO_COLLAPSE_THRESHOLDS: Record<
    AppSettings['sidebar.autoCollapseProjects'],
    number | undefined
> = {
    'off': undefined,
    '30m': 30 * 60 * 1000,
    '2h': 2 * 60 * 60 * 1000,
};

const MAX_PERSISTED_PROJECTS = 1000;
const MAX_PROJECT_ID_LENGTH = 256;

export function autoCollapseThresholdMs(
    setting: AppSettings['sidebar.autoCollapseProjects'],
): number | undefined {
    return AUTO_COLLAPSE_THRESHOLDS[setting];
}

export function parseProjectCollapseState(source: string | null): ProjectCollapseState {
    if (!source) return {};
    try {
        const parsed: unknown = JSON.parse(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const state: ProjectCollapseState = {};
        for (const [projectId, reason] of Object.entries(parsed as Record<string, unknown>).slice(
            0,
            MAX_PERSISTED_PROJECTS,
        )) {
            if (
                projectId.length <= MAX_PROJECT_ID_LENGTH &&
                (reason === 'automatic' || reason === 'manual')
            )
                state[projectId] = reason;
        }
        return state;
    } catch {
        return {};
    }
}

function protectedProjectIds(
    sessions: readonly SessionRecord[],
    selectedSessionId: string | undefined,
): Set<string> {
    const protectedIds = new Set<string>();
    for (const session of sessions) {
        if (
            session.id === selectedSessionId ||
            session.lastActivityState === 'running' ||
            session.hasUnread
        )
            protectedIds.add(session.projectId);
    }
    return protectedIds;
}

interface ProjectCollapsePolicyInput {
    autoCollapseThresholdMs?: number;
    collapsedProjects: Readonly<ProjectCollapseState>;
    manuallyExpandedProjectIds: ReadonlySet<string>;
    now: number;
    projects: readonly ProjectRecord[] | undefined;
    selectedSessionId: string | undefined;
    sessions: readonly SessionRecord[];
    shouldAutoCollapse: boolean;
}

/**
 * Reconciles persisted disclosure with live Project membership and protection. Manual collapse is never overridden;
 * automatic collapse is removed as soon as a Project becomes active, running, or unread.
 */
export function projectCollapseAfterPolicy(
    input: ProjectCollapsePolicyInput,
): ProjectCollapseState {
    /**
     * The Sidebar mounts before `app.bootstrap` resolves. Treating that loading state as an authoritative empty catalog
     * would erase persisted disclosure before the Projects arrive.
     */
    if (!input.projects) return { ...input.collapsedProjects };
    const projectIds = new Set(input.projects.map((project) => project.id));
    const protectedIds = protectedProjectIds(input.sessions, input.selectedSessionId);
    const next: ProjectCollapseState = {};
    for (const [projectId, reason] of Object.entries(input.collapsedProjects)) {
        if (!projectIds.has(projectId)) continue;
        if (reason === 'automatic' && protectedIds.has(projectId)) continue;
        next[projectId] = reason;
    }
    if (!input.shouldAutoCollapse || input.autoCollapseThresholdMs === undefined) return next;
    const cutoff = input.now - input.autoCollapseThresholdMs;
    for (const project of input.projects) {
        if (
            project.lastOpenedAt <= cutoff &&
            !protectedIds.has(project.id) &&
            !input.manuallyExpandedProjectIds.has(project.id) &&
            next[project.id] === undefined
        )
            next[project.id] = 'automatic';
    }
    return next;
}
