import type { BotTask } from '@caxri/protocol';

import { Checkbox } from '../../components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { useTranslation } from '../../i18n';
import { localizedRelativeTime } from '../../lib/relative-time';
import type { BotTaskChoice } from './bot-clear-data';
import type { BotClearDataState } from './hooks/use-bot-clear-data';

/**
 * Which tasks a ticked Tasks entry deletes: the finished ones (the default, and what a cleanup usually means), every
 * one, or the ones the user picks from the list. Picking shows the ledger the way `bot task list --all` returns it,
 * open tasks first.
 */
export function BotClearDataTasks({ state }: { state: BotClearDataState }) {
    const { t } = useTranslation();
    const { counts, data, selection, summary } = state;
    if (!counts || !data || !selection) return null;
    return (
        <div className="bot-clear-data-tasks grid gap-2">
            <ToggleGroup
                aria-label={t('caxriBot.clearData.taskChoiceLabel')}
                value={[selection.taskChoice]}
                onValueChange={(next: BotTaskChoice[]) => {
                    const picked = next.at(0);
                    if (picked) state.update({ taskChoice: picked });
                }}
            >
                <ToggleGroupItem value="closed" disabled={counts.closed === 0}>
                    {t('caxriBot.clearData.taskChoiceClosed')}
                    <span className="tabular-nums opacity-70">· {counts.closed}</span>
                </ToggleGroupItem>
                <ToggleGroupItem value="all">
                    {t('caxriBot.clearData.taskChoiceAll')}
                    <span className="tabular-nums opacity-70">· {counts.all}</span>
                </ToggleGroupItem>
                <ToggleGroupItem value="chosen" className="bot-clear-data-choose">
                    {t('caxriBot.clearData.taskChoiceChosen')}
                    {selection.chosenTaskIds.size > 0 && (
                        <span className="tabular-nums opacity-70">
                            · {selection.chosenTaskIds.size}
                        </span>
                    )}
                </ToggleGroupItem>
            </ToggleGroup>
            {selection.taskChoice === 'chosen' && (
                <ul className="m-0 grid max-h-52 list-none gap-px overflow-auto rounded-md border border-border bg-background p-1">
                    {data.tasks.map((task) => (
                        <TaskRow
                            key={task.id}
                            isChecked={selection.chosenTaskIds.has(task.id)}
                            now={summary.dataUpdatedAt}
                            task={task}
                            onCheckedChange={(isChecked) => state.toggleTask(task.id, isChecked)}
                        />
                    ))}
                    {data.taskCount > data.tasks.length && (
                        <li className="px-2 py-1 text-[11px] text-muted">
                            {t(
                                data.taskCount - data.tasks.length === 1
                                    ? 'caxriBot.clearData.olderTasksOne'
                                    : 'caxriBot.clearData.olderTasks',
                                { count: data.taskCount - data.tasks.length },
                            )}
                        </li>
                    )}
                </ul>
            )}
        </div>
    );
}

function TaskRow({
    isChecked,
    now,
    onCheckedChange,
    task,
}: {
    isChecked: boolean;
    now: number;
    onCheckedChange: (isChecked: boolean) => void;
    task: BotTask;
}) {
    const { locale, t } = useTranslation();
    return (
        <li>
            <label
                className="grid min-h-7 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded px-2 text-[12px] hover:bg-[var(--selection)]"
                data-bot-task={task.id}
            >
                <Checkbox
                    checked={isChecked}
                    onCheckedChange={(next) => onCheckedChange(next === true)}
                />
                <span className="truncate">{task.title}</span>
                <span className="text-[11px] text-muted">
                    {t(`caxriBot.clearData.taskStatus.${task.status}`)}
                </span>
                <span className="w-10 text-right text-[11px] text-muted tabular-nums">
                    {localizedRelativeTime(task.updatedAt, now, 'narrow', locale)}
                </span>
            </label>
        </li>
    );
}
