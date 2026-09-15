import { useState } from 'react';

import { relativeTime } from '@caxri/utils';
import { Check, GitBranch } from 'lucide-react';

import { useNow } from '@/hooks/use-now';

import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { switchBranch } from './branch-commands';
import { pickerSearchScore } from './picker-search';
import { statusItemClassName } from './status-item';

export function BranchPicker({
    branch,
    repositoryId,
    sessionId,
}: {
    branch: string;
    repositoryId: string;
    sessionId: string;
}) {
    const [open, setOpen] = useState(false);
    const [switching, setSwitching] = useState(false);
    const now = useNow(30_000);
    const branchesQuery = useCaxriQuery(
        'git.branches',
        { sessionId, repositoryId },
        { enabled: open },
    );
    useToastOnQueryError(branchesQuery.isError, branchesQuery.error, 'Unable to list branches');
    const loadedBranches = branchesQuery.data ?? [];
    // The current branch is pinned first; the rest keep the Server's most-recent-commit order.
    // Before the query resolves only the current branch is known, without a commit time.
    const branches: Array<{ name: string; committedAt?: number }> = [
        loadedBranches.find((candidate) => candidate.name === branch) ?? { name: branch },
        ...loadedBranches.filter((candidate) => candidate.name !== branch),
    ];

    const selectBranch = async (nextBranch: string): Promise<void> => {
        if (nextBranch === branch || switching) return;
        setSwitching(true);
        setOpen(false);
        try {
            await switchBranch(sessionId, repositoryId, nextBranch);
        } finally {
            setSwitching(false);
        }
    };

    return (
        <Popover
            open={open}
            onOpenChange={(isOpen) => {
                if (switching) return;
                setOpen(isOpen);
            }}
        >
            <PopoverTrigger
                role="combobox"
                aria-expanded={open}
                aria-haspopup="listbox"
                disabled={switching}
                aria-label={`Switch branch from ${branch}`}
                title={`Switch branch from ${branch}`}
                className={cn(
                    statusItemClassName,
                    'h-5 w-auto max-w-full justify-start px-[5px] text-[11px]',
                )}
            >
                <GitBranch size={13} className="flex-none" />
                <span className="min-w-0 truncate">{branch}</span>
            </PopoverTrigger>
            <PopoverContent
                side="top"
                className="w-96 max-w-[calc(100vw-16px)]"
                aria-label="Branches"
            >
                <Command
                    // `cmdk` points the input's `aria-labelledby` at this label, and
                    // `aria-labelledby` outranks `aria-label`, so this string — not a prop on
                    // `CommandInput` — is the search field's accessible name. The popup keeps
                    // `Branches` as its own dialog name above.
                    label="Search branches"
                    defaultValue={branch}
                    filter={pickerSearchScore}
                >
                    <CommandInput autoFocus placeholder="Search branches…" />
                    <CommandList className="max-h-[min(360px,var(--available-height))]">
                        {branchesQuery.isLoading && (
                            <div className="flex items-center gap-2 px-2 py-2 text-muted">
                                <Spinner aria-hidden="true" className="size-3" />
                                Loading branches…
                            </div>
                        )}
                        {!branchesQuery.isLoading && (
                            <CommandEmpty>
                                {branchesQuery.isError
                                    ? 'Unable to load branches. Reopen to retry.'
                                    : 'No matching branches.'}
                            </CommandEmpty>
                        )}
                        {branches.map(({ name, committedAt }) => (
                            <CommandItem
                                key={name}
                                value={name}
                                disabled={switching}
                                className="items-center text-[13px]"
                                onSelect={() => {
                                    // eslint-disable-next-line no-void -- intentional floating-promise discard, switchBranch() reports its own errors via tryCommand
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
                                        {relativeTime(committedAt, now)}
                                    </span>
                                )}
                            </CommandItem>
                        ))}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
