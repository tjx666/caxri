import type { PersistedWindowState } from '@caxri/protocol';
import type { Rectangle } from 'electron';

export type AuxiliaryWindowBounds = PersistedWindowState['bounds'];

type DisplayMatcher = (rect: Rectangle) => { workArea: Rectangle };

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
 * Resolves the bounds a reopening auxiliary window should use from its remembered rectangle, clamped to whichever
 * currently attached display Electron matches it against. `getDisplayMatching` is injected so this stays a pure,
 * Electron-free function in tests; production passes `screen.getDisplayMatching`, which always resolves to a real
 * display (falling back to the nearest one), so a display that no longer exists never has to be detected here.
 */
export function resolveAuxiliaryWindowBounds(
    remembered: AuxiliaryWindowBounds | undefined,
    getDisplayMatching: DisplayMatcher,
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

/**
 * Where one auxiliary window (Caxri Bot, Process Explorer) last stood, shared by both controllers so the
 * remember-and-restore rule exists once.
 *
 * The remembered rectangle is kept exactly as the window last reported it, and clamped to the displays attached at the
 * moment the window opens, on every open, not once when the previous quit's state is loaded. The app keeps running
 * while a monitor is unplugged, so a window closed on an external display must still reopen fully on a display that is
 * attached now (https://github.com/tjx666/caxri/issues/1415). Keeping the raw rectangle, rather than overwriting it
 * with the clamped one, lets the window return to that monitor once it is plugged back in.
 *
 * `getDisplayMatching` is injected so this stays Electron-free in tests; production passes `screen.getDisplayMatching`,
 * which may only be called after the app is ready and is therefore read lazily at open time.
 */
export class AuxiliaryWindowBoundsMemory {
    private remembered?: AuxiliaryWindowBounds;

    constructor(
        private readonly defaultSize: { width: number; height: number },
        private readonly getDisplayMatching: DisplayMatcher,
    ) {}

    remember(bounds: AuxiliaryWindowBounds): void {
        this.remembered = bounds;
    }

    /**
     * The unclamped rectangle, which is what quit persists.
     */
    current(): AuxiliaryWindowBounds | undefined {
        return this.remembered;
    }

    /**
     * The bounds a window being created right now should use: the remembered rectangle clamped to a currently attached
     * display, or the default size (centered by Electron) when nothing was remembered.
     */
    boundsForOpen(): AuxiliaryWindowBounds {
        return (
            resolveAuxiliaryWindowBounds(this.remembered, this.getDisplayMatching) ?? {
                ...this.defaultSize,
            }
        );
    }
}
