import { useState } from 'react';

import type { WorkbenchRootOption } from '@caxri/protocol';

import { usePolledQuery } from '@/hooks/use-polled-query';

import { awaitThenCleanup } from '../../../lib/await-then-cleanup';
import { selectWorkbenchRoot } from '../workbench-root-commands';
import { useStatusBarPickerRequest } from './use-status-bar-picker-request';

/**
 * How often a closed picker re-reads the roots so its trigger can point at the worktree this Session's conversation
 * moved into. The read is a local `git worktree list` plus a transcript scan the Server already shares, and it runs
 * only while the Session is still on its own root, which is the only case the Server ranks a recommendation for.
 */
const CONVERSATION_ROOT_POLL_MS = 60_000;

/**
 * `isOnOwnRoot`: the Session is still bound to its Project's root rather than a linked worktree, so the conversation
 * may recommend somewhere else. `workbenchProjectId` finds that root among the answer: the Server ranks a
 * recommendation only while it is the Git main worktree, so once a read shows it is not (a Project added at a linked
 * worktree, or a folder that is not a repository), the closed picker stops polling for a dot that can never appear.
 */
export function useWorkbenchRootPicker(
    sessionId: string,
    isOnOwnRoot: boolean,
    workbenchProjectId: string | undefined,
) {
    const [open, setOpen] = useState(false);
    const [all, setAll] = useState(false);
    const [search, setSearch] = useState('');
    const [switching, setSwitching] = useState(false);
    const [switchingLabel, setSwitchingLabel] = useState('');
    /**
     * Learned from the previous answer, so it starts optimistic and settles after the first read. `usePolledQuery`
     * takes a plain `enabled`, so the answer feeds back through state, adjusted during render as React documents for
     * state derived from a previous render.
     *
     * @see https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
     */
    const [canRecommend, setCanRecommend] = useState(true);
    const rootsQuery = usePolledQuery(
        'session.workbenchRoots',
        { sessionId },
        {
            label: 'session.workbenchRoots',
            intervalMs: CONVERSATION_ROOT_POLL_MS,
            enabled: open || (isOnOwnRoot && canRecommend),
            // Fresh for one poll, so switching back to a Session does not re-read what the last poll just answered.
            // Opening the menu refetches explicitly instead (see `changeOpen`).
            staleTime: CONVERSATION_ROOT_POLL_MS,
        },
    );
    const roots = rootsQuery.data;
    if (roots) {
        const isCurrentMain =
            roots.find((root) => root.projectId === workbenchProjectId)?.isMain === true;
        if (canRecommend !== isCurrentMain) setCanRecommend(isCurrentMain);
    }
    const changeOpen = (isOpen: boolean) => {
        if (switching) return;
        setOpen(isOpen);
        if (isOpen) {
            setAll(false);
            setSearch('');
            // The menu must never offer a worktree removed since the last read, whatever the cache says.
            void rootsQuery.refetch();
        }
    };
    useStatusBarPickerRequest('workbenchRoot', () => changeOpen(true));
    const select = async (root: WorkbenchRootOption) => {
        if (switching) return;
        setSwitching(true);
        setSwitchingLabel(root.displayTitle);
        setOpen(false);
        const selected = await awaitThenCleanup(selectWorkbenchRoot(sessionId, root), () =>
            setSwitching(false),
        );
        if (selected !== 'selected') setOpen(true);
    };
    return {
        open,
        all,
        search,
        switching,
        switchingLabel,
        rootsQuery,
        changeOpen,
        setAll,
        setSearch,
        select,
    };
}
