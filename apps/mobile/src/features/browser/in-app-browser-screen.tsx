/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ComponentType } from 'react';
import { useCallback, useRef, useState } from 'react';
import type { HostInstance } from 'react-native';
import { BackHandler, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { WebViewNavigation } from 'react-native-webview';
import { WebView } from 'react-native-webview';

import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import type { LucideProps } from 'lucide-react-native';
import {
    ArrowLeft,
    Copy,
    Ellipsis,
    ExternalLink,
    Lock,
    RotateCw,
    Share2,
    X,
} from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { PopoverMenu } from '../../components/popover-menu';
import { ScreenState } from '../../components/screen-state';
import { usePopoverAnchor } from '../../components/use-popover-anchor';
import { useTranslation } from '../../i18n';
import { openExternalLink } from '../../lib/open-external-link';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import {
    browserDisplayHost,
    browserNavigation,
    browserPageLabel,
    browserPillTitle,
    browserResumeUrl,
    isSecurePage,
} from './browser-url';

/**
 * What a browser paints behind a page that sets no background of its own (the CSS canvas default). The app's dark theme
 * there would leave such a page's default black text unreadable.
 */
const PAGE_CANVAS = '#ffffff';

interface PageState {
    canGoBack: boolean;
    isLoading: boolean;
    title: string;
    url: string;
}

const MenuAction = ({
    icon: Icon,
    label,
    onPress,
    testID,
    theme,
}: {
    icon: ComponentType<LucideProps>;
    label: string;
    onPress: () => void;
    testID: string;
    theme: MobileTheme;
}) => (
    <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.menuAction, pressed && { backgroundColor: theme.elevated }]}
        testID={testID}
    >
        <Icon color={theme.muted} size={18} />
        <Text style={[styles.menuActionText, { color: theme.text }]}>{label}</Text>
    </Pressable>
);

/**
 * A web page shown over the app, like X's in-app browser: the page fills the screen and a floating toolbar at the
 * bottom closes it, names the page, offers copy/share/open-elsewhere, goes back, and reloads. Closing returns to the
 * screen underneath exactly where it was, because the route is pushed over it rather than replacing it.
 *
 * The page is an ordinary website, so the WebView keeps its own cookies and storage (a sign-in persists) but gets no
 * bridge into the app: no injected script and no message handler. Navigations to a non-web scheme leave for the app the
 * system assigns.
 */
