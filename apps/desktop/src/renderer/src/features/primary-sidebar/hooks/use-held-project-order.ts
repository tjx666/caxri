import { useState } from 'react';

import { resolveHeldProjectOrder } from '../project-order';

/**
 * The Project order to draw. Holds the currently displayed order while `isHeld` is on (pointer inside the list or a
 * drag in progress) so a Server re-sort cannot swap the row under the cursor, and applies the newest order as soon as
 * it releases. `releaseKey` changes when the user's own reorder lands, which must show immediately even with the
 * pointer still inside the list.
 */
export function useHeldProjectOrder(
    latest: readonly string[],
    isHeld: boolean,
    releaseKey: number,
): readonly string[] {
    const [displayed, setDisplayed] = useState<readonly string[]>(latest);
    const [lastReleaseKey, setLastReleaseKey] = useState(releaseKey);
    if (releaseKey !== lastReleaseKey) setLastReleaseKey(releaseKey);
    const next = resolveHeldProjectOrder(
        displayed,
        latest,
        isHeld && releaseKey === lastReleaseKey,
    );
    // Adjusting state during render is the supported way to derive from props without an extra effect pass.
    const isSame =
        next.length === displayed.length && next.every((id, index) => id === displayed[index]);
    if (!isSame) setDisplayed(next);
    return isSame ? displayed : next;
}
