import type { TranslatedNamespace } from '@caxri/protocol';

import type { settings as source } from '../en/settings';
import { settingsAgents } from './settings-agents';
import { settingsCatalog } from './settings-catalog';
import { settingsClaudeWindows } from './settings-claude-windows';
import { settingsForms } from './settings-forms';
import { settingsKeybindings } from './settings-keybindings';
import { settingsMobile } from './settings-mobile';
import { settingsPage } from './settings-page';
import { settingsTheme } from './settings-theme';

export const settings: TranslatedNamespace<typeof source> = {
    ...settingsCatalog,
    ...settingsPage,
    ...settingsAgents,
    ...settingsClaudeWindows,
    ...settingsMobile,
    ...settingsKeybindings,
    ...settingsTheme,
    ...settingsForms,
};
