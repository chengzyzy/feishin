import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FileGrantRegistry } from '../../src/main/security/file-grants.ts';

test('grants resolve only for their use and owning webContents', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feishin-grants-'));
    const songPath = path.join(root, 'song.mp3');
    await fs.writeFile(songPath, 'marker');
    const realPath = await fs.realpath(songPath);

    const registry = new FileGrantRegistry();
    const grant = registry.create('audio', [realPath], 7);

    assert.equal(typeof grant.grantId, 'string');
    assert.deepEqual(registry.resolve(grant.grantId, 'audio', 7), {
        grantId: grant.grantId,
        paths: [realPath],
        use: 'audio',
    });
    assert.equal(registry.resolve(grant.grantId, 'image', 7), null);
    assert.equal(registry.resolve(grant.grantId, 'audio', 8), null);
    assert.equal(registry.resolve('unknown-grant', 'audio', 7), null);

    registry.revokeForWebContents(7);
    assert.equal(registry.resolve(grant.grantId, 'audio', 7), null);

    await fs.rm(root, { force: true, recursive: true });
});

test('only the owning editor can release a file grant', () => {
    const registry = new FileGrantRegistry();
    const grant = registry.create('image', ['/tmp/cover.png'], 1);

    assert.equal(registry.revoke(grant.grantId, 2), false);
    assert.deepEqual(registry.resolve(grant.grantId, 'image', 1), grant);
    assert.equal(registry.revoke(grant.grantId, 1), true);
    assert.equal(registry.resolve(grant.grantId, 'image', 1), null);
});
