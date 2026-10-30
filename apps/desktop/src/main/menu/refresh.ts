import type { Keybinding } from '@caxri/protocol';

import type { DesktopServerConnection } from '../connection/server-connection';
import { setMainLanguage } from '../locale';
import { createMenuKeybindingFailureInjection } from './keybinding-failure';

export interface MenuRefreshControllerOptions {
    applyKeybindings(keybindings: Keybinding[]): void;
    loadKeybindings(): Promise<Keybinding[]>;
}

export interface MenuRefreshController {
    refresh(): Promise<void>;
}

/**
 * Serializes native-menu refreshes so a slow read cannot overwrite a newer one. A request received during an active
 * read is collapsed into one trailing refresh, which observes the newest Server state after connection recovery. Failed
 * reads deliberately leave the installed Electron menu untouched: the current menu is the last-known-good state, while
 * the next configuration or recovery event schedules convergence again.
 */
export function createMenuRefreshController(
    options: MenuRefreshControllerOptions,
): MenuRefreshController {
    let inFlight: Promise<void> | undefined;
    let requestedGeneration = 0;

    const run = async () => {
        while (true) {
            const observedGeneration = requestedGeneration;
            try {
                // Sequential by design: each trailing pass must observe the newest state after the previous read.
                // eslint-disable-next-line no-await-in-loop -- the trailing pass must remain ordered
                options.applyKeybindings(await options.loadKeybindings());
            } catch {
                /**
                 * A transient Server outage is not an empty keybinding configuration. Skipping installation preserves
                 * the last menu that was built from a successful response.
                 */
            }
            if (observedGeneration === requestedGeneration) return;
        }
    };

    const track = async (refresh: Promise<void>) => {
        try {
            await refresh;
        } finally {
            inFlight = undefined;
        }
    };

    return {
        refresh() {
            requestedGeneration += 1;
            if (inFlight) return inFlight;
            inFlight = track(run());
            return inFlight;
        },
    };
}

/**
 * Reads everything the native menu renders: the keybindings for its accelerators and the language for its labels.
 */
export function createMenuStateLoader(
    server: () => Pick<DesktopServerConnection, 'request'>,
    systemLanguages: () => readonly string[],
): () => Promise<Keybinding[]> {
    const injectMenuKeybindingFailure = createMenuKeybindingFailureInjection();
    return async () => {
        const [keybindings, settings] = await Promise.all([
            server().request('keybindings.get'),
            server().request('settings.get'),
        ]);
        setMainLanguage(settings.value['workbench.language'], systemLanguages());
        return injectMenuKeybindingFailure(keybindings.value);
    };
}
