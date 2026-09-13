import { useState } from 'react';

import type { WorkbenchRootOption } from '@caxri/protocol';

import { useCaxriQuery, useToastOnQueryError } from '../../queries/client';
import { selectWorkbenchRoot } from './workbench-root-commands';

export function useWorkbenchRootPicker(sessionId: string) {
    const [open, setOpen] = useState(false);
    const [all, setAll] = useState(false);
    const [switching, setSwitching] = useState(false);
    const rootsQuery = useCaxriQuery(
        'session.workbenchRoots',
        { sessionId },
        { enabled: open, staleTime: 0 },
    );
    useToastOnQueryError(rootsQuery.isError, rootsQuery.error, 'Unable to list Workbench Roots');
    const changeOpen = (isOpen: boolean) => {
        if (switching) return;
        setOpen(isOpen);
        if (isOpen) setAll(false);
    };
    const select = async (root: WorkbenchRootOption) => {
        if (switching) return;
        setSwitching(true);
        setOpen(false);
        try {
            const selected = await selectWorkbenchRoot(sessionId, root);
            if (selected !== 'selected') setOpen(true);
        } finally {
            setSwitching(false);
        }
    };
    return { open, all, switching, rootsQuery, changeOpen, setAll, select };
}
