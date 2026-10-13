import type { KeyboardEvent } from 'react';

import type { CommanderHandoverRejection } from '@caxri/protocol';
import { FolderPlus, TriangleAlert } from 'lucide-react';

import { Checkbox } from '../../components/ui/checkbox';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { localizedRelativeTime } from '../../lib/relative-time';
import type { HandoverCandidate, HandoverCandidateGroup } from './commander-handover';
import { handoverRejectionLabelKeys } from './commander-handover';

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
 * visible Project groups under its folder, which the header says handing it over adds as a Project. A row the last
 * request refused carries the reason on its own second line.
 */
export function CommanderHandoverList({
    groups,
    now,
    onToggle,
    refusedByKey,
    selection,
}: {
    groups: readonly HandoverCandidateGroup[];
    now: number;
    onToggle: ToggleCandidates;
    refusedByKey: ReadonlyMap<string, CommanderHandoverRejection>;
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
                        className="overflow-hidden rounded-md border border-border bg-background"
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
                                <span className="flex-none text-[11px] text-muted">
                                    {t('agentCommander.handover.addsProject')}
                                </span>
                            )}
                            <span className="text-[11px] text-muted tabular-nums">
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
                                    refusal={refusedByKey.get(candidate.key)}
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

/**
 * One candidate. The checkbox carries the checked state for assistive technology; the row only paints it, through
 * `data-selected` rather than `aria-selected`, which a `<label>` has no role to support. Hover and selection read the
 * shared `--list-*` row tokens, so an imported theme reaches this list as it does every other picker.
 */
function HandoverCandidateRow({
    candidate,
    isSelected,
    now,
    onToggle,
    refusal,
}: {
    candidate: HandoverCandidate;
    isSelected: boolean;
    now: number;
    onToggle: ToggleCandidates;
    refusal?: CommanderHandoverRejection;
}) {
    const { locale, t } = useTranslation();
    return (
        <label
            className="commander-handover-row grid min-h-11 cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-1.5 hover:bg-list-hover-background hover:text-list-hover-foreground data-[selected=true]:bg-list-inactive-selection-background data-[selected=true]:text-list-inactive-selection-foreground"
            data-handover-key={candidate.key}
            data-handover-refused={refusal}
            data-selected={isSelected}
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
                <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
                    {resolveAgentIcon(candidate.agentKind).label}
                    {candidate.mayBeOpen && !refusal && (
                        <span className="commander-handover-open flex items-center gap-1 text-warning">
                            <TriangleAlert aria-hidden="true" size={11} />
                            {t('agentCommander.handover.mayBeOpen')}
                        </span>
                    )}
                    {refusal && (
                        <span className="commander-handover-refusal flex min-w-0 items-center gap-1 text-warning">
                            <TriangleAlert aria-hidden="true" className="flex-none" size={11} />
                            <span className="truncate">
                                {t('agentCommander.handover.refusedReason', {
                                    reason: t(handoverRejectionLabelKeys[refusal]),
                                })}
                            </span>
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
