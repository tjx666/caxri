import type { AgentAction } from '@caxri/protocol';
import { agentActionSchema } from '@caxri/protocol';

import type { AgentActionDiscoveryAdapter, ReportedAgentSkill } from './contract';

interface Discovered {
    actions: AgentAction[];
    referenceOnly: AgentAction[];
    files: Map<string, string>;
    partial: boolean;
}

/**
 * Folds the skills a running provider reports into what filesystem discovery found. The provider knows which skills are
 * actually in effect (plugin skills, per-skill disabling), so for skills its list is authoritative: an enabled reported
 * skill replaces a scanned one of the same invocation, a disabled one is removed, and a scanned skill the provider does
 * not list is dropped. Commands and `user-invocable: false` reference skills keep coming from the scan. A reported path
 * stays in `files` and never reaches the wire.
 */
export function mergeReportedSkills(
    discovered: Discovered,
    reported: readonly ReportedAgentSkill[],
    adapter: AgentActionDiscoveryAdapter,
): Discovered {
    const files = new Map(discovered.files);
    const reportedInvocations = new Set<string>();
    const enabled: AgentAction[] = [];
    for (const skill of reported) {
        const invocation = adapter.skillInvocation(skill.name);
        if (reportedInvocations.has(invocation)) continue;
        reportedInvocations.add(invocation);
        if (!skill.enabled) {
            continue;
        }
        const parsed = agentActionSchema.safeParse({
            invocation,
            kind: 'skill',
            ...(skill.description && { description: skill.description.slice(0, 240) }),
            requiresArguments: false,
            source: skill.isProject ? 'project' : 'global',
        });
        if (!parsed.success) continue;
        enabled.push(parsed.data);
        files.set(invocation, skill.path);
    }
    const enabledInvocations = new Set(enabled.map(({ invocation }) => invocation));
    return {
        actions: [...discovered.actions.filter(({ kind }) => kind !== 'skill'), ...enabled],
        referenceOnly: discovered.referenceOnly.filter(
            ({ kind, invocation }) =>
                kind !== 'skill' ||
                enabledInvocations.has(invocation) ||
                !reportedInvocations.has(invocation),
        ),
        files,
        partial: discovered.partial,
    };
}
