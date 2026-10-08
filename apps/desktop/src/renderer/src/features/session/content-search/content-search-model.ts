import type { ProjectRecord, SessionContentSearchResult, SessionRecord } from '@caxri/protocol';

export function contentSearchItems(
    result: SessionContentSearchResult | undefined,
    sessions: ReadonlyArray<
        Pick<SessionRecord, 'id' | 'displayTitle' | 'projectId' | 'archivedAt'>
    >,
    projects: ReadonlyArray<Pick<ProjectRecord, 'id' | 'displayTitle'>>,
) {
    const sessionById = new Map(sessions.map((session) => [session.id, session]));
    const projectById = new Map(projects.map((project) => [project.id, project]));
    return (result?.matches ?? []).flatMap((match) => {
        const session = sessionById.get(match.sessionId);
        if (!session) return [];
        return [
            {
                ...match,
                title: session.displayTitle,
                project: projectById.get(session.projectId)?.displayTitle ?? 'Unknown Project',
                isArchived: session.archivedAt !== undefined,
            },
        ];
    });
}

export function contentSearchCoverage(result: SessionContentSearchResult): string {
    const coverage = `Searched ${result.scanned} of ${result.total} Sessions`;
    if (!result.partial) return coverage;
    const unavailable =
        result.unavailable > 0 ? `; ${result.unavailable} without readable conversation data` : '';
    const limit =
        result.reason === 'budget'
            ? '; search limit reached: retry to search again'
            : result.reason === 'results'
              ? '; result limit reached: narrow your query'
              : result.unavailable === 0
                ? '; some conversation content was skipped or exceeded scan limits'
                : '';
    return `Partial results · ${coverage}${unavailable}${limit}`;
}
