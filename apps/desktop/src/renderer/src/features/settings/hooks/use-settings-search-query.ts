import { useState } from 'react';

import type { SettingsPageController } from './use-settings-page-controller';

/**
 * The targeted opens a Settings query yields to: each scrolls to one row, which the query may have filtered out.
 */
type SettingsSearchScopeSource = Pick<
    SettingsPageController,
    | 'agentActionsFocusRequest'
    | 'agentExecutableFocusRequest'
    | 'gitExclusionsFocusRequestId'
    | 'notificationsFocusRequestId'
    | 'rowFocusRequest'
    | 'trustedDomainsFocusRequestId'
>;

/**
 * What a Settings query belongs to: whether the Settings list is showing, plus the latest targeted open. The query
 * survives only while this value stays the same.
 */
export function settingsSearchScope(
    source: SettingsSearchScopeSource,
    isListShowing: boolean,
): string {
    return [
        String(isListShowing),
        source.agentActionsFocusRequest?.id,
        source.agentExecutableFocusRequest?.id,
        source.gitExclusionsFocusRequestId,
        source.notificationsFocusRequestId,
        source.rowFocusRequest?.id,
        source.trustedDomainsFocusRequestId,
    ].join(':');
}

/**
 * The Settings search query, owned by the page rather than the list because its field sits in the navigation column,
 * which stays mounted over Keybindings, Theme, and Source.
 *
 * A query belongs to the Settings list it filters. Leaving the list (another section, the Source view) or arriving
 * through a targeted open (a row, an Agent, Notifications) drops it, so the column never shows a query the content
 * ignores and a request never scrolls to a row the query filtered out. Typing from outside the list brings the list
 * back with the query applied.
 */
export function useSettingsSearchQuery(
    controller: SettingsSearchScopeSource &
        Pick<SettingsPageController, 'showSettingsList' | 'tab' | 'view'>,
): { query: string; changeQuery: (next: string) => void } {
    const isListShowing = controller.tab === 'settings' && controller.view === 'ui';
    const scope = settingsSearchScope(controller, isListShowing);
    const [query, setQuery] = useState('');
    const [queryScope, setQueryScope] = useState(scope);
    // Adjusting state while rendering (react.dev "You Might Not Need an Effect"): the reset lands before the list
    // renders, so it never filters one frame by a query that no longer applies.
    if (queryScope !== scope) {
        setQueryScope(scope);
        setQuery('');
    }
    const changeQuery = (next: string): void => {
        setQuery(next);
        if (isListShowing || !next.trim()) return;
        // Claim the scope the list will show under, so bringing the list back keeps this query.
        setQueryScope(settingsSearchScope(controller, true));
        controller.showSettingsList();
    };
    return { query, changeQuery };
}
