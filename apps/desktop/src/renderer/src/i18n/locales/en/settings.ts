import { settingsAgents } from './settings-agents';
import { settingsCatalog } from './settings-catalog';
import { settingsClaudeWindows } from './settings-claude-windows';
import { settingsForms } from './settings-forms';
import { settingsKeybindings } from './settings-keybindings';
import { settingsMobile } from './settings-mobile';
import { settingsNotifications } from './settings-notifications';
import { settingsPage } from './settings-page';
import { settingsTheme } from './settings-theme';

/**
 * Settings strings, split by area so each module stays reviewable. `settings-catalog` translates the protocol settings
 * catalog through keys derived from each setting key (`settings.<key>.title`).
 */
export const settings = {
    ...settingsCatalog,
    ...settingsPage,
    ...settingsAgents,
    ...settingsClaudeWindows,
    ...settingsMobile,
    ...settingsNotifications,
    ...settingsKeybindings,
    ...settingsTheme,
    ...settingsForms,
} as const;
