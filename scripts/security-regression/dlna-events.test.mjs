/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    activatePendingSubscription,
    DLNA_NOTIFY_MAX_BYTES,
    isAllowedNotifySource,
    isNotifyBodyWithinLimit,
    isPendingSubscriptionCandidate,
    isSupportedNotifyPath,
    isValidNotifySequence,
    isValidNotifySid,
    normalizeNotifyAddress,
    resolveHostAddresses,
    rotateSubscriptionSid,
    setPendingSubscription,
} from '../../src/main/security/dlna-events.ts';

test('IPv4, IPv4-mapped IPv6 and IPv6 zone addresses normalize for source checks', () => {
    assert.equal(normalizeNotifyAddress('::ffff:192.168.1.20'), '192.168.1.20');
    assert.equal(normalizeNotifyAddress('[fe80::1%en0]'), 'fe80::1');
    assert.equal(isAllowedNotifySource('::ffff:192.168.1.20', ['192.168.1.20']), true);
    assert.equal(isAllowedNotifySource('[fe80::1%en0]', ['fe80::1']), true);
    assert.equal(isAllowedNotifySource('192.168.1.21', ['192.168.1.20']), false);
    assert.equal(isAllowedNotifySource(undefined, ['192.168.1.20']), false);
});

test('subscription path, SID and sequence are validated before handling', () => {
    assert.equal(isSupportedNotifyPath('/notify'), 'avtransport');
    assert.equal(isSupportedNotifyPath('/topology'), 'topology');
    assert.equal(isSupportedNotifyPath('/other'), null);

    assert.equal(isValidNotifySid('uuid:avtransport-1'), true);
    assert.equal(isValidNotifySid(''), false);
    assert.equal(isValidNotifySid('x'.repeat(513)), false);

    assert.equal(isValidNotifySequence(0), true);
    assert.equal(isValidNotifySequence('2'), true);
    assert.equal(isValidNotifySequence(''), false);
    assert.equal(isValidNotifySequence(-1), false);
    assert.equal(isValidNotifySequence('NaN'), false);
});

test('notification body limit accepts exactly 1 MiB and rejects one byte more', () => {
    assert.equal(isNotifyBodyWithinLimit(DLNA_NOTIFY_MAX_BYTES), true);
    assert.equal(isNotifyBodyWithinLimit(DLNA_NOTIFY_MAX_BYTES + 1), false);
    assert.equal(isNotifyBodyWithinLimit(-1), false);
});

test('hostnames resolve to IP addresses and pending initial notifications are source-bound', async () => {
    const lookup = async (hostname) => {
        if (hostname === 'device.local') return [{ address: '::ffff:192.168.1.20' }];
        throw new Error('lookup failed');
    };

    assert.deepEqual(await resolveHostAddresses('device.local', lookup), ['192.168.1.20']);
    assert.deepEqual(await resolveHostAddresses('::ffff:192.168.1.21', lookup), ['192.168.1.21']);
    assert.deepEqual(await resolveHostAddresses('missing.local', lookup), []);

    const pending = new Map();
    setPendingSubscription(pending, 'avtransport', ['192.168.1.20'], 1000);
    assert.equal(
        isPendingSubscriptionCandidate(pending, 'avtransport', '::ffff:192.168.1.20', 0, 1001),
        true,
    );
    assert.equal(
        isPendingSubscriptionCandidate(pending, 'avtransport', '192.168.1.21', 0, 1001),
        false,
    );
    assert.equal(
        isPendingSubscriptionCandidate(pending, 'avtransport', '192.168.1.20', 1, 1001),
        false,
    );
    const expired = new Map();
    setPendingSubscription(expired, 'topology', ['192.168.1.20'], 1000);
    assert.equal(
        isPendingSubscriptionCandidate(expired, 'topology', '192.168.1.20', 0, 21000),
        false,
    );
});

test('renewed subscriptions rotate SID without losing source binding', () => {
    const subscriptions = new Map([
        ['uuid:old', { addresses: ['192.168.1.20'], kind: 'avtransport', sid: 'uuid:old' }],
    ]);

    rotateSubscriptionSid(subscriptions, 'uuid:old', 'uuid:new', 'avtransport', ['192.168.1.20']);

    assert.equal(subscriptions.has('uuid:old'), false);
    assert.deepEqual(subscriptions.get('uuid:new'), {
        addresses: ['192.168.1.20'],
        kind: 'avtransport',
        sid: 'uuid:new',
    });
});

test('buffered first notification is used only for the confirmed subscription', () => {
    const pending = new Map();
    const active = new Map();
    const first = setPendingSubscription(pending, 'avtransport', ['192.168.1.20'], 1000);
    first.initialNotification = { body: '<initial />', sid: 'uuid:expected' };
    assert.equal(active.size, 0);
    assert.equal(
        activatePendingSubscription(pending, active, first, 'uuid:expected', 1001)?.initialBody,
        '<initial />',
    );
    assert.deepEqual(active.get('uuid:expected')?.addresses, ['192.168.1.20']);

    const second = setPendingSubscription(pending, 'topology', ['fe80::1'], 1002);
    second.initialNotification = { body: '<initial />', sid: 'uuid:unconfirmed' };
    const confirmed = activatePendingSubscription(pending, active, second, 'uuid:confirmed', 1003);
    assert.ok(confirmed);
    assert.equal(confirmed.initialBody, undefined);
    assert.equal(active.has('uuid:unconfirmed'), false);

    const stale = setPendingSubscription(pending, 'topology', ['fe80::1'], 1004);
    const current = setPendingSubscription(pending, 'topology', ['fe80::2'], 1005);
    assert.equal(activatePendingSubscription(pending, active, stale, 'uuid:stale', 1006), null);
    assert.equal(pending.get('topology'), current);
});
