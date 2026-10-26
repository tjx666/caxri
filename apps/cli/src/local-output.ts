import type { AgentContextResult, AgentEndpointSummary, CaxriMethod } from '@caxri/protocol';
import { describeCaxriMethod, methods } from '@caxri/protocol';

import type { CliCommandDefinition, RemoteCommandDefinition } from './commands';
import { CLI_COMMANDS, CLI_GROUPS, describeCliCommand } from './commands';
import type { CliAutomation } from './environment';
import type { CliOutputMode } from './output';
import { formatEndpointReference, renderHumanValue } from './output';
import { renderHumanRecords } from './records-output';
import { CLI_PROTOCOL_VERSION, CLI_VERSION } from './version';

function capabilities() {
    return {
        cliVersion: CLI_VERSION,
        protocolVersion: CLI_PROTOCOL_VERSION,
        groups: CLI_GROUPS,
        commands: CLI_COMMANDS.map(describeCliCommand),
        protocolMethods: (Object.keys(methods) as CaxriMethod[]).map(describeCaxriMethod),
    };
}

export function localResult(
    command: CliCommandDefinition,
    options: {
        automation: CliAutomation;
        mode: CliOutputMode;
        profileSource: string;
    },
): unknown {
    if (command.path[0] === 'capabilities') return capabilities();
    if (command.path[0] === 'agent-context')
        return {
            status: 'unavailable',
            reason: 'endpoint-credential-missing',
            action: 'Run this command inside a directly managed Caxri Agent Terminal.',
            automation: options.automation,
            cliVersion: CLI_VERSION,
            outputMode: options.mode,
            profileSource: options.profileSource,
            protocolVersion: CLI_PROTOCOL_VERSION,
        };
    return {
        automation: options.automation,
        cliVersion: CLI_VERSION,
        outputMode: options.mode,
        profileSource: options.profileSource,
        protocolVersion: CLI_PROTOCOL_VERSION,
    };
}

function isSkillContentValue(value: unknown): value is { content: string } {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'content') === 'string'
    );
}

export function humanLocal(command: CliCommandDefinition, value: unknown): string {
    if (command.path[0] === 'skills' && command.path[1] === 'get' && isSkillContentValue(value))
        return `${value.content.trimEnd()}\n`;
    if (command.path[0] === 'agent-context' && isAgentContext(value))
        return humanAgentContext(value);
    if (command.path[0] !== 'capabilities') return `${renderHumanValue(value)}\n`;
    return [
        `Caxri CLI ${CLI_VERSION} (protocol ${CLI_PROTOCOL_VERSION})`,
        `${CLI_GROUPS.length} command groups`,
        `${CLI_COMMANDS.length} registered CLI commands`,
        '',
    ].join('\n');
}

const messagingActions: Record<AgentEndpointSummary['messaging']['nextAction'], string> = {
    use_pull: 'Use caxri agent message wait or check.',
    enable_integration: 'Enable peer messaging in Caxri Settings, then restart this Terminal.',
    install_provider: 'Install the configured Provider executable, then restart this Terminal.',
    upgrade_provider: 'Upgrade to a verified Provider version, then restart this Terminal.',
    fix_configuration: 'Review the Provider launch configuration, then restart this Terminal.',
    restart_terminal: 'Restart this Agent Terminal to restore the Caxri CLI adapter.',
    none: '',
};

function humanAgentEndpoint(endpoint: AgentEndpointSummary): string {
    const lines = [
        `${endpoint.name} (${endpoint.provider})`,
        `Endpoint: ${formatEndpointReference(endpoint.ref)}`,
        `Project: ${endpoint.projectId}`,
        `Delivery: ${endpoint.messaging.deliveryMode}`,
        `Health: ${endpoint.messaging.health}`,
        `Reason: ${endpoint.messaging.reason}`,
    ];
    const action = messagingActions[endpoint.messaging.nextAction];
    if (action) lines.push(`Next: ${action}`);
    return lines.join('\n');
}

function isAgentContext(value: unknown): value is AgentContextResult {
    return (
        typeof value === 'object' &&
        value !== null &&
        Reflect.get(value, 'status') === 'active' &&
        typeof Reflect.get(value, 'endpoint') === 'object'
    );
}

function humanAgentContext(value: AgentContextResult): string {
    return `${humanAgentEndpoint(value.endpoint)}\nCapabilities: ${value.capabilities.join(', ')}\n`;
}

export function humanRemote(command: RemoteCommandDefinition, value: unknown): string | undefined {
    const records = renderHumanRecords(command.method, command.path.at(-1), value, Date.now());
    if (records !== undefined) return records;
    if (value === null || typeof value !== 'object' || command.method !== 'agent.list')
        return undefined;
    const agents = (value as { agents?: unknown }).agents;
    if (!Array.isArray(agents)) return undefined;
    return `${agents.map((agent) => humanAgentEndpoint(agent as AgentEndpointSummary)).join('\n\n')}\n`;
}
