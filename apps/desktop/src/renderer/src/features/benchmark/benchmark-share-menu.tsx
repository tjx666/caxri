import type { BenchmarkCatalog, BenchmarkRun } from '@caxri/protocol';
import { Copy, Download, Share2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { pushToast, tryCommand } from '../../stores/toasts';
import { judgeModelLabel, metricLabel, modelLabel, qualityLabel } from './benchmark-presentation';
import type { ChartModel, ConfigResult, QualitySource } from './benchmark-results';
import { isHigherBetter } from './benchmark-results';
import { buildShareCard, shareCardFileName } from './benchmark-share-card';
import { copyShareCard, saveShareCard } from './benchmark-share-client';

/**
 * "Share" beside "Run again": exports the run as a share card (title, scatter chart, leading leaderboard rows, date,
 * judge, and the Caxri credit) that is either copied to the clipboard or saved as a PNG. The card is built from the
 * numbers the board already shows and rasterized in this window; nothing is uploaded. A Menu trigger is a real button,
 * so the whole flow is reachable by keyboard.
 */
export function BenchmarkShareMenu({
    catalog,
    chart,
    isDisabled,
    ranked,
    run,
    source,
}: {
    catalog: BenchmarkCatalog | undefined;
    chart: ChartModel;
    isDisabled: boolean;
    ranked: readonly ConfigResult[];
    run: BenchmarkRun;
    source: QualitySource;
}) {
    const { t } = useTranslation();
    const card = () => {
        const judge = run.settings.judge;
        return buildShareCard({
            chart,
            nameOf: (entry) => modelLabel(catalog, entry),
            ranked,
            source,
            text: {
                cost: metricLabel(t, 'cost'),
                madeWith: t('benchmark.share.madeWith'),
                mostEfficient: t('benchmark.chart.mostEfficient'),
                quality: qualityLabel(t, source),
                subtitle: [
                    new Date(run.createdAt).toLocaleDateString(),
                    judge &&
                        t('benchmark.run.judgedBy', { model: judgeModelLabel(catalog, judge) }),
                ]
                    .filter(Boolean)
                    .join(' · '),
                time: metricLabel(t, 'time'),
                xTitle: t(
                    isHigherBetter(chart.x)
                        ? 'benchmark.chart.xTitleMore'
                        : 'benchmark.chart.xTitle',
                    { metric: metricLabel(t, chart.x) },
                ),
                yTitle:
                    chart.y === 'quality'
                        ? qualityLabel(t, source)
                        : t('benchmark.chart.timeFaster'),
            },
            title: run.title,
        });
    };
    const copy = () => {
        void tryCommand(t('benchmark.share.copyFailed'), async () => {
            await copyShareCard(card());
            pushToast('success', t('benchmark.share.copied'));
        });
    };
    const save = () => {
        void tryCommand(t('benchmark.share.saveFailed'), async () => {
            const path = await saveShareCard(card(), shareCardFileName(run));
            if (path) pushToast('success', t('benchmark.share.saved'));
        });
    };
    return (
        <Menu>
            <Tooltip
                content={t(isDisabled ? 'benchmark.share.noResults' : 'benchmark.share.button')}
            >
                <MenuTrigger
                    disabled={isDisabled}
                    render={
                        <Button
                            aria-label={t('benchmark.share.button')}
                            size="sm"
                            variant="secondary"
                        >
                            <Share2 aria-hidden="true" size={12} />
                            {t('benchmark.share.button')}
                        </Button>
                    }
                />
            </Tooltip>
            <MenuContent align="end" className="min-w-44">
                <MenuItem onClick={copy}>
                    <Copy aria-hidden="true" size={14} className="text-muted" />
                    {t('benchmark.share.copy')}
                </MenuItem>
                <MenuItem onClick={save}>
                    <Download aria-hidden="true" size={14} className="text-muted" />
                    {t('benchmark.share.save')}
                </MenuItem>
            </MenuContent>
        </Menu>
    );
}
