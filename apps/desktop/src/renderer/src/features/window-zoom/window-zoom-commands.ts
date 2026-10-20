import { settingsSpecByKey } from '@caxri/protocol';

import { translate } from '../../i18n';
import { tryCommand } from '../../stores/toasts';
import { applyFormEdit } from '../settings/config-edit';
import { getSettings, updateSettings } from '../settings/settings-client';

const zoomSpec = settingsSpecByKey['window.zoomLevel'];

export type WindowZoomStep = 'in' | 'out' | 'reset';

/**
 * Lowest and highest `window.zoomLevel`, so a zoom control can disable the step that would do nothing.
 */
export const WINDOW_ZOOM_BOUNDS = { min: zoomSpec.min, max: zoomSpec.max } as const;

/**
 * Whether this window's zoom indicator has its controls open. The HUD stays hidden meanwhile: the open row already
 * shows each change, and a second copy of it appearing at the top of the window would only distract.
 */
export const windowZoomIndicator = { isOpen: false };

/**
 * The page scale a `window.zoomLevel` gives, as a whole percent: Chromium's 20% per level (`zoomFactorForLevel` in
 * `main/window-chrome.ts`), so level -1 reads 83% and level 1 reads 120%.
 */
export function windowZoomPercent(level: number): number {
    return Math.round(1.2 ** level * 100);
}

/**
 * The next `window.zoomLevel` for one step, clamped to the setting's bounds. Reset returns `undefined`, which removes
 * the key from `settings.jsonc` so the file keeps only choices the user actually made.
 */
export function nextWindowZoomLevel(current: number, step: WindowZoomStep): number | undefined {
    if (step === 'reset') return undefined;
    const next = current + (step === 'in' ? 1 : -1);
    return Math.min(zoomSpec.max, Math.max(zoomSpec.min, next));
}

/**
 * Tail of the serialized zoom writes; held in an object so each step can chain onto it.
 */
const zoomQueue: { tail: Promise<unknown> } = { tail: Promise.resolve() };

/**
 * Zoom is stored as `window.zoomLevel`, the same setting the Settings page edits, and Main applies it to the window
 * when `settings.changed` arrives. The write is an edit of the current `settings.jsonc` source, so comments and every
 * other key survive. Steps are serialized: a held `Cmd+=` repeats faster than one read-modify-write round trip, and two
 * overlapping writes built from the same source would silently drop a step.
 */
export function stepWindowZoom(step: WindowZoomStep): Promise<unknown> {
    const previous = zoomQueue.tail;
    const current = (async () => {
        await previous;
        return tryCommand(translate('windowZoom.changeFailed'), async () => {
            const { source, value } = await getSettings();
            const level = value['window.zoomLevel'];
            const next = nextWindowZoomLevel(level, step);
            if (next === level) return;
            await updateSettings({ source: applyFormEdit(source, ['window.zoomLevel'], next) });
        });
    })();
    zoomQueue.tail = current;
    return current;
}
