import { readFile } from 'node:fs/promises';

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
            mentionCount: 0,
        });
    });

    it('resolves inline command mentions and ignores capability names', () => {
        const prose = [
            'Run `agent dispatch status <id>` or `caxri agent-context` with the `commander` capability,',
            'an `agent:control` grant, `settings.write`, `--json`, or `caxri --version`.',
            'Global options may lead: `caxri --json agent dispatch wait <id>`. Placeholders may follow:',
            '`agent message wait --timeout <milliseconds>` or `caxri --timeout <milliseconds> agent message wait`.',
            'An empty result has `message = null`; add `--request-id` to retry.',
        ].join('\n');
        expect(validateSkillCommands(`${requiredWorkflows}\n${prose}\n${capabilities}`)).toEqual({
            capabilityCount: 2,
            commandCount: 2,
            mentionCount: 5,
        });
    });

    it('rejects inline mentions that name only a command group', () => {
        expect(() =>
            validateSkillCommands(
                `${requiredWorkflows}\n- \`agent dispatch\` starts a conversation.\n${capabilities}`,
            ),
        ).toThrow('Skill mentions an unknown command: `agent dispatch`');
        expect(() =>
            validateSkillCommands(
                `${requiredWorkflows}\nUse \`agent\n  control\` to stop it.\n${capabilities}`,
            ),
        ).toThrow('Skill mentions an unknown command: `agent control`');
        expect(() =>
            validateSkillCommands(
                `${requiredWorkflows}\nRun \`--json agent dispatch\`.\n${capabilities}`,
            ),
        ).toThrow('Skill mentions an unknown command: `--json agent dispatch`');
    });

    it('rejects shorthand mentions that omit the command group', () => {
        expect(() =>
            validateSkillCommands(
                `${requiredWorkflows}\nUse \`stop <id>\` to interrupt it.\n${capabilities}`,
            ),
        ).toThrow('Skill mentions an unknown command: `stop <id>`');
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

    it('accepts the canonical caxri-cli skill', async () => {
        const skill = await readFile(
            new URL('../../../skills/caxri-cli/SKILL.md', import.meta.url),
            'utf8',
        );
        expect(validateSkillCommands(skill).mentionCount).toBeGreaterThan(0);
    });
});
