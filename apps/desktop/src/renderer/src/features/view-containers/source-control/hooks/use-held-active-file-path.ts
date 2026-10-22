import { useState } from 'react';

import { selectActiveFilePath } from '../../../../stores/selectors';
import { useWorkbenchStore } from '../../../../stores/workbench';
import { useIsViewContainerActive } from '../../view-container-activity';

/**
 * Marks "container hidden" inside the store selector so a hidden view subscribes to nothing that moves.
 */
const HIDDEN = Symbol('hidden');

/**
 * The active editor file path while the Source Control container is visible, frozen at the last shown value while it is
 * hidden.
 *
 * The hold happens at the store selector, not after it: a hidden view that read the live path re-rendered on every
 * work-tab switch even though `useHeldWhileHidden` then discarded the value. While hidden this selector returns a
 * constant, so no tab switch notifies the component. The value is adopted during render on reveal, so the stale path
 * never paints.
 */
export function useHeldActiveFilePath(): string | undefined {
    const isActive = useIsViewContainerActive();
    const live = useWorkbenchStore((state) =>
        isActive ? selectActiveFilePath(state.bootstrap) : HIDDEN,
    );
    const [held, setHeld] = useState(() =>
        selectActiveFilePath(useWorkbenchStore.getState().bootstrap),
    );
    const shown = live === HIDDEN ? held : live;
    if (shown !== held) setHeld(shown);
    return shown;
}
