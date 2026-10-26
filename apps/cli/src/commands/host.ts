import { booleanFlag } from './boolean-flag';
import { rejectOptions } from './reject-options';
import type { RemoteCommandDefinition } from './types';

export const HOST_COMMANDS: readonly RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['host', 'status'],
        method: 'host.status',
        summary: 'Show the selected profile Host and Desktop status.',
        parseParams: rejectOptions,
    },
    {
        kind: 'remote',
        path: ['host', 'stop'],
        method: 'host.stop',
        summary: 'Stop the selected profile Host and its Runtime.',
        confirmation: 'Stop this Caxri Host and terminate its live Terminals?',
        usage: '[--force]',
        parseParams: (tokens) => booleanFlag(tokens, '--force', 'confirmLivePtys'),
    },
    /**
     * The entry point of the background job Desktop registers with launchd while `Keep 5-hour windows rolling` is on.
     * It starts the Host when Caxri is closed and runs one idempotent check, which may send the one minimal request the
     * schedule calls for. No confirmation: the user already chose the schedule, and a repeated run never sends twice.
     */
    {
        kind: 'remote',
        path: ['host', 'claude-window-tick'],
        method: 'claudeWindow.tick',
        summary: 'Run one Claude 5-hour window check for the signed-in account.',
        parseParams: rejectOptions,
        requiresHumanOwner: true,
    },
];
