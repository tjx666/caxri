import type { TranslatedNamespace } from '@caxri/protocol';

import type { components as source } from '../en/components';

export const components: TranslatedNamespace<typeof source> = {
    'components.back': '返回',
    'components.done': '完成',
    'components.openLinkFailed.message': '此设备上没有可以打开 {{url}} 的应用。',
    'components.openLinkFailed.title': '无法打开链接',
    'components.routeError.body': '此页面意外停止。电脑上的会话不受影响。',
    'components.routeError.retryHint': '重新加载此页面。',
    'components.routeError.title': '出现问题',
    'components.tryAgain': '重试',
};
