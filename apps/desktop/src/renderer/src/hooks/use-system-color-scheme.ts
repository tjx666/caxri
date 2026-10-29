import { useSyncExternalStore } from 'react';

import type { SystemColorScheme } from '@caxri/protocol';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeSystemColorScheme(onChange: () => void): () => void {
    const query = matchMedia(SYSTEM_DARK_QUERY);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
}

/**
 * Reads the live system appearance once, outside React. Chromium derives `prefers-color-scheme` from the macOS
 * appearance (including the automatic sunrise/sunset switch), so the Renderer needs no Main-process channel for it.
 */
export function readSystemColorScheme(): SystemColorScheme {
    return matchMedia(SYSTEM_DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * The system appearance, re-rendering the caller when it changes while the app runs.
 */
export function useSystemColorScheme(): SystemColorScheme {
    return useSyncExternalStore(subscribeSystemColorScheme, readSystemColorScheme);
}
