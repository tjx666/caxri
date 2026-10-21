import { useState } from 'react';

import type { SessionSearchEntry } from '@caxri/protocol';
import { Check, Copy } from 'lucide-react';

import {
    COPY_FEEDBACK_RESET_MS,
    writeToClipboardWithFeedback,
} from '../../../components/copy-feedback';
import { Tooltip } from '../../../components/ui/tooltip';
import { useRelativeTimes } from '../../../hooks/use-relative-time';
import type { Translate } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { resolveAgentIcon } from '../../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../../icons/agents/agent-identity-icon';
import { cn } from '../../../lib/utilities';
import { sessionTitleForDisplay } from '../session-title';
import { runSessionSearchAction } from './session-search-commands';
import type { SessionSearchAction } from './session-search-model';
import { sessionSearchAction, shortFolder, snippetSegments } from './session-search-model';

const actionLabelKeys = {
    open: 'session.search.action.open',
    restore: 'session.search.action.restore',
    import: 'session.search.action.import',
} as const satisfies Record<SessionSearchAction, string>;

const statusLabelKeys = {
    open: 'session.search.status.open',
    archived: 'session.search.status.archived',
    external: 'session.search.status.external',
} as const satisfies Record<SessionSearchEntry['status'], string>;

const statusClassNames: Record<SessionSearchEntry['status'], string> = {
    open: 'text-muted',
    archived: 'text-warning',
    external: 'text-accent',
};

function entryTitle(entry: SessionSearchEntry, t: Translate): string {
    if (entry.status !== 'external') return sessionTitleForDisplay(entry.title, t);
    return entry.title || t('session.search.untitledConversation');
}

/**
 * Who wrote the quoted message: the user, or the Agent by name, so a quote of the user's own request reads apart from
 * the Agent's answer.
 */
function snippetSpeaker(entry: SessionSearchEntry, t: Translate): string {
    if (entry.match.snippet?.role === 'user') return t('session.search.speaker.user');
    return resolveAgentIcon(entry.provider).label;
}

/**
 * The second line: where the query matched. A message match quotes the message with the matched terms highlighted; a
 * folder or ID match names what matched, since the title above already shows a title match.
 */
function MatchLine({ entry }: { entry: SessionSearchEntry }) {
    const { t } = useTranslation();
    const { field, snippet } = entry.match;
    if (snippet)
        return (
            <span className="session-search-snippet line-clamp-2 text-[12px] break-words text-muted">
                <span className="font-medium text-foreground">
                    {t('session.search.speakerPrefix', { speaker: snippetSpeaker(entry, t) })}
                </span>
                {snippetSegments(snippet).map((segment, index) =>
                    segment.isMatch ? (
                        <mark key={index} className="rounded-sm bg-warning px-0.5 text-background">
                            {segment.text}
                        </mark>
                    ) : (
                        <span key={index}>{segment.text}</span>
                    ),
                )}
            </span>
        );
    if (field === 'id' || field === 'path')
        return (
            <span className="text-[12px] text-muted">
                {t(field === 'id' ? 'session.search.matchedId' : 'session.search.matchedPath')}
            </span>
        );
    return null;
}

function CopyIdButton({ id }: { id: string }) {
    const { t } = useTranslation();
    const [isCopied, setCopied] = useState(false);
    const label = t('session.search.action.copyId');
    return (
        <Tooltip content={label}>
            <button
                aria-label={label}
                className="grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:bg-elevated hover:text-foreground"
                type="button"
                onClick={async (event) => {
                    event.stopPropagation();
                    const status = await writeToClipboardWithFeedback(navigator.clipboard, id);
                    if (status !== 'copied') return;
                    setCopied(true);
                    setTimeout(() => setCopied(false), COPY_FEEDBACK_RESET_MS);
                }}
            >
                {isCopied ? <Check size={13} /> : <Copy size={13} />}
            </button>
        </Tooltip>
    );
}

/**
 * One conversation per row: Agent, title, where it lives, when it last changed, what matched, and its folder. The
 * selected or hovered row reveals its action and Copy ID, so a dense list stays quiet until the user points at a row.
 */
export function SessionSearchResults({
    entries,
    id,
    query,
    rowId,
    selectedIndex,
    onSelect,
}: {
    entries: readonly SessionSearchEntry[];
    id: string;
    /**
     * The query the entries answer, handed to find in the Chat a row opens.
     */
    query: string;
    rowId: (index: number) => string;
    selectedIndex: number;
    onSelect: (index: number) => void;
}) {
    const { t } = useTranslation();
    const times = useRelativeTimes(
        entries.map((entry) => entry.updatedAt),
        'narrow',
    );
    return (
        <div
            aria-label={t('session.search.results')}
            className="session-search-results min-h-0 flex-1 overflow-y-auto py-1"
            id={id}
            role="listbox"
        >
            {entries.map((entry, index) => {
                const action = sessionSearchAction(entry);
                const isSelected = index === selectedIndex;
                const copyableId = entry.agentSessionId ?? entry.sessionId;
                return (
                    <div
                        key={entry.key}
                        aria-selected={isSelected}
                        className="group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2.5 px-3 py-2 hover:bg-list-hover-background aria-selected:bg-list-active-selection-background aria-selected:text-list-active-selection-foreground"
                        data-session-search-key={entry.key}
                        data-session-search-status={entry.status}
                        id={rowId(index)}
                        role="option"
                        onClick={() => {
                            onSelect(index);
                            // eslint-disable-next-line no-void -- the command reports its own failure through a toast
                            void runSessionSearchAction(entry, query);
                        }}
                        onMouseMove={() => {
                            if (!isSelected) onSelect(index);
                        }}
                    >
                        <span className="pt-0.5">
                            <AgentIdentityIcon identity={entry.provider ?? 'shell'} size={14} />
                        </span>
                        <span className="grid min-w-0 gap-0.5">
                            <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-[13px] font-medium">
                                    {entryTitle(entry, t)}
                                </span>
                                <span
                                    className={cn(
                                        'flex-none text-[11px]',
                                        statusClassNames[entry.status],
                                    )}
                                >
                                    {t(statusLabelKeys[entry.status])}
                                </span>
                            </span>
                            <MatchLine entry={entry} />
                            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                                {entry.cwd && (
                                    <span className="truncate">
                                        {isSelected ? entry.cwd : shortFolder(entry.cwd)}
                                    </span>
                                )}
                                {entry.match.messageCount !== undefined &&
                                    entry.match.messageCount > 1 && (
                                        <span className="flex-none">
                                            ·{' '}
                                            {t('session.search.messageCountOther', {
                                                count: entry.match.messageCount,
                                            })}
                                        </span>
                                    )}
                                {entry.status === 'external' && !action && (
                                    <span className="flex-none text-warning">
                                        · {t('session.search.noFolder')}
                                    </span>
                                )}
                            </span>
                        </span>
                        <span className="flex flex-col items-end gap-1">
                            <span className="text-[11px] text-muted tabular-nums">
                                {times[index]}
                            </span>
                            <span
                                className={cn(
                                    'flex items-center gap-1',
                                    !isSelected && 'invisible group-hover:visible',
                                )}
                            >
                                {copyableId && <CopyIdButton id={copyableId} />}
                                {action && (
                                    <span className="rounded bg-elevated px-1.5 py-0.5 text-[11px] text-foreground">
                                        {t(actionLabelKeys[action])}
                                    </span>
                                )}
                            </span>
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
