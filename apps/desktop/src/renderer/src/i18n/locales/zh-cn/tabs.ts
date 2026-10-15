import type { TranslatedNamespace } from '@caxri/protocol';

import type { tabs as source } from '../en/tabs';

export const tabs: TranslatedNamespace<typeof source> = {
    'tabs.description.inDetail': '位于 {{detail}}。',
    'tabs.description.unsaved': '有未保存的更改。',
};
