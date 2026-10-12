export const sshHost = {
    // Window identity: the window title and the status-bar indicator
    'sshHost.windowTitle': 'SSH: {{destination}}',
    'sshHost.status.ariaLabel': 'This window runs on the SSH Host {{destination}}',
    'sshHost.status.tooltip':
        "This window's Projects, Terminals, and Agents run on the SSH Host {{destination}}.",
    'sshHost.status.platform': '{{hostname}} · Linux {{architecture}} · glibc {{glibc}}',

    // Connect to SSH Host dialog
    'sshHost.connect.title': 'Connect to SSH Host',
    'sshHost.connect.inputLabel': 'SSH destination',
    'sshHost.connect.placeholder': 'user@host[:port] or a Host from ~/.ssh/config',
    'sshHost.connect.typed': 'Connect to {{destination}}',
    'sshHost.connect.recent': 'Recent',
    'sshHost.connect.config': 'SSH config',
    'sshHost.connect.invalid': 'An SSH destination cannot start with "-" or contain spaces.',
    'sshHost.connect.empty': 'Type user@host, or add a Host to ~/.ssh/config.',
    'sshHost.connect.noMatch': 'No matching SSH Host. Type a full user@host to connect to it.',
    'sshHost.connect.loadFailed': 'Unable to read ~/.ssh/config. You can still type a destination.',
    'sshHost.connect.failed': 'Unable to open the SSH Host window',

    // Connection overlay
    'sshHost.phase.connecting': 'Connecting…',
    'sshHost.phase.probing': 'Checking the SSH Host…',
    'sshHost.phase.installing': 'Installing Caxri Server…',
    'sshHost.phase.starting': 'Starting Caxri Server…',
    'sshHost.phase.connected': 'Connected',
    'sshHost.phase.reconnecting': 'Reconnecting…',
    'sshHost.phase.disconnected': 'Disconnected',
    'sshHost.phase.stopped': 'Server stopped',
    'sshHost.phase.failed': 'Unable to connect',
    'sshHost.progress.label': 'Installing Caxri Server',
    'sshHost.progress.percent': '{{percent}}%',
    'sshHost.needsUserAction':
        'Caxri stopped reconnecting because the SSH Host needs your answer. Choose Reconnect to try again.',
    'sshHost.failure.authentication':
        'The SSH Host did not accept your credentials. Check your password, key, or 2FA code, then reconnect.',
    'sshHost.failure.hostKey':
        "The SSH Host's key could not be verified. If the host was reinstalled, update ~/.ssh/known_hosts before reconnecting.",
    'sshHost.failure.unreachable':
        'The SSH Host could not be reached. Check the network, VPN, and the host name in ~/.ssh/config.',
    'sshHost.failure.unsupportedPlatform':
        'Caxri Server runs only on Linux x64 and arm64. This SSH Host runs a different system.',
    'sshHost.failure.unsupportedGlibc':
        'Caxri Server needs glibc 2.28 or newer, such as Ubuntu 20.04, Debian 10, or RHEL 8. This SSH Host has an older version.',
    'sshHost.failure.missingTool':
        'The SSH Host is missing a command Caxri needs to install its Server, such as tar or sha256sum.',
    'sshHost.failure.installFailed':
        'Caxri Server could not be installed on the SSH Host. Check its free disk space and the permissions of ~/.caxri-server.',
    'sshHost.failure.launchFailed': 'Caxri Server was installed but did not start on the SSH Host.',
    'sshHost.failure.cancelled': 'The connection was cancelled.',
    'sshHost.failure.connectionLost':
        'The connection to the SSH Host dropped. Terminals and Agents keep running there and reappear when you reconnect.',
    'sshHost.failure.unknown': 'Something went wrong while connecting to the SSH Host.',
    'sshHost.reconnect': 'Reconnect',
    'sshHost.closeWindow': 'Close Window',
    'sshHost.reconnect.failed': 'Unable to reconnect to the SSH Host',

    // OpenSSH prompts (passwords, passphrases, 2FA codes, host keys)
    'sshHost.askpass.title': '{{destination}} Needs Your Answer',
    'sshHost.askpass.verifyTitle': 'Verify {{destination}}',
    'sshHost.askpass.inputLabel': 'Answer',
    'sshHost.askpass.privacy': 'Caxri hands this answer to OpenSSH and never stores it.',
    'sshHost.askpass.failed': 'Unable to answer the SSH Host',

    // Stop Server on SSH Host
    'sshHost.stop.title': 'Stop the Server on {{destination}}?',
    'sshHost.stop.message':
        'Every Terminal and Agent running on this SSH Host ends, and this window closes. Connecting again starts a new Server.',
    'sshHost.stop.confirm': 'Stop Server',
    'sshHost.stop.failed': 'Unable to stop the Server on the SSH Host',

    // Project folder picker on the SSH Host
    'sshHost.folderPicker.title': 'Choose a Project Folder on {{destination}}',
    'sshHost.folderPicker.pathLabel': 'Folder path',
    'sshHost.folderPicker.pathPlaceholder': 'Type /absolute/path or ~/folder, then press Enter',
    'sshHost.folderPicker.parent': 'Parent folder',
    'sshHost.folderPicker.home': 'Home folder',
    'sshHost.folderPicker.breadcrumbs': 'Current folder',
    'sshHost.folderPicker.listLabel': 'Folders',
    'sshHost.folderPicker.loading': 'Loading folders',
    'sshHost.folderPicker.gitRepository': 'Git',
    'sshHost.folderPicker.gitRepositoryDescription': 'Git repository',
    'sshHost.folderPicker.empty': 'This folder has no subfolders.',
    'sshHost.folderPicker.truncated':
        'Only the first {{count}} folders are listed. Type a path to go further.',
    'sshHost.folderPicker.loadFailed': 'Unable to list this folder. {{message}}',
    'sshHost.folderPicker.invalidPath':
        'Enter an absolute path such as /srv/app, or a path in your home folder such as ~/app.',
    'sshHost.folderPicker.open': 'Open',
} as const;
