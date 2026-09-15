const state = { created: 0 };

/**
 * Counts the Workers Caxri has handed to Monaco in this window. Kept apart from `./monaco.ts` so diagnostics can read
 * the number without importing the editor bundle, and so its unit tests stay free of Monaco's global side effects.
 */
export function recordEditorWorkerCreated(): void {
    state.created += 1;
}

/**
 * Per-lifetime aggregate reported alongside a diff stall: a Worker count that never grows says Monaco stopped asking,
 * while one that keeps growing says Monaco kept asking and never got an answer.
 */
export function editorWorkersCreated(): number {
    return state.created;
}
