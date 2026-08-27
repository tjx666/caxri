// eslint-disable-next-line unicorn/name-replacements -- Vitest contract uses this exact suite naming convention.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConfigService } from '../config';

describe('ConfigurationService Agent Action history', () => {
    it('atomically persists provider-scoped recent actions without copying Terminal content', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-agent-action-mru-'));
        const service = new ConfigService(directory, () => {});
        try {
            await service.initialize();
            await service.updateSettings(`{
  // Keep this user-authored Settings note.
  "terminal.fontSize": 15,
}
`);

            await service.recordRecentAgentAction('codex', '/status');
            await service.recordRecentAgentAction('codex', '/diff');
            await service.recordRecentAgentAction('codex', '/status');
            await service.recordRecentAgentAction('claude', '/context');

            expect(
                service.getSettings().value['agents.providers'].codex.actions.recent.invocations,
            ).toEqual(['/status', '/diff']);
            expect(
                service.getSettings().value['agents.providers'].claude.actions.recent.invocations,
            ).toEqual(['/context']);
            const source = await readFile(service.settingsPath, 'utf8');
            expect(source).toContain('// Keep this user-authored Settings note.');
            expect(source).toContain('"recent": {');
            expect(source).not.toContain('"launch"');
            expect(source).not.toContain('"hooks"');
            expect(source).not.toContain('draft text');
            expect(source).not.toContain('prompt');
        } finally {
            await service.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('preserves a newer action receipt when a stale Settings editor source arrives later', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-agent-action-stale-'));
        const service = new ConfigService(directory, () => {});
        try {
            await service.initialize();
            await service.updateSettings('{ "terminal.fontSize": 15 }');
            const staleEditorSource = `{
  // This draft was prepared before the Agent action completed.
  "terminal.fontSize": 16,
}
`;

            await service.recordRecentAgentAction('codex', '/status');
            await service.updateSettings(staleEditorSource);

            expect(service.getSettings().value['terminal.fontSize']).toBe(16);
            expect(
                service.getSettings().value['agents.providers'].codex.actions.recent.invocations,
            ).toEqual(['/status']);
            expect(await readFile(service.settingsPath, 'utf8')).toContain(
                '// This draft was prepared before the Agent action completed.',
            );
        } finally {
            await service.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
