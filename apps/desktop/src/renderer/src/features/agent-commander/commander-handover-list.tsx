import type { KeyboardEvent } from 'react';

import { FolderPlus, TriangleAlert } from 'lucide-react';

import { Checkbox } from '../../components/ui/checkbox';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { localizedRelativeTime } from '../../lib/relative-time';
import type { HandoverCandidate, HandoverCandidateGroup } from './commander-handover';

/**
 * Adds or removes a run of candidates in one update, so a group header shares the row checkbox's path.
 */
export type ToggleCandidates = (keys: readonly string[], isChecked: boolean) => void;

const ROW_CHECKBOX_SELECTOR = '[data-handover-checkbox]';

/**
 * ↑ and ↓ move between checkboxes, header and row alike, so the whole list is reachable without Tab stepping through
 * every row; Space toggles the focused one, as on any checkbox.
 */
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const boxes = [...event.currentTarget.querySelectorAll<HTMLElement>(ROW_CHECKBOX_SELECTOR)];
    if (boxes.length === 0) return;
    event.preventDefault();
    const index = boxes.indexOf(document.activeElement as HTMLElement);
    const next =
        index === -1
            ? 0
            : Math.min(boxes.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
    boxes[next].focus();
}

/**
 * The picker's candidates grouped by Project, each group with a checkbox for all of its rows. A conversation in no
 * visible Project groups under its folder, which the header says handing it over adds as a Project.
 */
export function CommanderHandoverList({
    groups,
    now,
    onToggle,
    selection,
}: {
    groups: readonly HandoverCandidateGroup[];
    now: number;
    onToggle: ToggleCandidates;
    selection: ReadonlySet<string>;
}) {
    const { t } = useTranslation();
    return (
        <div className="commander-handover-list grid gap-3" onKeyDown={moveFocus}>
            {groups.map((group) => {
                const keys = group.candidates.map((candidate) => candidate.key);
                const selectedCount = keys.filter((key) => selection.has(key)).length;
                const isGroupSelected = selectedCount === keys.length;
                const headingId = `commander-handover-group-${group.key}`;
                return (
                    <section
                        key={group.key}
                        aria-labelledby={headingId}
                        className="overflow-hidden rounded border border-border bg-background"
                        data-handover-group={group.key}
                    >
                        <header className="flex h-9 items-center gap-2 border-b border-border bg-surface px-3">
                            <Checkbox
                                aria-label={t('agentCommander.handover.selectGroup', {
                                    group: group.title,
                                })}
                                checked={isGroupSelected}
                                data-handover-checkbox=""
                                indeterminate={!isGroupSelected && selectedCount > 0}
                                onCheckedChange={(next) => onToggle(keys, next === true)}
                            />
                            {group.newProjectRoot && (
                                <FolderPlus
                                    aria-hidden="true"
                                    className="flex-none text-muted"
                                    size={13}
                                />
                            )}
                            <h3
                                id={headingId}
                                className="m-0 min-w-0 flex-1 truncate text-[12px] font-semibold"
                            >
                                {group.title}
                            </h3>
                            {group.newProjectRoot && (
                                <span className="flex-none text-[10px] text-muted">
                                    {t('agentCommander.handover.addsProject')}
                                </span>
                            )}
                            <span className="text-[10px] text-muted tabular-nums">
                                {group.candidates.length}
                            </span>
                        </header>
                        <div className="divide-y divide-border">
                            {group.candidates.map((candidate) => (
                                <HandoverCandidateRow
                                    key={candidate.key}
                                    candidate={candidate}
                                    isSelected={selection.has(candidate.key)}
                                    now={now}
                                    onToggle={onToggle}
                                />
                            ))}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}

function HandoverCandidateRow({
    candidate,
    isSelected,
    now,
    onToggle,
}: {
    candidate: HandoverCandidate;
    isSelected: boolean;
    now: number;
    onToggle: ToggleCandidates;
}) {
    const { locale, t } = useTranslation();
    return (
        <label
            aria-selected={isSelected}
            className="commander-handover-row grid min-h-11 cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-1.5 hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] aria-selected:bg-[var(--selection)]"
            data-handover-key={candidate.key}
        >
            <Checkbox
                aria-label={t('agentCommander.handover.selectCandidate', {
                    title: candidate.title,
                })}
                checked={isSelected}
                data-handover-checkbox=""
                onCheckedChange={(next) => onToggle([candidate.key], next === true)}
            />
            <AgentIdentityIcon identity={candidate.agentKind} size={14} />
            <span className="min-w-0">
                <span className="block truncate text-[12px]">{candidate.title}</span>
                <span className="flex items-center gap-1.5 text-[10px] text-muted">
                    {resolveAgentIcon(candidate.agentKind).label}
                    {candidate.mayBeOpen && (
                        <span className="commander-handover-open flex items-center gap-1 text-warning">
                            <TriangleAlert aria-hidden="true" size={10} />
                            {t('agentCommander.handover.mayBeOpen')}
                        </span>
                    )}
                </span>
            </span>
            <span className="text-[11px] whitespace-nowrap text-muted tabular-nums">
                {localizedRelativeTime(candidate.updatedAt, now, 'narrow', locale)}
            </span>
        </label>
    );
}
