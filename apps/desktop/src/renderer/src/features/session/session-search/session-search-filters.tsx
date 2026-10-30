import type { SessionSearchStatusFilter } from '@caxri/protocol';
import { sessionSearchStatusFilters } from '@caxri/protocol';
import { X } from 'lucide-react';

import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import type { SessionSearchFilterChip } from './session-search-model';
import {
    sessionSearchFilterChips,
    sessionSearchProviders,
    sessionSearchScopes,
    sessionSearchSorts,
} from './session-search-model';
import type { SessionSearchModel } from './use-session-search';

const chipClassName =
    'flex h-6 cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-2 text-[12px] text-muted hover:bg-elevated hover:text-foreground aria-pressed:bg-elevated aria-pressed:text-foreground';

const statusFilterLabelKeys = {
    all: 'session.search.filter.all',
    caxri: 'session.search.filter.caxri',
    archived: 'session.search.filter.archived',
    external: 'session.search.filter.external',
} as const satisfies Record<SessionSearchStatusFilter, string>;

const sortLabelKeys = {
    relevance: 'session.search.sort.relevance',
    recent: 'session.search.sort.recent',
} as const;

const scopeLabelKeys = {
    currentProject: 'session.search.scope.currentProject',
    allProjects: 'session.search.scope.allProjects',
} as const;

const chipLabelKeys = {
    agent: 'session.search.chip.agent',
    project: 'session.search.chip.project',
    before: 'session.search.chip.before',
    after: 'session.search.chip.after',
} as const satisfies Record<SessionSearchFilterChip['kind'], string>;

/**
 * The filter bar under the search box: Where and Agent filters, the sort and Project-scope toggles, and one removable
 * chip for each operator (`agent:`, `project:`, `before:`, `after:`) the Server parsed out of the query.
 */
export function SessionSearchFilters({ search }: { search: SessionSearchModel }) {
    const { t } = useTranslation();
    const chips = sessionSearchFilterChips(search.result?.filters);
    return (
        <>
            <div className="flex flex-wrap items-center gap-1">
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
                <Divider />
                <div
                    aria-label={t('session.search.agentFilter')}
                    className="flex gap-0.5"
                    role="group"
                >
                    <button
                        aria-pressed={search.provider === undefined}
                        className={chipClassName}
                        type="button"
                        onClick={() => search.setProvider(undefined)}
                    >
                        {t('session.search.allAgents')}
                    </button>
                    {sessionSearchProviders.map((provider) => (
                        <button
                            key={provider}
                            aria-pressed={search.provider === provider}
                            className={chipClassName}
                            data-session-search-provider-filter={provider}
                            type="button"
                            onClick={() =>
                                search.setProvider(
                                    search.provider === provider ? undefined : provider,
                                )
                            }
                        >
                            <AgentIdentityIcon identity={provider} size={12} />
                            {resolveAgentIcon(provider).label}
                        </button>
                    ))}
                </div>
                <div className="ml-auto flex items-center gap-1">
                    {search.hasCurrentProject && (
                        <div
                            aria-label={t('session.search.scope')}
                            className="flex gap-0.5"
                            role="group"
                        >
                            {sessionSearchScopes.map((scope) => (
                                <button
                                    key={scope}
                                    aria-pressed={search.scope === scope}
                                    className={chipClassName}
                                    data-session-search-scope={scope}
                                    type="button"
                                    onClick={() => search.setScope(scope)}
                                >
                                    {t(scopeLabelKeys[scope])}
                                </button>
                            ))}
                        </div>
                    )}
                    {search.hasCurrentProject && <Divider />}
                    <div
                        aria-label={t('session.search.sort')}
                        className="flex gap-0.5"
                        role="group"
                    >
                        {sessionSearchSorts.map((sort) => (
                            <button
                                key={sort}
                                aria-pressed={search.sort === sort}
                                className={chipClassName}
                                data-session-search-sort={sort}
                                type="button"
                                onClick={() => search.setSort(sort)}
                            >
                                {t(sortLabelKeys[sort])}
                            </button>
                        ))}
                    </div>
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
