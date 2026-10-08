import { useEffect, useRef } from 'react';

import { useLatestReference } from '../../hooks/use-latest-reference';
import type { StatusBarPicker } from '../../stores/dialogs';
import { useDialogStore } from '../../stores/dialogs';

/**
 * Opens one status-bar picker when a command asks for it, following the shared "bump a revision to request something"
 * contract (see `hooks/use-focus-on-revision.ts`). The chip keeps owning its own popover state; the command only asks,
 * so asking twice in a row still re-opens the picker the second time.
 *
 * The revision the chip has already seen is captured at mount rather than compared against zero, so remounting a chip
 * (switching Sessions, for instance) cannot replay a request the user already answered and closed.
 */
export function useStatusBarPickerRequest(picker: StatusBarPicker, open: () => void): void {
    const revision = useDialogStore((state) =>
        state.statusBarPickerRequest?.picker === picker ? state.statusBarPickerRequest.id : 0,
    );
    const latestOpen = useLatestReference(open);
    const handledRevision = useRef(revision);

    useEffect(() => {
        if (revision === handledRevision.current) return;
        handledRevision.current = revision;
        if (revision) latestOpen.current();
    }, [revision, latestOpen]);
}
