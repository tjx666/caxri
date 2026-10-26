import { describe, expect, it, vi } from 'vitest';

import { createRuntimeFailurePrompt, runtimeFailureChoice } from '../runtime-failure';
import { serverReplacementNotice } from '../stale-server-notice';

function prompt(responses: number[]) {
    const showDialog = vi.fn(() => Promise.resolve({ response: responses.shift() ?? 2 }));
    const actions = { quit: vi.fn(), relaunch: vi.fn(), revealLogs: vi.fn() };
    return { actions, showDialog, ...createRuntimeFailurePrompt({ ...actions, showDialog }) };
}

describe('runtime failure prompt', () => {
    it('opens once per failure transition and relaunches on the first button', async () => {
        const p = prompt([0]);
        p.observe('ready');
        p.observe('failed');
        p.observe('failed');
        await vi.waitFor(() => expect(p.actions.relaunch).toHaveBeenCalledOnce());
        expect(p.showDialog).toHaveBeenCalledOnce();
    });

    it('re-arms after the Server recovers', async () => {
        const p = prompt([2, 2]);
        p.observe('failed');
        p.observe('restarting');
        p.observe('failed');
        await vi.waitFor(() => expect(p.actions.quit).toHaveBeenCalledTimes(2));
    });

    it('reveals logs and keeps the dialog open', async () => {
        const p = prompt([1, 2]);
        p.observe('failed');
        await vi.waitFor(() => expect(p.actions.quit).toHaveBeenCalledOnce());
        expect(p.actions.revealLogs).toHaveBeenCalledOnce();
        expect(p.showDialog).toHaveBeenCalledTimes(2);
    });

    it('maps buttons', () => {
        expect(runtimeFailureChoice(0)).toBe('retry');
        expect(runtimeFailureChoice(1)).toBe('reveal');
        expect(runtimeFailureChoice(2)).toBe('quit');
    });
});

describe('serverReplacementNotice', () => {
    it('stays silent when no Terminal was stopped', () => {
        expect(serverReplacementNotice(0)).toBeUndefined();
    });

    it('pluralizes the count', () => {
        expect(serverReplacementNotice(1)?.body).toContain('1 running Terminal ');
        expect(serverReplacementNotice(3)?.body).toContain('3 running Terminals');
    });
});
