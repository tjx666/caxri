import type { AppSettings, ProjectRecord, SessionRecord } from '@caxri/protocol';

/**
 * How a Project's disclosure reached its current state.
 *
 * - `automatic`: the idle auto-collapse policy closed it. Only this value may be revised by the machine.
 * - `user-collapsed` / `user-expanded`: the user said so by hand, with the pointer or the keyboard.
 *
 * Both halves of the user's decision are recorded, not just the collapse. Storing an expansion as "no entry" makes a
 * Project the user deliberately opened indistinguishable from one they never had an opinion about, so the next
 * auto-collapse pass closes it again, and because the record is persisted while the in-memory override was not, the
 * machine's decision outlived the user's across a reload.
 */
type ProjectDisclosure = 'automatic' | 'user-collapsed' | 'user-expanded';
export type ProjectCollapseState = Partial<Record<string, ProjectDisclosure>>;

const PROJECT_DISCLOSURES: ReadonlySet<unknown> = new Set<ProjectDisclosure>([
    'automatic',
    'user-collapsed',
    'user-expanded',
]);

function isProjectDisclosure(value: unknown): value is ProjectDisclosure {
    return PROJECT_DISCLOSURES.has(value);
}

const AUTO_COLLAPSE_THRESHOLDS: Record<
    AppSettings['primarySidebar.autoCollapseProjects'],
    number | undefined
> = {
    'off': undefined,
    '30m': 30 * 60 * 1000,
    '2h': 2 * 60 * 60 * 1000,
};

const MAX_PERSISTED_PROJECTS = 1000;
const MAX_PROJECT_ID_LENGTH = 256;

export function autoCollapseThresholdMs(
    setting: AppSettings['primarySidebar.autoCollapseProjects'],
): number | undefined {
    return AUTO_COLLAPSE_THRESHOLDS[setting];
}

export function parseProjectCollapseState(source: string | null): ProjectCollapseState {
    if (!source) return {};
    try {
        const parsed: unknown = JSON.parse(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const state: ProjectCollapseState = {};
        for (const [projectId, disclosure] of Object.entries(
            parsed as Record<string, unknown>,
        ).slice(0, MAX_PERSISTED_PROJECTS)) {
            if (isProjectDisclosure(disclosure) && projectId.length <= MAX_PROJECT_ID_LENGTH)
                state[projectId] = disclosure;
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

/**
 * Whether a Project renders closed right now, whoever closed it.
 */
export function isProjectCollapsed(
    collapsedProjects: Readonly<ProjectCollapseState>,
    projectId: string,
): boolean {
    const disclosure = collapsedProjects[projectId];
    return disclosure === 'automatic' || disclosure === 'user-collapsed';
}

/**
 * The state after the user flips one Project's disclosure. Both directions record an explicit decision, which is what
 * {@link projectCollapseAfterAutoPass} then refuses to overrule.
 */
export function projectCollapseAfterToggle(
    collapsedProjects: Readonly<ProjectCollapseState>,
    projectId: string,
): ProjectCollapseState {
    return {
        ...collapsedProjects,
        [projectId]: isProjectCollapsed(collapsedProjects, projectId)
            ? 'user-expanded'
            : 'user-collapsed',
    };
}

/**
 * The state after a Project is opened for a reason other than the user clicking its row: revealing a Session a keyboard
 * command is about to act on, for instance. Recorded as `user-expanded` rather than simply dropped, because a dropped
 * entry reads as "no opinion" and the next idle auto-collapse pass would close the Project again while the user is
 * still working inside it. Returns the input untouched when the Project is already open, so a caller can hand the
 * result straight to a state setter without forcing a render.
 */
export function projectCollapseAfterReveal(
    collapsedProjects: Readonly<ProjectCollapseState>,
    projectId: string,
): Readonly<ProjectCollapseState> {
    if (!isProjectCollapsed(collapsedProjects, projectId)) return collapsedProjects;
    return { ...collapsedProjects, [projectId]: 'user-expanded' };
}

interface ProjectCollapseReconciliation {
    collapsedProjects: Readonly<ProjectCollapseState>;
    projects: readonly ProjectRecord[] | undefined;
    selectedSessionId: string | undefined;
    sessions: readonly SessionRecord[];
}

/**
 * The disclosure the sidebar renders right now: stored decisions filtered against the live Project catalog. An
 * automatic collapse yields as soon as its Project becomes active, running, or unread; a decision the user made by hand
 * is never revised here, in either direction.
 */
export function reconcileProjectCollapse(
    input: ProjectCollapseReconciliation,
): ProjectCollapseState {
    /**
     * The PrimarySidebar mounts before `app.bootstrap` resolves. Treating that loading state as an authoritative empty
     * catalog would erase persisted disclosure before the Projects arrive.
     */
    if (!input.projects) return { ...input.collapsedProjects };
    const projectIds = new Set(input.projects.map((project) => project.id));
    const protectedIds = protectedProjectIds(input.sessions, input.selectedSessionId);
    const next: ProjectCollapseState = {};
    for (const [projectId, disclosure] of Object.entries(input.collapsedProjects)) {
        if (!projectIds.has(projectId)) continue;
        if (disclosure === 'automatic' && protectedIds.has(projectId)) continue;
        next[projectId] = disclosure;
    }
    return next;
}

interface ProjectAutoCollapseInput extends ProjectCollapseReconciliation {
    autoCollapseThresholdMs?: number;
    now: number;
}

/**
 * One idle auto-collapse pass on top of {@link reconcileProjectCollapse}. It closes only Projects that are stale,
 * unprotected, and carry no decision of the user's: an entry of either `user-` kind survives the reconciliation and
 * therefore excludes its Project here, in this Renderer and every later one.
 */
export function projectCollapseAfterAutoPass(
    input: ProjectAutoCollapseInput,
): ProjectCollapseState {
    const next = reconcileProjectCollapse(input);
    if (!input.projects || input.autoCollapseThresholdMs === undefined) return next;
    const cutoff = input.now - input.autoCollapseThresholdMs;
    const protectedIds = protectedProjectIds(input.sessions, input.selectedSessionId);
    for (const project of input.projects) {
        if (
            project.lastOpenedAt <= cutoff &&
            !protectedIds.has(project.id) &&
            next[project.id] === undefined
        )
            next[project.id] = 'automatic';
    }
    return next;
}
