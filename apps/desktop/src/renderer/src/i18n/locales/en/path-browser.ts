export const pathBrowser = {
    // Dialog chrome
    'pathBrowser.dialog.title': 'Open File by Path',
    'pathBrowser.projectRootFallback': 'Project',
    // Query field
    'pathBrowser.query.parentDirectory': 'Parent directory',
    'pathBrowser.query.inputLabel': 'File path',
    'pathBrowser.query.placeholderProject': 'Filter, or type / or ~ for any path…',
    'pathBrowser.query.placeholderFree': 'Filter, or type ./ to return to the Project…',
    'pathBrowser.query.placeholderSshHost': 'Filter, or type a path in this Project…',
    'pathBrowser.query.anchorHelp':
        'Type a path starting with / or ~ to browse outside the Project, or press Backspace at the start of an empty field. Type ./ to return to the Project.',
    'pathBrowser.query.projectRootRemoved': 'Project root removed. Enter any path.',
    // Results list
    'pathBrowser.results.label': 'Files',
    'pathBrowser.results.createFolder': 'Create folder “{{name}}”',
    'pathBrowser.results.createFile': 'Create file “{{name}}”',
    'pathBrowser.results.createDestination': 'in {{directory}}',
    'pathBrowser.results.directory': 'Directory',
    // Row groups and notices
    'pathBrowser.rows.directoryGroup': 'In this folder',
    'pathBrowser.rows.projectGroup': 'Elsewhere in this Project',
    'pathBrowser.rows.searchUnavailable': 'Project search is unavailable right now.',
    'pathBrowser.rows.searchIncomplete': 'Only part of this Project was searched. Refine the name.',
    'pathBrowser.rows.directoryTruncated':
        'Only part of this folder is shown. Refine or open a narrower folder.',
    'pathBrowser.rows.noMatch': 'No matching file or folder.',
    // Keyboard help footer
    'pathBrowser.help.select': '↑↓ Select',
    'pathBrowser.help.complete': 'Tab Complete',
    'pathBrowser.help.create': 'Enter Create',
    'pathBrowser.help.open': '→/Enter Open',
    'pathBrowser.help.parent': '← at start Parent',
    'pathBrowser.help.anyPath': '/ or ~ Any path',
    'pathBrowser.help.returnToProject': './ Project',
    'pathBrowser.help.close': 'Esc Close',
    // Status
    'pathBrowser.status.searching': 'Searching…',
    'pathBrowser.status.loadingFolder': 'Loading folder…',
    // Errors
    'pathBrowser.errors.shellExpansion': 'Shell path expansion is not supported',
    'pathBrowser.errors.otherUserHome': 'Only current-user ~/ paths are supported',
    'pathBrowser.errors.invalidPath': 'Invalid path',
    'pathBrowser.errors.browseFailed': 'Unable to browse files',
    'pathBrowser.errors.openFailed': 'Unable to open path',
    'pathBrowser.errors.openExternalFailed': 'Unable to open external file in this Session',
    'pathBrowser.errors.reopenFolderFailed': 'Created folder could not be reopened',
    'pathBrowser.errors.createFolderFailed': 'Unable to create folder',
    'pathBrowser.errors.createFileFailed': 'Unable to create file',
} as const;
