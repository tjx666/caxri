import { describe, expect, it } from 'vitest';

import { botLaunchArguments, botTrustArguments } from '../launch';

const workspacePath = '/profile/agent-commander';

describe('botLaunchArguments', () => {
    it('trusts the workspace for the recorded Caxri Bot Codex Terminal only', () => {
        const bot = { terminalId: 'terminal-bot', workspacePath };
        expect(botLaunchArguments({ id: 'terminal-bot', kind: 'codex' }, bot)).toEqual([
            '-c',
            'projects={ "/profile/agent-commander" = { trust_level = "trusted" } }',
            '-c',
            'project_doc_max_bytes=65536',
        ]);
        expect(botLaunchArguments({ id: 'terminal-other', kind: 'codex' }, bot)).toEqual([]);
        expect(botLaunchArguments({ id: 'terminal-bot', kind: 'claude' }, bot)).toEqual([]);
    });

    it('adds nothing before Caxri Bot is recorded', () => {
        const terminal = { id: 'terminal-bot', kind: 'codex' } as const;
        expect(botLaunchArguments(terminal, undefined)).toEqual([]);
        expect(botLaunchArguments(terminal, { terminalId: 'terminal-bot' })).toEqual([]);
    });

    it('quotes a path that needs escaping as one TOML key', () => {
        expect(botTrustArguments(String.raw`/Users/a "b"\c/agent-commander`)).toEqual([
            '-c',
            String.raw`projects={ "/Users/a \"b\"\\c/agent-commander" = { trust_level = "trusted" } }`,
        ]);
    });
});
