/**
 * Native UI owned by Main: the application menu bar and native message boxes. The Renderer never shows these keys, so
 * they stay out of its dictionaries.
 */
export const desktop = {
    'desktop.menu.project': 'Project',
    'desktop.menu.session': 'Session',
    'desktop.menu.terminal': 'Terminal',
    'desktop.menu.edit': 'Edit',
    'desktop.menu.view': 'View',
    'desktop.menu.window': 'Window',
    'desktop.menu.help': 'Help',
    'desktop.menu.about': 'About Caxri',
    'desktop.menu.viewUpdate': 'View Update…',
    'desktop.menu.hide': 'Hide Caxri',
    'desktop.menu.hideOthers': 'Hide Others',
    'desktop.menu.showAll': 'Show All',
    'desktop.menu.quit': 'Quit Caxri',
    'desktop.menu.undo': 'Undo',
    'desktop.menu.redo': 'Redo',
    'desktop.menu.cut': 'Cut',
    'desktop.menu.copy': 'Copy',
    'desktop.menu.paste': 'Paste',
    'desktop.menu.selectAll': 'Select All',
    'desktop.menu.reload': 'Reload',
    'desktop.menu.toggleDevTools': 'Toggle Developer Tools',
    'desktop.menu.minimize': 'Minimize',
    'desktop.menu.zoom': 'Zoom',
    'desktop.menu.bringAllToFront': 'Bring All to Front',

    'desktop.dialog.cancel': 'Cancel',
    'desktop.dialog.ok': 'OK',
    'desktop.dialog.open': 'Open',

    'desktop.externalLink.title': 'Open External Link',
    'desktop.externalLink.message': 'Open {{host}} in your default browser?',
    'desktop.externalLink.openOnce': 'Open Once',
    'desktop.externalLink.trustDomain': 'Trust Domain and Open',
    'desktop.externalLink.trustHost': 'Trust {{host}} and Open',
    'desktop.externalLink.trustParent': 'Trust *.{{parent}} and Open',
    'desktop.externalLink.detailOnce': '{{url}}\n\nYou can open this link once.',
    'desktop.externalLink.detailTrust':
        '{{url}}\n\nYou can open this link once or trust this exact origin for future links. Trusted origins can be reviewed or removed in Settings.',
    'desktop.externalLink.detailTrustParent':
        '{{url}}\n\nTrusting {{host}} covers that host alone. Trusting *.{{parent}} covers every subdomain of {{parent}}, including ones you have never visited — on a shared hosting domain that means sites other people control. Both rules can be reviewed or removed in Settings.',

    'desktop.trash.title': 'Move to Trash',
    'desktop.trash.message': "Move '{{name}}' to the Trash?",
    'desktop.trash.detail':
        '{{path}}\n\nYou can recover this item from the Trash. Press Cmd+Z in Files to undo.',
    'desktop.trash.detailUnsaved':
        '{{path}}\n\nThis file has unsaved changes in the editor. Only the last saved version can be recovered from the Trash.',
    'desktop.trash.detailSshHost':
        "{{path}}\n\nThe item moves to the SSH Host's Trash on {{host}}, where it can be recovered.",
    'desktop.trash.detailSshHostUnsaved':
        "{{path}}\n\nThe item moves to the SSH Host's Trash on {{host}}. This file has unsaved changes in the editor; only the last saved version can be recovered.",
    'desktop.trash.messageMany': 'Move {{count}} items to the Trash?',
    'desktop.trash.detailMany':
        '{{path}}\n\nYou can recover these items from the Trash. Press Cmd+Z in Files to undo.',
    'desktop.trash.detailUnsavedMany':
        '{{path}}\n\nSome of these files have unsaved changes in the editor. Only their last saved versions can be recovered from the Trash.',
    'desktop.trash.detailSshHostMany':
        "{{path}}\n\nThese items move to the SSH Host's Trash on {{host}}, where they can be recovered.",
    'desktop.trash.detailSshHostUnsavedMany':
        "{{path}}\n\nThese items move to the SSH Host's Trash on {{host}}. Some of these files have unsaved changes in the editor; only their last saved versions can be recovered.",
    'desktop.trash.moreItems': '...and {{count}} more',
    'desktop.trash.confirm': 'Move to Trash',

    'desktop.shellCommand.installTitle': "Install 'caxri' Command",
    'desktop.shellCommand.uninstallTitle': "Uninstall 'caxri' Command",
    'desktop.shellCommand.installMessage':
        "Caxri will now prompt for administrator privileges to install the 'caxri' shell command.",
    'desktop.shellCommand.uninstallMessage':
        "Caxri will now prompt for administrator privileges to uninstall the 'caxri' shell command.",
    'desktop.shellCommand.installDetail':
        '{{path}} will link to the caxri launcher inside this Caxri app.',
    'desktop.shellCommand.uninstallDetail':
        '{{path}} will be removed. The Caxri app itself is not affected.',

    'desktop.runningWork.terminalOne': '{{count}} Terminal',
    'desktop.runningWork.terminalOther': '{{count}} Terminals',
    'desktop.runningWork.chatOne': '{{count}} Chat',
    'desktop.runningWork.chatOther': '{{count}} Chats',
    'desktop.runningWork.and': '{{first}} and {{second}}',
    'desktop.runningWork.detail': 'Running: {{running}}',

    'desktop.deleteProject.title': 'Delete Project',
    'desktop.deleteProject.confirm': 'Delete Project',
    'desktop.deleteProject.message': 'Delete Project?',
    'desktop.deleteProject.messageRunning': 'Delete Project and stop {{running}}?',
    'desktop.deleteProject.worktreeOne': '1 linked worktree Project is removed with it: {{names}}.',
    'desktop.deleteProject.worktreeOther':
        '{{count}} linked worktree Projects are removed with it: {{names}}.',
    'desktop.deleteProject.worktreeMore': '{{names}}, and {{count}} more',
    'desktop.deleteProject.provenanceOne':
        'Caxri registered it automatically when a Session adopted the worktree, and a cascade like this is the only way it is removed. Any Session still working in it survives, with its Workbench Root back at its own Project root.',
    'desktop.deleteProject.provenanceOther':
        'Caxri registered them automatically when a Session adopted the worktree, and a cascade like this is the only way they are removed. Any Session still working in one of them survives, with its Workbench Root back at its own Project root.',
    'desktop.deleteSession.title': 'Delete Session',
    'desktop.deleteSession.confirm': 'Delete Session',
    'desktop.deleteSession.message': 'Delete Session?',
    'desktop.deleteSession.messageRunning': 'Delete Session and stop {{running}}?',
    'desktop.delete.detail': 'Files on disk are never touched.',
    'desktop.archiveWorktree.title': 'Remove Worktree',
    'desktop.archiveWorktree.message': 'Remove the worktree of "{{title}}" too?',
    'desktop.archiveWorktree.reasonOpen': 'Its pull request is not merged yet.',
    'desktop.archiveWorktree.reasonClosed': 'Its pull request was closed without merging.',
    'desktop.archiveWorktree.reasonNone': 'No pull request was found for it.',
    'desktop.archiveWorktree.detail':
        '{{reason}} Removing deletes {{path}}, including ignored files such as node_modules. Uncommitted changes are committed to {{branch}} first, and the branch is kept.',
    'desktop.archiveWorktree.remove': 'Archive and Remove',
    'desktop.archiveWorktree.keep': 'Archive Only',

    'desktop.deleteSessions.title': 'Delete Sessions',
    'desktop.deleteSessions.confirm': 'Delete Sessions',
    'desktop.deleteSessions.message': 'Delete {{count}} Sessions?',
    'desktop.deleteSessions.messageRunning': 'Delete {{count}} Sessions and stop {{running}}?',

    'desktop.clearBotData.title': 'Clear Caxri Bot Data',
    'desktop.clearBotData.message': 'Clear the selected Caxri Bot data?',
    'desktop.clearBotData.allTasks': 'Every task in the task ledger',
    'desktop.clearBotData.closedTasks': 'Every finished task in the task ledger',
    'desktop.clearBotData.someTasks': '{{count}} tasks from the task ledger',
    'desktop.clearBotData.someTasksOne': '1 task from the task ledger',
    'desktop.clearBotData.taskFiles': 'Task briefs and pull request reports',
    'desktop.clearBotData.inbox': 'Every Needs you item and reply',
    'desktop.clearBotData.memory':
        'Long-term memory, reset to the starting notes; AGENTS.md is rewritten to match',
    'desktop.clearBotData.instructions': 'AGENTS.md, rewritten from the built-in instructions',
    'desktop.clearBotData.conversation': 'The current conversation; Caxri Bot starts over',
    'desktop.clearBotData.detail':
        'This cannot be undone. Projects, Sessions, and the work running in them are not affected.',
    'desktop.clearBotData.confirm': 'Clear Data',

    'desktop.revokeDevice.title': 'Revoke Mobile Device',
    'desktop.revokeDevice.message': "Revoke '{{name}}'?",
    'desktop.revokeDevice.detail':
        'This {{platform}} device immediately loses access to Caxri. To reconnect it, you must pair it again. Projects and files are not affected.',
    'desktop.revokeDevice.confirm': 'Revoke Device',

    'desktop.discard.title': 'Discard Changes',
    'desktop.discard.deleteMessage': "Delete '{{path}}'?",
    'desktop.discard.message': "Discard changes in '{{path}}'?",
    'desktop.discard.untrackedDetail':
        'This file is untracked. It will be permanently deleted and cannot be restored.',
    'desktop.discard.trackedDetail':
        'The file is restored to its last committed state. Uncommitted changes cannot be restored.',
    'desktop.discard.deleteFile': 'Delete File',
    'desktop.discard.confirm': 'Discard Changes',
    'desktop.discardAll.title': 'Discard All Changes',
    'desktop.discardAll.messageOne': "Discard all changes in 1 file in '{{repository}}'?",
    'desktop.discardAll.messageOther':
        "Discard all changes in {{count}} files in '{{repository}}'?",
    'desktop.discardAll.detail':
        'Tracked files are restored to their last committed state and untracked files are permanently deleted. Uncommitted changes cannot be restored.',
    'desktop.discardAll.confirm': 'Discard All Changes',

    'desktop.unsaved.title': 'Unsaved Changes',
    'desktop.unsaved.message': "Do you want to save the changes you made to '{{name}}'?",
    'desktop.unsaved.detail': "Your changes will be lost if you don't save them.",
    'desktop.unsaved.save': 'Save',
    'desktop.unsaved.dontSave': "Don't Save",
    'desktop.unsaved.saveAll': 'Save All',
    'desktop.unsaved.quitOne': "Save changes to '{{name}}' before quitting?",
    'desktop.unsaved.quitOther': 'Save changes to {{count}} files before quitting?',
    'desktop.unsaved.closeOne': "Save changes to '{{name}}' before closing the window?",
    'desktop.unsaved.closeOther': 'Save changes to {{count}} files before closing the window?',
    'desktop.unsaved.more': 'and {{count}} more',

    'desktop.revertFiles.title': 'Revert File Changes',
    'desktop.revertFiles.messageOne': 'Revert the files {{provider}} changed in this turn?',
    'desktop.revertFiles.messageOther':
        'Revert the files {{provider}} changed in these {{count}} turns?',
    'desktop.revertFiles.detail':
        'Files return to how they were before this message. Changes made to them since, including your own, are lost.',
    'desktop.revertFiles.confirm': 'Revert Files',
    'desktop.revertFiles.previewFailed':
        "Couldn't preview changes. The files to revert are not listed.",
    'desktop.revertFiles.moreFiles': '...and {{count}} more',
    'desktop.revertFiles.filesOne': '{{count}} file will be reverted',
    'desktop.revertFiles.filesOther': '{{count}} files will be reverted',

    'desktop.quit.title': 'Quit Caxri?',
    'desktop.quit.otherClientsOne': '1 other client disconnects if tasks stop.',
    'desktop.quit.otherClientsOther': '{{count}} other clients disconnect if tasks stop.',
    'desktop.quit.stopTasks': 'Quit and Stop Tasks',
    'desktop.quit.keepTasks': 'Quit and Keep Tasks Running',
    'desktop.quit.reviewTitle': 'Quit with pending review comments?',
    'desktop.quit.reviewMessageOne': 'Lose 1 review comment?',
    'desktop.quit.reviewMessageOther': 'Lose {{count}} review comments?',
    'desktop.quit.reviewDetail': 'They are kept in memory only.',
    'desktop.quit.reviewLossOne': '1 unsent review comment is also lost.',
    'desktop.quit.reviewLossOther': '{{count}} unsent review comments are also lost.',
    'desktop.quit.anyway': 'Quit Anyway',
    'desktop.quit.stopFailureTitle': "Caxri Couldn't Stop All Tasks",
    'desktop.quit.stopFailureMessage': 'Some tasks may still be running.',
    'desktop.quit.stopFailureDetail': 'Reopen Caxri to stop them.',

    'desktop.updateRestart.title': 'Restart to Update?',
    'desktop.updateRestart.stopsRunning': '{{running}} will stop.',
    'desktop.updateRestart.detail': 'Caxri reopens on the new version.',
    'desktop.updateRestart.restart': 'Restart and Update',
    'desktop.sshServerUpdate.title': 'Update Server on SSH Host?',
    'desktop.sshServerUpdate.messageOne':
        'Update Caxri Server on {{host}} while {{running}} is running?',
    'desktop.sshServerUpdate.messageOther':
        'Update Caxri Server on {{host}} while {{running}} are running?',
    'desktop.sshServerUpdate.detail':
        '{{host}} is running Caxri Server from another version of Caxri. Updating it stops every running Terminal and Agent process there. Not Now keeps them running and leaves {{host}} disconnected; choose Reconnect when you are ready to update.',
    'desktop.sshServerUpdate.update': 'Update Server',
    'desktop.sshServerUpdate.notNow': 'Not Now',

    'desktop.windowClose.title': 'Close this window?',
    'desktop.windowClose.keepRunning': 'Keep Running',
    'desktop.windowClose.terminate': 'Terminate and Close',

    'desktop.menuBar.tooltip': 'Caxri',
    'desktop.menuBar.workingNone': 'No Agents working',
    'desktop.menuBar.workingOne': '1 Agent working',
    'desktop.menuBar.workingOther': '{{count}} Agents working',
    'desktop.menuBar.usageWaitingOne': '1 Chat waiting for a plan limit to reset',
    'desktop.menuBar.usageWaitingOther': '{{count}} Chats waiting for a plan limit to reset',
    'desktop.menuBar.keepingAwake': 'Keeping this Mac awake',
    'desktop.menuBar.needsYou': 'Needs You',
    'desktop.menuBar.attentionWaiting': 'Waiting for you',
    'desktop.menuBar.attentionFailed': 'Failed',
    'desktop.menuBar.attentionResult': 'Finished',
    'desktop.menuBar.moreOne': '1 More in Caxri',
    'desktop.menuBar.moreOther': '{{count}} More in Caxri',
    'desktop.menuBar.keepAwake': 'Keep Mac Awake While Agents Work',
    'desktop.menuBar.open': 'Open Caxri',
    'desktop.menuBar.quit': 'Quit Caxri',
    'desktop.menuBar.introTitle': 'Caxri is still running in the menu bar',
    'desktop.menuBar.introBody':
        'Your Agents keep working. Click the menu bar icon to come back, or turn this off in Settings.',

    'desktop.crash.title': 'Caxri Keeps Crashing',
    'desktop.crash.message':
        'The Caxri window has crashed repeatedly and automatic reload stopped.',
    'desktop.crash.detail': 'Relaunch Caxri, or quit to investigate.',
    'desktop.crash.relaunch': 'Relaunch',
    'desktop.crash.revealLogs': 'Reveal Logs in Finder',
    'desktop.crash.quit': 'Quit',

    'desktop.chooseSession.title': 'Choose a Session',
    'desktop.chooseSession.message': 'Choose a Session in {{project}} to open this file',
    'desktop.chooseSession.detail':
        'The file will open in the selected Session without starting a Terminal.',
    'desktop.chooseSession.untitled': 'Untitled',
    'desktop.chooseSession.fallbackProject': 'Project',
    'desktop.externalFile.title': 'Open a File Outside Added Projects?',
    'desktop.externalFile.message': 'Open {{name}} from outside your Projects?',
    'desktop.externalFile.detail':
        '{{path}}\n\nThis file is outside every added Project. Caxri opens it in the editor without adding a Project, and saving writes back to this file. Trusting the folder skips this prompt for files under {{folder}}.',
    'desktop.externalFile.trustFolder': 'Trust Folder and Open',
    'desktop.externalFile.copyPath': 'Copy Path',
    'desktop.delegationImport.title': 'Import dianjiang presets',
    'desktop.delegationImport.files': 'JSONC files',
    'desktop.themeImport.title': 'Import Theme',
    'desktop.themeImport.themeFiles': 'Theme Files',
    'desktop.fileFilter.allFiles': 'All Files',
    'desktop.diagnosticsExport.title': 'Export Diagnostics',
    'desktop.untitledSave.title': 'Save As',
    'desktop.diagnosticsExport.zipArchive': 'ZIP Archive',
    'desktop.projectTransfer.exportTitle': 'Export Projects and Sessions',
    'desktop.projectTransfer.importTitle': 'Import Projects and Sessions',
    'desktop.projectTransfer.jsonFile': 'Caxri Export',
    'desktop.updateDataReset.message': 'Caxri {{version}} will clear your Projects and Sessions',
    'desktop.updateDataReset.detail':
        'This update starts from a new database, so the Project and Session list will be empty after it restarts. Project folders, files, and Agent conversations are not touched, and a copy of the old database is kept next to it.\n\nExport your Projects and Sessions first, then import the file after the update to bring them back.',
    'desktop.updateDataReset.exported':
        'Exported to {{path}}.\n\nAfter the update, choose Import Projects and Sessions… from the Project menu and pick this file.',
    'desktop.updateDataReset.exportFailed': 'The export failed: {{message}}',
    'desktop.updateDataReset.export': 'Export…',
    'desktop.updateDataReset.update': 'Update Anyway',
    'desktop.updateDataReset.cancel': 'Cancel',
    'desktop.benchmarkShare.title': 'Save Share Image',
    'desktop.benchmarkShare.pngImage': 'PNG Image',
    'desktop.chooseProjectFolder': 'Choose a Project folder',
    'desktop.chooseChatFilesAndFolders': 'Add files and folders',

    'desktop.notification.agentWaiting': 'Waiting for your input',
    'desktop.notification.agentTurnFinished': 'Turn finished',
    'desktop.notification.agentFinishedIn': 'Finished in {{duration}}',
    'desktop.notification.botInbox.title': 'Caxri Bot needs your action',
    'desktop.notification.botInbox.bodyOther': '{{count}} new items in the Inbox',

    'desktop.reset.title': "This version of Caxri can't use the existing data",
    'desktop.reset.message':
        "This version of Caxri can't use the background service or data left by another build.",
    'desktop.reset.detail':
        'Quit Caxri, move the Caxri data folder to the Trash, then reopen Caxri. Your Project folders and files are never touched.',
    'desktop.reset.revealData': 'Reveal Data Folder',
    'desktop.reset.quit': 'Quit',

    'desktop.startupFailed.title': "Caxri couldn't start its background service",
    'desktop.startupFailed.message': "Caxri couldn't start its background service.",
    'desktop.startupFailed.detail.timeout':
        'The service took too long to start. Try again, or check the logs if it keeps happening.',
    'desktop.startupFailed.detail.crashedOnBoot':
        'The service stopped right after it started. Try again, or check the logs if it keeps happening.',
    'desktop.startupFailed.detail.database':
        "The service couldn't open Caxri's data. Check the logs for details before trying again.",
    'desktop.startupFailed.detail.unknown': 'Try again, or check the logs if it keeps happening.',
    'desktop.startupFailed.retry': 'Try Again',
    'desktop.startupFailed.revealLogs': 'Reveal Logs in Finder',
    'desktop.startupFailed.quit': 'Quit',

    'desktop.runtimeFailed.title': 'Caxri stopped',
    'desktop.runtimeFailed.message': 'Caxri stopped unexpectedly and could not recover on its own.',
    'desktop.runtimeFailed.detail':
        'Relaunch Caxri to continue. Your Projects and Sessions are kept.',
    'desktop.runtimeFailed.relaunch': 'Relaunch Caxri',
    'desktop.runtimeFailed.revealLogs': 'Reveal Logs in Finder',
    'desktop.runtimeFailed.quit': 'Quit',

    'desktop.moveToApplications.message': 'Move Caxri to the Applications folder?',
    'desktop.moveToApplications.detail':
        'Caxri is running from a download or disk image. Moving it to Applications lets it update itself and keeps it available after you eject the disk image.',
    'desktop.moveToApplications.move': 'Move to Applications',
    'desktop.moveToApplications.notNow': 'Not Now',
    'desktop.serverReplaced.title': 'Caxri updated',
    'desktop.serverReplaced.bodyOne': '1 running Terminal from the previous version was stopped.',
    'desktop.serverReplaced.bodyOther':
        '{{count}} running Terminals from the previous version were stopped.',
    'desktop.notification.environmentMonitor.title': 'Environment monitoring',
    'desktop.notification.environmentMonitor.publicIpChanged':
        'The public IP changed during this launch.',
    'desktop.notification.environmentMonitor.timeZoneMismatch':
        'The system time zone differs from the selected time zone.',
    'desktop.notification.environmentMonitor.routeNodeMismatch':
        'A monitored domain used a different Mihomo node.',
    'desktop.duration.hoursMinutes': '{{hours}}h {{minutes}}m',
    'desktop.duration.hours': '{{hours}}h',
    'desktop.duration.minutesSeconds': '{{minutes}}m {{seconds}}s',
    'desktop.duration.minutes': '{{minutes}}m',
    'desktop.duration.seconds': '{{seconds}}s',
} as const;
