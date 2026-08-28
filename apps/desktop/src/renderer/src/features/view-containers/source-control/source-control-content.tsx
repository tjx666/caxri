import { Empty } from '../../../components/ui/empty';
import type { SourceControlController } from './hooks/use-source-control-controller';
import { SourceControlHeader } from './source-control-header';
import { SourceControlProviderSection } from './source-control-provider-section';

export function SourceControlContent({ controller }: { controller: SourceControlController }) {
    if (controller.status === 'empty')
        return (
            <Empty className="empty-panel gap-0 p-0 px-3 py-4 text-muted">
                {controller.message}
            </Empty>
        );

    return (
        <div
            className="secondary-sidebar-content git-panel flex min-h-0 flex-1 flex-col overflow-hidden"
            aria-busy={controller.isRefreshing || undefined}
        >
            <SourceControlHeader controller={controller} />
            <div
                className="git-repositories min-h-0 flex-1 overflow-auto border-b border-border"
                aria-label={controller.model.accessibilityLabel}
                inert={controller.isRefreshing}
            >
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
        </div>
    );
}
