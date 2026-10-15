/**
 * Parses the emulator display state (`wm density`, `wm size`, font scale, rotation) an Android case saves before it
 * changes the display and restores exactly afterwards.
 */
interface AndroidDisplayStateSource {
    density: string;
    fontScale: string;
    rotation: string;
    size: string;
}

export interface AndroidDisplayState {
    density: { override?: number; physical: number };
    fontScale: number;
    rotation: number;
    size: {
        override?: { height: number; width: number };
        physical: { height: number; width: number };
    };
}

function requiredNumber(source: string, pattern: RegExp, field: string): number {
    const value = pattern.exec(source)?.[1];
    if (!value) throw new Error(`Android ${field} state is unavailable`);
    return Number(value);
}

function size(source: string, label: 'Override' | 'Physical') {
    const match = new RegExp(String.raw`${label} size: (\d+)x(\d+)`, 'u').exec(source);
    if (!match) return;
    return { height: Number(match[2]), width: Number(match[1]) };
}

/**
 * Android 36 no longer publishes `SurfaceOrientation` in `dumpsys input`. Its fallback must stay bound to the active
 * primary internal viewport because the same output also contains inactive virtual viewports with stale orientation.
 */
function rotation(source: string): number {
    const legacy = /SurfaceOrientation:\s*(\d+)/u.exec(source)?.[1];
    const activeViewportLine = source
        .split(/\r?\n/u)
        .find(
            (line) =>
                line.includes('Viewport INTERNAL:') &&
                line.includes('displayId=0,') &&
                line.includes('isActive=[1]'),
        );
    const activeViewport = activeViewportLine
        ? /orientation=(\d+)/u.exec(activeViewportLine)?.[1]
        : undefined;
    const value = legacy ?? activeViewport;
    if (!value) throw new Error('Android rotation state is unavailable');
    return Number(value);
}

export function parseAndroidDisplayState(source: AndroidDisplayStateSource): AndroidDisplayState {
    const physicalSize = size(source.size, 'Physical');
    if (!physicalSize) throw new Error('Android physical display size is unavailable');
    const overrideDensity = /Override density: (\d+)/u.exec(source.density)?.[1];
    const overrideSize = size(source.size, 'Override');
    return {
        density: {
            ...(overrideDensity && { override: Number(overrideDensity) }),
            physical: requiredNumber(source.density, /Physical density: (\d+)/u, 'density'),
        },
        fontScale: requiredNumber(source.fontScale, /(\d+(?:\.\d+)?)/u, 'font scale'),
        rotation: rotation(source.rotation),
        size: { ...(overrideSize && { override: overrideSize }), physical: physicalSize },
    };
}
