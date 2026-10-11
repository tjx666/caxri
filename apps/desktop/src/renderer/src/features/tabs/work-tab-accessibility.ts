import type { GitDecoration } from '../../lib/git-decorations';
import { gitDecorationDescription } from '../../lib/git-decorations';

export type WorkTabNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'End' | 'Home';

/**
 * Tab occurrence ids are already unique across the whole tree, so a DOM id needs no Session or pane prefix, and, unlike
 * the paths and Terminal ids the previous global strip hashed, an occurrence id is generated rather than user data, so
 * it is safe to put in the DOM as is.
 */
export function workTabId(tabId: string): string {
    return `work-tab-${tabId}`;
}

/**
 * Returns the ID of the pane surface labelled by {@link workTabId}.
 */
export function workPanelId(tabId: string): string {
    return `${workTabId(tabId)}-panel`;
}

/**
 * Calculates the roving-focus target with automatic activation inside one pane's tab bar. Arrow keys stay in the bar
 * they started in; moving between panes is a separate command.
 */
export function workTabNavigationTarget(
    tabIds: readonly string[],
    activeTabId: string | undefined,
    key: WorkTabNavigationKey,
): string | undefined {
    if (tabIds.length === 0) return undefined;
    if (key === 'Home') return tabIds[0];
    if (key === 'End') return tabIds.at(-1);
    const activeIndex = activeTabId === undefined ? -1 : tabIds.indexOf(activeTabId);
    if (activeIndex === -1) return key === 'ArrowRight' ? tabIds[0] : tabIds.at(-1);
    const delta = key === 'ArrowRight' ? 1 : -1;
    return tabIds[(activeIndex + delta + tabIds.length) % tabIds.length];
}

/**
 * Everything a tab shows but its accessible name cannot say, spoken through `aria-describedby`; empty when nothing
 * applies. "Unsaved changes" and the Git state are genuinely different facts: a file can be committed-clean with an
 * unsaved buffer, or modified on disk with nothing pending, so both are spoken when both hold.
 */
export function workTabDescription({
    accessibleDetail,
    detail,
    dirty,
    gitDecoration,
}: {
    accessibleDetail?: string;
    detail?: string;
    dirty?: boolean;
    gitDecoration?: Pick<GitDecoration, 'kind'>;
}): string {
    return [
        detail ? `In ${detail}.` : undefined,
        accessibleDetail ? `${accessibleDetail}.` : undefined,
        gitDecoration ? gitDecorationDescription(gitDecoration.kind) : undefined,
        dirty ? 'Unsaved changes.' : undefined,
    ]
        .filter(Boolean)
        .join(' ');
}
