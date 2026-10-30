import type { TranslatedNamespace } from '@caxri/protocol';

import type { processExplorer as source } from '../en/process-explorer';

export const processExplorer: TranslatedNamespace<typeof source> = {
    // Title bar
    'processExplorer.title': '进程资源管理器 — Caxri',
    'processExplorer.refresh': '刷新进程',
    'processExplorer.openFailed': '无法打开进程资源管理器',
    // Summary bar
    'processExplorer.summary.label': '资源概览',
    'processExplorer.summary.cpu': 'CPU',
    'processExplorer.summary.memory': '内存',
    'processExplorer.summary.processes': '进程',
    'processExplorer.summary.pty': '终端名额',
    'processExplorer.summary.ptyTooltip': '本机同时允许打开的终端数量',
    'processExplorer.summary.ptyHigh': '，终端名额即将用完',
    'processExplorer.filter.placeholder': '筛选',
    'processExplorer.filter.label': '筛选进程',
    'processExplorer.scope.label': '显示的进程类别',
    'processExplorer.scope.caxri': 'Caxri',
    'processExplorer.scope.caxriTooltip': 'Caxri 自身的进程：窗口、Server Core 和辅助进程',
    'processExplorer.scope.agents': 'Agent',
    'processExplorer.scope.agentsTooltip': 'Agent CLI、终端 Shell 及其启动的进程',
    'processExplorer.scope.other': '其他应用',
    'processExplorer.scope.otherTooltip': 'Caxri 之外占用终端名额的应用',
    // Table header
    'processExplorer.columns.name': '名称',
    'processExplorer.columns.cpu': 'CPU',
    'processExplorer.columns.memory': '内存',
    'processExplorer.columns.pty': '名额',
    'processExplorer.columns.pid': 'PID',
    'processExplorer.header.sortBy': '按{{column}}排序',
    'processExplorer.header.resize': '调整“{{column}}”列宽',
    // Grid and list messages
    'processExplorer.gridLabel': 'Caxri 进程',
    'processExplorer.list.loading': '正在加载进程…',
    'processExplorer.list.empty': '未找到 Caxri 进程。',
    'processExplorer.list.noScope': '所选类别下没有进程。',
    'processExplorer.list.noMatch': '没有与“{{filter}}”匹配的进程。',
    'processExplorer.error.sample': '无法采集进程信息，请重试。',
    'processExplorer.error.sampleStale': '无法刷新进程信息，当前显示上一次采集的结果。',
    'processExplorer.error.stop': '无法挂起 {{name}}，请重试。',
    // Rows
    'processExplorer.row.highResource': '，资源占用高',
    'processExplorer.row.stopTooltip': '挂起此终端，重新打开其会话即可恢复',
    'processExplorer.row.stopLabel': '挂起 {{name}}',
    // Tree grouping
    'processExplorer.kind.helper': '辅助进程',
    'processExplorer.kind.main': '主进程',
    'processExplorer.kind.service': '服务',
    'processExplorer.kind.window': '窗口',
    'processExplorer.terminal': '终端',
    'processExplorer.untitledSession': '未命名会话',
    'processExplorer.sessionsGroup': '会话',
    'processExplorer.otherAppsGroup': '其他应用',
    'processExplorer.processCount': '{{count}} 个进程',
    // Footer
    'processExplorer.footer.live': '实时 · 每 {{seconds}} 秒更新',
    'processExplorer.footer.noSample': '暂无当前采样',
    'processExplorer.footer.updated': '更新于 {{time}}',
};
