import type { TranslatedNamespace } from '@caxri/protocol';

import type { windowZoom as source } from '../en/window-zoom';

export const windowZoom: TranslatedNamespace<typeof source> = {
    'windowZoom.changeFailed': '无法更改缩放级别',
    'windowZoom.hud.label': '缩放',
    'windowZoom.hud.percent': '缩放 {{percent}}%',
    'windowZoom.hud.zoomOut': '缩小',
    'windowZoom.hud.zoomIn': '放大',
    'windowZoom.hud.reset': '重置',
    'windowZoom.hud.resetTooltip': '恢复默认缩放 (100%)',
    'windowZoom.indicator.label': '窗口缩放 {{percent}}%',
    'windowZoom.indicator.tooltip': '窗口已缩放到 {{percent}}%，点击可调整或重置',
};
