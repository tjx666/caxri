export const projectSearch = {
    // Dialog chrome
    'projectSearch.dialog.title': 'Search Files',
    'projectSearch.dialog.helpMove': '↑↓ to move',
    'projectSearch.dialog.helpOpen': 'Enter to open',
    'projectSearch.dialog.helpOpenToSide': '⌘Enter to open to the side',
    'projectSearch.dialog.helpDoubleClick': 'Double-click a result to open it',
    // Result-pane messages
    'projectSearch.status.searching': 'Searching…',
    'projectSearch.status.failed': 'Search failed.',
    'projectSearch.status.noResults': 'No results.',
    // Query controls
    'projectSearch.controls.findFilesLabel': 'Find Project files',
    'projectSearch.controls.searchContentsLabel': 'Search Project contents',
    'projectSearch.controls.findFilesPlaceholder': 'Find files',
    'projectSearch.controls.searchTextPlaceholder': 'Search text',
    'projectSearch.controls.clearTooltip': 'Clear Search',
    'projectSearch.controls.clearLabel': 'Clear Project search',
    'projectSearch.controls.matchCase': 'Match Case',
    'projectSearch.controls.matchWholeWord': 'Match Whole Word',
    'projectSearch.controls.useRegex': 'Use Regular Expression',
    'projectSearch.controls.ignoreFilesOn': 'Using .gitignore — click to search ignored files too',
    'projectSearch.controls.ignoreFilesOff': 'Searching ignored files — click to apply .gitignore',
    'projectSearch.controls.useIgnoreFiles': 'Use Ignore Files',
    'projectSearch.controls.modeName': 'Name',
    'projectSearch.controls.modeContent': 'Content',
    'projectSearch.controls.include': 'Files to include',
    'projectSearch.controls.includePlaceholder': 'Files to include (e.g. *.ts, src/**)',
    'projectSearch.controls.exclude': 'Files to exclude',
    'projectSearch.controls.excludePlaceholder': 'Files to exclude (e.g. *.min.js, dist/**)',
    // Results and preview
    'projectSearch.results.label': 'Search results',
    'projectSearch.preview.empty': 'Select a result to preview it.',
    'projectSearch.preview.readFailed': 'Unable to read this file.',
    'projectSearch.preview.loading': 'Loading preview…',
    // Why a search ended early; `{{next}}` is one of the two follow-up sentences below
    'projectSearch.termination.canceled': 'Search canceled.',
    'projectSearch.termination.timeout':
        'Search timed out after scanning {{count}} files. {{next}}',
    'projectSearch.termination.fileLimit':
        'Search stopped after reaching the {{count}} file limit. {{next}}',
    'projectSearch.termination.resultLimit':
        'Search reached the result limit. Showing partial results.',
    'projectSearch.termination.payloadLimit':
        'Search reached the response size limit. Showing partial results.',
    'projectSearch.termination.showingPartial': 'Showing partial results.',
    'projectSearch.termination.narrowSearch': 'Narrow the search to try again.',
} as const;
