import { describe, expect, it, vi } from 'vitest';

import { createTerminalActivityObservers } from '../create-terminal-activity-observers';

function fixture() {
    const readiness = { input: vi.fn() };
    const observeInput = vi.fn<(terminalId: string, data: string) => void>();
    const interruptTerminal = vi.fn<(terminalId: string, isHumanInput: boolean) => void>();
    const suspension: { service?: { observeInput: typeof observeInput } } = {};
    const delegation: { service?: { interruptTerminal: typeof interruptTerminal } } = {};
    const commander = { input: vi.fn() };
    const coordinator = { observeOutput: vi.fn() };
    const observers = createTerminalActivityObservers(
        readiness,
        suspension,
        commander,
        delegation,
        coordinator,
    );
    suspension.service = { observeInput };
    delegation.service = { interruptTerminal };
    return { ...observers, readiness, suspension, commander, delegation, coordinator };
}

describe('Terminal activity attribution', () => {
    it('keeps maintenance readiness current without recording human intervention', () => {
        const f = fixture();
        f.onInput?.('terminal-a', '/compact\r', 'maintenance');
        expect(f.readiness.input).toHaveBeenCalledWith('terminal-a', '/compact\r');
        expect(f.suspension.service?.observeInput).not.toHaveBeenCalled();
        expect(f.commander.input).not.toHaveBeenCalled();
        expect(f.delegation.service?.interruptTerminal).not.toHaveBeenCalled();
    });

    it('routes human input through services installed after the factory was created', () => {
        const f = fixture();
        f.onInput?.('terminal-a', 'hello\r', 'human');
        expect(f.readiness.input).toHaveBeenCalledWith('terminal-a', 'hello\r');
        expect(f.suspension.service?.observeInput).toHaveBeenCalledWith('terminal-a', 'hello\r');
        expect(f.commander.input).toHaveBeenCalledWith('terminal-a', 'hello\r');
        expect(f.delegation.service?.interruptTerminal).toHaveBeenCalledWith('terminal-a', true);
    });

    it('keeps output activity bound to the reporting process', () => {
        const f = fixture();
        f.onOutputActivity?.('terminal-a', 123);
        expect(f.coordinator.observeOutput).toHaveBeenCalledWith('terminal-a', 123);
    });
});
