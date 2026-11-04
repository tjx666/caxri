import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
    AgentHookHealthMap,
    AgentProvider,
    AgentSkillHealth,
    AppSettings,
    ArgvConfig,
    ArgvConfigChanges,
} from '@caxri/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SearchX } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../components/ui/empty';
import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { useDialogStore } from '../../stores/dialogs';
import { useAgentFocusRequests } from './hooks/use-agent-focus-requests';
import { useVisibleSettingsRows } from './hooks/use-visible-settings-rows';
import { SettingRow } from './setting-row';
import { hasOwnSurface } from './setting-row-layout';
import type { SettingRowDescriptor } from './settings-registry';
import { useSettingsRegistry } from './settings-registry';
import type { SettingsCardPosition, SettingsListItem } from './settings-search';
import { buildSettingsList, countRowsByCategory } from './settings-search';
import { settingsActiveAnchor, settingsAnchorOf } from './settings-toc';
import { rowResetAction } from './settings-values';

export interface SettingsNavigationState {
    activeAnchor?: string;
    counts: Partial<Record<string, number>>;
    searching: boolean;
    /**
     * Rows are filtered (a query, or advanced rows hidden), so a TOC entry with no listed rows would be a dead click.
     */
    filtered: boolean;
    /**
     * Rows the list shows, out of {@link totalCount}; the navigation column reports them under its search field.
     */
    visibleCount: number;
    totalCount: number;
    /**
     * Advanced rows the list leaves out, shown beside the navigation's Show advanced settings switch.
     */
    hiddenAdvancedCount: number;
}

export interface SettingsPageProperties {
    settings: AppSettings;
    argvConfig?: ArgvConfig;
    agentHookHealth?: AgentHookHealthMap;
    agentSkillHealth?: AgentSkillHealth;
    agentActionsFocusRequest?: { id: number; provider: AgentProvider };
    agentExecutableFocusRequest?: { id: number; provider: AgentProvider };
    gitExclusionsFocusRequestId?: number;
    /**
     * Scrolls one row into view: an `argv.jsonc` boot flag or the Agent suspension setting. One request for all of
     * them, because they differ only by which row they land on.
     */
    rowFocusRequest?: { id: number; rowId: string };
    trustedDomainsFocusRequestId?: number;
    notificationsFocusRequestId?: number;
    /**
     * The search typed in the navigation column, which owns the field (`useSettingsSearchQuery`).
     */
    query: string;
    onQueryChange: (query: string) => void;
    /**
     * Scrolls to a category or `category:subcategory` anchor picked in the Settings navigation.
     */
    anchorRequest?: { id: number; anchor: string };
    /**
     * Called once {@link anchorRequest} has been handled, so its owner can drop it.
     */
    onAnchorRequestHandled?: (id: number) => void;
    /**
     * Reports what the Settings navigation, which lives outside this page, highlights and counts. Called with
     * `undefined` on unmount, when the list it describes is gone.
     */
    onNavigationStateChange?: (state: SettingsNavigationState | undefined) => void;
    onArgvConfigChange: (changes: ArgvConfigChanges) => void;
    onFieldChange: <K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
        member?: string,
    ) => void;
}

/**
 * Class names that draw one row's slice of its card (see `SettingsCardPosition`). The hairline outline keeps a card
 * visible in a theme whose `--surface` matches `--background` (Oscura Midnight); a slice's top edge is the card's top
 * outline or the divider above the row.
 */
function cardSliceClassName(card: SettingsCardPosition): string {
    return cn(
        'border-x border-t border-border bg-surface',
        card.first && 'rounded-t-md',
        card.last && 'rounded-b-md border-b',
    );
}

/**
 * One entry of the Settings list: a category heading, a subcategory heading, or a row (`children`) drawn as its slice
 * of the card, unless the row draws its own surface.
 */
function SettingsListEntry({
    item,
    isFirst,
    children,
}: {
    item: SettingsListItem;
    isFirst: boolean;
    children?: ReactNode;
}) {
    if (item.kind === 'category')
        return (
            <h2
                className={cn(
                    'm-0 px-1 pb-3 text-[15px] font-semibold text-foreground',
                    isFirst ? 'pt-6' : 'pt-5',
                )}
            >
                {item.category.title}
            </h2>
        );
    if (item.kind === 'subcategory') {
        const { provider } = item.subcategory;
        return (
            <h3
                data-agent-provider={provider}
                className="m-0 flex items-center gap-2 px-1 pt-1 pb-2 text-[12px] font-medium text-muted"
            >
                {provider && <AgentIdentityIcon identity={provider} size={13} />}
                {item.subcategory.title}
            </h3>
        );
    }
    return (
        <div className={hasOwnSurface(item.row) ? undefined : cardSliceClassName(item.card)}>
            {children}
        </div>
    );
}

