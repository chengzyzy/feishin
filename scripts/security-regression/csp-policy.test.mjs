/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCspHtml } from '../../scripts/verify-runtime-csp.mjs';

const CSP = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' data: blob: http: https:",
    "connect-src 'self' http: https: ws: wss:",
    "object-src 'none'",
].join('; ');

const document = (policy, body = '<script type="module" src="./app.js"></script>') => `
<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${policy}" />
</head><body>${body}</body></html>`;

test('production CSP permits local modules, WASM and visualizer eval while rejecting inline scripts', () => {
    const result = validateCspHtml(document(CSP));
    assert.equal(result.ok, true);
    assert.match(result.policy, /'wasm-unsafe-eval'/);
    assert.match(result.policy, /'unsafe-eval'/);
    assert.doesNotMatch(result.policy.split(';')[1], /'unsafe-inline'/);
});

test('CSP validator rejects missing meta, inline scripts and broad script sources', () => {
    assert.equal(validateCspHtml('<html><body></body></html>').ok, false);
    assert.equal(validateCspHtml(document(CSP, '<script>alert(1)</script>')).ok, false);
    assert.equal(
        validateCspHtml(
            document(
                CSP.replace("'self' 'wasm-unsafe-eval' 'unsafe-eval'", "'self' 'unsafe-inline'"),
            ),
        ).ok,
        false,
    );
    assert.equal(
        validateCspHtml(
            document(CSP.replace("'self' 'wasm-unsafe-eval' 'unsafe-eval'", "'self' https:")),
        ).ok,
        false,
    );
});
