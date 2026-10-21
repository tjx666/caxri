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

import { useFocusOnRevision } from '@/hooks/use-focus-on-revision';

import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { SettingRow } from './setting-row';
import type { SettingRowDescriptor } from './settings-registry';
import { agentProviderForSubcategory, useSettingsRegistry } from './settings-registry';
import type { SettingsListItem } from './settings-search';
import { buildSettingsList, countRowsByCategory, filterSettingsRows } from './settings-search';
import { SettingsSearchInput } from './settings-search-input';
import { settingsActiveAnchor, settingsAnchorOf } from './settings-toc';
import { rowResetAction } from './settings-values';

export interface SettingsNavigationState {
    activeAnchor?: string;
    counts: Partial<Record<string, number>>;
    searching: boolean;
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
     * Bumped when Settings is opened without a target, which lands the caret in the search field the way VS Code and
     * macOS System Settings do. This is a revision request rather than the dialog's own `initialFocus` because the
     * field does not exist yet when Base UI resolves that: the page renders only once `settings.jsonc` has loaded, so
     * on the first open of a session the dialog's focus resolution runs against a tab panel that is still empty.
     */
    searchFocusRequestId?: number;
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

function SubcategoryHeading({ title }: { title: string }) {
    const provider = agentProviderForSubcategory(title);
    return (
        <h4
            data-agent-provider={provider}
            className="m-0 flex items-center gap-2 px-3 pt-3 pb-1 text-[13px] font-medium text-foreground"
        >
            {provider && <AgentIdentityIcon identity={provider} size={14} />}
            {title}
        </h4>
    );
}

const estimateItemSize = (item: SettingsListItem): number => {
    if (item.kind === 'category') return 42;
    if (item.kind === 'subcategory') return 34;
    return 76;
};

/**
 * VS Code-style Settings list: search on top over one virtualized flat list of headings and rows. Its table of contents
 * is `SettingsNavigation`, rendered by the Workbench page so it also stays over Keybindings and Theme. Rendering stays
 * schema-driven: rows come from the Settings registry, so the list scales to any number of settings without DOM cost.
 */
export function SettingsPage(properties: SettingsPageProperties) {
    const { settings, argvConfig, trustedDomainsFocusRequestId } = properties;
    const { t } = useTranslation();
    const { categories, rows } = useSettingsRegistry();
    const [query, setQuery] = useState('');
    const isSearching = query.trim().length > 0;
    const scrollParentReference = useRef<HTMLDivElement>(null);
    const searchInputReference = useRef<HTMLInputElement>(null);
    const handledFocusRequest = useRef(0);
    const handledAgentActionsFocusRequest = useRef(0);
    const handledAgentExecutableFocusRequest = useRef(0);
    const handledGitExclusionsFocusRequest = useRef(0);
    const handledRowFocusRequest = useRef(0);
    const handledNotificationsFocusRequest = useRef(0);
    const handledAnchorRequest = useRef(0);

    useFocusOnRevision(properties.searchFocusRequestId, searchInputReference);

    const visibleRows = useMemo(() => filterSettingsRows(rows, query), [rows, query]);
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
    /**
     * A focus request that arrives later scrolls to its own row, so it releases the pin the same way user scrolling
     * does: the pin only holds while the requests it was set under are still the latest ones.
     */
    const focusRequests = [
        trustedDomainsFocusRequestId,
        properties.agentActionsFocusRequest?.id,
        properties.agentExecutableFocusRequest?.id,
        properties.gitExclusionsFocusRequestId,
        properties.rowFocusRequest?.id,
        properties.notificationsFocusRequestId,
    ].join(':');
    const activeAnchor =
        pinnedAnchor?.requests === focusRequests ? pinnedAnchor.anchor : spiedAnchor;
    const releasePinnedAnchor = (): void => setPinnedAnchor(undefined);
    const changeQuery = (next: string): void => {
        setPinnedAnchor(undefined);
        setQuery(next);
    };

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

    useEffect(() => {
        onNavigationStateChange?.({ activeAnchor, counts, searching: isSearching });
    }, [activeAnchor, counts, isSearching, onNavigationStateChange]);
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

    useEffect(() => {
        const request = properties.agentActionsFocusRequest;
        if (!request || handledAgentActionsFocusRequest.current === request.id) return;
        handledAgentActionsFocusRequest.current = request.id;
        const index = list.findIndex(
            (item) => item.kind === 'row' && item.row.id === `agents.${request.provider}.actions`,
        );
        if (index !== -1) virtualizer.scrollToIndex(index, { align: 'start' });
    }, [list, properties.agentActionsFocusRequest, virtualizer]);

    useEffect(() => {
        const request = properties.agentExecutableFocusRequest;
        if (!request || handledAgentExecutableFocusRequest.current === request.id) return;
        handledAgentExecutableFocusRequest.current = request.id;
        const index = list.findIndex(
            (item) =>
                item.kind === 'row' && item.row.id === `agents.${request.provider}.executable`,
        );
        if (index !== -1) virtualizer.scrollToIndex(index, { align: 'start' });
    }, [list, properties.agentExecutableFocusRequest, virtualizer]);

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
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
            <div className="border-b border-border p-3 pb-2">
                <SettingsSearchInput
                    inputRef={searchInputReference}
                    label={t('settings.page.search')}
                    placeholder={t('settings.page.search')}
                    clearTooltip={t('settings.page.clearSearch')}
                    clearLabel={t('settings.page.clearSearchLabel')}
                    value={query}
                    onChange={changeQuery}
                />
                {isSearching && (
                    <p className="mt-2 mb-0 text-[11px] text-muted" role="status">
                        {t('settings.page.searchCount', {
                            total: rows.length,
                            visible: visibleRows.length,
                        })}
                    </p>
                )}
            </div>
            {/* Wheel, touch, keyboard, and scrollbar drags are the user's own scrolling; programmatic scrolls are not. */}
            <div
                ref={scrollParentReference}
                className="min-h-0 overflow-y-auto pr-2 pb-6 pl-1"
                onKeyDown={releasePinnedAnchor}
                onPointerDown={(event) => {
                    if (event.target === event.currentTarget) releasePinnedAnchor();
                }}
                onTouchMove={releasePinnedAnchor}
                onWheel={releasePinnedAnchor}
            >
                {list.length === 0 ? (
                    <p className="px-3 py-6 text-center text-[12px] text-muted">
                        {t('settings.page.noMatches', { query: query.trim() })}
                    </p>
                ) : (
                    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                        {virtualItems.map((virtualItem) => {
                            const item = list[virtualItem.index];
                            return (
                                <div
                                    key={virtualItem.key}
                                    ref={virtualizer.measureElement}
                                    data-index={virtualItem.index}
                                    className="absolute top-0 left-0 w-full"
                                    style={{
                                        transform: `translateY(${virtualItem.start}px)`,
                                    }}
                                >
                                    {item.kind === 'category' && (
                                        <h3 className="m-0 px-3 pt-4 pb-1 text-[15px] font-semibold text-foreground">
                                            {item.category.title}
                                        </h3>
                                    )}
                                    {item.kind === 'subcategory' && (
                                        <SubcategoryHeading title={item.title} />
                                    )}
                                    {item.kind === 'row' && (
                                        <SettingRow
                                            agentHookHealth={properties.agentHookHealth}
                                            agentSkillHealth={properties.agentSkillHealth}
                                            context={{ argvConfig, settings }}
                                            handlers={handlers}
                                            row={item.row}
                                            trustedDomainsFocusRequestId={
                                                trustedDomainsFocusRequestId
                                            }
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
