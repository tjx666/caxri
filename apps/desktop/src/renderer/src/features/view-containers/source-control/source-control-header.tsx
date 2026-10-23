import { PanelHeader } from '../../../components/panel-header';
import { Button } from '../../../components/ui/button';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { SourceControlController } from './hooks/use-source-control-controller';
import { SourceControlIcon } from './source-control-icon';

export function SourceControlHeader({ controller }: { controller: SourceControlController }) {
    const { t } = useTranslation();
    if (controller.status !== 'ready')
        return (
            <PanelHeader
                className="git-heading"
                title={t('viewContainers.sourceControl.title')}
                actions={
                    <Tooltip content={t('viewContainers.sourceControl.refresh')}>
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t('viewContainers.sourceControl.refresh')}
                            aria-busy={controller.isRefreshing || undefined}
                            aria-disabled={
                                controller.status === 'no-session' ||
                                controller.status === 'loading' ||
                                controller.isRefreshing
                            }
                            onClick={() => {
                                if (
                                    controller.status === 'no-session' ||
                                    controller.status === 'loading' ||
                                    controller.isRefreshing
                                )
                                    return;
                                controller.refresh();
                            }}
                        >
                            <SourceControlIcon icon={{ kind: 'theme', id: 'refresh' }} />
                        </Button>
                    </Tooltip>
                }
            />
        );

    const { model, runAction, selectMode } = controller;
    const refreshLabel = controller.isRefreshing
        ? t('viewContainers.sourceControl.refreshing')
        : model.refreshAction.label;
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
                                        'grid size-6 cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted not-aria-disabled:hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-45',
                                        model.selectedModeId === mode.id &&
                                            'bg-surface text-foreground',
                                    )}
                                    aria-label={mode.label}
                                    aria-pressed={model.selectedModeId === mode.id}
                                    aria-disabled={controller.isRefreshing}
                                    onClick={() => {
                                        if (!controller.isRefreshing) selectMode(mode);
                                    }}
                                >
                                    <SourceControlIcon icon={mode.icon} />
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                    {model.headerActions?.map((action) => (
                        <Tooltip content={action.tooltip ?? action.label} key={action.id}>
                            <Button
                                size="icon"
                                variant="ghost"
                                aria-label={action.accessibilityLabel ?? action.label}
                                aria-pressed={action.pressed}
                                className={cn(action.pressed && 'bg-elevated text-foreground')}
                                aria-disabled={controller.isRefreshing || action.disabled}
                                onClick={() => {
                                    if (controller.isRefreshing || action.disabled) return;
                                    void runAction(action);
                                }}
                            >
                                <SourceControlIcon icon={action.icon} />
                            </Button>
                        </Tooltip>
                    ))}
                    <Tooltip content={refreshLabel}>
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={refreshLabel}
                            aria-busy={controller.isRefreshing || undefined}
                            aria-disabled={controller.isRefreshing || model.refreshAction.disabled}
                            onClick={() => {
                                if (controller.isRefreshing || model.refreshAction.disabled) return;
                                void runAction(model.refreshAction);
                            }}
                        >
                            <SourceControlIcon
                                className={
                                    controller.isRefreshing
                                        ? 'animate-spin motion-reduce:animate-none'
                                        : undefined
                                }
                                icon={model.refreshAction.icon}
                            />
                            {controller.isRefreshing && (
                                <span className="sr-only" role="status" aria-live="polite">
                                    {refreshLabel}
                                </span>
                            )}
                        </Button>
                    </Tooltip>
                </>
            }
        />
    );
}
