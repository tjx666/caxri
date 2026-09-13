/**
 * Reserve the marker column from the full active Project list, including Sessions outside the current reveal window, so
 * expanding the list never moves existing row content sideways.
 */
export function hasWorktreeSession(
    sessions: ReadonlyArray<{ id: string }>,
    worktreeProjects?: Readonly<Record<string, unknown>>,
): boolean {
    return sessions.some((session) => Boolean(worktreeProjects?.[session.id]));
}
