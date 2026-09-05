import { useState } from 'react';

import { FolderGit2, LoaderCircle } from 'lucide-react';

import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '../../components/ui/select';
import { Separator } from '../../components/ui/separator';
import { caxri } from '../../lib/caxri';
import { cn } from '../../lib/utilities';
import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { statusItemClassName } from './status-item';

const AUTHORIZE_WORKBENCH_ROOT_VALUE = '__authorize_workbench_root__';

export function WorkbenchRootPicker({ branch, sessionId }: { branch?: string; sessionId: string }) {
    const session = useSelectedSession();
    const workbenchProject = useSelectedWorkbenchProject();
    const [open, setOpen] = useState(false);
    const [switching, setSwitching] = useState(false);
    const rootsQuery = useCaxriQuery(
        'session.workbenchRoots',
        { sessionId },
        { enabled: open, staleTime: 0 },
    );
    useToastOnQueryError(rootsQuery.isError, rootsQuery.error, 'Unable to list Workbench Roots');
    if (!session || !workbenchProject) return null;
    const roots = rootsQuery.data ?? [
        {
            projectId: workbenchProject.id,
            displayTitle: workbenchProject.displayTitle,
            branch: branch ?? 'No branch',
            owner: workbenchProject.id === session.projectId,
        },
    ];
    const current = roots.find((root) => root.projectId === session.workbenchProjectId) ?? roots[0];
    const switchRoot = async (projectId: string | null): Promise<void> => {
        if (!projectId || switching) return;
        setSwitching(true);
        try {
            if (projectId === AUTHORIZE_WORKBENCH_ROOT_VALUE) {
                const selected = await tryCommand('Unable to authorize Workbench Root', () =>
                    caxri.request('session.authorizeWorkbenchRoot', { sessionId }),
                );
                if (selected && !('canceled' in selected))
                    await useWorkbenchStore.getState().refresh();
                return;
            }
            if (projectId === session.workbenchProjectId) return;
            const selected = await tryCommand('Unable to switch Workbench Root', () =>
                caxri.request('session.selectWorkbenchRoot', { sessionId, projectId }),
            );
            if (selected) await useWorkbenchStore.getState().refresh();
        } finally {
            setSwitching(false);
        }
    };
    return (
        <Select
            value={session.workbenchProjectId}
            open={open}
            disabled={switching}
            onOpenChange={setOpen}
            onValueChange={(value) => {
                // eslint-disable-next-line no-void -- intentional floating-promise discard, switchRoot() reports its own errors via tryCommand
                void switchRoot(value);
            }}
        >
            <SelectTrigger
                showIcon={false}
                aria-label={`Switch Workbench Root from ${current.displayTitle}, branch ${current.branch}`}
                title={workbenchProject.rootPath}
                className={cn(
                    statusItemClassName,
                    'h-5 w-auto max-w-full justify-start px-[5px] text-[11px]',
                )}
            >
                <FolderGit2 size={13} />
                {/**
                 * The trigger shows only the root's title: the adjacent BranchPicker already renders the same branch, so repeating it
                 * here made the status bar read "title · branch · branch". The dropdown items keep "title · branch" because the branch
                 * is what tells parallel worktree roots apart.
                 */}
                <SelectValue>{current.displayTitle}</SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-96 min-w-56">
                {roots.map((root) => (
                    <SelectItem key={root.projectId} value={root.projectId} className="max-w-96">
                        {root.displayTitle} · {root.branch}
                    </SelectItem>
                ))}
                <Separator className="my-1" />
                <SelectItem value={AUTHORIZE_WORKBENCH_ROOT_VALUE} className="max-w-96">
                    Authorize another worktree…
                </SelectItem>
                {rootsQuery.isLoading && (
                    <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-muted">
                        <LoaderCircle className="animate-spin" size={12} />
                        Loading Workbench Roots…
                    </div>
                )}
            </SelectContent>
        </Select>
    );
}
