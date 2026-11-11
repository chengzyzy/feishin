import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    isAllowedFilePath,
    isAllowedServedTempPath,
    validateExecutableFile,
    validateGrantedFiles,
    validateReadableFiles,
} from '../../src/main/security/file-policy.ts';

test('file type policy accepts media, image and font extensions only', () => {
    assert.equal(isAllowedFilePath('/tmp/song.mp3', 'audio'), true);
    assert.equal(isAllowedFilePath('/tmp/song.flac', 'audio'), true);
    assert.equal(isAllowedFilePath('/tmp/cover.png', 'image'), true);
    assert.equal(isAllowedFilePath('/tmp/font.woff2', 'font'), true);
    assert.equal(isAllowedFilePath('/tmp/notes.txt', 'image'), false);
    assert.equal(isAllowedFilePath('/tmp/song.mp3', 'image'), false);
    assert.equal(isAllowedFilePath('/tmp/no-extension', 'audio'), false);
    assert.equal(isAllowedFilePath('/tmp/bad\0name.mp3', 'audio'), false);
});

test('real file validation canonicalizes paths and rejects invalid lists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishin-file-policy-'));
    const songPath = path.join(root, 'song.mp3');
    const imagePath = path.join(root, 'cover.png');
    const textPath = path.join(root, 'notes.txt');
    await fs.writeFile(songPath, 'marker-audio');
    await fs.writeFile(imagePath, 'marker-image');
    await fs.writeFile(textPath, 'marker-text');

    const valid = await validateReadableFiles([songPath], 'audio');
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.paths, [await fs.realpath(songPath)]);

    const wrongType = await validateReadableFiles([imagePath], 'audio');
    assert.equal(wrongType.ok, false);

    const missing = await validateReadableFiles([path.join(root, 'missing.mp3')], 'audio');
    assert.equal(missing.ok, false);

    const executablePath = path.join(root, 'mpv');
    await fs.writeFile(executablePath, '#!/bin/sh\nexit 0\n');
    await fs.chmod(executablePath, 0o755);
    const executable = await validateExecutableFile(executablePath);
    assert.equal(executable.ok, true);
    assert.deepEqual(executable.paths, [await fs.realpath(executablePath)]);

    const textAsExecutable = await validateExecutableFile(textPath);
    assert.equal(textAsExecutable.ok, false);

    await fs.rm(root, { force: true, recursive: true });
});

test('saving one track in a batch resolves only that track', async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishin-tag-selection-'));
    context.after(async () => fs.rm(root, { force: true, recursive: true }));
    const trackPaths = ['first.mp3', 'second.mp3', 'other.mp3'].map((name) =>
        path.join(root, name),
    );
    await Promise.all(trackPaths.map((filePath) => fs.writeFile(filePath, 'test-audio')));
    const [first, second, other] = await Promise.all(
        trackPaths.map((filePath) => fs.realpath(filePath)),
    );
    const grantedPaths = [first, second];

    assert.deepEqual(await validateGrantedFiles([second], grantedPaths, 'audio'), [second]);
    assert.deepEqual(await validateGrantedFiles(grantedPaths, grantedPaths, 'audio'), grantedPaths);
    assert.equal(await validateGrantedFiles([second, other], grantedPaths, 'audio'), null);
    assert.equal(await validateGrantedFiles([], grantedPaths, 'audio'), null);
});

test('DLNA temp path must be in the temp root, served, and use the expected prefix', () => {
    const tempRoot = '/tmp/feishin-temp';
    const served = new Set([
        '/tmp/feishin-temp/dlna-speed-a1-s1.5-p1.mp3',
        '/tmp/feishin-temp/other-file.mp3',
    ]);

    assert.equal(
        isAllowedServedTempPath('/tmp/feishin-temp/dlna-speed-a1-s1.5-p1.mp3', tempRoot, served),
        true,
    );
    assert.equal(
        isAllowedServedTempPath('/tmp/feishin-temp/other-file.mp3', tempRoot, served),
        false,
    );
    assert.equal(
        isAllowedServedTempPath('/tmp/elsewhere/dlna-speed-a1-s1.5-p1.mp3', tempRoot, served),
        false,
    );
});
