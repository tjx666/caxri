export const settingsNotifications = {
    'settings.notificationHelper.status.helper': 'Delivered by the notification helper',
    'settings.notificationHelper.status.native': 'Delivered by macOS notifications',
    'settings.notificationHelper.status.missing':
        'Notification helper not installed. Install it with:',
    'settings.notificationHelper.status.basic':
        'Using basic macOS notifications. Install the notification helper with:',
    'settings.notificationHelper.note.basic': 'Clicking a banner will not open its Session.',
    'settings.notificationHelper.note.unavailable':
        'Banners cannot be shown until the helper is installed.',
    'settings.notificationHelper.copyCommand': 'Copy',
    'settings.notificationHelper.checkAgain': 'Check Again',
    'settings.notificationHelper.checking': 'Checking…',
    'settings.notificationHelper.sendTest': 'Send Test Notification',
    'settings.notificationHelper.openMacosSettings': 'Open macOS Notification Settings',
    'settings.notificationHelper.test.title': 'Caxri',
    'settings.notificationHelper.test.body': 'This is a test notification.',
    'settings.notificationHelper.test.sent':
        'Test notification sent. If you do not see it, check macOS notification settings and Focus mode.',
    'settings.notificationHelper.test.notSent': 'Could not send the test notification.',
    'settings.notificationHelper.test.failed': 'Unable to send the test notification',
    'settings.notificationHelper.recheck.failed': 'Unable to check notifications',
    'settings.notificationHelper.openMacosSettings.failed': 'Unable to open macOS settings',
    'settings.notificationHelper.toast.unavailable':
        'System notifications are not being shown because the notification helper is not installed.',
    'settings.environmentMonitor.timeZone.off': 'Off',
    'settings.environmentMonitor.timeZone.searchLabel': 'Search time zones',
    'settings.environmentMonitor.timeZone.searchPlaceholder': 'Search time zones…',
    'settings.environmentMonitor.timeZone.empty': 'No matching time zone.',
    'settings.environmentMonitor.mihomo.ariaLabel': 'Mihomo route assertions',
    'settings.environmentMonitor.mihomo.controllerLabel': 'Local Mihomo Controller',
    'settings.environmentMonitor.mihomo.secretLabel': 'Mihomo Controller secret',
    'settings.environmentMonitor.mihomo.secretPlaceholder': 'Secret (optional)',
    'settings.environmentMonitor.mihomo.controllerDescription':
        'Local loopback HTTP endpoints and absolute Unix sockets are supported. Caxri only reads proxy and live connection data.',
    'settings.environmentMonitor.mihomo.loadNodes': 'Load Nodes',
    'settings.environmentMonitor.mihomo.loadingNodes': 'Loading…',
    'settings.environmentMonitor.mihomo.off':
        'Off. Add a domain route after loading nodes to start monitoring.',
    'settings.environmentMonitor.mihomo.routesLabel': 'Monitored domain routes',
    'settings.environmentMonitor.mihomo.domainLabel': 'Exact domain',
    'settings.environmentMonitor.mihomo.expectedNodeLabel': 'Expected Mihomo node',
    'settings.environmentMonitor.mihomo.expectedNodeFor': 'Expected node for {{domain}}',
    'settings.environmentMonitor.mihomo.loadNodesFirst': 'Load nodes first',
    'settings.environmentMonitor.mihomo.addRoute': 'Add Route',
    'settings.environmentMonitor.mihomo.removeRoute': 'Remove route for {{domain}}',
    'settings.environmentMonitor.mihomo.invalidController':
        'Enter a local loopback HTTP endpoint or an absolute Unix socket.',
    'settings.environmentMonitor.mihomo.noNodes': 'The Controller returned no fixed proxy nodes.',
    'settings.environmentMonitor.mihomo.unavailable':
        'Cannot read the local Mihomo Controller. Check the endpoint and secret.',
    'settings.environmentMonitor.mihomo.invalidDomain':
        'Enter an exact domain such as example.com.',
    'settings.environmentMonitor.mihomo.duplicateDomain': 'That domain already has a route.',
    'settings.environmentMonitor.mihomo.chooseNode': 'Choose an expected node.',
    'settings.environmentMonitor.mihomo.invalidRule': 'The route could not be saved.',
} as const;
