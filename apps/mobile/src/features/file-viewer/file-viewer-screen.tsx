import '../../components/prism-grammars';

import { useCallback, useRef } from 'react';
import type { ListRenderItemInfo, StyleProp, TextStyle } from 'react-native';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useLocalSearchParams, useRouter } from 'expo-router';
import type { RenderProps, Token } from 'prism-react-renderer';
import { Highlight, themes } from 'prism-react-renderer';

import { ScreenHeader } from '../../components/screen-header';
import { ScreenState } from '../../components/screen-state';
import { useTranslation } from '../../i18n';
import { MONOSPACE_FONT } from '../../theme/monospace';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-errors';
import { fileLanguage } from '../panels/file-language';
import { PendingPanelState } from '../panels/pending-panel-state';
import { useFileRead } from '../panels/use-panels';
import type { FileViewerTarget } from './file-viewer-model';
import {
    fileViewerInitialLine,
    fileViewerTarget,
    isFileViewerLineCited,
} from './file-viewer-model';

const styles = StyleSheet.create({
    body: { borderTopWidth: StyleSheet.hairlineWidth, flex: 1 },
    code: {
        ...mobileType.caption,
        flex: 1,
        fontFamily: MONOSPACE_FONT,
        lineHeight: 18,
    },
    line: {
        flexDirection: 'row',
        gap: mobileSpace.sm,
        paddingHorizontal: mobileSpace.md,
    },
    lineNumber: {
        ...mobileType.caption,
        fontFamily: MONOSPACE_FONT,
        lineHeight: 18,
        textAlign: 'right',
    },
    list: { flex: 1 },
    root: { flex: 1 },
});

/**
 * A missing file and one outside the Session's Project read the same to the user: there is nothing here to open.
 */
const isMissingFileError = (error: unknown): boolean =>
    error instanceof MobileGatewayRequestError &&
    (error.code === 'NOT_FOUND' || error.code === 'PATH_DENIED');

/**
 * One numbered line, tinted when the message cited it.
 */
const FileViewerLine = ({
    getTokenProps,
    gutter,
    isCited,
    lineNumber,
    theme,
    tokens,
}: {
    getTokenProps: RenderProps['getTokenProps'];
    gutter: number;
    isCited: boolean;
    lineNumber: number;
    theme: MobileTheme;
    tokens: Token[];
}) => (
    <View
        style={[styles.line, isCited && { backgroundColor: theme.selection }]}
        testID={isCited ? 'file-viewer-cited-line' : undefined}
    >
        <Text style={[styles.lineNumber, { color: theme.muted, minWidth: gutter * 8 }]}>
            {lineNumber}
        </Text>
        <Text selectable style={[styles.code, { color: theme.text }]}>
            {tokens.map((token, tokenIndex) => (
                // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- Tokens carry no identity and repeat; the position within the line is the token.
                <Text
                    key={tokenIndex}
                    style={getTokenProps({ token }).style as StyleProp<TextStyle>}
                >
                    {token.content}
                </Text>
            ))}
        </Text>
    </View>
);

/**
 * The highlighted lines in a list, scrolled to the citation once the list has laid out.
 */
const FileViewerLineList = ({
    getTokenProps,
    target,
    theme,
    tokens,
}: {
    getTokenProps: RenderProps['getTokenProps'];
    target: FileViewerTarget;
    theme: MobileTheme;
    tokens: Token[][];
}) => {
    const list = useRef<FlatList<Token[]>>(null);
    const hasScrolled = useRef(false);
    const initialLine = fileViewerInitialLine(target, tokens.length);
    const gutter = String(tokens.length).length;
    const renderItem = useCallback(
        ({ index, item }: ListRenderItemInfo<Token[]>) => (
            <FileViewerLine
                getTokenProps={getTokenProps}
                gutter={gutter}
                isCited={isFileViewerLineCited(target, index)}
                lineNumber={index + 1}
                theme={theme}
                tokens={item}
            />
        ),
        [getTokenProps, gutter, target, theme],
    );
    return (
        <FlatList
            data={tokens}
            initialNumToRender={Math.min(tokens.length, initialLine + 40)}
            keyExtractor={(_line, index) => String(index)}
            onLayout={() => {
                if (initialLine === 0 || hasScrolled.current) return;
                hasScrolled.current = true;
                list.current?.scrollToIndex({ animated: false, index: initialLine });
            }}
            onScrollToIndexFailed={({ averageItemLength, index }) => {
                // Lines wrap, so the list cannot know an unrendered line's offset: jump near it, then
                // settle on it once those rows exist.
                list.current?.scrollToOffset({
                    animated: false,
                    offset: averageItemLength * index,
                });
                setTimeout(() => list.current?.scrollToIndex({ animated: false, index }), 50);
            }}
            ref={list}
            renderItem={renderItem}
            style={styles.list}
            testID="file-viewer-lines"
        />
    );
};

/**
 * The file's lines, numbered, with the cited ones tinted.
 */
const FileViewerLines = ({
    content,
    target,
    theme,
}: {
    content: string;
    target: FileViewerTarget;
    theme: MobileTheme;
}) => (
    <Highlight code={content} language={fileLanguage(target.name) ?? 'text'} theme={themes.dracula}>
        {({ getTokenProps, tokens }) => (
            <FileViewerLineList
                getTokenProps={getTokenProps}
                target={target}
                theme={theme}
                tokens={tokens}
            />
        )}
    </Highlight>
);

/**
 * A file a message cited, read-only, as Desktop's Chat opens it in the Editor: the Server reads it through the
 * Session's own file access (`mobile.files.read`), so a path outside the Session's Project is refused there. Editing
 * stays in the Files tab.
 */
export const FileViewerScreen = () => {
    const router = useRouter();
    const theme = useMobileTheme();
    const { t } = useTranslation();
    const { reference = '', session = '' } = useLocalSearchParams<{
        reference: string;
        session: string;
    }>();
    const target = fileViewerTarget(reference);
    const file = useFileRead(session, target.path || null);
    const body = (() => {
        if (file.isPending)
            return <PendingPanelState fetchStatus={file.fetchStatus} theme={theme} />;
        if (file.isError)
            return isMissingFileError(file.error) ? (
                <ScreenState
                    kind="empty"
                    testID="file-viewer-missing"
                    theme={theme}
                    title={t('panels.citedFileMissing')}
                />
            ) : (
                <ScreenState
                    actionLabel={t('common.retry')}
                    kind="error"
                    onAction={() => {
                        void file.refetch();
                    }}
                    testID="file-viewer-error"
                    theme={theme}
                    title={t('panels.openFileFailed')}
                />
            );
        if (file.data.status !== 'available')
            return (
                <ScreenState
                    kind="empty"
                    testID="file-viewer-unavailable"
                    theme={theme}
                    title={t('panels.fileUnavailable')}
                />
            );
        return <FileViewerLines content={file.data.content} target={target} theme={theme} />;
    })();
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="file-viewer-screen"
        >
            <ScreenHeader
                leading="back"
                leadingLabel={t('common.back')}
                leadingTestID="file-viewer-back"
                onLeading={() => router.back()}
                subtitle={file.data?.status === 'available' ? file.data.path : target.path}
                subtitleTestID="file-viewer-path"
                theme={theme}
                title={target.name}
            />
            <View style={[styles.body, { borderColor: theme.border }]}>{body}</View>
        </SafeAreaView>
    );
};
