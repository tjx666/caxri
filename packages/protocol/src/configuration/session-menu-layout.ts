/**
 * Every top-level slot of the Session row's right-click menu. A slot is one position, not one label: paired actions
 * share it (Pin/Unpin, Hand Over/Take Back, Detach/Resume Agent, Open as Terminal/Chat), and a conditional slot such as
 * Mark as Done renders only where it applies.
 */
export const sessionMenuItemIds = [
    'markAsDone',
    'archive',
    'pin',
    'detachAgent',
    'switchSurface',
    'restartAgent',
    'reopenConversation',
    'turnOffAlwaysAllow',
    'forkSession',
    'continueInAgent',
    'handOverToBot',
    'openInNewWindow',
    'openProjectInEditor',
    'goToCreatingSession',
    'openPullRequest',
    'copy',
    'rename',
    'renameWithAi',
    'deleteSession',
] as const;

export type SessionMenuItemId = (typeof sessionMenuItemIds)[number];

export const SESSION_MENU_SEPARATOR = 'separator';

export type SessionMenuLayoutEntry = SessionMenuItemId | typeof SESSION_MENU_SEPARATOR;

/**
 * A customized `primarySidebar.sessionMenu`. Hidden items keep their place in `order`, so showing one again puts it
 * back where the user left it.
 */
export interface SessionMenuLayout {
    order: SessionMenuLayoutEntry[];
    hidden: SessionMenuItemId[];
}

/**
 * Generous bound on the stored arrays: every item plus a separator between each pair.
 */
export const MAX_SESSION_MENU_LAYOUT_ENTRIES = sessionMenuItemIds.length * 2;

/**
 * The built-in layout, ordered by how often each action is used: the actions that close out a Session first, the Agent
 * actions next, and Rename (usually reached by double-click, Enter, or F2) low, with the destructive Delete alone at
 * the end. `primarySidebar.sessionMenu` stays `null` until the user customizes it, so a newer Caxri can move this order
 * without a stored copy freezing the old one.
 */
export const defaultSessionMenuLayout: SessionMenuLayout = {
    order: [
        'markAsDone',
        'archive',
        'pin',
        SESSION_MENU_SEPARATOR,
        'detachAgent',
        'switchSurface',
        'restartAgent',
        'reopenConversation',
        'turnOffAlwaysAllow',
        SESSION_MENU_SEPARATOR,
        'forkSession',
        'continueInAgent',
        'handOverToBot',
        SESSION_MENU_SEPARATOR,
        'openInNewWindow',
        'openProjectInEditor',
        'goToCreatingSession',
        'openPullRequest',
        'copy',
        SESSION_MENU_SEPARATOR,
        'rename',
        'renameWithAi',
        SESSION_MENU_SEPARATOR,
        'deleteSession',
    ],
    hidden: [],
};

const knownItemIds: ReadonlySet<string> = new Set(sessionMenuItemIds);

function isSessionMenuItemId(value: string): value is SessionMenuItemId {
    return knownItemIds.has(value);
}

/**
 * Canonicalizes a stored or edited layout: drops unknown and repeated ids, collapses separators that would render at an
 * edge or next to another one, and appends every item the layout does not mention (one a newer Caxri added after the
 * user customized) at the end, so no action silently disappears. `null` resolves to the built-in layout.
 */
export function normalizeSessionMenuLayout(
    layout: { order: readonly string[]; hidden: readonly string[] } | null | undefined,
): SessionMenuLayout {
    if (!layout) return structuredClone(defaultSessionMenuLayout);
    const order: SessionMenuLayoutEntry[] = [];
    const seen = new Set<SessionMenuItemId>();
    for (const entry of layout.order) {
        if (entry === SESSION_MENU_SEPARATOR) {
            if (order.length > 0 && order.at(-1) !== SESSION_MENU_SEPARATOR) order.push(entry);
            continue;
        }
        if (!isSessionMenuItemId(entry) || seen.has(entry)) continue;
        seen.add(entry);
        order.push(entry);
    }
    if (order.at(-1) === SESSION_MENU_SEPARATOR) order.pop();
    const missing = sessionMenuItemIds.filter((id) => !seen.has(id));
    if (missing.length > 0) {
        if (order.length > 0) order.push(SESSION_MENU_SEPARATOR);
        order.push(...missing);
    }
    const hidden = sessionMenuItemIds.filter((id) => layout.hidden.includes(id));
    return { order, hidden };
}
