import type { settings as source } from '../en/settings';
import type { TranslatedNamespace } from '../types';

export const settings: TranslatedNamespace<typeof source> = {
    'settings.workbench.language.title': '语言',
    'settings.workbench.language.description':
        '界面的显示语言。跟随系统时，系统语言为中文则使用简体中文。',
    'settings.workbench.language.nullLabel': '跟随系统',
};
