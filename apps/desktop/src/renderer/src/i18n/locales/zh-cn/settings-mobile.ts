import type { TranslatedNamespace } from '@caxri/protocol';

import type { settingsMobile as source } from '../en/settings-mobile';

export const settingsMobile: TranslatedNamespace<typeof source> = {
    'settings.mobileAccess.loading': '正在加载移动端访问…',
    'settings.mobileAccess.status.available': '已在当前网络上可用',
    'settings.mobileAccess.status.offByDefault': '默认关闭',
    'settings.mobileAccess.status.listeningOne': '{{address}}:{{port}} · {{count}} 台活跃设备',
    'settings.mobileAccess.status.listeningOther': '{{address}}:{{port}} · {{count}} 台活跃设备',
    'settings.mobileAccess.status.noListener': '本地网络监听未运行',
    'settings.mobileAccess.status.turnOnLabel': '开启移动端访问',
    'settings.mobileAccess.status.turnOffLabel': '关闭移动端访问',
    'settings.mobileAccess.status.turnOn': '开启',
    'settings.mobileAccess.status.turnOff': '关闭',
    'settings.mobileAccess.projects.title': '项目访问权限',
    'settings.mobileAccess.projects.description':
        '新设备只能看到所选项目，你可以随时撤销。已选 {{selected}} 个 · 最多 {{max}} 个。',
    'settings.mobileAccess.projects.allow': '允许访问 {{project}}',
    'settings.mobileAccess.projects.createPairing': '生成配对码',
    'settings.mobileAccess.pairing.expired': '已过期',
    'settings.mobileAccess.pairing.expiresIn': '{{remaining}} 后过期',
    'settings.mobileAccess.pairing.scan': '使用 Caxri Mobile 扫描',
    'settings.mobileAccess.pairing.description':
        '{{expiration}}。此配对码仅可使用一次，且只在你的本地网络中有效。',
    'settings.mobileAccess.pairing.copyLink': '复制配对链接',
    'settings.mobileAccess.devices.title': '已配对设备',
    'settings.mobileAccess.devices.revoked': '已撤销',
    'settings.mobileAccess.devices.paired': '已配对',
    'settings.mobileAccess.devices.role.view': '查看',
    'settings.mobileAccess.devices.role.reply': '回复',
    'settings.mobileAccess.devices.role.control': '控制',
    'settings.mobileAccess.devices.lastConnected': '上次连接于 {{time}}',
    'settings.mobileAccess.devices.access': '访问范围：{{projects}}',
    'settings.mobileAccess.devices.revoke': '撤销 {{device}}',
    'settings.mobileAccess.devices.unavailable': '+{{count}} 个不可用',
    'settings.mobileAccess.error.load': '无法加载移动端访问。',
    'settings.mobileAccess.error.enable': '移动端访问需要一个可用的私有本地网络。',
    'settings.mobileAccess.error.disable': '无法关闭移动端访问。',
    'settings.mobileAccess.error.createPairing': '无法生成配对码。',
    'settings.mobileAccess.error.revoke': '无法撤销此设备。',
    'settings.mobileAccess.error.copyLink': '无法复制配对链接。',
};
