export const settingsMobile = {
    // Form shell
    'settings.mobileAccess.loading': 'Loading mobile access…',
    // Status card
    'settings.mobileAccess.status.available': 'Available on this network',
    'settings.mobileAccess.status.offByDefault': 'Off by default',
    'settings.mobileAccess.status.listeningOne': '{{address}}:{{port}} · {{count}} active device',
    'settings.mobileAccess.status.listeningOther':
        '{{address}}:{{port}} · {{count}} active devices',
    'settings.mobileAccess.status.noListener': 'No local network listener is running',
    'settings.mobileAccess.status.turnOnLabel': 'Turn on mobile access',
    'settings.mobileAccess.status.turnOffLabel': 'Turn off mobile access',
    'settings.mobileAccess.status.turnOn': 'Turn on',
    'settings.mobileAccess.status.turnOff': 'Turn off',
    // Project access
    'settings.mobileAccess.projects.title': 'Project access',
    'settings.mobileAccess.projects.description':
        'The new device can see only the selected Projects. You can revoke it at any time. {{selected}} selected · up to {{max}}.',
    'settings.mobileAccess.projects.allow': 'Allow {{project}}',
    'settings.mobileAccess.projects.createPairing': 'Create pairing code',
    // Pairing card
    'settings.mobileAccess.pairing.expired': 'Expired',
    'settings.mobileAccess.pairing.expiresIn': 'Expires in {{remaining}}',
    'settings.mobileAccess.pairing.scan': 'Scan with Caxri Mobile',
    'settings.mobileAccess.pairing.description':
        '{{expiration}}. This code works once and stays on your local network.',
    'settings.mobileAccess.pairing.copyLink': 'Copy pairing link',
    // Paired devices
    'settings.mobileAccess.devices.title': 'Paired devices',
    'settings.mobileAccess.devices.revoked': 'Revoked',
    'settings.mobileAccess.devices.paired': 'Paired',
    // Device roles render lowercase in English, matching the protocol value shown before translation.
    'settings.mobileAccess.devices.role.view': 'view',
    'settings.mobileAccess.devices.role.reply': 'reply',
    'settings.mobileAccess.devices.role.control': 'control',
    'settings.mobileAccess.devices.lastConnected': 'Last connected {{time}}',
    'settings.mobileAccess.devices.access': 'Access: {{projects}}',
    'settings.mobileAccess.devices.revoke': 'Revoke {{device}}',
    'settings.mobileAccess.devices.unavailable': '+{{count}} unavailable',
    // Errors
    'settings.mobileAccess.error.load': 'Unable to load mobile access.',
    'settings.mobileAccess.error.enable': 'Mobile access needs an active private local network.',
    'settings.mobileAccess.error.disable': 'Unable to turn off mobile access.',
    'settings.mobileAccess.error.createPairing': 'Unable to create a pairing code.',
    'settings.mobileAccess.error.revoke': 'Unable to revoke this device.',
    'settings.mobileAccess.error.copyLink': 'Unable to copy the pairing link.',
} as const;
