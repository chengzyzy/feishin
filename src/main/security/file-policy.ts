import type { FileUse } from '/@/shared/types/file-access';

import { constants, promises as fs } from 'node:fs';

export type { FileUse } from '/@/shared/types/file-access';

export const isFileUse = (value: unknown): value is FileUse =>
    value === 'audio' || value === 'font' || value === 'image';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const FILE_EXTENSIONS: Record<FileUse, readonly string[]> = {
    audio: [
        'aac',
        'aif',
        'aiff',
        'alac',
        'ape',
        'dff',
        'dsf',
        'flac',
        'm4a',
        'mka',
        'mp3',
        'mp4',
        'mpc',
        'oga',
        'ogg',
        'opus',
        'wav',
        'wma',
        'wv',
    ],
    font: ['otf', 'ttc', 'ttf', 'woff', 'woff2'],
    image: ['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'tif', 'tiff', 'webp'],
};

const extensionOf = (filePath: string): string => {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot < 0 || lastDot === filePath.length - 1) return '';
    return filePath.slice(lastDot + 1).toLowerCase();
};

export const isAllowedFilePath = (filePath: unknown, use: FileUse): filePath is string => {
    if (typeof filePath !== 'string') return false;
    if (filePath.length === 0 || filePath.length > 4096 || filePath.includes('\0')) return false;
    return FILE_EXTENSIONS[use].includes(extensionOf(filePath));
};

export interface ValidatedFilesResult {
    ok: boolean;
    paths?: string[];
    reason?: string;
}

/**
 * Resolves renderer-supplied paths to real regular files and enforces the resource
 * type for the operation. The canonical paths bind a grant to the selected files.
 */
export const validateReadableFiles = async (
    filePaths: unknown,
    use: FileUse,
): Promise<ValidatedFilesResult> => {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return { ok: false, reason: 'empty-file-list' };
    }

    const resolved: string[] = [];

    for (const candidate of filePaths) {
        if (!isAllowedFilePath(candidate, use)) {
            return { ok: false, reason: 'invalid-file-type' };
        }

        try {
            const realPath = await fs.realpath(candidate);
            if (!isAllowedFilePath(realPath, use)) {
                return { ok: false, reason: 'invalid-file-type' };
            }
            const stat = await fs.stat(realPath);
            if (!stat.isFile()) {
                return { ok: false, reason: 'not-a-file' };
            }

            if (use === 'image' && stat.size > MAX_IMAGE_BYTES) {
                return { ok: false, reason: 'file-too-large' };
            }

            if (use === 'audio' && stat.size === 0) {
                return { ok: false, reason: 'empty-file' };
            }

            await fs.access(realPath, constants.R_OK);
            resolved.push(realPath);
        } catch {
            return { ok: false, reason: 'unreadable-file' };
        }
    }

    return { ok: true, paths: resolved };
};

export const validateReadableFile = async (
    filePath: unknown,
    use: FileUse,
): Promise<ValidatedFilesResult> => validateReadableFiles([filePath], use);

export const validateGrantedFiles = async (
    requestedPaths: unknown,
    grantedPaths: string[],
    use: FileUse,
): Promise<null | string[]> => {
    if (!Array.isArray(requestedPaths) || requestedPaths.length === 0) return null;
    const granted = new Set(grantedPaths);
    if (
        !requestedPaths.every(
            (filePath): filePath is string => typeof filePath === 'string' && granted.has(filePath),
        )
    ) {
        return null;
    }

    const selectedPaths = [...new Set(requestedPaths)];
    const validated = await validateReadableFiles(selectedPaths, use);
    if (!validated.paths?.every((filePath, index) => filePath === selectedPaths[index])) {
        return null;
    }
    return selectedPaths;
};

/**
 * The DLNA temp server may only expose files this process created inside the OS temp
 * directory. The active servedTempFiles set remains the primary allow list.
 */
export const isAllowedServedTempPath = (
    candidate: unknown,
    tempDirectory: string,
    servedTempFiles: ReadonlySet<string>,
): candidate is string => {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;

    const resolved = candidate;
    const expectedRoot = tempDirectory.endsWith('/') ? tempDirectory : `${tempDirectory}/`;
    if (!resolved.startsWith(expectedRoot)) return false;

    const fileName = resolved.slice(expectedRoot.length);
    return (
        servedTempFiles.has(resolved) &&
        fileName.startsWith('dlna-speed-') &&
        !fileName.includes('/')
    );
};

export const validateExecutableFile = async (filePath: unknown): Promise<ValidatedFilesResult> => {
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 4096) {
        return { ok: false, reason: 'invalid-path' };
    }

    try {
        const realPath = await fs.realpath(filePath);
        const stat = await fs.stat(realPath);
        if (!stat.isFile() || stat.size === 0) {
            return { ok: false, reason: 'not-an-executable-file' };
        }

        // X_OK is meaningful on POSIX. Windows only needs an existing regular file here.
        if (process.platform !== 'win32') {
            await fs.access(realPath, constants.X_OK);
        }

        return { ok: true, paths: [realPath] };
    } catch {
        return { ok: false, reason: 'unreadable-file' };
    }
};
