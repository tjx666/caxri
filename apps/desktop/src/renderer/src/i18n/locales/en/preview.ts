export const preview = {
    // Shared preview surface states.
    'preview.loading': 'Loading preview…',
    'preview.unavailable': 'No preview is available for this file.',
    'preview.externalClosed.reason':
        'This file is outside every Project and is no longer open. Open it again to preview it.',
    'preview.externalClosed.action': 'Open File…',

    // Switching between a document's source and preview.
    'preview.revealInFinder': 'Reveal in Finder',
    'preview.openSource': 'Open Source',
    'preview.openPreviewToSide': 'Open Preview to the Side',

    // Markdown and Mermaid.
    'preview.markdown.copyCodeBlock': 'Copy code block',
    'preview.mermaid.label': 'Mermaid diagram',
    'preview.mermaid.empty': 'This diagram is empty.',
    'preview.mermaid.renderFailed': 'This diagram could not be rendered.',

    // PDF.
    'preview.pdf.passwordPrompt': 'This PDF is password-protected. Enter its password to open it.',
    'preview.pdf.password': 'Password',
    'preview.pdf.passwordIncorrect': 'Incorrect password.',
    'preview.pdf.invalid': 'This file is not a valid PDF, or it is damaged.',
    'preview.pdf.tooLarge': 'This PDF is larger than the {{limit}} preview limit.',
    'preview.pdf.displayFailed': "Couldn't display this PDF.",
    'preview.pdf.label': 'PDF preview',
    'preview.pdf.page': 'Page',
    'preview.pdf.pageCount': 'of {{count}}',
    'preview.pdf.zoomLabel': 'Zoom: {{percent}}%',
    'preview.pdf.zoomIn': 'Zoom In',
    'preview.pdf.zoomOut': 'Zoom Out',
    'preview.pdf.fitWidth': 'Fit Width',
    'preview.pdf.fitPage': 'Fit Page',
    'preview.pdf.viewAnnouncement': 'Page {{page}} of {{count}}, {{percent}}%',
    'preview.pdf.find': 'Find in PDF',
    'preview.pdf.findNoResults': 'No results',

    // CSV and TSV table.
    'preview.table.label': 'Table preview',
    'preview.table.noRows': 'This file has no rows.',
    'preview.table.rowHeader': 'Row',
    'preview.table.column': 'Column {{index}}',
    'preview.table.rowsOne': '{{count}} row',
    'preview.table.rowsOther': '{{count}} rows',
    'preview.table.columnsOne': '{{count}} column',
    'preview.table.columnsOther': '{{count}} columns',
    'preview.table.filter': 'Filter rows',
    'preview.table.clearFilter': 'Clear Filter',
    'preview.table.filteredRows': '{{visible}} of {{total}}',
    'preview.table.noMatches': 'No rows match the filter.',
    'preview.table.limitRowsAndColumns': 'Only the first {{rows}} and {{columns}} are shown.',
    'preview.table.limitRows': 'Only the first {{rows}} are shown.',
    'preview.table.limitColumns': 'Only the first {{columns}} are shown.',
    'preview.table.issueLocation': 'Row {{row}}: ',
    'preview.table.moreIssuesOne': ' ({{count}} more issue)',
    'preview.table.moreIssuesOther': ' ({{count}} more issues)',
    'preview.table.issues': 'Some rows may be split incorrectly. {{location}}{{message}}{{more}}.',
} as const;
