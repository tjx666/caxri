import { useMemo } from 'react';

import type { CommandId } from '@caxri/protocol';
import { Code2, ExternalLink, Plus, SquarePen } from 'lucide-react';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { useWorkbenchStore } from '../../stores/workbench';
import { openHelpPage } from '../help/help-commands';
import { beginSessionCreation, chooseProjectFolder } from '../session/session-creation-commands';
import { selectWelcomeAction } from './welcome-action';

function ShortcutHint({ commandId, label }: { commandId: CommandId; label: string }) {
    const shortcut = useCommandShortcut(commandId);
    return (
        <li className="flex items-center justify-between gap-6">
            <span>{label}</span>
            {shortcut && <ShortcutBadge compact shortcut={shortcut} />}
        </li>
    );
}

/**
 * What the Workbench shows with no selected Session. A first-run user gets Add Project; a returning user whose last
 * Session is gone gets a new Session in the Project they used most recently. Either way the live shortcuts for the
 * three entry points a newcomer cannot guess sit underneath.
 */
export function WelcomeView() {
    const { t } = useTranslation();
    const projects = useWorkbenchStore((state) => state.bootstrap?.projects);
    const action = useMemo(() => selectWelcomeAction(projects ?? []), [projects]);
    const hasProject = action.kind === 'newSession';
    return (
        <div className="welcome mx-auto flex h-full max-w-[540px] flex-col items-center justify-center gap-3 p-6 text-center text-muted">
            <Code2 size={38} />
            <h1 className="mx-0 mt-1 mb-0 text-[15px] text-foreground">
                {t(hasProject ? 'workbench.welcome.returningTitle' : 'workbench.welcome.title')}
            </h1>
            <p className="m-0 leading-relaxed">
                {hasProject
                    ? t('workbench.welcome.returningDescription', {
                          project: action.projectTitle,
                      })
                    : t('workbench.welcome.description')}
            </p>
            <div className="flex items-center gap-2">
                {hasProject && (
                    <Button onClick={() => beginSessionCreation(action.projectId)}>
                        <SquarePen size={15} />{' '}
                        {t('workbench.welcome.newSession', { project: action.projectTitle })}
                    </Button>
                )}
                <Button
                    variant={hasProject ? 'secondary' : 'default'}
                    onClick={() => {
                        void chooseProjectFolder();
                    }}
                >
                    <Plus size={15} /> {t('workbench.welcome.addProject')}
                </Button>
            </div>
            <ul className="m-0 mt-3 flex min-w-64 list-none flex-col gap-1.5 p-0 text-left text-[12px]">
                <ShortcutHint
                    commandId="project.create"
                    label={t('workbench.welcome.addProject')}
                />
                <ShortcutHint
                    commandId="commandPalette.open"
                    label={t('workbench.welcome.commandPalette')}
                />
                <ShortcutHint
                    commandId="help.showKeyboardShortcuts"
                    label={t('workbench.welcome.keyboardShortcuts')}
                />
            </ul>
            <Button size="sm" variant="ghost" onClick={() => openHelpPage('documentation')}>
                <ExternalLink aria-hidden="true" size={13} />
                {t('workbench.welcome.documentation')}
            </Button>
        </div>
    );
}
