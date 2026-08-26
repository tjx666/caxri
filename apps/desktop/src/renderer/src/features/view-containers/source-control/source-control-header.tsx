import { PanelHeader } from '../../../components/panel-header';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utilities';
import type { SourceControlController } from './hooks/use-source-control-controller';
import { SourceControlIcon } from './source-control-icon';

export function SourceControlHeader({
    controller,
}: {
    controller: Extract<SourceControlController, { status: 'ready' }>;
}) {
    const { model, runAction, selectMode } = controller;
    return (
        <PanelHeader
            className="git-heading"
            title={model.title}
            actions={
                <>
                    <div
                        className="git-mode-switch flex h-7 items-center rounded-md bg-elevated p-0.5"
                        role="group"
                        aria-label={model.modeAccessibilityLabel}
                    >
                        {model.modes.map((mode) => (
                            <Tooltip content={mode.label} key={mode.id}>
                                <button
                                    type="button"
                                    className={cn(
                                        'grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted hover:text-foreground',
                                        model.selectedModeId === mode.id &&
                                            'bg-surface text-foreground',
                                    )}
                                    aria-label={mode.label}
                                    aria-pressed={model.selectedModeId === mode.id}
                                    onClick={() => selectMode(mode)}
                                >
                                    <SourceControlIcon icon={mode.icon} />
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                    <Tooltip content={model.refreshAction.label}>
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={model.refreshAction.label}
                            disabled={model.refreshAction.disabled}
                            onClick={() => {
                                // eslint-disable-next-line no-void -- the controller owns provider action errors
                                void runAction(model.refreshAction);
                            }}
                        >
                            <SourceControlIcon icon={model.refreshAction.icon} />
                        </Button>
                    </Tooltip>
                </>
            }
        />
    );
}
