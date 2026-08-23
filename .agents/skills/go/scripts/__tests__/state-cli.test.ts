import { describe, expect, it } from 'vitest';

import { stateCliHelp } from '../state-cli';

describe('Go state CLI help', () => {
    it('shows command-level parameters and accepted typed values', () => {
        expect(stateCliHelp('validation-start')).toContain(
            'ci|evidence|fixture|gates|remote_state',
        );
        expect(stateCliHelp('phase')).toContain('acceptance_handoff');
        expect(stateCliHelp('acceptance-restart-lineage')).toContain(
            '--acceptance-id ID --reason TEXT',
        );
        expect(stateCliHelp()).toContain('state.ts help <command>');
    });

    it('fails explicitly for an unknown help topic', () => {
        expect(() => stateCliHelp('unknown-command')).toThrow(
            'Unknown Go state command: unknown-command',
        );
    });
});
