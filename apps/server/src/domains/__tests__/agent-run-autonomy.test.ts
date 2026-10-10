import { describe, expect, it } from 'vitest';

import { AgentRunAutonomy } from '../agent-run-autonomy';

const yolo = '--dangerously-skip-permissions';

describe('AgentRunAutonomy', () => {
    it('launches on the configured settings until a launch asks to keep the previous mode', () => {
        const autonomy = new AgentRunAutonomy();
        const configured = { executable: 'claude', args: [yolo, '--verbose'] };
        expect(autonomy.launch('terminal-1', 'claude', configured)).toBe(configured);
        // The first resume of a Terminal this generation never launched has nothing to keep.
        expect(autonomy.launch('terminal-2', 'claude', configured, true)).toBe(configured);
    });

    it('keeps a YOLO launch in YOLO after the Settings switch turned it off', () => {
        const autonomy = new AgentRunAutonomy();
        autonomy.launch('terminal-1', 'claude', { executable: 'claude', args: [yolo] });
        expect(
            autonomy.launch(
                'terminal-1',
                'claude',
                { executable: 'claude', args: ['--verbose'] },
                true,
            ).args,
        ).toEqual([yolo, '--verbose']);
    });

    it('keeps an approving launch approving after the Settings switch turned YOLO on', () => {
        const autonomy = new AgentRunAutonomy();
        autonomy.launch('terminal-1', 'claude', { executable: 'claude', args: [] });
        expect(
            autonomy.launch(
                'terminal-1',
                'claude',
                { executable: 'claude', args: [yolo, '--verbose'] },
                true,
            ).args,
        ).toEqual(['--verbose']);
    });

    it('records each launch, so a fresh start resets what the next resume keeps', () => {
        const autonomy = new AgentRunAutonomy();
        autonomy.launch('terminal-1', 'claude', { executable: 'claude', args: [yolo] });
        autonomy.launch('terminal-1', 'claude', { executable: 'claude', args: [] });
        expect(
            autonomy.launch('terminal-1', 'claude', { executable: 'claude', args: [yolo] }, true)
                .args,
        ).toEqual([]);
    });
});
