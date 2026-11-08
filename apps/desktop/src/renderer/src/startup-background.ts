import { startupBackgroundState } from './lib/startup-background-state';

/**
 * Publishes the remembered light-appearance canvas as `--startup-background` for the startup loader in `index.html`. It
 * stays a separate entry module because the Renderer's Content-Security-Policy forbids inline scripts, and it runs
 * before `main.tsx` so the value is set while the loader is still the only thing on screen. Only a `#rrggbb` value is
 * accepted: the stored string reaches a stylesheet, so anything else is ignored.
 */
const remembered = startupBackgroundState('light').read();
// Storage can be unavailable; the stylesheet's fallback then applies.
if (remembered !== undefined)
    document.documentElement.style.setProperty('--startup-background', remembered);
