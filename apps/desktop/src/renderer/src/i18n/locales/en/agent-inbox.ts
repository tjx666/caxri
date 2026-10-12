export const agentInbox = {
    'agentInbox.body.readFailed': 'The complete message could not be read.',
    'agentInbox.body.readFailedHint':
        'Approve and Deny stay available without it — approving only delivers this message and grants nothing. Retry loads the full text if you want to read it first.',
    'agentInbox.body.loading': 'Loading the complete message…',
    'agentInbox.summary.sender': 'Sender',
    'agentInbox.summary.project': 'Project',
    'agentInbox.summary.provider': 'Provider',
    'agentInbox.summary.permission': 'Permission',
    'agentInbox.summary.endpoint': 'Endpoint',
    'agentInbox.summary.expired': 'Expired',
    'agentInbox.summary.expires': 'Expires',
    'agentInbox.actions.hint':
        'Decide later, Escape, and closing this dialog all leave the request waiting. None of them answers the sender.',
    'agentInbox.actions.decideLater': 'Decide later',
    'agentInbox.actions.deny': 'Deny',
    'agentInbox.actions.approve': 'Approve message',
    'agentInbox.dialog.titleExpired': 'Peer message expired',
    'agentInbox.dialog.title': 'Peer message approval',
    'agentInbox.dialog.description':
        'This is inert Agent-to-Agent text. Approving delivers only this message and does not grant permissions, change settings, or execute a command.',
    'agentInbox.dialog.expiredNotice':
        'This request expired before it was answered. It can no longer be approved or denied, and the message was not delivered.',
    'agentInbox.dialog.loadBodyFailed': 'Unable to load the complete peer message',
    'agentInbox.dialog.approveFailed': 'Unable to approve peer message',
    'agentInbox.dialog.denyFailed': 'Unable to deny peer message',
    'agentInbox.waitingList.label': 'Peer messages waiting for your decision',
    'agentInbox.waitingList.title': 'Waiting for your decision',
    'agentInbox.waitingList.hint':
        'Nothing was answered. Each sender is still waiting until its approval window closes.',
    'agentInbox.waitingList.until': 'Until {{time}}',
    'agentInbox.waitingList.reviewLabel': 'Review the message from {{name}}',
    'agentInbox.waitingList.review': 'Review',
    'agentInbox.store.loadFailed': 'Unable to load held peer messages',
} as const;