export const InAppBrowserScreen = () => {
    const theme = useMobileTheme();
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const { label, url: initialUrl = 'about:blank' } = useLocalSearchParams<{
        label?: string;
        url?: string;
    }>();
    const webview = useRef<WebView>(null);
    const [page, setPage] = useState<PageState>({
        canGoBack: false,
        isLoading: true,
        title: '',
        url: initialUrl,
    });
    const [progress, setProgress] = useState(0);
    /**
     * True from a failed load until the next one starts; the pill must not show Chromium's error page title meanwhile.
     */
    const [hasLoadFailed, setHasLoadFailed] = useState(false);
    /**
     * Remounts the WebView after Android kills its renderer, as the Terminal does.
     */
    const [generation, setGeneration] = useState(0);
    /**
     * What the WebView loads when it (re)mounts: the opening URL first, then the page the reader was on after a
     * renderer death. It changes only with `generation`, never on a navigation, so a page change never restarts the
     * load.
     */
    const [sourceUrl, setSourceUrl] = useState(initialUrl);
    const menuAnchor = useRef<HostInstance>(null);
    const menu = usePopoverAnchor(menuAnchor, { side: 'above' });

    // Android Back walks the page's history first, then closes the browser like any other screen.
    useFocusEffect(
        useCallback(() => {
            if (!page.canGoBack) return;
            const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
                webview.current?.goBack();
                return true;
            });
            return () => subscription.remove();
        }, [page.canGoBack]),
    );

    const close = useCallback(() => {
        if (router.canGoBack()) router.back();
    }, []);
    const onNavigationStateChange = useCallback((navigation: WebViewNavigation) => {
        setPage({
            canGoBack: navigation.canGoBack,
            isLoading: navigation.loading,
            title: navigation.title,
            url: navigation.url,
        });
    }, []);
    const reloadOrStop = useCallback(() => {
        if (page.isLoading) {
            webview.current?.stopLoading();
            return;
        }
        webview.current?.reload();
    }, [page.isLoading]);
    const runMenuAction = useCallback(
        (action: () => Promise<unknown> | void) => {
            menu.close();
            void action();
        },
        [menu],
    );

    const pageLabel = browserPageLabel(label, initialUrl, page.url);
    const host = pageLabel ?? browserDisplayHost(page.url);
    const title = pageLabel ?? browserPillTitle({ ...page, hasLoadFailed });
    return (
        <View
            style={[styles.root, { backgroundColor: theme.background, paddingTop: insets.top }]}
            testID="in-app-browser"
        >
            {page.isLoading && progress < 1 ? (
                <View style={[styles.progressTrack, { top: insets.top }]}>
                    <View
                        style={[
                            styles.progress,
                            {
                                backgroundColor: theme.primary,
                                width: `${Math.max(progress, 0.05) * 100}%`,
                            },
                        ]}
                    />
                </View>
            ) : null}
            <WebView
                key={generation}
                ref={webview}
                allowsBackForwardNavigationGestures
                allowsInlineMediaPlayback
                javaScriptCanOpenWindowsAutomatically={false}
                onError={() => setHasLoadFailed(true)}
                onLoadStart={() => setHasLoadFailed(false)}
                onLoadProgress={(event) => setProgress(event.nativeEvent.progress)}
                onNavigationStateChange={onNavigationStateChange}
                onRenderProcessGone={() => {
                    setSourceUrl(browserResumeUrl(page.url, initialUrl));
                    setGeneration((current) => current + 1);
                }}
                onShouldStartLoadWithRequest={(request) => {
                    if (browserNavigation(request.url) === 'load') return true;
                    void openExternalLink(request.url);
                    return false;
                }}
                originWhitelist={['*']}
                pullToRefreshEnabled
                // The WebView swaps this in while its load has failed, so Chromium's own error page never shows.
                renderError={() => (
                    <View
                        style={[styles.error, { backgroundColor: theme.background }]}
                        testID="in-app-browser-error"
                    >
                        <ScreenState
                            actionLabel={t('browser.reload')}
                            detail={t('browser.errorBody')}
                            kind="error"
                            onAction={() => webview.current?.reload()}
                            testID="in-app-browser-error-state"
                            theme={theme}
                            title={t('browser.errorTitle')}
                        />
                    </View>
                )}
                setSupportMultipleWindows={false}
                source={{ uri: sourceUrl }}
                style={[styles.webview, { backgroundColor: PAGE_CANVAS }]}
                testID="in-app-browser-webview"
            />
            <View
                pointerEvents="box-none"
                style={[styles.toolbar, { bottom: insets.bottom + 12 }]}
                testID="in-app-browser-toolbar"
            >
                <View
                    style={[
                        styles.round,
                        { backgroundColor: theme.elevated, borderColor: theme.border },
                    ]}
                >
                    <IconButton
                        accessibilityLabel={t('browser.close')}
                        icon={X}
                        onPress={close}
                        testID="in-app-browser-close"
                        theme={theme}
                    />
                </View>
                <View
                    collapsable={false}
                    ref={menuAnchor}
                    style={[
                        styles.pill,
                        { backgroundColor: theme.elevated, borderColor: theme.border },
                    ]}
                >
                    <Pressable
                        accessibilityHint={t('browser.menuHint')}
                        accessibilityLabel={`${t('browser.menu')}: ${title}`}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: menu.isOpen }}
                        onPress={menu.open}
                        style={styles.pillButton}
                        testID="in-app-browser-menu"
                    >
                        {isSecurePage(page.url) ? <Lock color={theme.muted} size={14} /> : null}
                        <Text numberOfLines={1} style={[styles.pillText, { color: theme.text }]}>
                            {title}
                        </Text>
                        <Ellipsis color={theme.muted} size={18} />
                    </Pressable>
                </View>
                {page.canGoBack ? (
                    <View
                        style={[
                            styles.round,
                            { backgroundColor: theme.elevated, borderColor: theme.border },
                        ]}
                    >
                        <IconButton
                            accessibilityLabel={t('browser.back')}
                            icon={ArrowLeft}
                            onPress={() => webview.current?.goBack()}
                            testID="in-app-browser-back"
                            theme={theme}
                        />
                    </View>
                ) : null}
                <View
                    style={[
                        styles.round,
                        { backgroundColor: theme.elevated, borderColor: theme.border },
                    ]}
                >
                    <IconButton
                        accessibilityLabel={t(page.isLoading ? 'browser.stop' : 'browser.reload')}
                        icon={page.isLoading ? X : RotateCw}
                        onPress={reloadOrStop}
                        testID="in-app-browser-reload"
                        theme={theme}
                    />
                </View>
            </View>
            <PopoverMenu
                closeLabel={t('browser.closeMenu')}
                onClose={menu.close}
                placement={menu.placement}
                theme={theme}
            >
                <Text numberOfLines={1} style={[styles.menuHost, { color: theme.muted }]}>
                    {host}
                </Text>
                <MenuAction
                    icon={Copy}
                    label={t('browser.copyLink')}
                    onPress={() => runMenuAction(() => Clipboard.setStringAsync(page.url))}
                    testID="in-app-browser-copy"
                    theme={theme}
                />
                <MenuAction
                    icon={Share2}
                    label={t('browser.share')}
                    onPress={() =>
                        runMenuAction(() => Share.share({ message: page.url, url: page.url }))
                    }
                    testID="in-app-browser-share"
                    theme={theme}
                />
                <MenuAction
                    icon={ExternalLink}
                    label={t('browser.openExternal')}
                    onPress={() => runMenuAction(() => openExternalLink(page.url))}
                    testID="in-app-browser-open-external"
                    theme={theme}
                />
            </PopoverMenu>
        </View>
    );
};

const styles = StyleSheet.create({
    error: { ...StyleSheet.absoluteFill, justifyContent: 'center' },
    menuAction: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.md,
        minHeight: 48,
        paddingHorizontal: 14,
    },
    menuActionText: { ...mobileType.body },
    menuHost: {
        ...mobileType.caption,
        paddingBottom: mobileSpace.xs,
        paddingHorizontal: 14,
        paddingTop: mobileSpace.sm,
    },
    pill: {
        borderRadius: mobileRadius.pill,
        borderWidth: 1,
        flex: 1,
        minHeight: 48,
    },
    pillButton: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: 6,
        paddingHorizontal: mobileSpace.lg,
    },
    pillText: { ...mobileType.meta, flex: 1 },
    progress: { height: 2 },
    progressTrack: { left: 0, position: 'absolute', right: 0, zIndex: 1 },
    root: { flex: 1 },
    round: {
        alignItems: 'center',
        borderRadius: mobileRadius.pill,
        borderWidth: 1,
        height: 48,
        justifyContent: 'center',
        width: 48,
    },
    toolbar: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        left: mobileSpace.md,
        position: 'absolute',
        right: mobileSpace.md,
    },
    webview: { flex: 1 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
