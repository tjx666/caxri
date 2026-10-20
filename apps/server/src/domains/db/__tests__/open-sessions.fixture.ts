import type { CaxriDatabase } from '../repository';

/**
 * Session creation options that open the new Session in the `main` window, the way Desktop Main's default window does.
 */
export const inMain = { windowKey: 'main' } as const;

/**
 * The active Open Session of the `main` window, which replaced the global "selected Session" cell.
 */
export const activeIn = (database: CaxriDatabase): string | null =>
    database.windowOpenSessions.get('main').activeSessionId;
