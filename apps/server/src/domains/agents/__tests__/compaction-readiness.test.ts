import { describe, expect, it } from 'vitest';

import { CompactionReadiness } from '../compaction-readiness';
import type { AgentLifecycleSignal } from '../hooks/contract';

const base = {
    terminalId: 'terminal',
    launchId: 'launch',
    agentTurnId: 'turn',
    provider: 'codex',
} as const;
const event = (phase: AgentLifecycleSignal['phase']) => ({ ...base, phase });

describe('compaction empty-composer proof', () => {
    it('requires an observed submission, matching native turn and no further input', () => {
        const state = new CompactionReadiness();
        state.observe(event('turnFinished'));
        expect(state.proof(base.terminalId)).toBeUndefined();
        state.input(base.terminalId, 'question');
        state.input(base.terminalId, '\r');
        state.observe(event('turnStarted'));
        state.observe(event('turnFinished'));
        expect(state.proof(base.terminalId)).toEqual({ launchId: 'launch', turnId: 'turn' });
        state.input(base.terminalId, 'next draft');
        expect(state.proof(base.terminalId)).toBeUndefined();
    });
    it('rejects a draft typed while the previous turn is running, even after Stop', () => {
        const state = new CompactionReadiness();
        state.input(base.terminalId, '\r');
        state.observe(event('turnStarted'));
        state.input(base.terminalId, 'draft');
        state.observe(event('turnFinished'));
        expect(state.proof(base.terminalId)).toBeUndefined();
    });
    it('rejects a pasted newline and a queued turn without its own observed submission', () => {
        const state = new CompactionReadiness();
        state.input(base.terminalId, '\u{1B}[200~');
        state.input(base.terminalId, '\r');
        state.observe(event('turnStarted'));
        state.observe(event('turnFinished'));
        expect(state.proof(base.terminalId)).toBeUndefined();
        state.input(base.terminalId, '\u{1B}[201~');
        state.input(base.terminalId, '\r');
        state.observe(event('turnStarted'));
        state.observe(event('turnFinished'));
        expect(state.proof(base.terminalId)).toBeDefined();
        state.observe({ ...event('turnStarted'), agentTurnId: 'queued' });
        state.observe({ ...event('turnFinished'), agentTurnId: 'queued' });
        expect(state.proof(base.terminalId)).toBeUndefined();
    });
    it.each([
        'attentionRequested',
        'compactionStarted',
        'sessionIdentified',
        'turnFailed',
    ] as const)('retires evidence at %s and ignores late completion', (phase) => {
        const state = new CompactionReadiness();
        state.input(base.terminalId, '\r');
        state.observe(event('turnStarted'));
        state.observe(event(phase));
        state.observe(event('turnFinished'));
        expect(state.proof(base.terminalId)).toBeUndefined();
    });
    it('never transfers proof across launches or child completion', () => {
        const state = new CompactionReadiness();
        state.input(base.terminalId, '\r');
        state.observe(event('turnStarted'));
        state.observe({ ...event('turnFinished'), launchId: 'other' });
        state.observe({ ...event('turnFinished'), agentId: 'child' });
        expect(state.proof(base.terminalId)).toBeUndefined();
    });
});
