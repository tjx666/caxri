import { createSharedLocalState } from '../../lib/local-storage';
import { createStore } from '../../lib/store';

const STORAGE_KEY = 'caxri.settings.showAdvanced';

interface SettingsAdvancedState {
    /**
     * Whether the Settings list shows advanced rows without a query. A device-local presentation choice rather than a
     * `settings.jsonc` value: it changes which rows the page lists, never how Caxri behaves. Off by default, so a new
     * user first meets the everyday settings.
     */
    showAdvanced: boolean;
}

function parseShowAdvanced(stored: unknown): SettingsAdvancedState {
    return { showAdvanced: stored === true };
}

/**
 * Shared by every window of the profile (docs/client-local-data.md): a scalar the user chose, so a toggle in one window
 * reaches the others live.
 */
const sharedShowAdvanced = createSharedLocalState(STORAGE_KEY, parseShowAdvanced);

export const useSettingsAdvancedStore = createStore<SettingsAdvancedState>(
    'settings-advanced',
    (set) => {
        // Memory only, so another window's change never writes back.
        sharedShowAdvanced.subscribe((state) => set(state));
        return sharedShowAdvanced.read();
    },
);

export function setShowAdvancedSettings(shouldShow: boolean): void {
    useSettingsAdvancedStore.setState({ showAdvanced: shouldShow });
    sharedShowAdvanced.write(shouldShow);
}
