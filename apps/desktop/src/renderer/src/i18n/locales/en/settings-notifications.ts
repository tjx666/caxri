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
} as const;
