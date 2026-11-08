import { createSharedLocalState } from './local-storage';

/**
 * The canvas color the startup loader paints, keyed by system appearance so a light-mode launch never inherits what a
 * dark-mode session painted. Only a `#rrggbb` value is accepted: the stored string reaches a stylesheet, so anything
 * else reads as unset. Written by the Workbench appearance hook and read once by the `startup-background` entry module,
 * so neither side subscribes (docs/client-local-data.md).
 */
export function startupBackgroundState(scheme: string) {
    return createSharedLocalState(`caxri.startupBackground.${scheme}`, parseStartupBackground);
}

function parseStartupBackground(stored: unknown): string | undefined {
    return typeof stored === 'string' && /^#[\da-f]{6}$/i.test(stored) ? stored : undefined;
}
