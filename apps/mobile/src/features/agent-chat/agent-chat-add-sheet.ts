import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import type { AgentChatModelTrigger } from './agent-chat-model-choice';
import type { AgentChatPermissionTrigger } from './agent-chat-permission-choice';
import type { AgentChatContextRing } from './agent-chat-session-usage';

/**
 * One settings row in the Chat composer's add sheet: which sheet it opens, the current value it names, and whether the
 * device may open it now.
 */
export interface AgentChatAddSheetRow {
    entry: 'model' | 'permission' | 'usage';
    label: string;
    value: string | undefined;
    isEnabled: boolean;
}

/**
 * The add sheet's settings rows, in LobeHub's order (model, then the permission level, then usage), each naming its
 * current value as the expanded capsule's chips do: `Model · Effort` (with `Ultracode`), the permission level (with
 * `Plan`), and the context window's share used. A row whose trigger the Chat has not reported yet is left out, and
 * usage only shows once the Chat has a Terminal to read it from. Unlike the permission chip, the permission row shows
 * at every level, since the sheet is where the reader goes to look.
 */
export const agentChatAddSheetRows = (
    {
        context,
        hasUsage,
        model,
        permission,
    }: {
        context: AgentChatContextRing | undefined;
        hasUsage: boolean;
        model: AgentChatModelTrigger | undefined;
        permission: AgentChatPermissionTrigger | undefined;
    },
    t: Translate = translate,
): AgentChatAddSheetRow[] => [
    ...(model
        ? [
              {
                  entry: 'model' as const,
                  label: t('chat.model.model'),
                  value: [model.model, model.effort, model.isUltracode ? 'Ultracode' : undefined]
                      .filter(Boolean)
                      .join(' · '),
                  isEnabled: model.isInteractive,
              },
          ]
        : []),
    ...(permission
        ? [
              {
                  entry: 'permission' as const,
                  label: t('chat.permission.permissions'),
                  value: permission.isPlanMode
                      ? `${permission.label} · ${t('chat.permission.plan')}`
                      : permission.label,
                  isEnabled: permission.isInteractive,
              },
          ]
        : []),
    ...(hasUsage
        ? [
              {
                  entry: 'usage' as const,
                  label: t('chat.usage.open'),
                  value: context ? `${context.percent}%` : undefined,
                  isEnabled: true,
              },
          ]
        : []),
];
