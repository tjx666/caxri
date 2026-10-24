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

function readStorage(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // A storage-disabled window keeps the choice for this Renderer's lifetime only.
    }
}

export function parseMode(raw: string | null): MonitorMode {
    return raw === 'window' ? 'window' : 'overlay';
}

/**
 * Reads a saved card position; anything that is not two finite numbers is treated as never saved.
 */
export function parsePosition(raw: string | null): OverlayPosition | null {
    if (raw === null) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== 'object' || value === null) return null;
        const x: unknown = Reflect.get(value, 'x');
        const y: unknown = Reflect.get(value, 'y');
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    } catch {
        return null;
    }
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

/**
 * Window-local UI state. The mode and the card position persist in this window's `localStorage`: they are presentation
 * preferences of one Renderer, not Server data, so an SSH Host window or a second Workbench keeps its own.
 */
export const useMonitorStore = createStore<MonitorState>('performanceMonitor', (set) => ({
    closeOverlay: () => set({ isOverlayOpen: false }),
    isOverlayOpen: false,
    mode: parseMode(readStorage(MODE_KEY)),
    openOverlay: () => set({ isOverlayOpen: true }),
    position: parsePosition(readStorage(POSITION_KEY)),
    setMode: (mode) => {
        writeStorage(MODE_KEY, mode);
        set({ mode });
    },
    setPosition: (position) => {
        writeStorage(POSITION_KEY, JSON.stringify(position));
        set({ position });
    },
}));
