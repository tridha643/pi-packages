import assert from 'node:assert/strict';
import test from 'node:test';
import {
    calculateCacheHealth,
    formatCacheHealthReport,
    formatCacheHealthStatus,
    type CacheUsageSample,
} from './cache-health-metrics.ts';
import cacheHealthExtension from './index.ts';

const coldStart: CacheUsageSample = { input: 10_000, cacheRead: 0, cacheWrite: 0 };

test('waits before the current model has answered', () => {
    assert.deepEqual(calculateCacheHealth([]), { state: 'waiting' });
});

test('treats the first request as expected cache warmup', () => {
    const health = calculateCacheHealth([coldStart]);

    assert.equal(health.state, 'warming');
    if (health.state !== 'warming') return;
    assert.equal(health.latest.promptTokens, 10_000);
    assert.equal(formatCacheHealthStatus(health), 'Warming');
});

test('reports unavailable when multiple requests contain no cache data', () => {
    const health = calculateCacheHealth([coldStart, { input: 12_000, cacheRead: 0, cacheWrite: 0 }]);

    assert.equal(health.state, 'unavailable');
    assert.match(formatCacheHealthReport(health, 20), /cache data cannot guide a reset/);
});

test('shows latest and weighted recent hit rates without counting the expected cold start', () => {
    const health = calculateCacheHealth([
        coldStart,
        { input: 1_000, cacheRead: 9_000, cacheWrite: 0 },
        { input: 3_000, cacheRead: 7_000, cacheWrite: 0 },
    ]);

    assert.equal(health.state, 'measured');
    if (health.state !== 'measured') return;
    assert.equal(health.grade, 'partial');
    assert.equal(health.latest.hitPercent, 70);
    assert.equal(health.recentHitPercent, 80);
    assert.equal(health.latest.freshTokens, 3_000);
    assert.equal(formatCacheHealthStatus(health), 'Cooling');
});

test('reduces a healthy cache to a clearly named keep-session action', () => {
    const health = calculateCacheHealth([
        coldStart,
        { input: 50, cacheRead: 9_950, cacheWrite: 0 },
    ]);

    assert.equal(health.state, 'measured');
    if (health.state !== 'measured') return;
    assert.equal(health.grade, 'healthy');
    assert.equal(formatCacheHealthStatus(health), 'Warm');
});

test('flags repeated cold requests without claiming that a reset is automatically better', () => {
    const health = calculateCacheHealth([
        coldStart,
        { input: 6_000, cacheRead: 4_000, cacheWrite: 0 },
        { input: 8_000, cacheRead: 2_000, cacheWrite: 0 },
    ]);

    assert.equal(health.state, 'measured');
    if (health.state !== 'measured') return;
    assert.equal(health.grade, 'cold');
    assert.equal(health.consecutiveColdRequests, 2);
    assert.equal(formatCacheHealthStatus(health), 'Cold');
    assert.match(formatCacheHealthReport(health, 75), /reset only when the task changed/);
});

test('normalizes malformed provider counts instead of rendering invalid percentages', () => {
    const health = calculateCacheHealth([
        coldStart,
        { input: Number.NaN, cacheRead: -100, cacheWrite: Number.POSITIVE_INFINITY },
    ]);

    assert.equal(health.state, 'unavailable');
    if (health.state !== 'unavailable') return;
    assert.equal(health.latest.promptTokens, 0);
    assert.equal(health.latest.hitPercent, 0);
});

test('publishes and clears its Pi status through the extension lifecycle', async () => {
    const eventHandlers = new Map<string, (event: never, ctx: never) => unknown>();
    let cacheCommand: { handler: (args: string, ctx: never) => Promise<void> } | undefined;
    const statusUpdates: Array<[string, string | undefined]> = [];
    const notifications: string[] = [];
    const context = {
        model: undefined,
        sessionManager: { getBranch: () => [] },
        getContextUsage: () => ({ percent: 42 }),
        ui: {
            theme: { fg: (_tone: string, text: string) => text },
            setStatus: (id: string, text: string | undefined) => statusUpdates.push([id, text]),
            notify: (text: string) => notifications.push(text),
        },
    };
    const pi = {
        on: (eventName: string, handler: unknown) => {
            eventHandlers.set(eventName, handler as (event: never, ctx: never) => unknown);
        },
        registerCommand: (_name: string, command: unknown) => {
            cacheCommand = command as { handler: (args: string, ctx: never) => Promise<void> };
        },
    };

    cacheHealthExtension(pi as never);

    eventHandlers.get('session_start')?.(undefined as never, context as never);
    await cacheCommand?.handler('', context as never);
    eventHandlers.get('session_shutdown')?.(undefined as never, context as never);

    assert.deepEqual(statusUpdates, [
        ['cache-health', 'Waiting'],
        ['cache-health', undefined],
    ]);
    assert.deepEqual(notifications, [
        'Cache: waiting for the first response from this model.\nContext: 42.0% used\nDecision: wait; a new session also starts cold.',
    ]);
});
