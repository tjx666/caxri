import type { ReactNode } from 'react';

import type { AgentProvider, SessionSearchStatusFilter } from '@caxri/protocol';
import { sessionSearchStatusFilters } from '@caxri/protocol';
import { ArrowUpDown, Clock, X } from 'lucide-react';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../../components/ui/select';
import { Tooltip } from '../../../components/ui/tooltip';
import type { TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { cn } from '../../../lib/utilities';
import { SessionTimeRangeSelect } from '../session-time-range-select';
import type {
    SessionSearchFilterChip,
    SessionSearchScope,
    SessionSearchSort,
} from './session-search-model';
import {
    sessionSearchFilterChips,
    sessionSearchProviders,
    sessionSearchScopes,
    sessionSearchSorts,
} from './session-search-model';
import type { SessionSearchModel } from './use-session-search';

const chipClassName =
    'flex h-6 cursor-pointer items-center gap-1 rounded border border-transparent bg-transparent px-2 text-[12px] text-muted outline-none hover:bg-elevated hover:text-foreground focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--state-focus-ring)] aria-pressed:bg-state-selected-quiet aria-pressed:font-medium aria-pressed:text-foreground';

/**
 * Shrinks the shared Select trigger to the chip row's height and quiet styling, so each dropdown reads as one more
 * filter chip.
 */
const selectTriggerClassName =
    'h-6 w-auto gap-1 rounded border-transparent bg-transparent px-2 text-[12px] text-muted hover:bg-elevated hover:text-foreground';

/**
 * A narrowing dropdown (Agent, time range) shows as pressed while it filters anything out, like a pressed chip.
 */
const activeSelectTriggerClassName = 'bg-state-selected-quiet font-medium text-foreground';

const statusFilterLabelKeys = {
    all: 'session.search.filter.all',
    caxri: 'session.search.filter.caxri',
    archived: 'session.search.filter.archived',
    external: 'session.search.filter.external',
} as const satisfies Record<SessionSearchStatusFilter, string>;

const sortLabelKeys = {
    relevance: 'session.search.sort.relevance',
    recent: 'session.search.sort.recent',
} as const satisfies Record<SessionSearchSort, string>;

const scopeLabelKeys = {
    currentProject: 'session.search.scope.currentProject',
    allProjects: 'session.search.scope.allProjects',
} as const satisfies Record<SessionSearchScope, string>;

const chipLabelKeys = {
    agent: 'session.search.chip.agent',
    project: 'session.search.chip.project',
    before: 'session.search.chip.before',
    after: 'session.search.chip.after',
} as const satisfies Record<SessionSearchFilterChip['kind'], string>;

/**
 * Select needs a string value; `all` stands for no Agent filter.
 */
const ALL_AGENTS = 'all';

/**
 * The filter bar under the search box. Location stays a row of chips because it is the filter people switch most; the
 * Agent, time range, Project scope, and sort each collapse into one dropdown so the bar stays short. Each control's
 * tooltip names its keyboard shortcut instead of the footer listing all of them. One removable chip follows for each
 * operator (`agent:`, `project:`, `before:`, `after:`) the Server parsed out of the query.
 */
export function SessionSearchFilters({ search }: { search: SessionSearchModel }) {
    const { t } = useTranslation();
    const chips = sessionSearchFilterChips(search.result?.filters);
    return (
        <>
            <div className="flex flex-wrap items-center gap-1">
                <Tooltip content={t('session.search.statusFilterTooltip')} shortcut="Tab">
                    <div
                        aria-label={t('session.search.statusFilter')}
                        className="flex gap-0.5"
                        role="group"
                    >
                        {sessionSearchStatusFilters.map((filter) => (
                            <button
                                key={filter}
                                aria-pressed={search.status === filter}
                                className={chipClassName}
                                data-session-search-status-filter={filter}
                                type="button"
                                onClick={() => search.setStatus(filter)}
                            >
                                {t(statusFilterLabelKeys[filter])}
                            </button>
                        ))}
                    </div>
                </Tooltip>
                <Divider />
                <AgentFilterSelect search={search} />
                <SessionTimeRangeSelect
                    ariaLabel={t('session.timeRange.filterActivity')}
                    leading={<Clock aria-hidden="true" size={12} />}
                    triggerClassName={cn(
                        selectTriggerClassName,
                        search.timeRange !== 'all' && activeSelectTriggerClassName,
                    )}
                    shortcut="Alt+T"
                    value={search.timeRange}
                    onChange={search.setTimeRange}
                />
                <div className="ml-auto flex items-center gap-1">
                    {search.hasCurrentProject && (
                        <OptionSelect
                            ariaLabel={t('session.search.scope')}
                            dataAttribute="data-session-search-scope"
                            labelKeys={scopeLabelKeys}
                            options={sessionSearchScopes}
                            shortcut="Alt+P"
                            value={search.scope}
                            onChange={search.setScope}
                        />
                    )}
                    <OptionSelect
                        ariaLabel={t('session.search.sort')}
                        dataAttribute="data-session-search-sort"
                        labelKeys={sortLabelKeys}
                        leading={<ArrowUpDown aria-hidden="true" size={12} />}
                        options={sessionSearchSorts}
                        shortcut="Alt+S"
                        value={search.sort}
                        onChange={search.setSort}
                    />
                </div>
            </div>
            {chips.length > 0 && (
                <div
                    aria-label={t('session.search.operators')}
                    className="flex flex-wrap items-center gap-1"
                    role="group"
                >
                    {chips.map((chip) => (
                        <OperatorChip
                            key={chip.key}
                            chip={chip}
                            onRemove={() => search.removeFilterChip(chip)}
                        />
                    ))}
                </div>
            )}
        </>
    );
}

function AgentFilterSelect({ search }: { search: SessionSearchModel }) {
    const { t } = useTranslation();
    const value: AgentProvider | typeof ALL_AGENTS = search.provider ?? ALL_AGENTS;
    const label = (option: AgentProvider | typeof ALL_AGENTS) =>
        option === ALL_AGENTS ? (
            t('session.search.allAgents')
        ) : (
            <span className="flex items-center gap-1.5">
                <AgentIdentityIcon identity={option} size={12} />
                {resolveAgentIcon(option).label}
            </span>
        );
    return (
        <Select
            value={value}
            onValueChange={(next) =>
                search.setProvider(!next || next === ALL_AGENTS ? undefined : next)
            }
        >
            <Tooltip content={t('session.search.agentFilter')} shortcut="Shift+Tab">
                <SelectTrigger
                    aria-label={t('session.search.agentFilter')}
                    className={cn(
                        selectTriggerClassName,
                        search.provider && activeSelectTriggerClassName,
                    )}
                    data-session-search-provider-filter={value}
                >
                    <SelectValue>{label(value)}</SelectValue>
                </SelectTrigger>
            </Tooltip>
            <SelectContent>
                <SelectItem value={ALL_AGENTS}>{label(ALL_AGENTS)}</SelectItem>
                {sessionSearchProviders.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                        {label(provider)}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

/**
 * A two-way setting (Project scope, sort) as one quiet dropdown; the trigger shows the current choice and carries it in
 * `dataAttribute` for tests.
 */
function OptionSelect<Option extends string>({
    ariaLabel,
    dataAttribute,
    labelKeys,
    leading,
    onChange,
    options,
    shortcut,
    value,
}: {
    ariaLabel: string;
    dataAttribute: `data-${string}`;
    labelKeys: Record<Option, TranslationKey>;
    leading?: ReactNode;
    onChange: (value: Option) => void;
    options: readonly Option[];
    shortcut: string;
    value: Option;
}) {
    const { t } = useTranslation();
    return (
        <Select value={value} onValueChange={(next) => next && onChange(next)}>
            <Tooltip content={ariaLabel} shortcut={shortcut}>
                <SelectTrigger
                    aria-label={ariaLabel}
                    className={selectTriggerClassName}
                    {...{ [dataAttribute]: value }}
                >
                    {leading}
                    <SelectValue>{t(labelKeys[value])}</SelectValue>
                </SelectTrigger>
            </Tooltip>
            <SelectContent>
                {options.map((option) => (
                    <SelectItem key={option} value={option}>
                        {t(labelKeys[option])}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

function Divider() {
    return <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />;
}

function OperatorChip({ chip, onRemove }: { chip: SessionSearchFilterChip; onRemove: () => void }) {
    const { t } = useTranslation();
    const label = t(chipLabelKeys[chip.kind], {
        value: chip.kind === 'agent' ? resolveAgentIcon(chip.value).label : chip.value,
    });
    return (
        <span
            className="flex h-6 items-center gap-1 rounded border border-border bg-elevated pr-0.5 pl-2 text-[12px] text-foreground"
            data-session-search-operator={chip.kind}
        >
            {label}
            <button
                aria-label={t('session.search.chip.remove', { filter: label })}
                className="flex size-5 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-border hover:text-foreground"
                type="button"
                onClick={onRemove}
            >
                <X size={12} />
            </button>
        </span>
    );
}
