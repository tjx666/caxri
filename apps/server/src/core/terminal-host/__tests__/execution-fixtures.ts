import type { TerminalRecord, TerminalSnapshot } from '@caxri/protocol';

export const terminal: TerminalRecord = {
    id: 'terminal-1',
    sessionId: 'session-1',
    cwd: '/project',
    kind: 'shell',
    title: 'Shell',
    icon: 'terminal',
    orderIndex: 0,
    lastProcessState: 'starting',
    createdAt: 1,
    updatedAt: 1,
};

export const snapshot: TerminalSnapshot = {
    terminalId: terminal.id,
    encodingVersion: 1,
    cols: 120,
    rows: 40,
    lineCount: 1,
    byteCount: 6,
    payload: 'screen',
    updatedAt: 2,
};
