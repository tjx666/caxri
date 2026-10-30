export const processExplorer = {
    // Title bar
    'processExplorer.title': 'Process Explorer — Caxri',
    'processExplorer.refresh': 'Refresh processes',
    'processExplorer.openFailed': 'Unable to open Process Explorer',
    // Summary bar
    'processExplorer.summary.label': 'Resource summary',
    'processExplorer.summary.cpu': 'CPU',
    'processExplorer.summary.memory': 'Memory',
    'processExplorer.summary.processes': 'Processes',
    'processExplorer.summary.pty': 'PTY',
    'processExplorer.summary.ptyHigh': ', nearly out of PTY slots',
    'processExplorer.filter.placeholder': 'Filter',
    'processExplorer.filter.label': 'Filter processes',
    'processExplorer.scope.label': 'Process categories to show',
    'processExplorer.scope.caxri': 'Caxri',
    'processExplorer.scope.caxriTooltip':
        "Caxri's own processes: windows, Server Core, and helpers",
    'processExplorer.scope.agents': 'Agents',
    'processExplorer.scope.agentsTooltip':
        'Agent CLIs, Terminal shells, and the processes they start',
    'processExplorer.scope.other': 'Other apps',
    'processExplorer.scope.otherTooltip': 'Apps outside Caxri that hold PTYs',
    // Table header
    'processExplorer.columns.name': 'Name',
    'processExplorer.columns.cpu': 'CPU',
    'processExplorer.columns.memory': 'Memory',
    'processExplorer.columns.pty': 'PTY',
    'processExplorer.columns.pid': 'PID',
    'processExplorer.header.sortBy': 'Sort by {{column}}',
    'processExplorer.header.resize': 'Resize {{column}} column',
    // Grid and list messages
    'processExplorer.gridLabel': 'Caxri processes',
    'processExplorer.list.loading': 'Loading processes…',
    'processExplorer.list.empty': 'No Caxri processes found.',
    'processExplorer.list.noScope': 'No processes in the shown categories.',
    'processExplorer.list.noMatch': 'No processes match “{{filter}}”.',
    'processExplorer.error.sample': 'Unable to sample processes. Try again.',
    'processExplorer.error.stop': 'Unable to suspend {{name}}. Try again.',
    // Rows
    'processExplorer.row.highResource': ', high resource use',
    'processExplorer.row.stopTooltip': 'Suspend this Terminal; reopen its Session to resume',
    'processExplorer.row.stopLabel': 'Suspend {{name}}',
    // Tree grouping
    'processExplorer.kind.helper': 'Helper',
    'processExplorer.kind.main': 'Main process',
    'processExplorer.kind.service': 'Service',
    'processExplorer.kind.window': 'Window',
    'processExplorer.terminal': 'Terminal',
    'processExplorer.untitledSession': 'Untitled Session',
    'processExplorer.sessionsGroup': 'Sessions',
    'processExplorer.otherAppsGroup': 'Other apps',
    'processExplorer.processCount': '{{count}} processes',
    // Footer
    'processExplorer.footer.live': 'Live · updates every {{seconds}} seconds',
    'processExplorer.footer.noSample': 'No current sample',
    'processExplorer.footer.updated': 'Updated {{time}}',
} as const;
