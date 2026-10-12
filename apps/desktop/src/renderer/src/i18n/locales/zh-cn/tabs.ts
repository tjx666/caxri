import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { tabs as source } from '../en/tabs';

export const tabs: TranslatedNamespace<typeof source> = {
    'tabs.description.inDetail': '位于 {{detail}}。',
    'tabs.description.unsaved': '有未保存的更改。',
};
