import type { TranslatedNamespace } from '@caxri/protocol';

import type { settingsNotifications as source } from '../en/settings-notifications';

export const settingsNotifications: TranslatedNamespace<typeof source> = {
    'settings.notificationHelper.status.helper': '由通知助手投递',
    'settings.notificationHelper.status.native': '由 macOS 通知投递',
    'settings.notificationHelper.status.missing': '尚未安装通知助手。请运行以下命令安装：',
    'settings.notificationHelper.status.basic':
        '正在使用基础 macOS 通知。请运行以下命令安装通知助手：',
    'settings.notificationHelper.note.basic': '点击通知横幅无法打开对应会话。',
    'settings.notificationHelper.note.unavailable': '安装通知助手之前，无法显示通知横幅。',
    'settings.notificationHelper.copyCommand': '复制',
    'settings.notificationHelper.checkAgain': '重新检查',
    'settings.notificationHelper.checking': '正在检查…',
    'settings.notificationHelper.sendTest': '发送测试通知',
    'settings.notificationHelper.openMacosSettings': '打开 macOS 通知设置',
    'settings.notificationHelper.test.title': 'Caxri',
    'settings.notificationHelper.test.body': '这是一条测试通知。',
    'settings.notificationHelper.test.sent':
        '测试通知已发送。如果没有看到，请检查 macOS 通知设置和专注模式。',
    'settings.notificationHelper.test.notSent': '无法发送测试通知。',
    'settings.notificationHelper.test.failed': '无法发送测试通知',
    'settings.notificationHelper.recheck.failed': '无法检查通知状态',
    'settings.notificationHelper.openMacosSettings.failed': '无法打开 macOS 设置',
    'settings.notificationHelper.toast.unavailable': '未安装通知助手，系统通知目前无法显示。',
    'settings.environmentMonitor.timeZone.off': '关闭',
    'settings.environmentMonitor.timeZone.searchLabel': '搜索时区',
    'settings.environmentMonitor.timeZone.searchPlaceholder': '搜索时区…',
    'settings.environmentMonitor.timeZone.empty': '没有匹配的时区。',
    'settings.environmentMonitor.mihomo.ariaLabel': 'Mihomo 路由断言',
    'settings.environmentMonitor.mihomo.controllerLabel': '本地 Mihomo Controller',
    'settings.environmentMonitor.mihomo.secretLabel': 'Mihomo Controller 密钥',
    'settings.environmentMonitor.mihomo.secretPlaceholder': '密钥（可选）',
    'settings.environmentMonitor.mihomo.controllerDescription':
        '支持本机回环 HTTP 地址和绝对 Unix Socket。Caxri 只读取代理节点和实时连接数据。',
    'settings.environmentMonitor.mihomo.loadNodes': '读取节点',
    'settings.environmentMonitor.mihomo.loadingNodes': '正在读取…',
    'settings.environmentMonitor.mihomo.off': '已关闭。读取节点并添加域名路由后才会开始监测。',
    'settings.environmentMonitor.mihomo.routesLabel': '已监测的域名路由',
    'settings.environmentMonitor.mihomo.domainLabel': '精确域名',
    'settings.environmentMonitor.mihomo.expectedNodeLabel': '预期 Mihomo 节点',
    'settings.environmentMonitor.mihomo.expectedNodeFor': '{{domain}} 的预期节点',
    'settings.environmentMonitor.mihomo.loadNodesFirst': '请先读取节点',
    'settings.environmentMonitor.mihomo.addRoute': '添加路由',
    'settings.environmentMonitor.mihomo.removeRoute': '移除 {{domain}} 的路由',
    'settings.environmentMonitor.mihomo.invalidController':
        '请输入本机回环 HTTP 地址或绝对 Unix Socket。',
    'settings.environmentMonitor.mihomo.noNodes': 'Controller 没有返回固定代理节点。',
    'settings.environmentMonitor.mihomo.unavailable':
        '无法读取本地 Mihomo Controller，请检查地址和密钥。',
    'settings.environmentMonitor.mihomo.invalidDomain': '请输入 example.com 这样的精确域名。',
    'settings.environmentMonitor.mihomo.duplicateDomain': '该域名已经设置了路由。',
    'settings.environmentMonitor.mihomo.chooseNode': '请选择预期节点。',
    'settings.environmentMonitor.mihomo.invalidRule': '无法保存该路由。',
};
