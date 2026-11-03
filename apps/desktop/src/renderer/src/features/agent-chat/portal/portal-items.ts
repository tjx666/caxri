/**
 * What one Session's Portal holds: the beside-Chat tab paths it shows, in opening order, and the one on screen.
 * `activePath` is always one of `paths`; an empty `paths` means the Portal is closed.
 */
export interface PortalItems {
    paths: readonly string[];
    activePath?: string;
}

export const EMPTY_PORTAL_ITEMS: PortalItems = { paths: [] };

/**
 * Shows `path`, adding it after the others when it is not already open. Opening what is already open only selects it,
 * so a second click on a subagent row never stacks a duplicate.
 */
export function openPortalItem(items: PortalItems, path: string): PortalItems {
    if (items.paths.includes(path)) return { ...items, activePath: path };
    return { paths: [...items.paths, path], activePath: path };
}

export function selectPortalItem(items: PortalItems, path: string): PortalItems {
    return items.paths.includes(path) ? { ...items, activePath: path } : items;
}

/**
 * Drops `path`. Closing the item on screen shows its right neighbor, or the left one when it was last, the way an
 * editor tab strip moves on; closing the last item closes the Portal.
 */
export function closePortalItem(items: PortalItems, path: string): PortalItems {
    const index = items.paths.indexOf(path);
    if (index === -1) return items;
    const paths = items.paths.filter((candidate) => candidate !== path);
    if (paths.length === 0) return EMPTY_PORTAL_ITEMS;
    if (items.activePath !== path) return { ...items, paths };
    return { paths, activePath: paths[Math.min(index, paths.length - 1)] };
}

/**
 * Keeps only the items `isLive` accepts, for a Chat that closed while its Portal items were open. The item on screen
 * falls back to the first survivor.
 */
export function retainPortalItems(
    items: PortalItems,
    isLive: (path: string) => boolean,
): PortalItems {
    const paths = items.paths.filter((path) => isLive(path));
    if (paths.length === items.paths.length) return items;
    if (paths.length === 0) return EMPTY_PORTAL_ITEMS;
    const activePath =
        items.activePath && paths.includes(items.activePath) ? items.activePath : paths[0];
    return { paths, activePath };
}
