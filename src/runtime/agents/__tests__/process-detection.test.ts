import { describe, expect, it } from 'vitest';

import { foregroundAgentProviderFromProcessList } from '../process-detection';

describe('Shell foreground Agent detection', () => {
    it.each([
        ['claude', '/opt/tools/claude'],
        ['codex', '/opt/tools/codex'],
    ] as const)('identifies a foreground %s descendant', (provider, executable) => {
        expect(
            foregroundAgentProviderFromProcessList(
                `100 1 100 200 /bin/zsh -l\n200 100 200 200 /usr/bin/node wrapper.js\n201 200 200 200 ${executable} --flag\n`,
                100,
            ),
        ).toBe(provider);
    });

    it('ignores background Agents and ambiguous foreground process groups', () => {
        expect(
            foregroundAgentProviderFromProcessList(
                '100 1 100 300 /bin/zsh -l\n200 100 200 300 /opt/tools/codex\n300 100 300 300 /usr/bin/git status\n',
                100,
            ),
        ).toBeUndefined();
        expect(
            foregroundAgentProviderFromProcessList(
                '100 1 100 200 /bin/zsh -l\n200 100 200 200 /opt/tools/codex\n201 100 200 200 /opt/tools/claude\n',
                100,
            ),
        ).toBeUndefined();
    });
});
