/**
 * CLI domains expose thin barrels by repository contract; commands consume the skills domain API rather than its
 * private module layout.
 */
// oxlint-disable-next-line react-doctor/no-barrel-import
import { agentSkillProviderUsage, parseAgentSkillProvider } from '@caxri/agent-skills';
import { CaxriError } from '@caxri/protocol';

import { rejectOptions } from './reject-options';
import type { LocalCommandDefinition } from './types';

const SKILL_NAME = 'caxri-cli';
const providerUsage = `<${agentSkillProviderUsage}>`;

function skillName(source: string | undefined): typeof SKILL_NAME {
    if (source !== SKILL_NAME)
        throw new CaxriError('VALIDATION', `Expected the bundled skill name ${SKILL_NAME}`);
    return SKILL_NAME;
}

function getSkill(tokens: readonly string[]): { full: boolean; name: typeof SKILL_NAME } {
    const name = skillName(tokens[0]);
    if (tokens.length === 1) return { full: false, name };
    if (tokens.length === 2 && tokens[1] === '--full') return { full: true, name };
    throw new CaxriError('VALIDATION', `Unknown option: ${tokens[1]?.split('=', 1)[0] ?? ''}`);
}

interface SkillCommandSelection {
    name: typeof SKILL_NAME;
    provider: ReturnType<typeof parseAgentSkillProvider>;
    scope: 'global' | 'local';
}

function selection(tokens: readonly string[]): SkillCommandSelection {
    const name = skillName(tokens[0]);
    let selectedProvider: SkillCommandSelection['provider'] | undefined;
    let scope: SkillCommandSelection['scope'] | undefined;
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--provider') {
            if (selectedProvider)
                throw new CaxriError('VALIDATION', '--provider may be provided only once');
            selectedProvider = parseAgentSkillProvider(tokens[index + 1]);
            index += 1;
        } else if (token === '--local' || token === '--global') {
            if (scope)
                throw new CaxriError('VALIDATION', 'Choose exactly one of --local or --global');
            scope = token === '--local' ? 'local' : 'global';
        } else throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
    }
    if (!selectedProvider)
        throw new CaxriError(
            'VALIDATION',
            `Skill installation requires --provider ${agentSkillProviderUsage}`,
        );
    if (!scope)
        throw new CaxriError('VALIDATION', 'Skill installation requires --local or --global');
    return { name, provider: selectedProvider, scope };
}

function statusSelection(tokens: readonly string[]): Partial<Omit<SkillCommandSelection, 'name'>> {
    let selectedProvider: SkillCommandSelection['provider'] | undefined;
    let scope: SkillCommandSelection['scope'] | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--provider') {
            if (selectedProvider)
                throw new CaxriError('VALIDATION', '--provider may be provided only once');
            selectedProvider = parseAgentSkillProvider(tokens[index + 1]);
            index += 1;
        } else if (token === '--local' || token === '--global') {
            if (scope)
                throw new CaxriError('VALIDATION', 'Choose at most one of --local or --global');
            scope = token === '--local' ? 'local' : 'global';
        } else throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=', 1)[0]}`);
    }
    return {
        ...(selectedProvider && { provider: selectedProvider }),
        ...(scope && { scope }),
    };
}

export const SKILL_COMMANDS: readonly LocalCommandDefinition[] = [
    {
        kind: 'local',
        path: ['skills', 'list'],
        summary: 'List version-matched Agent skills bundled with this CLI.',
        parseParams: rejectOptions,
    },
    {
        kind: 'local',
        path: ['skills', 'get'],
        summary: 'Read bundled skill metadata or its complete canonical text.',
        usage: 'caxri-cli [--full]',
        parseParams: getSkill,
    },
    {
        kind: 'local',
        path: ['skills', 'status'],
        summary: 'Inspect bundled and installed skill compatibility without a running Server.',
        usage: `[--provider ${providerUsage}] [--local|--global]`,
        parseParams: statusSelection,
    },
    {
        kind: 'local',
        path: ['skills', 'install'],
        summary: 'Install the bundled skill into one explicit Provider scope.',
        usage: `caxri-cli --provider ${providerUsage} <--local|--global>`,
        confirmation: 'Install the Caxri-managed skill into this Provider scope?',
        mutates: true,
        parseParams: selection,
    },
    {
        kind: 'local',
        path: ['skills', 'update'],
        summary: 'Atomically update one older Caxri-managed skill.',
        usage: `caxri-cli --provider ${providerUsage} <--local|--global>`,
        confirmation: 'Update the Caxri-managed skill in this Provider scope?',
        mutates: true,
        parseParams: selection,
    },
    {
        kind: 'local',
        path: ['skills', 'uninstall'],
        summary: 'Remove one current or older Caxri-managed skill.',
        usage: `caxri-cli --provider ${providerUsage} <--local|--global>`,
        confirmation: 'Remove the Caxri-managed skill from this Provider scope?',
        mutates: true,
        parseParams: selection,
    },
];
