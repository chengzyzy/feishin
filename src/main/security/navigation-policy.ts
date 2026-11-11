export interface MainWindowNavigationPolicy {
    devServerUrl?: string;
    rendererFileUrl: string;
}

/**
 * Allows only the packaged renderer document itself, or same-origin navigation inside
 * the Vite dev server. Hash and query changes do not trigger document navigation.
 */
export const isAllowedMainWindowNavigation = (
    targetUrl: string,
    policy: MainWindowNavigationPolicy,
): boolean => {
    let target: URL;
    let rendererFile: URL;
    try {
        target = new URL(targetUrl);
        rendererFile = new URL(policy.rendererFileUrl);
    } catch {
        return false;
    }

    if (target.protocol === 'file:') {
        return (
            target.host === rendererFile.host &&
            target.pathname === rendererFile.pathname &&
            target.search === rendererFile.search
        );
    }

    if (!policy.devServerUrl) return false;

    let devServer: URL;
    try {
        devServer = new URL(policy.devServerUrl);
    } catch {
        return false;
    }

    return (
        target.protocol === devServer.protocol &&
        target.host === devServer.host &&
        target.pathname.startsWith(devServer.pathname)
    );
};
