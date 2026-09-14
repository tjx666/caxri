import type { MethodResult, ParametersArgument } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * The Server calls the Settings dialog makes. Keeping them here rather than inline in the controller hook is the
 * boundary `caxri/server-reads-through-query` enforces: a request written inside a component or hook resolves into
 * state that dies with it, and the next feature copies whatever shape it sees.
 *
 * Each wrapper forwards `ParametersArgument` verbatim so the protocol registry stays the single source of truth for
 * these payloads instead of a hand-copied duplicate that can drift.
 */
export function getSettings(): Promise<MethodResult<'settings.get'>> {
    return caxri.request('settings.get');
}

export function updateSettings(
    ...arguments_: ParametersArgument<'settings.update'>
): Promise<MethodResult<'settings.update'>> {
    return caxri.request('settings.update', ...arguments_);
}

export function getKeybindings(): Promise<MethodResult<'keybindings.get'>> {
    return caxri.request('keybindings.get');
}

export function updateKeybindings(
    ...arguments_: ParametersArgument<'keybindings.update'>
): Promise<MethodResult<'keybindings.update'>> {
    return caxri.request('keybindings.update', ...arguments_);
}

export function getTheme(): Promise<MethodResult<'theme.get'>> {
    return caxri.request('theme.get');
}

export function updateTheme(
    ...arguments_: ParametersArgument<'theme.update'>
): Promise<MethodResult<'theme.update'>> {
    return caxri.request('theme.update', ...arguments_);
}

export function importThemeFile(): Promise<MethodResult<'theme.import'>> {
    return caxri.request('theme.import');
}

export function getAgentHookHealth(): Promise<MethodResult<'agentHooks.get'>> {
    return caxri.request('agentHooks.get');
}

export function getAgentSkillHealth(): Promise<MethodResult<'agentSkills.get'>> {
    return caxri.request('agentSkills.get');
}

export function getArgvConfig(): Promise<MethodResult<'argv.get'>> {
    return caxri.request('argv.get');
}

export function writeArgvConfig(
    ...arguments_: ParametersArgument<'argv.update'>
): Promise<MethodResult<'argv.update'>> {
    return caxri.request('argv.update', ...arguments_);
}
