import type { AgentDelegationSession } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { chooseSessionSignIn } from '../session/session-creation-commands';
import { DELEGATION_LINK_CLASS_NAME } from './delegation-link-class-name';
import { delegationNextSteps } from './delegation-next-step';
import {
    delegationSignInCommand,
    openDelegatedAgentHooksSettings,
} from './delegation-next-step-commands';

/**
 * The failure-specific actions that come before Retry on a failed delegated task: "Sign in" for a signed-out Agent and
 * "Enable hooks" for a provider whose lifecycle hooks are off. Both fix the cause, so they sit left of Retry, which
 * only repeats the attempt. "Sign in" is shown only where Caxri knows the Agent's sign-in command, like the New Session
 * menu.
 */
export function DelegationNextStepActions({
    entry,
    projectId,
    sessionTitle,
}: {
    entry: Pick<AgentDelegationSession, 'failure' | 'provider'>;
    /**
     * The Project of the child Session, where a sign-in Shell Session opens.
     */
    projectId: string | undefined;
    sessionTitle: string;
}) {
    const { t } = useTranslation();
    const steps = delegationNextSteps(entry.failure);
    const { provider } = entry;
    if (provider === undefined) return null;
    const providerName = agentProviderCatalog[provider].displayName;
    const signInCommand = steps.includes('signIn') ? delegationSignInCommand(provider) : undefined;
    return (
        <>
            {signInCommand !== undefined && projectId !== undefined && (
                <button
                    aria-label={t('delegation.nextStep.signInAria', {
                        provider: providerName,
                        title: sessionTitle,
                    })}
                    className={DELEGATION_LINK_CLASS_NAME}
                    data-delegation-sign-in={provider}
                    type="button"
                    onClick={() => chooseSessionSignIn(projectId, signInCommand)}
                >
                    {t('delegation.nextStep.signIn')}
                </button>
            )}
            {steps.includes('enableHooks') && (
                <button
                    aria-label={t('delegation.nextStep.enableHooksAria', {
                        provider: providerName,
                        title: sessionTitle,
                    })}
                    className={DELEGATION_LINK_CLASS_NAME}
                    data-delegation-enable-hooks={provider}
                    type="button"
                    onClick={() => openDelegatedAgentHooksSettings(provider)}
                >
                    {t('delegation.nextStep.enableHooks')}
                </button>
            )}
        </>
    );
}
