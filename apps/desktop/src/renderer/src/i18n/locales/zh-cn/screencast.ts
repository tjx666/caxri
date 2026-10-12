import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { screencast as source } from '../en/screencast';

export const screencast: TranslatedNamespace<typeof source> = {
    'screencast.toast.on': '已开启录屏模式',
    'screencast.toast.off': '已关闭录屏模式',
};
