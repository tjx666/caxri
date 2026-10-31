import { CAXRI_REPOSITORY_URL, caxriReleaseUrl } from '@caxri/protocol';
import Constants from 'expo-constants';

import { useTranslation } from '../../i18n';
import { openExternalLink } from '../../lib/open-external-link';
import type { MobileTheme } from '../../theme/tokens';
import { MobileUpdateSettingsRow } from '../update/mobile-update-settings-row';
import { mobileUpdateCheckLabel } from '../update/mobile-update-state';
import { useMobileUpdate } from '../update/use-mobile-update';
import { SettingsLinkRow, SettingsRow, SettingsSection } from './settings-rows';

/**
 * The app version with its update state, and the public pages behind it. The version row always says whether this build
 * is current, so an up-to-date phone does not read as one without updates; tapping it asks Desktop again.
 */
export const SettingsAboutSection = ({ theme }: { theme: MobileTheme }) => {
    const { t } = useTranslation();
    const mobileUpdate = useMobileUpdate();
    const { checkNow, checkStatus, update } = mobileUpdate;
    const version = Constants.expoConfig?.version;
    const checkLabel = mobileUpdateCheckLabel(checkStatus, t);
    const canCheck = checkStatus !== 'unsupported' && checkStatus !== 'checking' && !update;
    return (
        <SettingsSection theme={theme} title={t('settings.section.about')}>
            <SettingsRow
                accessibilityHint={canCheck ? t('update.checkHint') : undefined}
                label={t('settings.version')}
                onPress={canCheck ? checkNow : undefined}
                testID="settings-app-version"
                theme={theme}
                value={[version ?? t('settings.unknown'), checkLabel].filter(Boolean).join(' · ')}
                valueColor={checkStatus === 'failed' ? theme.danger : undefined}
            />
            {update ? (
                <MobileUpdateSettingsRow mobileUpdate={{ ...mobileUpdate, update }} theme={theme} />
            ) : null}
            <SettingsLinkRow
                accessibilityHint={t('settings.releaseNotesHint')}
                label={t('settings.releaseNotes')}
                onPress={() => {
                    void openExternalLink(caxriReleaseUrl(version), { t });
                }}
                testID="settings-release-notes"
                theme={theme}
            />
            <SettingsLinkRow
                accessibilityHint={t('settings.reportIssueHint')}
                label={t('settings.reportIssue')}
                onPress={() => {
                    void openExternalLink(`${CAXRI_REPOSITORY_URL}/issues/new`, { t });
                }}
                testID="settings-report-issue"
                theme={theme}
            />
            <SettingsLinkRow
                accessibilityHint={t('settings.sourceCodeHint')}
                isLast
                label={t('settings.sourceCode')}
                onPress={() => {
                    void openExternalLink(CAXRI_REPOSITORY_URL, { t });
                }}
                testID="settings-source-code"
                theme={theme}
            />
        </SettingsSection>
    );
};
