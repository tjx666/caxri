export const bugReport = {
    // Dialog
    'bugReport.dialog.title': 'Report Bug to Agent',
    'bugReport.dialog.description':
        'Capture, annotate, and send a redacted Markdown bug report to a running Agent in the current Session.',
    'bugReport.dialog.restoredDraft':
        'Restored your unsent draft, including the screenshot and its annotations. Use Discard Draft below to start over.',

    // Form
    'bugReport.form.noRunningAgent':
        'No running Agent in this Session — you can still copy the report to paste manually.',
    'bugReport.form.actualLabel': 'Actual behavior',
    'bugReport.form.actualPlaceholder': 'What happened?',
    'bugReport.form.expectedLabel': 'Expected behavior',
    'bugReport.form.expectedPlaceholder': 'What should have happened?',
    'bugReport.form.stepsLabel': 'Reproduction steps (optional)',
    'bugReport.form.discardDraft': 'Discard Draft',
    'bugReport.form.preparing': 'Preparing…',
    'bugReport.form.previewReport': 'Preview Report',

    // Screenshot field
    'bugReport.screenshot.title': 'Screenshot',
    'bugReport.screenshot.alt':
        'Unredacted screenshot of the current Caxri window, including any open files and terminal output',
    'bugReport.screenshot.annotateCaptured': 'Annotate the captured screenshot',
    'bugReport.screenshot.annotationCountOne': '1 annotation',
    'bugReport.screenshot.annotationCountOther': '{{count}} annotations',
    'bugReport.screenshot.annotate': 'Annotate',
    'bugReport.screenshot.capturing': 'Capturing…',
    'bugReport.screenshot.retake': 'Retake',
    'bugReport.screenshot.unredactedWarning':
        'Unlike the text report, this screenshot is not redacted: it shows everything on screen, including source code and Terminal output.',
    'bugReport.screenshot.retryCapture': 'Retry capture',
    'bugReport.screenshot.capture': 'Capture screenshot',
    'bugReport.screenshot.textOnly': 'The report will be sent as text only.',

    // Image delivery notice
    'bugReport.imageDelivery.savedPath':
        'The screenshot is saved to a temporary file and its path is included in the report so the Agent can open it.',
    'bugReport.imageDelivery.pasted':
        'The screenshot is saved to a temporary file and its path is included in the report so the Agent can open it. It is also pasted into this Agent directly; sending replaces the system clipboard with the image.',

    // Preview
    'bugReport.preview.unredactedNotice':
        'This screenshot is unredacted: it captures everything currently visible in the Caxri window, including open files and Terminal output.',
    'bugReport.preview.targetAgent': 'Target Agent',
    'bugReport.preview.noRunningAgent': 'No running Agent in this Session',
    'bugReport.preview.sessionChanged':
        'The selected Session changed. Copy the report or reopen this flow.',
    'bugReport.preview.noAgentAvailable':
        'No running Agent is available. You can still copy the report.',
    'bugReport.preview.copyReport': 'Copy Report',
    'bugReport.preview.sending': 'Sending…',
    'bugReport.preview.sendToAgent': 'Send to Agent',

    // Dialog flow messages
    'bugReport.flow.selectSession': 'Select a Session before reporting a bug to an Agent.',
    'bugReport.flow.contextLoadFailed': 'Unable to load Caxri context.',
    'bugReport.flow.captureFailed': 'Unable to capture the Caxri window.',
    'bugReport.flow.discardConfirmTitle': 'Discard this bug report draft?',
    'bugReport.flow.discardConfirmMessage':
        'The text you wrote, the screenshot, and every annotation on it are deleted. This cannot be undone.',
    'bugReport.flow.keepDraft': 'Keep Draft',
    'bugReport.flow.saveScreenshotFailed':
        'Unable to save the screenshot file. The report will not include an image path.',
    'bugReport.flow.copied': 'Bug report copied',
    'bugReport.flow.copyFailed': 'Unable to copy the bug report.',
    'bugReport.flow.agentStopped':
        'The selected Agent is no longer running. Choose another Agent or copy the report.',
    'bugReport.flow.sent': 'Bug report sent to {{title}}',
    'bugReport.flow.sendFailed': 'Unable to send the bug report.',

    // Annotator dialog
    'bugReport.annotator.title': 'Annotate Screenshot',
    'bugReport.annotator.description': 'Mark the areas that are wrong and write one note per mark.',
    'bugReport.annotator.tool': 'Annotation tool',
    'bugReport.annotator.box': 'Box',
    'bugReport.annotator.arrow': 'Arrow',
    'bugReport.annotator.limit': 'Up to {{max}} annotations',
    'bugReport.annotator.hint': 'Drag on the screenshot to mark an area, or press Enter on it',
    'bugReport.annotator.rendering': 'Rendering…',
    'bugReport.annotator.renderFailed': 'Unable to render the annotated screenshot.',
    'bugReport.annotator.readFailed': 'Unable to read the captured screenshot.',
    'bugReport.annotator.canvasFailed': 'Unable to prepare a canvas for the annotated screenshot.',
    'bugReport.annotator.encodeFailed': 'Unable to encode the annotated screenshot as a JPEG.',

    // Annotation list and canvas
    'bugReport.annotations.title': 'Annotations',
    'bugReport.annotations.description': 'Describe what is wrong in each marked area.',
    'bugReport.annotations.empty':
        'No marks yet. Drag on the screenshot to add one, or press Enter on it.',
    'bugReport.annotations.noteLabel': 'Note for annotation {{number}}',
    'bugReport.annotations.notePlaceholder': "What's wrong here?",
    'bugReport.annotations.delete': 'Delete annotation {{number}}',
    'bugReport.annotations.select': 'Select annotation {{number}}',
    'bugReport.annotations.canvas': 'Screenshot annotation canvas',

    // Screen reader announcements for the keyboard annotation path
    'bugReport.keyboard.arrowSegment': 'Arrow from {{from}} to {{to}}',
    'bugReport.keyboard.boxSegment': 'Box {{width}} by {{height}} pixels at {{point}}',
    'bugReport.keyboard.marksOne': '1 mark',
    'bugReport.keyboard.marksOther': '{{count}} marks',
    'bugReport.keyboard.boxDescription':
        'Box tool, {{marks}}. Press Enter to start a box at the keyboard cursor, arrow keys to size it, Option and arrow keys to move it, Enter again to add it, Escape to discard it. Hold Shift to move further. Press Delete to remove the selected mark.',
    'bugReport.keyboard.arrowDescription':
        'Arrow tool, {{marks}}. Press Enter to start an arrow at the keyboard cursor, arrow keys to size it, Option and arrow keys to move it, Enter again to add it, Escape to discard it. Hold Shift to move further. Press Delete to remove the selected mark.',
    'bugReport.keyboard.cursorAt': 'Cursor at {{point}}.',
    'bugReport.keyboard.segment': '{{description}}.',
    'bugReport.keyboard.boxStarted': 'Box started at {{point}}.',
    'bugReport.keyboard.arrowStarted': 'Arrow started at {{point}}.',
    'bugReport.keyboard.boxLimit': 'Up to {{max}} marks. Delete one before adding another box.',
    'bugReport.keyboard.arrowLimit': 'Up to {{max}} marks. Delete one before adding another arrow.',
    'bugReport.keyboard.boxTooSmall':
        'This box is too small to add. Press the arrow keys to make it bigger.',
    'bugReport.keyboard.arrowTooSmall':
        'This arrow is too small to add. Press the arrow keys to make it bigger.',
    'bugReport.keyboard.added': 'Added {{description}}.',
    'bugReport.keyboard.boxDiscarded': 'Box discarded.',
    'bugReport.keyboard.arrowDiscarded': 'Arrow discarded.',
    'bugReport.keyboard.cursorHidden': 'Keyboard cursor hidden.',
    'bugReport.keyboard.deletedSelected': 'Deleted the selected mark.',
} as const;