/**
 * The list left empty: by a query with no match, offering to clear it, or by a registry with nothing to show.
 */
function SettingsNoMatches({ query, onClear }: { query: string; onClear: () => void }) {
    const { t } = useTranslation();
    return (
        <Empty className="pt-16">
            <EmptyMedia>
                <SearchX aria-hidden="true" size={20} />
            </EmptyMedia>
            <EmptyTitle>{t('settings.page.noMatches', { query: query.trim() })}</EmptyTitle>
            {query.trim() && (
                <Button size="sm" variant="secondary" onClick={onClear}>
                    {t('settings.page.clearSearchAction')}
                </Button>
            )}
        </Empty>
    );
}

/**
 * Measured heights of the common case: a one-line title with a one-line description and its 1px top edge, plus the last
 * row's bottom outline and the card's 12px bottom gap. A navigation jump right after Show advanced settings turns on
 * lands on offsets computed from these estimates for dozens of unmeasured rows, so each pixel of error per row
 * compounds; an estimate of 68 overshot Claude by ~400px.
 */
const estimateItemSize = (item: SettingsListItem): number => {
    if (item.kind === 'category') return 55;
    if (item.kind === 'subcategory') return 30;
    return item.card.last ? 75 : 62;
};

/**
 * The Settings list: one virtualized flat list of headings and rows, grouped into cards inside a centered column. Its
 * search field and table of contents live in the navigation column (`SettingsSidebar`), rendered by the Workbench page
 * so they also stay over Keybindings and Theme. Rendering stays schema-driven: rows come from the Settings registry, so
 * the list scales to any number of settings without DOM cost.
 */
