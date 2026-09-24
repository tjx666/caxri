import { createPaneLayout, openResource } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { lastTabTerminalSessionId } from '../session-last-tab';

describe('lastTabTerminalSessionId', () => {
    const terminal = { kind: 'terminal', terminalId: 'terminal-1' } as const;
    const terminals = [{ id: 'terminal-1', sessionId: 'session-1' }];

    it('archives the Session when its only Terminal is the last open tab', () => {
        expect(lastTabTerminalSessionId(terminals, createPaneLayout(terminal), 'terminal-1')).toBe(
            'session-1',
        );
    });

    it('keeps the ordinary close while another Terminal or a document tab remains', () => {
        const withSecondTerminal = [...terminals, { id: 'terminal-2', sessionId: 'session-1' }];
        expect(
            lastTabTerminalSessionId(withSecondTerminal, createPaneLayout(terminal), 'terminal-1'),
        ).toBeUndefined();
        const withDocument = openResource(createPaneLayout(terminal), {
            kind: 'file',
            path: 'notes.ts',
        });
        expect(lastTabTerminalSessionId(terminals, withDocument, 'terminal-1')).toBeUndefined();
    });

    it('ignores other Sessions and unknown Terminals', () => {
        const otherSession = [...terminals, { id: 'terminal-9', sessionId: 'session-2' }];
        expect(
            lastTabTerminalSessionId(otherSession, createPaneLayout(terminal), 'terminal-1'),
        ).toBe('session-1');
        expect(
            lastTabTerminalSessionId(terminals, createPaneLayout(terminal), 'terminal-x'),
        ).toBeUndefined();
    });
});
