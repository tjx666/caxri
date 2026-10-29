import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { validateSkillCommands } from './validate-skill';

const requiredWorkflows = `
caxri settings validate --set terminal.fontSize=14
caxri agent message wait --timeout 30000
`;
const capabilities = '<!-- caxri-capabilities: settings.read,settings.write -->';

describe('caxri-cli skill validation', () => {
    it('validates command examples, capabilities, and required workflows', async () => {
        expect(await validateSkillCommands(`${requiredWorkflows}\n${capabilities}`)).toEqual({
            capabilityCount: 2,
            commandCount: 2,
            mentionCount: 0,
        });
    });

    it('resolves inline command mentions and ignores capability names', async () => {
        const prose = [
            'Run `agent dispatch status <id>` or `caxri agent-context` with the `bot` capability,',
            'an `agent:control` grant, `settings.write`, `--json`, or `caxri --version`.',
            'Global options may lead: `caxri --json agent dispatch wait <id>`. Placeholders may follow:',
            '`agent message wait --timeout <milliseconds>` or `caxri --timeout <milliseconds> agent message wait`.',
            'An empty result has `message = null`; add `--request-id` to retry.',
        ].join('\n');
        expect(
            await validateSkillCommands(`${requiredWorkflows}\n${prose}\n${capabilities}`),
        ).toEqual({
            capabilityCount: 2,
            commandCount: 2,
            mentionCount: 5,
        });
    });

    it('validates generic request examples against the protocol schema', async () => {
        const valid = `${requiredWorkflows}\ncaxri request session.query --params '{"mode":"list"}'\n${capabilities}`;
        expect((await validateSkillCommands(valid)).commandCount).toBe(3);
        await expect(
            validateSkillCommands(
                `${requiredWorkflows}\ncaxri request session.query --params '{"mode":"bogus"}'\n${capabilities}`,
            ),
        ).rejects.toThrow('Invalid params for session.query');
    });

    it('rejects inline mentions that name only a command group', async () => {
        await expect(
            validateSkillCommands(
                `${requiredWorkflows}\n- \`agent dispatch\` starts a conversation.\n${capabilities}`,
            ),
        ).rejects.toThrow('Skill mentions an unknown command: `agent dispatch`');
        await expect(
            validateSkillCommands(
                `${requiredWorkflows}\nUse \`agent\n  control\` to stop it.\n${capabilities}`,
            ),
        ).rejects.toThrow('Skill mentions an unknown command: `agent control`');
        await expect(
            validateSkillCommands(
                `${requiredWorkflows}\nRun \`--json agent dispatch\`.\n${capabilities}`,
            ),
        ).rejects.toThrow('Skill mentions an unknown command: `--json agent dispatch`');
    });

    it('rejects shorthand mentions that omit the command group', async () => {
        await expect(
            validateSkillCommands(
                `${requiredWorkflows}\nUse \`stop <id>\` to interrupt it.\n${capabilities}`,
            ),
        ).rejects.toThrow('Skill mentions an unknown command: `stop <id>`');
    });

    it('rejects missing commands and unknown command examples', async () => {
        await expect(validateSkillCommands(capabilities)).rejects.toThrow(
            'has no command examples',
        );
        await expect(
            validateSkillCommands(`${requiredWorkflows}\ncaxri unknown command\n${capabilities}`),
        ).rejects.toThrow('Skill references an unknown command');
    });

    it('validates timeout parameters for both wait workflows', async () => {
        expect(
            await validateSkillCommands(
                `${requiredWorkflows}\ncaxri agent dispatch wait dispatch-1 --after-revision 3 --timeout 30000\n${capabilities}`,
            ),
        ).toMatchObject({ commandCount: 3 });
    });

    it('rejects missing and unknown capability markers', async () => {
        await expect(validateSkillCommands(requiredWorkflows)).rejects.toThrow(
            'missing its capability validation marker',
        );
        await expect(
            validateSkillCommands(
                `${requiredWorkflows}\n<!-- caxri-capabilities: settings.read,unknown -->`,
            ),
        ).rejects.toThrow('Skill references an unknown capability: unknown');
    });

    it('requires both dry-run settings and peer pull workflows', async () => {
        await expect(
            validateSkillCommands(
                `caxri settings validate --set terminal.fontSize=14\n${capabilities}`,
            ),
        ).rejects.toThrow('must retain Settings dry-run and Peer pull workflows');
    });

    it('accepts the canonical caxri-cli skill', async () => {
        const skill = await readFile(
            new URL('../../../skills/caxri-cli/SKILL.md', import.meta.url),
            'utf8',
        );
        expect((await validateSkillCommands(skill)).mentionCount).toBeGreaterThan(0);
    });
});
