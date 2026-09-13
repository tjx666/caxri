import { FolderGit2, GitBranch, TriangleAlert } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Empty, EmptyMedia, EmptyTitle } from '../../../components/ui/empty';
import { Spinner } from '../../../components/ui/spinner';
import type { SourceControlController } from './hooks/use-source-control-controller';
import { SourceControlHeader } from './source-control-header';
import { SourceControlHistory } from './source-control-history';
import { SourceControlProviderSection } from './source-control-provider-section';

export function SourceControlContent({ controller }: { controller: SourceControlController }) {
    return (
        <div
            className="secondary-sidebar-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden"
            aria-busy={controller.isRefreshing || controller.status === 'loading' || undefined}
        >
            <SourceControlHeader controller={controller} />
            {controller.status === 'ready' ? (
                <SourceControlReadyContent controller={controller} />
            ) : (
                <SourceControlMessage controller={controller} />
            )}
        </div>
    );
}

function SourceControlMessage({
    controller,
}: {
    controller: Exclude<SourceControlController, { status: 'ready' }>;
}) {
    const state =
        controller.status === 'no-session'
            ? {
                  description: controller.noContextMessage,
                  icon: <GitBranch aria-hidden="true" size={28} />,
                  title: 'No Session selected',
              }
            : controller.status === 'loading'
              ? {
                    description: undefined,
                    icon: <Spinner aria-hidden="true" size={24} />,
                    title: controller.loadingMessage,
                }
              : controller.status === 'no-repository'
                ? {
                      description: 'This Project root is not a repository yet.',
                      icon: <FolderGit2 aria-hidden="true" size={28} />,
                      title: 'No Git repository',
                  }
                : {
                      description: controller.message,
                      icon: <TriangleAlert aria-hidden="true" className="text-danger" size={28} />,
                      title: 'Git is not available',
                  };

    return (
        <Empty className="min-h-0 flex-1 gap-2 p-4" aria-live="polite">
            <EmptyMedia>{state.icon}</EmptyMedia>
            <EmptyTitle>{state.title}</EmptyTitle>
            {state.description && (
                <p className="m-0 max-w-64 text-[11px] leading-[1.45] text-pretty break-words text-muted">
                    {state.description}
                </p>
            )}
            {(controller.status === 'no-repository' || controller.status === 'unavailable') && (
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={controller.isRefreshing}
                    onClick={controller.refresh}
                >
                    Refresh
                </Button>
            )}
        </Empty>
    );
}

function SourceControlReadyContent({
    controller,
}: {
    controller: Extract<SourceControlController, { status: 'ready' }>;
}) {
    return (
        <div
            className="git-repositories min-h-0 flex-1 overflow-auto border-b border-border"
            aria-label={controller.model.accessibilityLabel}
            inert={controller.isRefreshing}
        >
            {controller.model.fileHistory && (
                <SourceControlHistory
                    descriptor={controller.model.fileHistory.history}
                    enabled={!controller.isRefreshing}
                    expansion={{
                        expanded: controller.fileHistoryExpanded,
                        setExpanded: controller.setFileHistoryExpanded,
                    }}
                    key={JSON.stringify([
                        controller.model.fileHistory.history.id,
                        controller.model.fileHistory.path ?? null,
                    ])}
                    runAction={controller.runAction}
                    scope={{ kind: 'file', ...controller.model.fileHistory }}
                />
            )}
            {controller.model.truncationMessage && (
                <div
                    role="status"
                    aria-live="polite"
                    className="border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted"
                >
                    {controller.model.truncationMessage}
                </div>
            )}
            {controller.model.providers.map((provider) => (
                <SourceControlProviderSection
                    controller={controller}
                    key={provider.id}
                    provider={provider}
                />
            ))}
        </div>
    );
}
