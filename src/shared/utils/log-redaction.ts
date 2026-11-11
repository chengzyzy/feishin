const SENSITIVE_URL_PARAMETERS = new Set([
    'access_token',
    'api_key',
    'apikey',
    'auth',
    'authorization',
    'credential',
    'p',
    'passwd',
    'password',
    's',
    'salt',
    'secret',
    't',
    'token',
    'u',
    'username',
]);

const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
const AUTHORIZATION_PATTERN = /\b(authorization\s*[:=]\s*)([^\r\n,}]+)/gi;
const BEARER_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

const redactQuery = (url: URL): URL => {
    for (const key of [...url.searchParams.keys()]) {
        if (SENSITIVE_URL_PARAMETERS.has(key.toLowerCase())) {
            url.searchParams.set(key, 'redacted');
        }
    }
    return url;
};

/** Redacts userinfo and authentication query parameters in one URL for a log line. */
export const redactUrlForLog = (rawUrl: string): string => {
    try {
        const url = redactQuery(new URL(rawUrl));
        if (url.username) url.username = 'redacted';
        if (url.password) url.password = 'redacted';
        return url.toString();
    } catch {
        return '[redacted-url]';
    }
};

/** Returns a short, non-sensitive summary suitable for a media URL log. */
export const summarizeUrlForLog = (rawUrl: string): string => {
    try {
        const url = new URL(rawUrl);
        const pathname =
            url.pathname.length > 80 ? `${url.pathname.slice(0, 77)}...` : url.pathname;
        return `${url.protocol}//${url.host}${pathname}${url.search ? '?[redacted]' : ''}`;
    } catch {
        return '[redacted-url]';
    }
};

/**
 * Sanitizes arbitrary log text before it is packaged into the diagnostics archive.
 * The source log files are never rewritten: only the exported copy is redacted.
 */
export const sanitizeLogText = (text: string): string =>
    text
        .replace(URL_PATTERN, (match) => redactUrlForLog(match))
        .replace(AUTHORIZATION_PATTERN, '$1[redacted]')
        .replace(BEARER_PATTERN, '$1[redacted]');
