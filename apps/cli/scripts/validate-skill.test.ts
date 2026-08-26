import { describe, expect, it } from 'vitest';

import { validateSkillCommands } from './validate-skill';

const requiredWorkflows = `
caxri settings validate --set terminal.fontSize=14
caxri agent message wait --timeout 30000
`;
const capabilities = '<!-- caxri-capabilities: settings.read,settings.write -->';

describe('caxri-cli skill validation', () => {
    it('validates command examples, capabilities, and required workflows', () => {
        expect(validateSkillCommands(`${requiredWorkflows}\n${capabilities}`)).toEqual({
            capabilityCount: 2,
            commandCount: 2,
        });
    });

    it('rejects missing commands and unknown command examples', () => {
        expect(() => validateSkillCommands(capabilities)).toThrow('has no command examples');
        expect(() =>
            validateSkillCommands(`${requiredWorkflows}\ncaxri unknown command\n${capabilities}`),
        ).toThrow('Skill references an unknown command');
    });

    it('validates timeout parameters for both wait workflows', () => {
        expect(
            validateSkillCommands(
                `${requiredWorkflows}\ncaxri agent dispatch wait dispatch-1 --after-revision 3 --timeout 30000\n${capabilities}`,
            ),
        ).toMatchObject({ commandCount: 3 });
    });

    it('rejects missing and unknown capability markers', () => {
        expect(() => validateSkillCommands(requiredWorkflows)).toThrow(
            'missing its capability validation marker',
        );
        expect(() =>
            validateSkillCommands(
                `${requiredWorkflows}\n<!-- caxri-capabilities: settings.read,unknown -->`,
            ),
        ).toThrow('Skill references an unknown capability: unknown');
    });

    it('requires both dry-run settings and peer pull workflows', () => {
        expect(() =>
            validateSkillCommands(
                `caxri settings validate --set terminal.fontSize=14\n${capabilities}`,
            ),
        ).toThrow('must retain Settings dry-run and Peer pull workflows');
    });
});
