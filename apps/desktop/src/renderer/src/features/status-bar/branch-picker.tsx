import { useState } from 'react';

import { Check, GitBranch } from 'lucide-react';

import { useRelativeTimes } from '@/hooks/use-relative-time';

import { Command, CommandInput, CommandItem, CommandList } from '../../components/ui/command';
import { Dialog, PickerDialogContent } from '../../components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { awaitThenCleanup } from '../../lib/await-then-cleanup';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { switchBranch } from './branch-commands';
import { useStatusBarPickerRequest } from './hooks/use-status-bar-picker-request';
import { PickerQueryStatus } from './picker-query-status';
import { pickerSearchScore } from './picker-search';
import { statusItemClassName } from './status-item';

export function BranchPicker({
    branch,
    repositoryId,
    sessionId,
    showTrigger = true,
}: {
    branch: string;
    repositoryId: string;
    sessionId: string;
    showTrigger?: boolean;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [switching, setSwitching] = useState<string>();
    useStatusBarPickerRequest('branch', () => setOpen(true));
    const branchesQuery = useCaxriQuery(
        'git.branches',
        { sessionId, repositoryId },
        { enabled: open },
    );
    const loadedBranches = branchesQuery.data ?? [];
    // The current branch is pinned first; the rest keep the Server's most-recent-commit order.
    // Before the query resolves only the current branch is known, without a commit time.
    const branches: Array<{ name: string; committedAt?: number }> = [
        loadedBranches.find((candidate) => candidate.name === branch) ?? { name: branch },
        ...loadedBranches.filter((candidate) => candidate.name !== branch),
    ];
    const committedLabels = useRelativeTimes(branches.map(({ committedAt }) => committedAt));

    const selectBranch = async (nextBranch: string): Promise<void> => {
        if (nextBranch === branch || switching) return;
        setSwitching(nextBranch);
        setOpen(false);
        await awaitThenCleanup(switchBranch(sessionId, repositoryId, nextBranch), () =>
            setSwitching(undefined),
        );
    };

    const content = (
        <Command
            // `cmdk` points the input's `aria-labelledby` at this label, and
            // `aria-labelledby` outranks `aria-label`, so this string (not a prop on
            // `CommandInput`) is the search field's accessible name. The popup keeps
            // `Branches` as its own dialog name above.
            label={t('statusBar.branch.searchLabel')}
            defaultValue={branch}
            filter={pickerSearchScore}
        >
            <CommandInput autoFocus placeholder={t('statusBar.branch.searchPlaceholder')} />
            <CommandList className="max-h-[min(360px,var(--available-height))]">
                <PickerQueryStatus noun="branches" query={branchesQuery} />
                {branches.map(({ name, committedAt }, index) => (
                    <CommandItem
                        key={name}
                        value={name}
                        disabled={Boolean(switching)}
                        className="items-center text-[13px]"
                        onSelect={() => {
                            void selectBranch(name);
                        }}
                    >
                        <Check
                            size={13}
                            className={cn('flex-none', name !== branch && 'invisible')}
                            aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate">{name}</span>
                        {committedAt !== undefined && (
                            <span className="flex-none text-[11px] text-muted">
                                {committedLabels[index]}
                            </span>
                        )}
                    </CommandItem>
                ))}
            </CommandList>
        </Command>
    );
    /**
     * Keep command access independent of the optional status bar trigger.
     */
    if (!showTrigger) {
        return (
            <Dialog
                open={open}
                onOpenChange={(isOpen) => {
                    if (!switching) setOpen(isOpen);
                }}
            >
                <PickerDialogContent aria-label={t('statusBar.branch.dialogLabel')}>
                    {content}
                </PickerDialogContent>
            </Dialog>
        );
    }

    const switchingLabel = switching
        ? t('statusBar.branch.switching', { branch: switching })
        : undefined;
    const triggerLabel = switchingLabel ?? t('statusBar.branch.switchFrom', { branch });
    return (
        <Popover
            open={open}
            onOpenChange={(isOpen) => {
                if (switching) return;
                setOpen(isOpen);
            }}
        >
            <Tooltip
                content={triggerLabel}
                // Same reason as the Workbench Root trigger: an open menu must not sit under its own trigger's tooltip.
                disabled={open}
            >
                <PopoverTrigger
                    role="combobox"
                    aria-expanded={open}
                    aria-haspopup="listbox"
                    aria-disabled={Boolean(switching)}
                    aria-busy={Boolean(switching)}
                    aria-label={triggerLabel}
                    className={cn(
                        statusItemClassName,
                        // Capped rather than shrinking, so the bar can measure its natural width (`chip-priority.ts`).
                        'h-5 w-auto max-w-60 flex-none justify-start px-[5px] text-[11px]',
                    )}
                >
                    {switching ? (
                        <Spinner size={13} />
                    ) : (
                        <GitBranch size={13} className="flex-none" />
                    )}
                    <span className="min-w-0 truncate" role={switching ? 'status' : undefined}>
                        {switching ? switchingLabel : branch}
                    </span>
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent
                side="top"
                className="w-96 max-w-[calc(100vw-16px)]"
                aria-label={t('statusBar.branch.dialogLabel')}
            >
                {content}
            </PopoverContent>
        </Popover>
    );
}
