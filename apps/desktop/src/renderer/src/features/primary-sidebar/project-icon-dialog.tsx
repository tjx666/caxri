import { useReducer, useState } from 'react';

import type { ProjectIconColor, ProjectIconName, ProjectRecord } from '@caxri/protocol';
import { projectIconColors, projectIconNames } from '@caxri/protocol';

import { Button } from '../../components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '../../components/ui/dialog';
import { cn } from '../../lib/utilities';
import { closeProjectIconDialog, useDialogStore } from '../../stores/dialogs';
import { useProjects } from '../../stores/selectors';
import { ProjectIcon } from './project-icon';
import { didSaveProjectIcon } from './project-icon-actions';
import { projectIconColorPresentation, projectIconRegistry } from './project-icon-registry';

interface ProjectIconDraft {
    iconColor: ProjectIconColor;
    iconName: ProjectIconName | undefined;
}

type ProjectIconDraftAction =
    | { iconColor: ProjectIconColor; type: 'select-color' }
    | { iconName: ProjectIconName; type: 'select-icon' };

function projectIconDraftReducer(
    state: ProjectIconDraft,
    action: ProjectIconDraftAction,
): ProjectIconDraft {
    return action.type === 'select-icon'
        ? { ...state, iconName: action.iconName }
        : { ...state, iconColor: action.iconColor };
}

function initialProjectIconDraft(icon: ProjectRecord['icon']): ProjectIconDraft {
    return { iconColor: icon?.color, iconName: icon?.name };
}

function ProjectIconDialogForm({ close, project }: { close: () => void; project: ProjectRecord }) {
    const [{ iconColor, iconName }, dispatch] = useReducer(
        projectIconDraftReducer,
        project.icon,
        initialProjectIconDraft,
    );
    const [saving, setSaving] = useState(false);

    const persist = async (shouldClear: boolean): Promise<void> => {
        if (!shouldClear && !iconName) return;
        setSaving(true);
        let didSave: boolean;
        try {
            didSave = await didSaveProjectIcon(
                project.id,
                shouldClear ? null : { name: iconName!, ...(iconColor && { color: iconColor }) },
            );
        } finally {
            setSaving(false);
        }
        if (didSave) close();
    };
    const clearIcon = async (): Promise<void> => {
        await persist(true);
    };
    const saveIcon = async (): Promise<void> => {
        await persist(false);
    };

    return (
        <>
            <DialogHeader>
                <DialogTitle>Customize Project Icon</DialogTitle>
                <DialogDescription>
                    Choose a controlled icon and semantic color for {project.displayTitle}. The
                    Project title and root stay unchanged.
                </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 p-4">
                <fieldset>
                    <legend className="mb-2 text-[11px] font-semibold">Icon</legend>
                    <div className="grid grid-cols-4 gap-2">
                        {projectIconNames.map((name) => (
                            <button
                                key={name}
                                type="button"
                                aria-label={projectIconRegistry[name].label}
                                aria-pressed={iconName === name}
                                className={cn(
                                    'grid min-h-14 cursor-pointer place-items-center gap-1 rounded border border-border bg-transparent p-2 text-[10px] text-muted hover:bg-elevated hover:text-foreground focus-visible:border-accent focus-visible:outline-none',
                                    iconName === name && 'bg-elevated text-foreground',
                                )}
                                onClick={() => dispatch({ iconName: name, type: 'select-icon' })}
                            >
                                <ProjectIcon
                                    icon={{ name, ...(iconColor && { color: iconColor }) }}
                                />
                                <span>{projectIconRegistry[name].label}</span>
                            </button>
                        ))}
                    </div>
                </fieldset>
                <fieldset>
                    <legend className="mb-2 text-[11px] font-semibold">Color</legend>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            aria-label="Default color"
                            aria-pressed={iconColor === undefined}
                            className={cn(
                                'flex h-8 cursor-pointer items-center gap-2 rounded border border-border bg-transparent px-2 text-[10px] hover:bg-elevated focus-visible:border-accent focus-visible:outline-none',
                                iconColor === undefined && 'bg-elevated',
                            )}
                            onClick={() => dispatch({ iconColor: undefined, type: 'select-color' })}
                        >
                            <span className="size-3 rounded-full border border-border bg-foreground" />
                            Default
                        </button>
                        {projectIconColors.map((color) => (
                            <button
                                key={color}
                                type="button"
                                aria-label={`${projectIconColorPresentation[color].label} color`}
                                aria-pressed={iconColor === color}
                                className={cn(
                                    'flex h-8 cursor-pointer items-center gap-2 rounded border border-border bg-transparent px-2 text-[10px] hover:bg-elevated focus-visible:border-accent focus-visible:outline-none',
                                    iconColor === color && 'bg-elevated',
                                )}
                                onClick={() => dispatch({ iconColor: color, type: 'select-color' })}
                            >
                                <span
                                    className={cn(
                                        'size-3 rounded-full border border-border',
                                        projectIconColorPresentation[color].swatchClassName,
                                    )}
                                />
                                {projectIconColorPresentation[color].label}
                            </button>
                        ))}
                    </div>
                </fieldset>
                <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
                    <Button
                        disabled={saving || !project.icon}
                        size="sm"
                        variant="ghost"
                        onClick={clearIcon}
                    >
                        Clear icon
                    </Button>
                    <div className="flex gap-2">
                        <Button disabled={saving} size="sm" variant="secondary" onClick={close}>
                            Cancel
                        </Button>
                        <Button disabled={saving || !iconName} size="sm" onClick={saveIcon}>
                            Save
                        </Button>
                    </div>
                </div>
            </div>
        </>
    );
}

export function ProjectIconDialog() {
    const projectId = useDialogStore((state) => state.projectIconProjectId);
    const project = useProjects()?.find((item) => item.id === projectId);
    const close = closeProjectIconDialog;

    return (
        <Dialog open={Boolean(project)} onOpenChange={(open) => !open && close()}>
            <DialogContent className="project-icon-dialog">
                {project && (
                    <ProjectIconDialogForm key={project.id} close={close} project={project} />
                )}
            </DialogContent>
        </Dialog>
    );
}
