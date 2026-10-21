import { randomUUID } from 'node:crypto';

import type {
    AgentLaunchSettings,
    AgentProvider,
    TerminalFailureReason,
    TerminalRecord,
} from '@caxri/protocol';
import {
    agentProviderCatalog,
    defaultAgentProviderSettings,
    errorMessage,
    isCaxriError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import {
    assertE2EAgentLaunch,
    assertE2EShellLaunch,
    logEventCatalog,
    readE2EAgentPolicy,
} from '@caxri/system';
import { expandLaunchArguments } from '@caxri/utils';

// Server providers use the public domain barrel by architecture contract.
// oxlint-disable-next-line react-doctor/no-barrel-import
import { agentProviders, AgentRunAutonomy, defaultAgentEnvironment, readVersion } from '../agents';
import { agentProcessEnvironment } from '../executables';
import { assertTerminalWorkingDirectory, resolveTerminalExecutable } from './launch';
import type {
    TerminalManagerOptions,
    TerminalStartOptions,
    TerminalWorkingDirectoryIdentity,
} from './manager-types';
import { managedAgentShellExecutable } from './shell-integration';
import { terminalEnvironment } from './terminal-environment';

export interface ResolvedTerminalLaunch {
    args: string[];
    executable: string;
    agent?: {
        agentSessionId?: string;
        resumeAgentSessionId?: string;
        assignedAgentSessionId?: string;
        initialPrompt?: string;
        args: string[];
        executable: string;
        launch: AgentLaunchSettings;
        launchId: ReturnType<typeof randomUUID>;
        provider: AgentProvider;
    };
}

export interface TerminalLaunchPlan extends ResolvedTerminalLaunch {
    agent?: NonNullable<ResolvedTerminalLaunch['agent']> & { environment: NodeJS.ProcessEnv };
    environment: NodeJS.ProcessEnv;
}

export type TerminalLaunchPlanResult<T> =
    | { ok: true; value: T }
    | {
          ok: false;
          error: unknown;
          failureReason: TerminalFailureReason;
          failureDetail?: string;
      };

export interface TerminalLaunchPlannerOptions {
    agentEnvironment?: () => Promise<NodeJS.ProcessEnv>;
    agentLaunchArguments?: TerminalManagerOptions['agentLaunchArguments'];
    agentLaunchPrompt?: TerminalManagerOptions['agentLaunchPrompt'];
    agentLaunchSettings?: (provider: AgentProvider) => AgentLaunchSettings;
    lifecycleEnvironment?: TerminalManagerOptions['lifecycleEnvironment'];
    shellEnvironment?: TerminalManagerOptions['shellEnvironment'];
    logger: StructuredLogger;
    resolveExecutable?: TerminalManagerOptions['resolveExecutable'];
    shellIntegration?: TerminalManagerOptions['shellIntegration'];
}

/**
 * Produces the serializable launch input consumed by the Terminal execution owner. Splitting resolve from prepare keeps
 * the existing restore-grid wait between executable discovery and working-directory/environment validation.
 */
export class TerminalLaunchPlanner {
    private readonly agentEnvironment: () => Promise<NodeJS.ProcessEnv>;
    private readonly agentRunAutonomy = new AgentRunAutonomy();

    constructor(private readonly options: TerminalLaunchPlannerOptions) {
        this.agentEnvironment = options.agentEnvironment ?? agentProcessEnvironment;
    }

    async resolve(
        record: TerminalRecord,
        start?: TerminalStartOptions,
    ): Promise<TerminalLaunchPlanResult<ResolvedTerminalLaunch>> {
        try {
            const e2eAgentPolicy = readE2EAgentPolicy();
            const configuredShellExecutable = await resolveTerminalExecutable(
                'shell',
                undefined,
                this.options.resolveExecutable,
            );
            if (record.kind === 'shell') {
                assertE2EShellLaunch(e2eAgentPolicy);
                return {
                    ok: true,
                    value: { args: ['-l'], executable: configuredShellExecutable },
                };
            }
            const executable = managedAgentShellExecutable(configuredShellExecutable);
            const shouldLaunchAgent =
                start?.launchAgent ?? record.lastAgentProcessState !== 'stopped';
            if (!shouldLaunchAgent) return { ok: true, value: { args: ['-l'], executable } };

            const launch = this.agentRunAutonomy.launch(
                record.id,
                record.kind,
                start?.launchSettings ??
                    this.options.agentLaunchSettings?.(record.kind) ??
                    defaultAgentProviderSettings[record.kind].launch,
                start?.shouldKeepAgentAutonomy,
            );
            try {
                assertE2EAgentLaunch(
                    e2eAgentPolicy,
                    record.kind,
                    launch,
                    start?.resumeAgentSessionId,
                );
            } catch (error) {
                return { ok: false, error, failureReason: 'spawn_failed' };
            }
            try {
                const agentExecutable = await resolveTerminalExecutable(
                    record.kind,
                    launch,
                    this.options.resolveExecutable,
                );
                const agentArguments = [
                    ...(agentProviders[record.kind].managedLaunchArguments ?? []),
                    ...(this.options.agentLaunchArguments?.(record) ?? []),
                    ...expandLaunchArguments(launch.args),
                ];
                if (start?.resumeAgentSessionId && !agentProviders[record.kind].prepareLaunch) {
                    agentArguments.push(
                        ...agentProviders[record.kind].resumeArguments(start.resumeAgentSessionId),
                    );
                }
                const initialPrompt =
                    start?.initialPrompt ?? this.options.agentLaunchPrompt?.(record);
                if (initialPrompt && !agentProviders[record.kind].prepareLaunch)
                    agentArguments.push('--', initialPrompt);
                return {
                    ok: true,
                    value: {
                        args: ['-l'],
                        executable,
                        agent: {
                            resumeAgentSessionId: start?.resumeAgentSessionId,
                            assignedAgentSessionId: start?.assignedAgentSessionId,
                            initialPrompt,
                            args: agentArguments,
                            executable: agentExecutable,
                            launch,
                            launchId: randomUUID(),
                            provider: record.kind,
                        },
                    },
                };
            } catch (error) {
                return {
                    ok: false,
                    error,
                    failureReason: 'executable_not_found',
                    failureDetail: `${agentProviderCatalog[record.kind].displayName} CLI was not found`,
                };
            }
        } catch (error) {
            if (isCaxriError(error) && error.details?.reason === 'shell_not_found')
                return {
                    ok: false,
                    error,
                    failureReason: 'executable_not_found',
                    failureDetail: error.message,
                };
            return { ok: false, error, failureReason: 'spawn_failed' };
        }
    }

    async prepare(
        record: TerminalRecord,
        resolved: ResolvedTerminalLaunch,
        expectedWorkingDirectory?: TerminalWorkingDirectoryIdentity,
        delegationId?: string,
    ): Promise<TerminalLaunchPlanResult<TerminalLaunchPlan>> {
        try {
            await assertTerminalWorkingDirectory(record.cwd, expectedWorkingDirectory);
        } catch (error) {
            return { ok: false, error, failureReason: 'working_directory_unavailable' };
        }
        try {
            let arguments_ = resolved.args;
            let environment = terminalEnvironment();
            try {
                const integrated = this.options.shellIntegration?.(
                    resolved.executable,
                    environment,
                );
                if (integrated) {
                    arguments_ = integrated.args;
                    environment = integrated.environment;
                } else if (resolved.agent) {
                    throw new Error(
                        'Managed Agent Terminals require zsh or bash shell integration',
                    );
                }
            } catch (error) {
                if (resolved.agent) throw error;
                /**
                 * Shell integration is optional decoration metadata; startup retains the ordinary login-shell path if
                 * its resolver becomes unavailable.
                 */
                this.options.logger.write('warn', logEventCatalog.pty.shellIntegrationUnavailable, {
                    fields: { error: errorMessage(error, 'unknown') },
                });
            }
            environment = { ...environment, ...this.options.shellEnvironment?.(record) };
            const providerEnvironment = resolved.agent ? await this.agentEnvironment() : undefined;
            if (resolved.agent) {
                const prepareLaunch = agentProviders[resolved.agent.provider].prepareLaunch;
                if (prepareLaunch) {
                    const prepared = await prepareLaunch({
                        args: resolved.agent.args,
                        cwd: record.cwd,
                        environment: defaultAgentEnvironment(providerEnvironment),
                        resumeAgentSessionId: resolved.agent.resumeAgentSessionId,
                        assignedAgentSessionId: resolved.agent.assignedAgentSessionId,
                        initialPrompt: resolved.agent.initialPrompt,
                        version: await readVersion(
                            resolved.agent.provider,
                            resolved.agent.executable,
                        ),
                    });
                    resolved = { ...resolved, agent: { ...resolved.agent, ...prepared } };
                }
            }
            const agent = resolved.agent
                ? {
                      ...resolved.agent,
                      environment: {
                          ...providerEnvironment,
                          TERM: 'xterm-256color',
                          COLORTERM: 'truecolor',
                          ...(await this.options.lifecycleEnvironment?.(
                              record,
                              resolved.agent.launch,
                              resolved.agent.launchId,
                              delegationId,
                          )),
                      },
                  }
                : undefined;
            return {
                ok: true,
                value: {
                    executable: resolved.executable,
                    args: arguments_,
                    environment,
                    ...(agent && { agent }),
                },
            };
        } catch (error) {
            return {
                ok: false,
                error,
                ...(error instanceof Error &&
                    error.message ===
                        'Managed Agent Terminals require zsh or bash shell integration' && {
                        failureDetail:
                            'Managed Agent Terminals require zsh or bash shell integration.',
                    }),
                failureReason:
                    isCaxriError(error) && error.details?.reason === 'agent_session_unavailable'
                        ? 'agent_session_unavailable'
                        : 'spawn_failed',
            };
        }
    }
}