export function SettingsPage(properties: SettingsPageProperties) {
    const { settings, argvConfig, trustedDomainsFocusRequestId, query } = properties;
    const { categories, rows } = useSettingsRegistry();
    const isSearching = query.trim().length > 0;
    const scrollParentReference = useRef<HTMLDivElement>(null);
    const isCreateSessionSuspended = useDialogStore((state) => state.isPendingSuspended);
    const handledFocusRequest = useRef(0);
    const handledGitExclusionsFocusRequest = useRef(0);
    const handledRowFocusRequest = useRef(0);
    const handledNotificationsFocusRequest = useRef(0);
    const handledAnchorRequest = useRef(0);

    const { showAdvanced, visibleRows, hiddenAdvancedCount } = useVisibleSettingsRows(
        rows,
        query,
        { argvConfig, settings },
        {
            trustedDomainsFocusRequestId,
            gitExclusionsFocusRequestId: properties.gitExclusionsFocusRequestId,
            rowFocusRequest: properties.rowFocusRequest,
            agentActionsFocusRequest: properties.agentActionsFocusRequest,
            agentExecutableFocusRequest: properties.agentExecutableFocusRequest,
        },
    );
    const isFiltered = isSearching || !showAdvanced;
    const list = useMemo(
        () => buildSettingsList(categories, visibleRows),
        [categories, visibleRows],
    );
    const counts = useMemo(() => countRowsByCategory(visibleRows), [visibleRows]);

    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler
    // skips this component, which is the library's documented, expected behavior.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: list.length,
        estimateSize: (index) => estimateItemSize(list[index]),
        getItemKey: (index) => list[index].id,
        getScrollElement: () => scrollParentReference.current,
        overscan: 8,
    });

    const virtualItems = virtualizer.getVirtualItems();
    const scrollOffset = virtualizer.scrollOffset ?? 0;
    const spiedAnchor = useMemo(
        () => settingsActiveAnchor(list, virtualItems, scrollOffset),
        [list, scrollOffset, virtualItems],
    );
    /**
     * The TOC entry the user clicked stays current until they scroll the list themselves. Scroll-spy alone cannot hold
     * it: a short last section such as Agent or Grok Build can never reach the top of the viewport, so the section
     * above it would keep the highlight.
     */
    const [pinnedAnchor, setPinnedAnchor] = useState<{ anchor: string; requests: string }>();
    const searchedQuery = query.trim();
    /**
     * A focus request that arrives later scrolls to its own row, so it releases the pin the same way user scrolling
     * does: the pin only holds while the requests it was set under are still the latest ones. A new query re-filters
     * the list under the pin, so it hides the pin at once and the effect below releases it.
     */
    const focusRequests = [
        trustedDomainsFocusRequestId,
        properties.agentActionsFocusRequest?.id,
        properties.agentExecutableFocusRequest?.id,
        properties.gitExclusionsFocusRequestId,
        properties.rowFocusRequest?.id,
        properties.notificationsFocusRequestId,
        searchedQuery,
    ].join(':');
    const activeAnchor =
        pinnedAnchor?.requests === focusRequests ? pinnedAnchor.anchor : spiedAnchor;
    const releasePinnedAnchor = (): void => setPinnedAnchor(undefined);

    /**
     * A new query lists other rows, so its result starts at the top and the clicked navigation entry no longer holds;
     * released only through `focusRequests`, the pin came back when the query returned to the one it was set under.
     * Scrolling to the top also replaces a jump still in flight: TanStack Virtual retargets a `scrollToIndex` for up to
     * five seconds until it settles, and that index named a row of the previous list, so clearing a query right after
     * picking Claude landed back on Claude. Declared before the request effects below, so a request arriving in the
     * same commit still has the last word.
     */
    const lastSearchedQuery = useRef(searchedQuery);
    useEffect(() => {
        if (lastSearchedQuery.current === searchedQuery) return;
        lastSearchedQuery.current = searchedQuery;
        setPinnedAnchor(undefined);
        virtualizer.scrollToOffset(0);
    }, [searchedQuery, virtualizer]);

    const { anchorRequest, onAnchorRequestHandled, onNavigationStateChange } = properties;
    useEffect(() => {
        if (!anchorRequest || handledAnchorRequest.current === anchorRequest.id) return;
        // A request from Keybindings, Theme, or Source mounts this list first; scrolling before the virtualizer has a
        // range silently does nothing, so wait for measured items like the focus requests below.
        if (virtualItems.length === 0 && list.length > 0) return;
        handledAnchorRequest.current = anchorRequest.id;
        onAnchorRequestHandled?.(anchorRequest.id);
        const index = list.findIndex((item) => settingsAnchorOf(item) === anchorRequest.anchor);
        if (index === -1) return;
        setPinnedAnchor({ anchor: anchorRequest.anchor, requests: focusRequests });
        virtualizer.scrollToIndex(index, { align: 'start' });
    }, [
        anchorRequest,
        focusRequests,
        list,
        onAnchorRequestHandled,
        virtualizer,
        virtualItems.length,
    ]);

    const visibleCount = visibleRows.length;
    const totalCount = rows.length;
    useEffect(() => {
        // The scroll-spied anchor comes from this page's virtualizer, and the navigation that shows it must outlive the
        // page over Keybindings, Theme, and Source, so the state cannot be lifted into the parent with the list.
        // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent, react-doctor/no-pass-live-state-to-parent
        onNavigationStateChange?.({
            activeAnchor,
            counts,
            searching: isSearching,
            filtered: isFiltered,
            visibleCount,
            totalCount,
            hiddenAdvancedCount,
        });
    }, [
        activeAnchor,
        counts,
        hiddenAdvancedCount,
        isFiltered,
        isSearching,
        onNavigationStateChange,
        totalCount,
        visibleCount,
    ]);
    useEffect(() => () => onNavigationStateChange?.(undefined), [onNavigationStateChange]);

    // A `trusted-domains` open request scrolls the row into view; the mounted editor then grabs
    // focus through its own `focusRequestId` effect.
    useEffect(() => {
        if (!trustedDomainsFocusRequestId) return;
        if (handledFocusRequest.current === trustedDomainsFocusRequestId) return;
        handledFocusRequest.current = trustedDomainsFocusRequestId;
        const index = list.findIndex(
            (item) => item.kind === 'row' && item.row.id === 'security.trustedDomains',
        );
        if (index !== -1) virtualizer.scrollToIndex(index, { align: 'start' });
    }, [list, trustedDomainsFocusRequestId, virtualizer]);

    useAgentFocusRequests({
        actions: properties.agentActionsFocusRequest,
        executable: properties.agentExecutableFocusRequest,
        focusRequests,
        list,
        measuredItemCount: virtualItems.length,
        setPinnedAnchor,
        virtualizer,
    });

    useEffect(() => {
        const requestId = properties.gitExclusionsFocusRequestId;
        if (
            !requestId ||
            handledGitExclusionsFocusRequest.current === requestId ||
            virtualItems.length === 0
        )
            return;
        const index = list.findIndex(
            (item) => item.kind === 'row' && item.row.id === 'git.diffExclude',
        );
        if (index === -1) return;
        /**
         * Wait for measured items: opening the dialog on this request mounts an unmeasured list, and scrolling it
         * before the virtualizer has a range silently does nothing.
         */
        handledGitExclusionsFocusRequest.current = requestId;
        virtualizer.scrollToIndex(index, { align: 'start' });
    }, [list, properties.gitExclusionsFocusRequestId, virtualizer, virtualItems.length]);

    useEffect(() => {
        const request = properties.rowFocusRequest;
        if (!request || handledRowFocusRequest.current === request.id || virtualItems.length === 0)
            return;
        const index = list.findIndex(
            (item) => item.kind === 'row' && item.row.id === request.rowId,
        );
        if (index === -1) return;
        /**
         * Same wait for measured items as the two requests below: a request that opens the dialog mounts an unmeasured
         * list, and scrolling it before the virtualizer has a range silently does nothing, which is exactly how this
         * arrives from the status bar's debugging chip and the GPU crash card.
         */
        handledRowFocusRequest.current = request.id;
        virtualizer.scrollToIndex(index, { align: 'start' });
    }, [list, properties.rowFocusRequest, virtualizer, virtualItems.length]);

    useEffect(() => {
        const requestId = properties.notificationsFocusRequestId;
        if (
            !requestId ||
            handledNotificationsFocusRequest.current === requestId ||
            virtualItems.length === 0
        )
            return;
        const index = list.findIndex(
            (item) => item.kind === 'category' && item.category.id === 'notifications',
        );
        if (index === -1) return;
        /**
         * Wait for measured items: the first mount has no scroll range, so an earlier request is discarded.
         */
        handledNotificationsFocusRequest.current = requestId;
        virtualizer.scrollToIndex(index, { align: 'start' });
    }, [list, properties.notificationsFocusRequestId, virtualizer, virtualItems.length]);

    const handlers = {
        onArgvConfigChange: properties.onArgvConfigChange,
        onFieldChange: properties.onFieldChange,
        onResetRow: (row: SettingRowDescriptor): void => {
            const action = rowResetAction(row.binding, settings);
            if (!action) return;
            if (action.kind === 'argv') properties.onArgvConfigChange(action.changes);
            else properties.onFieldChange(action.key, action.value, action.member);
        },
    };

    return (
        // Wheel, touch, keyboard, and scrollbar drags are the user's own scrolling; programmatic scrolls are not.
        <div
            ref={scrollParentReference}
            className={cn(
                'min-h-0 overflow-y-auto px-8 pb-16',
                // Keeps the last rows clear of the floating Create Session resume bar.
                isCreateSessionSuspended && 'pb-24',
            )}
            onKeyDown={releasePinnedAnchor}
            onPointerDown={(event) => {
                if (event.target === event.currentTarget) releasePinnedAnchor();
            }}
            onTouchMove={releasePinnedAnchor}
            onWheel={releasePinnedAnchor}
        >
            {list.length === 0 ? (
                <SettingsNoMatches query={query} onClear={() => properties.onQueryChange('')} />
            ) : (
                /*
                 * One centered column, as macOS System Settings lays it out: a wide window keeps each label within reach
                 * of its control instead of stretching the row across the screen.
                 */
                <div
                    className="relative mx-auto w-full max-w-3xl"
                    style={{ height: virtualizer.getTotalSize() }}
                >
                    {virtualItems.map((virtualItem) => {
                        const item = list[virtualItem.index];
                        return (
                            <div
                                key={virtualItem.key}
                                ref={virtualizer.measureElement}
                                data-index={virtualItem.index}
                                className={cn(
                                    'absolute top-0 left-0 w-full',
                                    // The measured wrapper carries the gap after a card: margins are not measured.
                                    item.kind === 'row' && item.card.last && 'pb-3',
                                )}
                                style={{
                                    transform: `translateY(${virtualItem.start}px)`,
                                }}
                            >
                                <SettingsListEntry isFirst={virtualItem.index === 0} item={item}>
                                    {item.kind === 'row' && (
                                        <SettingRow
                                            agentHookHealth={properties.agentHookHealth}
                                            agentSkillHealth={properties.agentSkillHealth}
                                            context={{ argvConfig, settings }}
                                            handlers={handlers}
                                            row={item.row}
                                            showAdvancedTag={item.row.advanced && !showAdvanced}
                                            trustedDomainsFocusRequestId={
                                                trustedDomainsFocusRequestId
                                            }
                                        />
                                    )}
                                </SettingsListEntry>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
