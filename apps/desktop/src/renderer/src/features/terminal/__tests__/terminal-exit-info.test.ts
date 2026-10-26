import { beforeEach, describe, expect, it } from 'vitest';

import {
    forgetTerminalProcessState,
    getTerminalExitInfo,
    MAX_TERMINAL_EXIT_ENTRIES,
    noteTerminalProcessState,
    recordTerminalExit,
    resetTerminalExitInfoForTest,
} from '../terminal-exit-info';

describe('terminal exit info', () => {
    beforeEach(resetTerminalExitInfoForTest);

    it('measures run length from the first running state to the exit', () => {
        noteTerminalProcessState('t1', 'starting', 1_000);
        noteTerminalProcessState('t1', 'running', 2_000);
        recordTerminalExit({ terminalId: 't1', exitCode: 1, signal: 0 }, 3_500);
        expect(getTerminalExitInfo('t1')).toEqual({ exitCode: 1, ranForMs: 2_500 });
    });

    it('omits run length when the first observed state is already running', () => {
        noteTerminalProcessState('t1', 'running', 1_000);
        recordTerminalExit({ terminalId: 't1', exitCode: 1 }, 2_000);
        expect(getTerminalExitInfo('t1')).toEqual({ exitCode: 1 });
    });

    it('starts the clock when running follows an observed stop', () => {
        noteTerminalProcessState('t1', 'dead', 1_000);
        noteTerminalProcessState('t1', 'running', 2_000);
        recordTerminalExit({ terminalId: 't1', exitCode: 1 }, 3_000);
        expect(getTerminalExitInfo('t1')).toEqual({ exitCode: 1, ranForMs: 1_000 });
    });

    it('drops the clock when the pane unmounts', () => {
        noteTerminalProcessState('t1', 'starting', 1_000);
        forgetTerminalProcessState('t1');
        recordTerminalExit({ terminalId: 't1', exitCode: 1 }, 2_000);
        expect(getTerminalExitInfo('t1')).toEqual({ exitCode: 1 });
    });

    it('omits run length when the launch was not observed', () => {
        recordTerminalExit({ terminalId: 't1', exitCode: 0, signal: 15 });
        expect(getTerminalExitInfo('t1')).toEqual({ exitCode: 0, signal: 15 });
    });

    it('clears a previous exit when the Terminal runs again', () => {
        recordTerminalExit({ terminalId: 't1', exitCode: 1 });
        noteTerminalProcessState('t1', 'running');
        expect(getTerminalExitInfo('t1')).toBeUndefined();
    });

    it('evicts the oldest exit once the map is full', () => {
        for (let index = 0; index <= MAX_TERMINAL_EXIT_ENTRIES; index += 1)
            recordTerminalExit({ terminalId: `t${index}`, exitCode: 1 });
        expect(getTerminalExitInfo('t0')).toBeUndefined();
        expect(getTerminalExitInfo(`t${MAX_TERMINAL_EXIT_ENTRIES}`)).toEqual({ exitCode: 1 });
    });
});
