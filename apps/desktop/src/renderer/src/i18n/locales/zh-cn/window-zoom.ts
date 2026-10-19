import type { TranslatedNamespace } from '@caxri/protocol';

import type { windowZoom as source } from '../en/window-zoom';

export const windowZoom: TranslatedNamespace<typeof source> = {
    'windowZoom.changeFailed': '无法更改缩放级别',
    'windowZoom.hud.label': '缩放',
    'windowZoom.hud.percent': '缩放 {{percent}}%',
    'windowZoom.hud.zoomOut': '缩小',
    'windowZoom.hud.zoomIn': '放大',
    'windowZoom.hud.reset': '重置',
};
