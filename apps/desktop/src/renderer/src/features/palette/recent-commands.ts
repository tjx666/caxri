import type { CommandId } from '@caxri/protocol';

import { createSharedLocalState } from '../../lib/local-storage';

const STORAGE_KEY = 'caxri.palette.recent-commands';

/**
 * How many commands the palette's Recently Used group keeps (VS Code's command palette lists a "recently used" group
 * first, then the rest): enough to cover a working set, few enough that the group never pushes the rest of the list off
 * screen.
 */
export const RECENT_COMMANDS_LIMIT = 5;

/**
 * Bulk or disruptive commands that never join the Recently Used group. With an empty query the first row is
 * pre-highlighted, so a recent copy of one of these would let a bare Enter interrupt, compact, or restore every Session
 * at once. They stay reachable by typing their name.
 */
export const NON_RECENT_COMMAND_IDS: ReadonlySet<string> = new Set<CommandId>([
    'session.compactWarm',
    'session.enterAirplaneMode',
    'session.interruptAndCompact',
    'session.restoreQuitStopped',
]);

/**
 * Moves `commandId` to the front of the list and keeps the newest {@link RECENT_COMMANDS_LIMIT}, so running a command
 * again promotes it instead of listing it twice. A command in {@link NON_RECENT_COMMAND_IDS} is not recorded.
 */
export function pushRecentCommand(recent: readonly string[], commandId: string): string[] {
    if (NON_RECENT_COMMAND_IDS.has(commandId)) return [...recent];
    return [commandId, ...recent.filter((id) => id !== commandId)].slice(0, RECENT_COMMANDS_LIMIT);
}

/**
 * Validates the persisted value. Anything that is not a list of strings (a corrupt or hand-edited entry) is treated as
 * empty rather than trusted.
 */
export function parseRecentCommands(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === 'string').slice(0, RECENT_COMMANDS_LIMIT);
}

/**
 * The recent commands the palette can show right now, newest first. A command whose condition no longer holds (or that
 * a newer build removed) drops out here instead of being forgotten, so it returns once it applies again.
 */
export function visibleRecentCommands(
    recent: readonly string[],
    visibleCommandIds: ReadonlySet<string>,
): string[] {
    return recent.filter((id) => visibleCommandIds.has(id) && !NON_RECENT_COMMAND_IDS.has(id));
}

/**
 * Shared by every window of the profile (docs/client-local-data.md). The list is re-read at each record, never cached,
 * so a command another window ran meanwhile is kept; the palette reads it when it opens, so it needs no subscription.
 */
const sharedRecent = createSharedLocalState(STORAGE_KEY, parseRecentCommands);

export function loadRecentCommands(): string[] {
    return sharedRecent.read();
}

/**
 * Records a command the user ran from the palette. Device-local presentation state, so it stays in the Renderer.
 */
export function recordRecentCommand(commandId: string): void {
    sharedRecent.write(pushRecentCommand(loadRecentCommands(), commandId));
}
