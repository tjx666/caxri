/**
 * Transient UI state that belongs to one Session, keyed by Session ID. The wide layout keeps one detail component
 * mounted while the selection changes, so plain `useState` would show Session A's "Opening..." or failure notice under
 * Session B. Each Session reads only its own entry, and returning to A shows what happened there.
 */
export type SessionScoped<T> = Readonly<Record<string, T>>;

/**
 * The entry for `sessionId`, or `idle` when that Session has none.
 */
export const readSessionScoped = <T>(states: SessionScoped<T>, sessionId: string, idle: T): T =>
    states[sessionId] ?? idle;

/**
 * A copy of `states` with `patch` merged into `sessionId`'s entry, leaving every other Session untouched.
 */
export const patchSessionScoped = <T extends object>(
    states: SessionScoped<T>,
    sessionId: string,
    idle: T,
    patch: Partial<T>,
): SessionScoped<T> => ({ ...states, [sessionId]: { ...(states[sessionId] ?? idle), ...patch } });
