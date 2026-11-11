import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedMainWindowNavigation } from '../../src/main/security/navigation-policy.ts';

const productionPolicy = {
    rendererFileUrl:
        'file:///Applications/Feishin%20Local.app/Contents/Resources/app.asar/out/renderer/index.html',
};
const devPolicy = {
    ...productionPolicy,
    devServerUrl: 'http://localhost:5173/',
};

test('production allows only the packaged renderer document', () => {
    assert.equal(
        isAllowedMainWindowNavigation(productionPolicy.rendererFileUrl, productionPolicy),
        true,
    );
    assert.equal(
        isAllowedMainWindowNavigation(
            'file:///Applications/Feishin%20Local.app/Contents/Resources/app.asar/out/renderer/other.html',
            productionPolicy,
        ),
        false,
    );
    assert.equal(isAllowedMainWindowNavigation('https://example.test/', productionPolicy), false);
    assert.equal(isAllowedMainWindowNavigation('not a url', productionPolicy), false);
});

test('development allows same-origin dev server paths only', () => {
    assert.equal(isAllowedMainWindowNavigation('http://localhost:5173/', devPolicy), true);
    assert.equal(
        isAllowedMainWindowNavigation('http://localhost:5173/src/app.tsx', devPolicy),
        true,
    );
    assert.equal(isAllowedMainWindowNavigation('http://localhost:9999/', devPolicy), false);
    assert.equal(isAllowedMainWindowNavigation('https://localhost:5173/', devPolicy), false);
    assert.equal(isAllowedMainWindowNavigation(productionPolicy.rendererFileUrl, devPolicy), true);
});
