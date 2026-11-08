import { createSharedLocalState } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

/**
 * Where the monitor shows: a draggable card inside the Workbench, or its own window that survives a Workbench reload.
 */
export type MonitorMode = 'overlay' | 'window';

export interface OverlayPosition {
    x: number;
    y: number;
}

const MODE_KEY = 'caxri.performanceMonitor.mode';
const POSITION_KEY = 'caxri.performanceMonitor.position';

export function parseMode(raw: unknown): MonitorMode {
    return raw === 'window' ? 'window' : 'overlay';
}

/**
 * Reads a saved card position; anything that is not two finite numbers is treated as never saved.
 */
export function parsePosition(value: unknown): OverlayPosition | null {
    if (typeof value !== 'object' || value === null) return null;
    const x: unknown = Reflect.get(value, 'x');
    const y: unknown = Reflect.get(value, 'y');
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

interface MonitorState {
    closeOverlay: () => void;
    isOverlayOpen: boolean;
    mode: MonitorMode;
    openOverlay: () => void;
    position: OverlayPosition | null;
    setMode: (mode: MonitorMode) => void;
    setPosition: (position: OverlayPosition) => void;
}

const modeState = createSharedLocalState(MODE_KEY, parseMode);
const positionState = createSharedLocalState(POSITION_KEY, parsePosition);

/**
 * Window-local UI state. The mode and the card position persist in the profile's `localStorage`
 * (docs/client-local-data.md) but are never subscribed: they are presentation preferences of the window showing the
 * card, and switching the mode in one window must not open or close the monitor in another. The entries only seed the
 * next window that opens.
 */
export const useMonitorStore = createStore<MonitorState>('performanceMonitor', (set) => ({
    closeOverlay: () => set({ isOverlayOpen: false }),
    isOverlayOpen: false,
    mode: modeState.read(),
    openOverlay: () => set({ isOverlayOpen: true }),
    position: positionState.read(),
    setMode: (mode) => {
        modeState.write(mode);
        set({ mode });
    },
    setPosition: (position) => {
        positionState.write(position);
        set({ position });
    },
}));
