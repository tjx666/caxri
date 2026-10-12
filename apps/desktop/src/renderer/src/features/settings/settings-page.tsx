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
import { cn } from '@/lib/utilities';

import { useTranslation } from '../../i18n';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { SettingRow } from './setting-row';
import type { SettingRowDescriptor, SettingsCategory } from './settings-registry';
import { agentProviderForSubcategory, useSettingsRegistry } from './settings-registry';
import type { SettingsListItem } from './settings-search';
import { buildSettingsList, countRowsByCategory, filterSettingsRows } from './settings-search';
import { SettingsSearchInput } from './settings-search-input';
import { rowResetAction } from './settings-values';

export interface SettingsPageProperties {
    settings: AppSettings;
    argvConfig?: ArgvConfig;
    agentHookHealth?: AgentHookHealthMap;
    agentSkillHealth?: AgentSkillHealth;
    agentActionsFocusRequest?: { id: number; provider: AgentProvider };
    agentExecutableFocusRequest?: { id: number; provider: AgentProvider };
    gitExclusionsFocusRequestId?: number;
    /**
     * Scrolls one `argv.jsonc` boot-flag row into view. One request for both flags, because they differ only by which
     * row they land on.
     */
    argvRowFocusRequest?: { id: number; rowId: string };
    trustedDomainsFocusRequestId?: number;
    notificationsFocusRequestId?: number;
    /**
     * Bumped when Settings is opened without a target, which lands the caret in the search field the way VS Code and
     * macOS System Settings do. This is a revision request rather than the dialog's own `initialFocus` because the
     * field does not exist yet when Base UI resolves that: the page renders only once `settings.jsonc` has loaded, so
     * on the first open of a session the dialog's focus resolution runs against a tab panel that is still empty.
     */
    searchFocusRequestId?: number;
    onArgvConfigChange: (changes: ArgvConfigChanges) => void;
    onFieldChange: <K extends keyof AppSettings>(
        key: K,
        value: AppSettings[K],
        member?: string,
    ) => void;
}

/**
 * Anchor id a TOC entry scrolls to: a category id, or `category:subcategory`.
 */
const anchorOf = (item: SettingsListItem): string | undefined => {
    if (item.kind === 'category') return item.category.id;
    if (item.kind === 'subcategory') return `${item.categoryId}:${item.title}`;
    return undefined;
};

interface SettingsTocProperties {
    categories: SettingsCategory[];
    counts: Partial<Record<string, number>>;
    activeAnchor?: string;
    searching: boolean;
    onNavigate: (anchor: string) => void;
}

function SettingsToc({
    categories,
    counts,
    activeAnchor,
    searching,
    onNavigate,
}: SettingsTocProperties) {
    const { t } = useTranslation();
    return (
        <nav
            aria-label={t('settings.page.categoriesNav')}
            className="min-h-0 overflow-y-auto py-2 pl-2"
        >
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {categories.map((category) => {
                    const count = counts[category.id] ?? 0;
                    if (searching && count === 0) return null;
                    const isActive =
                        activeAnchor === category.id ||
                        (activeAnchor?.startsWith(`${category.id}:`) ?? false);
                    return (
                        <li key={category.id}>
                            <button
                                type="button"
                                aria-current={isActive ? 'location' : undefined}
                                className={cn(
                                    'flex h-7 w-full cursor-pointer items-center justify-between gap-2 rounded border-0 bg-transparent px-2 text-left text-[12px] text-muted hover:bg-elevated hover:text-foreground',
                                    isActive && 'bg-elevated text-foreground',
                                )}
                                onClick={() => onNavigate(category.id)}
                            >
                                <span className="truncate">{category.title}</span>
                                {searching && (
                                    <span className="text-[10px] text-muted">{count}</span>
                                )}
                            </button>
                            {category.subcategories.length > 0 && (
                                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                                    {category.subcategories.map((subcategory) => {
                                        const anchor = `${category.id}:${subcategory}`;
                                        // A subcategory with no matches has no heading in the
                                        // filtered list, so its TOC entry would be a dead click.
                                        if (searching && (counts[anchor] ?? 0) === 0) return null;
                                        const provider = agentProviderForSubcategory(subcategory);
                                        return (
                                            <li key={anchor}>
                                                <button
                                                    type="button"
                                                    aria-current={
                                                        activeAnchor === anchor
                                                            ? 'location'
                                                            : undefined
                                                    }
                                                    className={cn(
                                                        'flex h-7 w-full cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2 pl-6 text-left text-[12px] text-muted hover:bg-elevated hover:text-foreground',
                                                        activeAnchor === anchor &&
                                                            'bg-elevated text-foreground',
                                                    )}
                                                    onClick={() => onNavigate(anchor)}
                                                >
                                                    {provider && (
                                                        <AgentIdentityIcon
                                                            identity={provider}
                                                            size={13}
                                                        />
                                                    )}
                                                    <span className="truncate">{subcategory}</span>
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
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
 * VS Code-style Settings surface: search on top, category table of contents left, and one virtualized flat list of
 * headings and rows right. Rendering stays schema-driven: rows come from the Settings registry, so the list scales to
 * any number of settings without DOM cost.
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
    const handledArgvRowFocusRequest = useRef(0);
    const handledNotificationsFocusRequest = useRef(0);

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

    // Scroll-spy: the anchor owning the first item in the viewport drives the TOC highlight.
    const virtualItems = virtualizer.getVirtualItems();
    const scrollOffset = virtualizer.scrollOffset ?? 0;
    const activeAnchor = useMemo(() => {
        const topItem = virtualItems.find((item) => item.end > scrollOffset) ?? virtualItems.at(0);
        if (topItem === undefined) return;
        for (let index = topItem.index; index >= 0; index -= 1) {
            const item = list[index];
            if (item.kind === 'subcategory' || item.kind === 'category') return anchorOf(item);
            if (item.row.subcategory) return `${item.row.category}:${item.row.subcategory}`;
        }
        return list[0] ? anchorOf(list[0]) : undefined;
    }, [list, scrollOffset, virtualItems]);

    const navigate = (anchor: string): void => {
        const index = list.findIndex((item) => anchorOf(item) === anchor);
        if (index !== -1) virtualizer.scrollToIndex(index, { align: 'start' });
    };

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
        const request = properties.argvRowFocusRequest;
        if (
            !request ||
            handledArgvRowFocusRequest.current === request.id ||
            virtualItems.length === 0
        )
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
        handledArgvRowFocusRequest.current = request.id;
        virtualizer.scrollToIndex(index, { align: 'start' });
    }, [list, properties.argvRowFocusRequest, virtualizer, virtualItems.length]);

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
                    onChange={setQuery}
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
            <div className="grid min-h-0 grid-cols-[168px_minmax(0,1fr)] overflow-hidden">
                <SettingsToc
                    activeAnchor={activeAnchor}
                    categories={categories}
                    counts={counts}
                    searching={isSearching}
                    onNavigate={navigate}
                />
                <div ref={scrollParentReference} className="min-h-0 overflow-y-auto pr-2 pb-6 pl-1">
                    {list.length === 0 ? (
                        <p className="px-3 py-6 text-center text-[12px] text-muted">
                            {t('settings.page.noMatches', { query: query.trim() })}
                        </p>
                    ) : (
                        <div
                            className="relative w-full"
                            style={{ height: virtualizer.getTotalSize() }}
                        >
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
        </div>
    );
}
