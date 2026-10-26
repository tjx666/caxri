import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

/**
 * One row of the `@` Sessions group: a Session whose Agent conversation can be cited.
 */
export interface SessionReferenceCandidate {
    projectTitle: string | undefined;
    sessionId: string;
    title: string;
}

const MAX_SESSION_REFERENCE_CANDIDATES = 20;

/**
 * How well `title` matches every query word: 0 for a title that starts with the query, 1 when each word starts a word
 * of the title, 2 for a plain substring match, `undefined` when some word is missing.
 */
function titleMatchTier(title: string, query: string): number | undefined {
    const normalizedTitle = title.toLowerCase();
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (words.length === 0) return 0;
    if (words.some((word) => !normalizedTitle.includes(word))) return undefined;
    if (normalizedTitle.startsWith(words.join(' '))) return 0;
    const titleWords = normalizedTitle.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return words.every((word) => titleWords.some((titleWord) => titleWord.startsWith(word)))
        ? 1
        : 2;
}

/**
 * The Sessions an `@` can cite, searched by title: every unarchived Session with a Primary Agent except the one doing
 * the citing. An empty query lists the most recently opened first, which is the Session a user most often means.
 */
export function searchSessionReferences(
    sessions: readonly SessionRecord[] | undefined,
    projects: readonly ProjectRecord[] | undefined,
    currentSessionId: string | undefined,
    query: string,
): SessionReferenceCandidate[] {
    const projectTitles = new Map(projects?.map((project) => [project.id, project.displayTitle]));
    return (sessions ?? [])
        .flatMap((session) => {
            if (
                session.id === currentSessionId ||
                session.archivedAt !== undefined ||
                !session.primaryAgentTerminalId
            )
                return [];
            const tier = titleMatchTier(session.displayTitle, query.trim());
            return tier === undefined ? [] : [{ session, tier }];
        })
        .toSorted(
            (left, right) =>
                left.tier - right.tier ||
                right.session.lastOpenedAt - left.session.lastOpenedAt ||
                left.session.id.localeCompare(right.session.id),
        )
        .slice(0, MAX_SESSION_REFERENCE_CANDIDATES)
        .map(({ session }) => ({
            projectTitle: projectTitles.get(session.projectId),
            sessionId: session.id,
            title: session.displayTitle,
        }));
}

/**
 * The Project of each Session this window cited, by its reference file, so a Session chip's tooltip can name it. The
 * reference text carries only the title; a chip restored after a restart names only that.
 */
const citedProjects = new Map<string, string>();

export function rememberSessionReferenceProject(
    path: string,
    projectTitle: string | undefined,
): void {
    if (projectTitle) citedProjects.set(path, projectTitle);
}

/**
 * The Project of the Session whose reference file is `path`, when this window cited it.
 */
export function sessionReferenceProjectTitle(path: string): string | undefined {
    return citedProjects.get(path);
}

/**
 * The Session title being searched when a picker's query starts with `@`, the same prefix that cites a Session in the
 * Chat composer; `undefined` for any other query.
 */
export function sessionReferenceQuery(search: string): string | undefined {
    const trimmed = search.trimStart();
    return trimmed.startsWith('@') ? trimmed.slice(1) : undefined;
}
