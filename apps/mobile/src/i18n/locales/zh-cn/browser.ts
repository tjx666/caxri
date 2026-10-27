import type { TranslatedNamespace } from '@caxri/protocol';

import type { browser as source } from '../en/browser';

export const browser: TranslatedNamespace<typeof source> = {
    'browser.back': '后退',
    'browser.close': '关闭浏览器',
    'browser.closeMenu': '关闭页面菜单',
    'browser.copied': '已复制链接',
    'browser.copyLink': '复制链接',
    'browser.errorBody': '请检查网络连接后重新加载。',
    'browser.errorTitle': '无法加载此页面',
    'browser.menu': '页面菜单',
    'browser.menuHint': '复制、分享，或在其他浏览器中打开此页面。',
    'browser.openExternal': '在浏览器中打开',
    'browser.preview.chipHint': '打开此 Session 在电脑上提供的网页',
    'browser.preview.chipMany': '有 {{count}} 个本地网页可预览',
    'browser.preview.chipOne': '预览端口 {{port}} 上的网页',
    'browser.preview.closeMenu': '关闭预览菜单',
    'browser.preview.openFailedBody': '电脑上的页面可能已停止运行。请检查 dev server 后重试。',
    'browser.preview.openFailedTitle': '无法打开预览',
    'browser.preview.portCount': '{{count}} 个端口',
    'browser.reload': '重新加载',
    'browser.share': '分享',
    'browser.stop': '停止加载',
};
