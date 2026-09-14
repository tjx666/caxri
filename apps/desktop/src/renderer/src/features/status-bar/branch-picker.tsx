import { useState } from 'react';

import { relativeTime } from '@caxri/utils';
import { GitBranch } from 'lucide-react';

import { useNow } from '@/hooks/use-now';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { switchBranch } from './branch-commands';
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

    const selectBranch = async (nextBranch: string | null): Promise<void> => {
        if (!nextBranch || nextBranch === branch || switching) return;
        setSwitching(true);
        try {
            await switchBranch(sessionId, repositoryId, nextBranch);
        } finally {
            setSwitching(false);
        }
    };

    return (
        <Select
            value={branch}
            open={open}
            disabled={switching}
            onOpenChange={setOpen}
            onValueChange={(value) => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, switchBranch() reports its own errors via tryCommand
                void selectBranch(value);
            }}
        >
            <SelectTrigger
                showIcon={false}
                aria-label={`Switch branch from ${branch}`}
                title={`Switch branch from ${branch}`}
                className={cn(
                    statusItemClassName,
                    'h-5 w-auto max-w-full justify-start px-[5px] text-[11px]',
                )}
            >
                <GitBranch size={13} />
                <SelectValue>{branch}</SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-96 min-w-48">
                {branches.map(({ name, committedAt }) => (
                    <SelectItem key={name} value={name} className="max-w-96">
                        <span className="flex min-w-0 items-baseline gap-2">
                            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                                {name}
                            </span>
                            {committedAt !== undefined && (
                                <span className="flex-none text-[11px] text-muted">
                                    {relativeTime(committedAt, now)}
                                </span>
                            )}
                        </span>
                    </SelectItem>
                ))}
                {branchesQuery.isLoading && (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-muted">
                        <Spinner aria-hidden="true" className="size-3" />
                        Loading branches…
                    </div>
                )}
            </SelectContent>
        </Select>
    );
}
