import { CaxriError } from '@caxri/protocol';

import type { LocalCommandDefinition } from './command-catalog';

const SKILL_NAME = 'caxri-cli';
const providers = ['claude', 'codex'] as const;

type SkillCommandProvider = (typeof providers)[number];

function rejectOptions(tokens: readonly string[]): Record<string, never> {
    if (tokens.length > 0)
        throw new CaxriError('VALIDATION', `Unexpected argument: ${tokens[0].split('=')[0]}`);
    return {};
}

function skillName(source: string | undefined): typeof SKILL_NAME {
    if (source !== SKILL_NAME)
        throw new CaxriError('VALIDATION', `Expected the bundled skill name ${SKILL_NAME}`);
    return SKILL_NAME;
}

function provider(source: string | undefined): SkillCommandProvider {
    if (!providers.includes(source as SkillCommandProvider))
        throw new CaxriError('VALIDATION', '--provider must be claude or codex');
    return source as SkillCommandProvider;
}

function getSkill(tokens: readonly string[]): { full: boolean; name: typeof SKILL_NAME } {
    const name = skillName(tokens[0]);
    if (tokens.length === 1) return { full: false, name };
    if (tokens.length === 2 && tokens[1] === '--full') return { full: true, name };
    throw new CaxriError('VALIDATION', `Unknown option: ${tokens[1]?.split('=')[0] ?? ''}`);
}

interface SkillCommandSelection {
    name: typeof SKILL_NAME;
    provider: SkillCommandProvider;
    scope: 'global' | 'local';
}

function selection(tokens: readonly string[]): SkillCommandSelection {
    const name = skillName(tokens[0]);
    let selectedProvider: SkillCommandProvider | undefined;
    let scope: SkillCommandSelection['scope'] | undefined;
    for (let index = 1; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--provider') {
            if (selectedProvider)
                throw new CaxriError('VALIDATION', '--provider may be provided only once');
            selectedProvider = provider(tokens[index + 1]);
            index += 1;
        } else if (token === '--local' || token === '--global') {
            if (scope)
                throw new CaxriError('VALIDATION', 'Choose exactly one of --local or --global');
            scope = token === '--local' ? 'local' : 'global';
        } else throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=')[0]}`);
    }
    if (!selectedProvider)
        throw new CaxriError('VALIDATION', 'Skill installation requires --provider claude|codex');
    if (!scope)
        throw new CaxriError('VALIDATION', 'Skill installation requires --local or --global');
    return { name, provider: selectedProvider, scope };
}

function statusSelection(tokens: readonly string[]): Partial<Omit<SkillCommandSelection, 'name'>> {
    let selectedProvider: SkillCommandProvider | undefined;
    let scope: SkillCommandSelection['scope'] | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--provider') {
            if (selectedProvider)
                throw new CaxriError('VALIDATION', '--provider may be provided only once');
            selectedProvider = provider(tokens[index + 1]);
            index += 1;
        } else if (token === '--local' || token === '--global') {
            if (scope)
                throw new CaxriError('VALIDATION', 'Choose at most one of --local or --global');
            scope = token === '--local' ? 'local' : 'global';
        } else throw new CaxriError('VALIDATION', `Unknown option: ${token.split('=')[0]}`);
    }
    return {
        ...(selectedProvider ? { provider: selectedProvider } : {}),
        ...(scope ? { scope } : {}),
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
        summary: 'Inspect bundled and installed skill compatibility without a Host.',
        usage: '[--provider <claude|codex>] [--local|--global]',
        parseParams: statusSelection,
    },
    {
        kind: 'local',
        path: ['skills', 'install'],
        summary: 'Install the bundled skill into one explicit Provider scope.',
        usage: 'caxri-cli --provider <claude|codex> <--local|--global>',
        confirmation: 'Install the Caxri-managed skill into this Provider scope?',
        mutates: true,
        parseParams: selection,
    },
    {
        kind: 'local',
        path: ['skills', 'update'],
        summary: 'Atomically update one older Caxri-managed skill.',
        usage: 'caxri-cli --provider <claude|codex> <--local|--global>',
        confirmation: 'Update the Caxri-managed skill in this Provider scope?',
        mutates: true,
        parseParams: selection,
    },
    {
        kind: 'local',
        path: ['skills', 'uninstall'],
        summary: 'Remove one current or older Caxri-managed skill.',
        usage: 'caxri-cli --provider <claude|codex> <--local|--global>',
        confirmation: 'Remove the Caxri-managed skill from this Provider scope?',
        mutates: true,
        parseParams: selection,
    },
];
