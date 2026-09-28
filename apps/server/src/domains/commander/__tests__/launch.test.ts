import { describe, expect, it } from 'vitest';

import { commanderLaunchArguments, commanderTrustArguments } from '../launch';

const workspacePath = '/profile/agent-commander';

describe('commanderLaunchArguments', () => {
    it('trusts the workspace for the recorded Commander Codex Terminal only', () => {
        const commander = { terminalId: 'terminal-commander', workspacePath };
        expect(
            commanderLaunchArguments({ id: 'terminal-commander', kind: 'codex' }, commander),
        ).toEqual(['-c', 'projects={ "/profile/agent-commander" = { trust_level = "trusted" } }']);
        expect(
            commanderLaunchArguments({ id: 'terminal-other', kind: 'codex' }, commander),
        ).toEqual([]);
        expect(
            commanderLaunchArguments({ id: 'terminal-commander', kind: 'claude' }, commander),
        ).toEqual([]);
    });

    it('adds nothing before the Commander is recorded', () => {
        const terminal = { id: 'terminal-commander', kind: 'codex' } as const;
        expect(commanderLaunchArguments(terminal, undefined)).toEqual([]);
        expect(commanderLaunchArguments(terminal, { terminalId: 'terminal-commander' })).toEqual(
            [],
        );
    });

    it('quotes a path that needs escaping as one TOML key', () => {
        expect(commanderTrustArguments(String.raw`/Users/a "b"\c/agent-commander`)).toEqual([
            '-c',
            String.raw`projects={ "/Users/a \"b\"\\c/agent-commander" = { trust_level = "trusted" } }`,
        ]);
    });
});
