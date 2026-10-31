import type { Principal } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import type { ExtensionService } from '../../extensions/service';
import { invokeMobilePanelRequest } from '../panel-requests';

type PairedPrincipal = Extract<Principal, { kind: 'paired-device' }>;

const principal = (role: PairedPrincipal['role']): PairedPrincipal => ({
    kind: 'paired-device',
    id: 'device_1',
    deviceId: 'device_1',
    generation: 1,
    projectIds: ['project-1'],
    role,
});

const terminal = (overrides: { id: string; provider?: string; surface?: 'chat' }) => ({
    sessionId: 'session-1',
    kind: 'claude',
    provider: 'claude',
    surface: 'chat' as const,
    title: 'Claude',
    lastProcessState: 'running',
    ...overrides,
});

const prompt = 'Resolve the merge conflicts\r\nplease\u{1B}';

function setup(terminals: Array<ReturnType<typeof terminal>>, primaryAgentTerminalId?: string) {
    const request = vi.fn((method: string) => {
        if (method === 'session.queryForPrincipal')
            return Promise.resolve({
                sessions: [{ id: 'session-1', projectId: 'project-1', primaryAgentTerminalId }],
            });
        if (method === 'app.sessionContext')
            return Promise.resolve({
                projectIds: ['project-1'],
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
            });
        if (method === 'terminal.queryForPrincipal') return Promise.resolve({ terminals });
        throw new Error(`Unexpected method: ${method}`);
    });
    const executeCommand = vi.fn();
    const forward = vi.fn(() => Promise.resolve(null));
    const reauthorize = vi.fn();
    const run = (role: PairedPrincipal['role'], arguments_: unknown[] = [prompt]) =>
        invokeMobilePanelRequest(
            {
                method: 'mobile.tree.executeCommand',
                params: {
                    sessionId: 'session-1',
                    commandId: 'caxri.sendToAgent',
                    arguments: arguments_,
                },
            },
            principal(role),
            { request } as unknown as ServerDomainService,
            { executeCommand } as unknown as ExtensionService,
            reauthorize,
            forward,
        );
    return { executeCommand, forward, reauthorize, run };
}

describe('mobile.tree.executeCommand caxri.sendToAgent', () => {
    it('sends the normalized prompt to the Session primary Agent Chat', async () => {
        const { executeCommand, forward, run } = setup(
            [
                terminal({ id: 'other-chat' }),
                terminal({ id: 'primary', provider: 'codex' }),
                terminal({ id: 'pty', surface: undefined }),
            ],
            'primary',
        );
        await expect(run('control')).resolves.toEqual({
            executed: true,
            message: 'Sent to Codex',
        });
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.send',
            params: { terminalId: 'primary', text: 'Resolve the merge conflicts\nplease' },
        });
        expect(executeCommand).not.toHaveBeenCalled();
    });

    it('rejects a device that cannot start an Agent turn before reading anything', async () => {
        const { forward, run } = setup([terminal({ id: 'chat' })], 'chat');
        await expect(run('reply')).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(forward).not.toHaveBeenCalled();
    });

    it('rejects a missing, blank, or oversized prompt', async () => {
        const { forward, run } = setup([terminal({ id: 'chat' })], 'chat');
        await expect(run('control', [])).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(run('control', ['\u{1B}'])).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(run('control', ['x'.repeat(100_001)])).rejects.toMatchObject({
            code: 'VALIDATION',
        });
        expect(forward).not.toHaveBeenCalled();
    });

    it('conflicts when the primary Agent is a Terminal or the Session has none', async () => {
        const { forward, run } = setup([terminal({ id: 'pty', surface: undefined })], 'pty');
        await expect(run('control')).rejects.toMatchObject({ code: 'CONFLICT' });
        const none = setup([terminal({ id: 'chat' })], undefined);
        await expect(none.run('control')).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(forward).not.toHaveBeenCalled();
        expect(none.forward).not.toHaveBeenCalled();
    });

    it('does not send when the device is revoked after the Chat is resolved', async () => {
        const { forward, reauthorize, run } = setup([terminal({ id: 'chat' })], 'chat');
        reauthorize.mockImplementation(() => {
            throw new Error('revoked');
        });
        await expect(run('control')).rejects.toThrow('revoked');
        expect(forward).not.toHaveBeenCalled();
    });
});
