import type { TerminalSnapshot, TerminalWheelInput } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import { TerminalRemoteObservers } from '../../domains/terminal';
import type { RemoteTerminalIdentity, TerminalHostControl } from './execution-contract';
import { terminalScope } from './execution-scope';

/**
 * Core-to-Host mobile control keeps its own authority path; Desktop attachments never grant mobile access.
 */
export class RemoteMobileTerminalControl {
    private readonly observers = new TerminalRemoteObservers();

    constructor(
        private readonly identities: ReadonlyMap<string, RemoteTerminalIdentity>,
        private readonly supervisor: TerminalHostControl,
    ) {}

    private requireGeneration(
        terminalId: string,
        expectedGeneration: number,
    ): RemoteTerminalIdentity {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId || identity.generation !== expectedGeneration)
            throw new CaxriError('CONFLICT', 'Terminal generation changed');
        return identity;
    }

    async observe(
        terminalId: string,
        observerId: string,
    ): Promise<{ snapshot: TerminalSnapshot | null; nextSequence: number; generation: number }> {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId) throw new CaxriError('UNAVAILABLE', 'Terminal is not running');
        await identity.ready;
        const result = (await this.supervisor.request(
            { method: 'terminal.observe', params: { observerId } },
            terminalScope(identity, 'terminal.observe'),
        )) as { snapshot: TerminalSnapshot | null; nextSequence: number };
        if (this.identities.get(terminalId) !== identity || !identity.processId)
            throw new CaxriError('CONFLICT', 'Terminal generation changed during observation');
        if (!result.snapshot) throw new CaxriError('UNAVAILABLE', 'Terminal is not running');
        this.observers.add(terminalId, observerId);
        return { ...result, generation: identity.generation };
    }

    isObserved(terminalId: string): boolean {
        return this.observers.has(terminalId);
    }

    async unobserve(terminalId: string, observerId: string): Promise<void> {
        this.observers.remove(terminalId, observerId);
        const identity = this.identities.get(terminalId);
        if (!identity?.processId) return;
        await this.supervisor.request(
            { method: 'terminal.unobserve', params: { observerId } },
            terminalScope(identity, 'terminal.observe'),
        );
    }

    async takeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
        size: { cols: number; rows: number },
        timeoutMs: number,
    ): Promise<{ expiresAt: number }> {
        const identity = this.requireGeneration(terminalId, expectedGeneration);
        return (await this.supervisor.request(
            { method: 'terminal.takeOver', params: { holderId, size, timeoutMs } },
            terminalScope(identity, 'terminal.lease'),
        )) as { expiresAt: number };
    }

    async renewTakeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
        timeoutMs: number,
    ): Promise<{ expiresAt: number }> {
        const identity = this.requireGeneration(terminalId, expectedGeneration);
        return (await this.supervisor.request(
            { method: 'terminal.renewTakeOver', params: { holderId, timeoutMs } },
            terminalScope(identity, 'terminal.lease'),
        )) as { expiresAt: number };
    }

    async releaseTakeOver(
        terminalId: string,
        holderId: string,
        expectedGeneration: number,
    ): Promise<void> {
        const identity = this.identities.get(terminalId);
        if (!identity?.processId || identity.generation !== expectedGeneration) return;
        await this.supervisor.request(
            { method: 'terminal.releaseTakeOver', params: { holderId } },
            terminalScope(identity, 'terminal.lease'),
        );
    }

    async inputForGeneration(
        terminalId: string,
        expectedGeneration: number,
        data: string,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const identity = this.requireGeneration(terminalId, expectedGeneration);
        const result = (await this.supervisor.request(
            { method: 'terminal.observer.input', params: { data } },
            terminalScope(identity, 'terminal.mobile.input'),
            signal,
        )) as { accepted: boolean };
        return result.accepted;
    }

    async scrollForGeneration(
        terminalId: string,
        expectedGeneration: number,
        wheel: TerminalWheelInput,
        signal?: AbortSignal,
    ): Promise<boolean> {
        const identity = this.requireGeneration(terminalId, expectedGeneration);
        const result = (await this.supervisor.request(
            { method: 'terminal.observer.scroll', params: wheel },
            terminalScope(identity, 'terminal.mobile.input'),
            signal,
        )) as { accepted: boolean };
        return result.accepted;
    }
}
