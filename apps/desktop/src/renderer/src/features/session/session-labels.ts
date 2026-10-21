import { DEFAULT_SESSION_TITLE } from '@caxri/protocol';

/**
 * Everything the label rule reads about one Session, flattened to primitives so the rule stays pure and the store
 * selector that feeds it can be memoized on a few record references.
 */
export interface SessionLabelInput {
    /**
     * Agent kind in words ("Claude Code", "Codex", "Shell"), used to tell same-titled Sessions apart.
     */
    agentLabel: string;
    /**
     * Creation time; orders the per-Project ordinal so a number is never reassigned when another Session closes.
     */
    createdAt: number;
    /**
     * The stored title. The stored placeholder (`DEFAULT_SESSION_TITLE`) means the Session is unnamed.
     */
    displayTitle: string;
    id: string;
    projectId: string;
    projectTitle: string;
    /**
     * Short snippet of the first prompt, when a surface has one. Names an unnamed Session before its title lands.
     */
    promptSnippet?: string;
    /**
     * False for a Session outside the surface being labeled (an archived one): it never causes a collision, but it
     * still counts when ordinals are assigned so that archiving it does not renumber its siblings.
     */
    visible?: boolean;
    /**
     * Title of the linked worktree Project the Session works in, when it does not work in its own Project root.
     */
    workingLocation?: string;
}

/**
 * The result for one Session: the title to show and, only when another visible Session carries the same title, a muted
 * suffix that tells them apart.
 */
export interface SessionLabel {
    suffix?: string;
    title: string;
}

/**
 * Longest first-prompt snippet used as a title.
 */
const SESSION_LABEL_SNIPPET_LENGTH = 24;

/**
 * The title chain for one Session: its stored title (the user's rename or the Agent's own), then a snippet of the first
 * prompt, then `Project · worktree`, then the translated placeholder. One rule for every surface, so the strip and the
 * sidebar never name a Session differently.
 */
export function sessionLabelTitle(input: SessionLabelInput, untitledLabel: string): string {
    const stored = input.displayTitle.trim();
    if (stored !== '' && stored !== DEFAULT_SESSION_TITLE) return input.displayTitle;
    const snippet = input.promptSnippet?.trim().replaceAll(/\s+/g, ' ');
    if (snippet) {
        return snippet.length > SESSION_LABEL_SNIPPET_LENGTH
            ? `${snippet.slice(0, SESSION_LABEL_SNIPPET_LENGTH - 1).trimEnd()}…`
            : snippet;
    }
    if (input.workingLocation) return `${input.projectTitle} · ${input.workingLocation}`;
    return untitledLabel;
}

function collisionKey(title: string): string {
    return title.trim().toLowerCase();
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): T[][] {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
    }
    return Array.from(groups.values());
}

interface Titled {
    input: SessionLabelInput;
    title: string;
}

function byCreation(left: Titled, right: Titled): number {
    return (
        left.input.createdAt - right.input.createdAt || left.input.id.localeCompare(right.input.id)
    );
}

/**
 * Rank of each Session among every Session of the same Project and title, in creation order, 1-based.
 */
function ordinals(all: readonly Titled[]): Map<string, number> {
    const rank = new Map<string, number>();
    const groups = groupBy(all, ({ input, title }) => `${input.projectId}\0${collisionKey(title)}`);
    for (const group of groups) {
        const sorted = group.toSorted(byCreation);
        for (const [index, item] of sorted.entries()) rank.set(item.input.id, index + 1);
    }
    return rank;
}

/**
 * Suffixes for Sessions of one Project that share a title (the Project part, when it is needed, is prepended by the
 * caller): the Agent kind and worktree where those differ, a creation-order ordinal where they do not.
 */
function projectSuffixes(
    group: readonly Titled[],
    projectPart: string | undefined,
    rank: ReadonlyMap<string, number>,
): Map<string, string> {
    const suffixes = new Map<string, string>();
    const join = (rest: string): string => [projectPart, rest].filter(Boolean).join(' · ');
    const byAgent = groupBy(
        group,
        ({ input }) => `${input.agentLabel}\0${input.workingLocation ?? ''}`,
    );
    for (const agentGroup of byAgent) {
        for (const { input } of agentGroup) {
            const place = [input.agentLabel, input.workingLocation].filter(Boolean).join(' · ');
            const rest = agentGroup.length > 1 ? `#${rank.get(input.id) ?? 1}` : place;
            suffixes.set(input.id, join(group.length > 1 ? rest : ''));
        }
    }
    return suffixes;
}

/**
 * Labels a set of Sessions. A suffix appears only where two visible Sessions share a title, and it escalates only as
 * far as needed to separate them:
 *
 * 1. The Project name, when the colliding Sessions belong to different Projects;
 * 2. Else the Agent kind and worktree, when those differ;
 * 3. Else a per-Project ordinal (`#2`) assigned by creation order among every Session of that Project with that title,
 *    visible or not, so it never renumbers when a sibling closes, is archived, or the strip is reordered.
 *
 * The tiers compose: Sessions in different Projects get the Project, and within one Project the next tier applies only
 * to the Sessions that still collide.
 */
export function sessionLabels(
    inputs: readonly SessionLabelInput[],
    untitledLabel: string,
): Map<string, SessionLabel> {
    const all: Titled[] = inputs.map((input) => ({
        input,
        title: sessionLabelTitle(input, untitledLabel),
    }));
    const result = new Map<string, SessionLabel>();
    for (const { input, title } of all) result.set(input.id, { title });
    const rank = ordinals(all);
    const visible = all.filter(({ input }) => input.visible !== false);
    const collisions = groupBy(visible, ({ title }) => collisionKey(title)).filter(
        (group) => group.length > 1,
    );
    for (const sameTitle of collisions) {
        const isSpansProjects = new Set(sameTitle.map(({ input }) => input.projectId)).size > 1;
        const projectGroups = isSpansProjects
            ? groupBy(sameTitle, ({ input }) => input.projectId)
            : [sameTitle];
        for (const projectGroup of projectGroups) {
            const projectPart = isSpansProjects ? projectGroup[0]?.input.projectTitle : undefined;
            const suffixes = projectSuffixes(projectGroup, projectPart, rank);
            for (const { input, title } of projectGroup)
                result.set(input.id, { title, suffix: suffixes.get(input.id) });
        }
    }
    return result;
}
