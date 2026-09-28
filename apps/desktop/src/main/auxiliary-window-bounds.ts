import type { PersistedWindowState } from '@caxri/protocol';
import type { Rectangle } from 'electron';

export type AuxiliaryWindowBounds = PersistedWindowState['bounds'];

/**
 * Clamps a remembered rectangle into one display's visible work area so bounds saved against a larger, or since
 * unplugged, display can never reopen a window off-screen. Width and height beyond the work area shrink to fit; an
 * undefined `x`/`y` (the "default, centered" placeholder a fresh install starts with) is left alone, since there is no
 * remembered position to move.
 */
export function clampBoundsToWorkArea(
    bounds: AuxiliaryWindowBounds,
    workArea: Rectangle,
): AuxiliaryWindowBounds {
    const width = Math.min(bounds.width, workArea.width);
    const height = Math.min(bounds.height, workArea.height);
    if (bounds.x === undefined || bounds.y === undefined) return { width, height };
    return {
        width,
        height,
        x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
        y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    };
}

/**
 * Resolves the bounds a reopening auxiliary window should use from its persisted rectangle, clamped to whichever
 * currently attached display Electron matches it against. `getDisplayMatching` is injected so this stays a pure,
 * Electron-free function in tests; production passes `screen.getDisplayMatching`, which always resolves to a real
 * display (falling back to the nearest one), so a display that no longer exists never has to be detected here.
 */
export function resolveAuxiliaryWindowBounds(
    remembered: AuxiliaryWindowBounds | undefined,
    getDisplayMatching: (rect: Rectangle) => { workArea: Rectangle },
): AuxiliaryWindowBounds | undefined {
    if (!remembered) return undefined;
    const probe: Rectangle = {
        x: remembered.x ?? 0,
        y: remembered.y ?? 0,
        width: remembered.width,
        height: remembered.height,
    };
    return clampBoundsToWorkArea(remembered, getDisplayMatching(probe).workArea);
}
