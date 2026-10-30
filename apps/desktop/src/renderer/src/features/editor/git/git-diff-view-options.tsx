import { useId } from 'react';

import { Ellipsis } from 'lucide-react';

import { Button } from '../../../components/ui/button';
import { Field, FieldLabel } from '../../../components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { Switch } from '../../../components/ui/switch';
import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { useGitDiffViewStore } from './diff-view-store';

export function GitDiffViewOptions({ stacked = false }: { stacked?: boolean }) {
    const { t } = useTranslation();
    const id = useId();
    const inlineView = useGitDiffViewStore((state) => state.inlineView);
    const collapseUnchanged = useGitDiffViewStore((state) => state.collapseUnchanged ?? stacked);
    const showWhitespaceDifferences = useGitDiffViewStore(
        (state) => state.showWhitespaceDifferences,
    );
    return (
        <Popover>
            <Tooltip content={t('editor.diffOptions.title')}>
                <PopoverTrigger
                    render={
                        <Button
                            size="icon"
                            variant="ghost"
                            aria-label={t('editor.diffOptions.title')}
                        />
                    }
                >
                    <Ellipsis aria-hidden="true" size={14} />
                </PopoverTrigger>
            </Tooltip>
            <PopoverContent
                align="end"
                aria-label={t('editor.diffOptions.title')}
                className="w-80 p-3"
            >
                <div className="flex flex-col gap-3">
                    <Field orientation="horizontal">
                        <FieldLabel htmlFor={`${id}-inline`}>
                            {t('editor.diffOptions.inlineView')}
                        </FieldLabel>
                        <Switch
                            id={`${id}-inline`}
                            checked={inlineView}
                            onCheckedChange={(checked) =>
                                useGitDiffViewStore.setState({ inlineView: checked })
                            }
                        />
                    </Field>
                    <Field orientation="horizontal">
                        <FieldLabel htmlFor={`${id}-collapse`}>
                            {t('editor.diffOptions.collapseUnchanged')}
                        </FieldLabel>
                        <Switch
                            id={`${id}-collapse`}
                            checked={collapseUnchanged}
                            onCheckedChange={(checked) =>
                                useGitDiffViewStore.setState({ collapseUnchanged: checked })
                            }
                        />
                    </Field>
                    <Field orientation="horizontal">
                        <FieldLabel htmlFor={`${id}-whitespace`}>
                            {t('editor.diffOptions.showWhitespace')}
                        </FieldLabel>
                        <Switch
                            id={`${id}-whitespace`}
                            checked={showWhitespaceDifferences}
                            onCheckedChange={(checked) =>
                                useGitDiffViewStore.setState({ showWhitespaceDifferences: checked })
                            }
                        />
                    </Field>
                </div>
            </PopoverContent>
        </Popover>
    );
}
