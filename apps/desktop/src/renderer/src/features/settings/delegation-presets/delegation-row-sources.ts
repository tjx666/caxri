import type { SettingSpec } from '@caxri/protocol';
import { settingsSpecByKey } from '@caxri/protocol';

import type { SettingRowSource } from '../settings-row-sources';

/**
 * The search-term builders `settings-row-sources.ts` owns, passed in so this module never imports that file at runtime.
 */
interface RowSearchTerms {
    lower: (values: Array<string | undefined>) => string;
    specSearchTerms: (spec: SettingSpec, extra?: string[]) => string;
}

/**
 * The Settings > Agents rows for delegation: the read-only preset list with dianjiang import, then the advanced depth,
 * read-child-Chat and parent-approval fields. Split out of `settings-row-sources.ts`, which sits at the source-size
 * ratchet.
 */
export function delegationRowSources({
    lower,
    specSearchTerms,
}: RowSearchTerms): SettingRowSource[] {
    return [
        {
            id: 'agents.delegation.presets',
            category: 'agents',
            titleKey: 'settings.row.delegationPresets.title',
            descriptionKey: 'settings.row.delegationPresets.description',
            binding: { type: 'delegation-presets' },
            searchSpec: 'agents.delegation',
            searchTerms: lower([
                'dianjiang',
                'import',
                'presets',
                'delegation',
                'delegate',
                'model',
                'effort',
            ]),
        },
        {
            id: 'agents.delegation.maxDepth',
            advanced: true,
            category: 'agents',
            titleKey: 'settings.row.delegationDepth.title',
            descriptionKey: 'settings.row.delegationDepth.description',
            /**
             * The worked example and the pointer to where delegation presets are edited both matter, but together they
             * wrapped this row to four lines (issue caxri#1289). Moved behind the row's info affordance so the one-line
             * description stays the thing every reader sees.
             */
            detailKey: 'settings.row.delegationDepth.detail',
            binding: { type: 'delegation-field', field: 'maxDepth' },
            /**
             * Derived from the one spec that already describes this key, so the words it lists (`model`, `effort`,
             * `caller`) keep finding the row instead of dying with the complex editor this row replaced.
             */
            searchSpec: 'agents.delegation',
            searchTerms: specSearchTerms(settingsSpecByKey['agents.delegation'], [
                'delegation depth',
                'delegate',
                'max depth',
                'subagent',
                'helper',
                'hand off',
            ]),
        },
        {
            id: 'agents.delegation.readChildChat',
            advanced: true,
            category: 'agents',
            titleKey: 'settings.row.delegationReadChildChat.title',
            descriptionKey: 'settings.row.delegationReadChildChat.description',
            binding: { type: 'delegation-field', field: 'readChildChat' },
            searchTerms: lower([
                'delegation transcript',
                'read child chat',
                'delegate',
                'subagent',
                'conversation',
                'progress',
            ]),
        },
        {
            id: 'agents.delegation.approval',
            advanced: true,
            category: 'agents',
            titleKey: 'settings.row.delegationApproval.title',
            descriptionKey: 'settings.row.delegationApproval.description',
            binding: { type: 'delegation-field', field: 'approval' },
            searchTerms: lower([
                'parent approval',
                'approve',
                'permission request',
                'delegate',
                'subagent',
                'helper',
            ]),
        },
    ];
}
