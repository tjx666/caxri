import { useState } from 'react';

import type { WorkbenchRootOption } from '@caxri/protocol';

import { useCaxriQuery } from '../../../queries/client';
import { selectWorkbenchRoot } from '../workbench-root-commands';
import { useStatusBarPickerRequest } from './use-status-bar-picker-request';

export function useWorkbenchRootPicker(sessionId: string) {
    const [open, setOpen] = useState(false);
    const [all, setAll] = useState(false);
    const [search, setSearch] = useState('');
    const [switching, setSwitching] = useState(false);
    const [switchingLabel, setSwitchingLabel] = useState('');
    const rootsQuery = useCaxriQuery(
        'session.workbenchRoots',
        { sessionId },
        { enabled: open, staleTime: 0 },
    );
    const changeOpen = (isOpen: boolean) => {
        if (switching) return;
        setOpen(isOpen);
        if (isOpen) {
            setAll(false);
            setSearch('');
        }
    };
    useStatusBarPickerRequest('workbenchRoot', () => changeOpen(true));
    const select = async (root: WorkbenchRootOption) => {
        if (switching) return;
        setSwitching(true);
        setSwitchingLabel(root.displayTitle);
        setOpen(false);
        try {
            const selected = await selectWorkbenchRoot(sessionId, root);
            if (selected !== 'selected') setOpen(true);
        } finally {
            setSwitching(false);
        }
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
