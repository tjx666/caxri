import { useEffect, useRef } from 'react';

import type { AgentProvider } from '@caxri/protocol';
import type { Virtualizer } from '@tanstack/react-virtual';

import type { SettingsListItem } from '../settings-search';
import { settingsAnchorOf } from '../settings-toc';

interface AgentFocusRequest {
    id: number;
    provider: AgentProvider;
}

/**
 * Scrolls the Settings list to one Agent's row for an "open Settings at this Agent" request (the Terminal recovery bar,
 * the Chat dock, and the Create Session dialog's Configure action), and pins the provider's own heading so the
 * navigation selects its entry.
 *
 * It waits for measured items: a request that mounts the page (no Session open) scrolls an unmeasured list, which
 * silently does nothing and left Settings on General.
 */
function useAgentRowFocus(
    request: AgentFocusRequest | undefined,
    rowSuffix: 'actions' | 'executable',
    options: Pick<
        Parameters<typeof useAgentFocusRequests>[0],
        'focusRequests' | 'list' | 'measuredItemCount' | 'setPinnedAnchor' | 'virtualizer'
    >,
): void {
    const { focusRequests, list, measuredItemCount, setPinnedAnchor, virtualizer } = options;
    const handledRequest = useRef(0);
    useEffect(() => {
        if (!request || measuredItemCount === 0 || handledRequest.current === request.id) return;
        const index = list.findIndex(
            (item) =>
                item.kind === 'row' && item.row.id === `agents.${request.provider}.${rowSuffix}`,
        );
        if (index === -1) return;
        handledRequest.current = request.id;
        const heading = list.slice(0, index).findLast((item) => item.kind === 'subcategory');
        const anchor = heading && settingsAnchorOf(heading);
        if (anchor) setPinnedAnchor({ anchor, requests: focusRequests });
        virtualizer.scrollToIndex(index, { align: 'start' });
    }, [focusRequests, list, measuredItemCount, request, rowSuffix, setPinnedAnchor, virtualizer]);
}

export function useAgentFocusRequests(options: {
    actions: AgentFocusRequest | undefined;
    executable: AgentFocusRequest | undefined;
    focusRequests: string;
    list: SettingsListItem[];
    /**
     * Virtual items currently rendered; zero until the list has been measured.
     */
    measuredItemCount: number;
    setPinnedAnchor: (pin: { anchor: string; requests: string }) => void;
    virtualizer: Virtualizer<HTMLDivElement, Element>;
}): void {
    useAgentRowFocus(options.actions, 'actions', options);
    useAgentRowFocus(options.executable, 'executable', options);
}
