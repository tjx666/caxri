import type { WorkbenchRootOption } from '@caxri/protocol';
import { Check, FolderGit2, LoaderCircle } from 'lucide-react';

import {
    Command,
    CommandEmpty,
    CommandInput,
    CommandItem,
    CommandList,
} from '../../components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { Separator } from '../../components/ui/separator';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { useSelectedSession, useSelectedWorkbenchProject } from '../../stores/selectors';
import { statusItemClassName } from './status-item';
import { useWorkbenchRootPicker } from './use-workbench-root-picker';
import {
    visibleWorkbenchRoots,
    workbenchRootLabel,
    workbenchRootSearchScore,
} from './workbench-root-options';

function WorktreeOption({
    root,
    roots,
    current,
    disabled,
    onSelect,
}: {
    root: WorkbenchRootOption;
    roots: WorkbenchRootOption[];
    current: boolean;
    disabled: boolean;
    onSelect: () => void;
}) {
    const label = workbenchRootLabel(root, roots);
    const authorization = root.authorization === 'required' ? 'Authorize' : '';
    return (
        <Tooltip
            content={
                <span className="break-all whitespace-pre-wrap">
                    {label}
                    {'\n'}
                    {root.rootPath}
                </span>
            }
        >
            <CommandItem
                value={root.worktreeId}
                keywords={[root.branch, root.displayTitle, root.rootPath]}
                aria-label={`${label}${authorization ? `, ${authorization}` : ''}${root.isMain ? ', Main worktree' : ''}`}
                disabled={disabled}
                onSelect={onSelect}
                className="items-center text-[13px]"
            >
                <Check
                    size={13}
                    className={cn('flex-none', !current && 'invisible')}
                    aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {root.isMain && (
                    <span className="flex-none text-[11px] text-muted">Main worktree</span>
                )}
                {authorization && (
                    <span className="flex-none text-[11px] text-muted">{authorization}</span>
                )}
            </CommandItem>
        </Tooltip>
    );
}

export function WorkbenchRootPicker({ branch, sessionId }: { branch?: string; sessionId: string }) {
    const session = useSelectedSession();
    const workbenchProject = useSelectedWorkbenchProject();
    const picker = useWorkbenchRootPicker(sessionId);
    if (!session || !workbenchProject) return null;
    const roots = picker.rootsQuery.data ?? [];
    const current = roots.find((root) => root.projectId === session.workbenchProjectId);
    const visible = visibleWorkbenchRoots(roots, session.workbenchProjectId, picker.all);
    return (
        <Popover open={picker.open} onOpenChange={picker.changeOpen}>
            <Tooltip content={workbenchProject.rootPath}>
                <PopoverTrigger
                    role="combobox"
                    aria-expanded={picker.open}
                    aria-haspopup="listbox"
                    disabled={picker.switching}
                    aria-label={`Switch Workbench Root from ${workbenchProject.displayTitle}, branch ${current?.branch ?? branch ?? 'No branch'}`}
                    className={cn(
                        statusItemClassName,
                        'h-5 w-auto max-w-full justify-start px-[5px] text-[11px]',
                    )}
                >
                    <FolderGit2 size={13} className="flex-none" />
                    <span className="min-w-0 truncate">{workbenchProject.displayTitle}</span>
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent
                side="top"
                className="w-96 max-w-[calc(100vw-16px)]"
                aria-label="Workbench Roots"
            >
                <Command
                    key={picker.all ? 'all' : 'recent'}
                    label={picker.all ? 'Search worktrees' : 'Workbench Roots'}
                    tabIndex={0}
                    defaultValue={current?.worktreeId}
                    shouldFilter={picker.all}
                    filter={workbenchRootSearchScore}
                >
                    {picker.all && (
                        <CommandInput
                            autoFocus
                            placeholder="Search worktrees…"
                            aria-label="Search worktrees"
                        />
                    )}
                    <CommandList className="max-h-[min(360px,var(--available-height))]">
                        {picker.rootsQuery.isLoading && (
                            <div className="flex items-center gap-2 px-2 py-2 text-muted">
                                <LoaderCircle size={12} className="animate-spin" />
                                Loading worktrees…
                            </div>
                        )}
                        {!picker.rootsQuery.isLoading && (
                            <CommandEmpty>
                                {picker.rootsQuery.isError
                                    ? 'Unable to load worktrees. Reopen to retry.'
                                    : 'No matching worktrees.'}
                            </CommandEmpty>
                        )}
                        {visible.map((root) => (
                            <WorktreeOption
                                key={root.worktreeId}
                                root={root}
                                roots={roots}
                                current={root.projectId === session.workbenchProjectId}
                                disabled={picker.switching}
                                onSelect={() => {
                                    // eslint-disable-next-line no-void -- the action owns its error toast and pending state.
                                    void picker.select(root);
                                }}
                            />
                        ))}
                        {!picker.all && visible.length < roots.length && (
                            <>
                                <Separator className="my-1" />
                                <CommandItem
                                    value="show-all-worktrees"
                                    className="text-[13px]"
                                    onSelect={() => picker.setAll(true)}
                                >
                                    Show all worktrees…
                                    <span className="text-muted">{roots.length}</span>
                                </CommandItem>
                            </>
                        )}
                    </CommandList>
                </Command>
            </PopoverContent>
        </Popover>
    );
}
