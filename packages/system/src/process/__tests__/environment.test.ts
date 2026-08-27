import { describe, expect, it } from 'vitest';

import { safeProcessEnvironment } from '../environment';

describe('safeProcessEnvironment', () => {
    it('keeps runtime discovery paths without inheriting unrelated credentials', () => {
        expect(
            safeProcessEnvironment({
                CODEX_HOME: '/tmp/codex',
                CODEX_SQLITE_HOME: '/tmp/codex-sqlite',
                CLAUDE_CONFIG_DIR: '/tmp/claude',
                GITHUB_TOKEN: 'secret',
                PATH: '/usr/bin',
            }),
        ).toEqual({
            CODEX_HOME: '/tmp/codex',
            CODEX_SQLITE_HOME: '/tmp/codex-sqlite',
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            PATH: '/usr/bin',
        });
    });
});
