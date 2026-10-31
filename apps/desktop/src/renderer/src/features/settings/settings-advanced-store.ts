import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
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

export const useSettingsAdvancedStore = createStore<SettingsAdvancedState>(
    'settings-advanced',
    () => ({ showAdvanced: readLocalStorageJson(STORAGE_KEY) === true }),
);

export function setShowAdvancedSettings(shouldShow: boolean): void {
    useSettingsAdvancedStore.setState({ showAdvanced: shouldShow });
    writeLocalStorageJson(STORAGE_KEY, shouldShow);
}
