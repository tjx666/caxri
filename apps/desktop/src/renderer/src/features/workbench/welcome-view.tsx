import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { CommandId } from '@caxri/protocol';
import { formatShortcut } from '@caxri/protocol';
import { ExternalLink, Plus, SquarePen } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { useWorkbenchStore } from '../../stores/workbench';
import { openHelpPage } from '../help/help-commands';
import { beginSessionCreation, chooseProjectFolder } from '../session/session-creation-commands';
import { selectWelcomeAction } from './welcome-action';

/**
 * The Caxri glyph drawn in one color, so it can sit faintly behind an empty Workbench the way VS Code's letterpress
 * does; the app icon's dark tile would read as a block rather than a watermark.
 */
function CaxriMark() {
    return (
        <svg aria-hidden="true" className="size-28 opacity-20" fill="none" viewBox="0 0 100 100">
            <path
                d="M68 22 A34 34 0 1 0 68 78"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="9"
            />
            <line
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="9"
                x1="68"
                x2="68"
                y1="40"
                y2="60"
            />
        </svg>
    );
}

/**
 * One row of the Welcome view's list: a quiet button with what it does on the left and its live shortcut, or a trailing
 * glyph, on the right.
 */
function WelcomeRow({
    commandId,
    label,
    trailing,
    onSelect,
}: {
    commandId?: CommandId;
    label: string;
    trailing?: ReactNode;
    onSelect: () => void;
}) {
    const shortcut = useCommandShortcut(commandId);
    return (
        <li>
            <button
                className="flex h-7 w-full cursor-pointer items-center justify-between gap-6 rounded-md border-0 bg-transparent px-2 text-left text-[12px] text-muted hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                type="button"
                onClick={onSelect}
            >
                <span>{label}</span>
                {shortcut ? <ShortcutBadge compact shortcut={shortcut} /> : trailing}
            </button>
        </li>
    );
}

/**
 * What the Workbench shows with no selected Session, after VS Code's empty editor: a faint Caxri mark, one primary
 * button, and a short list of entry points a newcomer cannot guess, with their live shortcuts and no slogan. A
 * first-run user's button adds a Project; a returning user whose last Session is gone gets a new Session in the Project
 * they used most recently, with Add Project beside it.
 */
export function WelcomeView() {
    const { t } = useTranslation();
    const projects = useWorkbenchStore((state) => state.bootstrap?.projects);
    const action = useMemo(() => selectWelcomeAction(projects ?? []), [projects]);
    const addProjectShortcut = useCommandShortcut('project.create');
    const hasProject = action.kind === 'newSession';
    return (
        <div
            className="flex h-full flex-col items-center justify-center gap-6 p-6 text-muted"
            data-workbench-welcome=""
        >
            <CaxriMark />
            <div className="flex flex-wrap items-center justify-center gap-2">
                {hasProject && (
                    <Button onClick={() => beginSessionCreation(action.projectId)}>
                        <SquarePen aria-hidden="true" size={14} />
                        {t('workbench.welcome.newSession', { project: action.projectTitle })}
                    </Button>
                )}
                <Button
                    variant={hasProject ? 'secondary' : 'default'}
                    onClick={() => {
                        void chooseProjectFolder();
                    }}
                >
                    <Plus aria-hidden="true" size={14} />
                    {t('workbench.welcome.addProject')}
                    {addProjectShortcut && (
                        <span className="ml-1 opacity-70">
                            {formatShortcut(addProjectShortcut)}
                        </span>
                    )}
                </Button>
            </div>
            <ul className="m-0 flex w-75 max-w-full list-none flex-col gap-0.5 p-0">
                <WelcomeRow
                    commandId="commandPalette.open"
                    label={t('workbench.welcome.commandPalette')}
                    onSelect={() => executeCommand('commandPalette.open')}
                />
                <WelcomeRow
                    commandId="help.showKeyboardShortcuts"
                    label={t('workbench.welcome.keyboardShortcuts')}
                    onSelect={() => executeCommand('help.showKeyboardShortcuts')}
                />
                <WelcomeRow
                    label={t('workbench.welcome.documentation')}
                    trailing={<ExternalLink aria-hidden="true" className="size-3.5" />}
                    onSelect={() => openHelpPage('documentation')}
                />
            </ul>
        </div>
    );
}
