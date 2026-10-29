import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider, ServerEvent } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../../db';
import { pushUsageGuardToPtyTerminals } from '../terminal-usage-guard-push';

describe('pushUsageGuardToPtyTerminals', () => {
    it('re-reads only the PTY Terminals of the provider whose guard changed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-guard-push-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(async () => {
            database.close();
            await rm(directory, { recursive: true, force: true });
        });
        const project = database.createProject(join(directory, 'project'));
        const { session } = database.createSession(project.id, null);
        const pty = database.createTerminal(session.id, 'claude');
        database.createTerminal(session.id, 'claude', undefined, 'chat');
        database.createTerminal(session.id, 'codex');
        let listener: ((provider: AgentProvider) => void) | undefined;
        const sent: ServerEvent[] = [];
        pushUsageGuardToPtyTerminals({
            guards: {
                subscribe: (next) => {
                    listener = next;
                    return () => {};
                },
            },
            database,
            send: (event) => sent.push(event),
        });
        listener?.('claude');
        expect(sent).toEqual([
            {
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [pty.id] },
            },
        ]);
        sent.length = 0;
        listener?.('gemini' as AgentProvider);
        expect(sent).toEqual([]);
    });
});
