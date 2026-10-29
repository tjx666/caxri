export const settingsMobile = {
    // Form shell
    'settings.mobileAccess.loading': 'Loading mobile access…',
    // Relay server row
    'settings.mobile.relayStatus.connected': 'Connected to the Relay',
    'settings.mobile.relayStatus.connecting': 'Connecting to the Relay…',
    'settings.mobile.relayStatus.failed': 'Cannot reach the Relay.',
    'settings.mobile.relayStatus.reason.networkError':
        'The address did not answer; check the address and your network.',
    'settings.mobile.relayStatus.reason.registrationRejected': 'The Relay rejected this computer.',
    'settings.mobile.relayStatus.reason.closedByRelay':
        'The Relay closed the connection. Retrying.',
    'settings.mobile.relayStatus.reason.heartbeatTimeout':
        'The Relay stopped responding. Retrying.',
    'settings.mobile.relayStatus.reason.protocolError':
        'The address is not a compatible Caxri Relay.',
    // Status card
    'settings.mobileAccess.status.available': 'Available on this network',
    'settings.mobileAccess.status.off': 'Off',
    'settings.mobileAccess.status.on': 'On',
    'settings.mobileAccess.status.listeningOne': '{{address}}:{{port}} · {{count}} active device',
    'settings.mobileAccess.status.listeningOther':
        '{{address}}:{{port}} · {{count}} active devices',
    'settings.mobileAccess.status.offDetail': 'Turn on to let a phone pair with this computer',
    'settings.mobileAccess.status.waitingDetail': 'Waiting for a network connection',
    'settings.mobileAccess.status.turnOnLabel': 'Turn on mobile access',
    'settings.mobileAccess.status.turnOffLabel': 'Turn off mobile access',
    'settings.mobileAccess.status.turnOn': 'Turn on',
    'settings.mobileAccess.status.turnOff': 'Turn off',
    // Project access
    'settings.mobileAccess.projects.title': 'Project access',
    'settings.mobileAccess.projects.description':
        'This phone can read and reply to Agents, control Terminals, edit files and start Sessions in the selected Projects. You can revoke it at any time. {{selected}} selected · up to {{max}}.',
    'settings.mobileAccess.projects.allow': 'Allow {{project}}',
    'settings.mobileAccess.projects.createPairing': 'Create pairing code',
    // Pairing card
    'settings.mobileAccess.pairing.expired': 'Expired',
    'settings.mobileAccess.pairing.expiresIn': 'Expires in {{remaining}}',
    'settings.mobileAccess.pairing.scan': 'Scan with Caxri Mobile',
    'settings.mobileAccess.pairing.description': '{{expiration}}. This code works once.',
    'settings.mobileAccess.pairing.expiredTitle': 'Pairing code expired',
    'settings.mobileAccess.pairing.expiredDescription': 'This code expired.',
    'settings.mobileAccess.pairing.createNew': 'Create New Code',
    'settings.mobileAccess.pairing.role': 'Access level: {{role}}',
    'settings.mobileAccess.pairing.tailscale': 'Works away from home over Tailscale',
    'settings.mobileAccess.pairing.success': '{{device}} is paired.',
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
    // Getting the app
    'settings.mobileAccess.steps.title': 'Get started',
    'settings.mobileAccess.steps.install':
        'Install Caxri Mobile on your Android phone. iOS is not available yet.',
    'settings.mobileAccess.steps.turnOn': 'Turn on Mobile access below.',
    'settings.mobileAccess.steps.pair':
        'Create a pairing code and scan it within {{minutes}} minutes.',
    'settings.mobileAccess.steps.download': 'Download Caxri Mobile',
    // Empty Project list
    'settings.mobileAccess.projects.emptyTitle': 'Add a Project first to pair a phone',
    'settings.mobileAccess.projects.emptyDescription':
        'A phone can only open Projects you choose, so there is nothing to share yet.',
    'settings.mobileAccess.projects.addProject': 'Add Project',
    // Revoke confirmation
    'settings.mobileAccess.devices.revokeTitle': 'Revoke {{device}}?',
    'settings.mobileAccess.devices.revokeFallbackName': 'this phone',
    'settings.mobileAccess.devices.revokeMessage': 'This phone will need to pair again.',
    'settings.mobileAccess.devices.revokeConfirm': 'Revoke',
    // Specific failure reasons
    'settings.mobileAccess.error.noPrivateNetwork':
        'Connect this computer to a Wi-Fi or local network, then try again.',
    'settings.mobileAccess.error.portBusy':
        'The port Mobile access used before is taken by another app. Close that app and try again.',
    'settings.mobileAccess.error.endpointFailed':
        'Caxri could not start listening for phones. Check your firewall and network, then try again.',
} as const;
