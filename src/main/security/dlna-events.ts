import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

export const DLNA_NOTIFY_MAX_BYTES = 1024 * 1024;
export const DLNA_PENDING_SUBSCRIPTION_TTL_MS = 15_000;

export type DlnaNotifyKind = 'avtransport' | 'topology';

export interface DlnaPendingSubscription {
    addresses: string[];
    expiresAt: number;
    initialNotification?: { body: string; sid: string };
    kind: DlnaNotifyKind;
}

export interface DlnaSubscription {
    addresses: string[];
    kind: DlnaNotifyKind;
    sid: string;
}

export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export const normalizeNotifyAddress = (address: string): string => {
    let value = address.trim().toLowerCase();

    // Node reports IPv4 connections as ::ffff:a.b.c.d in dual-stack servers.
    if (value.startsWith('::ffff:')) {
        value = value.slice('::ffff:'.length);
    }

    // URLs may carry brackets; strip them before the zone id so [fe80::1%en0]
    // still compares as fe80::1.
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);

    const zoneIndex = value.indexOf('%');
    if (zoneIndex >= 0) value = value.slice(0, zoneIndex);

    return value;
};

export const isAllowedNotifySource = (remoteAddress: unknown, expectedHosts: string[]): boolean => {
    if (typeof remoteAddress !== 'string' || remoteAddress.length === 0) return false;
    const normalizedRemote = normalizeNotifyAddress(remoteAddress);
    return expectedHosts
        .map((host) => normalizeNotifyAddress(host))
        .some((host) => host.length > 0 && host === normalizedRemote);
};

export const isValidNotifySid = (sid: unknown): sid is string =>
    typeof sid === 'string' && sid.trim().length > 0 && sid.length <= 512;

export const isValidNotifySequence = (sequence: unknown): boolean => {
    if (typeof sequence !== 'string' && typeof sequence !== 'number') return false;
    if (typeof sequence === 'string' && !/^\d+$/.test(sequence)) return false;
    const value = Number(sequence);
    return Number.isSafeInteger(value) && value >= 0;
};

export const defaultHostLookup: HostLookup = async (hostname: string) => {
    const normalized = normalizeNotifyAddress(hostname);
    if (isIP(normalized)) return [{ address: normalized }];
    const records = await dns.lookup(normalized, { all: true });
    return records.map((record) => ({ address: record.address }));
};

/**
 * Resolves a device hostname to the addresses a callback may legitimately come from.
 * Literal IPv4/IPv6 values bypass DNS so test doubles and IP-based devices are stable.
 */
export const resolveHostAddresses = async (
    hostname: unknown,
    lookup: HostLookup = defaultHostLookup,
): Promise<string[]> => {
    if (typeof hostname !== 'string' || hostname.length === 0) return [];

    const normalizedInput = normalizeNotifyAddress(hostname);
    if (isIP(normalizedInput)) return [normalizedInput];

    try {
        const records = await lookup(hostname);
        const addresses = records
            .map((record) => normalizeNotifyAddress(record.address))
            .filter((address) => address.length > 0);
        return [...new Set(addresses)];
    } catch {
        return [];
    }
};

export const setPendingSubscription = (
    pending: Map<DlnaNotifyKind, DlnaPendingSubscription>,
    kind: DlnaNotifyKind,
    addresses: string[],
    now: number = Date.now(),
): DlnaPendingSubscription => {
    const subscription = {
        addresses: [...addresses],
        expiresAt: now + DLNA_PENDING_SUBSCRIPTION_TTL_MS,
        kind,
    };
    pending.set(kind, subscription);
    return subscription;
};

export const clearPendingSubscription = (
    pending: Map<DlnaNotifyKind, DlnaPendingSubscription>,
    kind: DlnaNotifyKind,
): void => {
    pending.delete(kind);
};

/**
 * The first NOTIFY may race the SUBSCRIBE response. Only an initial (SEQ 0) callback
 * from the address we are currently subscribing to may use the pending record.
 */
export const isPendingSubscriptionCandidate = (
    pending: Map<DlnaNotifyKind, DlnaPendingSubscription>,
    kind: DlnaNotifyKind,
    remoteAddress: unknown,
    sequence: unknown,
    now: number = Date.now(),
): boolean => {
    if (!isValidNotifySequence(sequence) || Number(sequence) !== 0) return false;

    const candidate = pending.get(kind);
    if (!candidate) return false;
    if (now >= candidate.expiresAt) {
        pending.delete(kind);
        return false;
    }

    return isAllowedNotifySource(remoteAddress, candidate.addresses);
};

/** Processes a buffered initial event only after the SUBSCRIBE response confirms its SID. */
export const activatePendingSubscription = (
    pending: Map<DlnaNotifyKind, DlnaPendingSubscription>,
    active: Map<string, DlnaSubscription>,
    subscription: DlnaPendingSubscription,
    sid: string,
    now: number = Date.now(),
): null | { initialBody?: string } => {
    if (pending.get(subscription.kind) !== subscription) return null;
    pending.delete(subscription.kind);
    if (now >= subscription.expiresAt || !isValidNotifySid(sid)) return null;

    active.set(sid, { addresses: subscription.addresses, kind: subscription.kind, sid });
    return {
        initialBody:
            subscription.initialNotification?.sid === sid
                ? subscription.initialNotification.body
                : undefined,
    };
};

export const rotateSubscriptionSid = (
    subscriptions: Map<string, DlnaSubscription>,
    oldSid: string,
    newSid: string,
    kind: DlnaNotifyKind,
    addresses: string[],
): void => {
    subscriptions.delete(oldSid);
    subscriptions.set(newSid, { addresses: [...addresses], kind, sid: newSid });
};

export const isSupportedNotifyPath = (pathname: string): DlnaNotifyKind | null => {
    if (pathname === '/notify') return 'avtransport';
    if (pathname === '/topology') return 'topology';
    return null;
};

export const isNotifyBodyWithinLimit = (byteLength: number): boolean =>
    Number.isFinite(byteLength) && byteLength >= 0 && byteLength <= DLNA_NOTIFY_MAX_BYTES;
