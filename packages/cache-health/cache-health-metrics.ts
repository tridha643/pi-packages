const RECENT_REQUEST_LIMIT = 5;
const HEALTHY_CACHE_HIT_PERCENT = 90;
const PARTIAL_CACHE_HIT_PERCENT = 70;

/** Token usage from one model request, split by prompt-cache billing bucket. */
export interface CacheUsageSample {
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
}

interface CacheRequestMetrics {
    readonly promptTokens: number;
    readonly cacheReadTokens: number;
    readonly freshTokens: number;
    readonly hitPercent: number;
}

/** Cache state before the current model has produced a response. */
export interface WaitingCacheHealth {
    readonly state: 'waiting';
}

/** Cache state while the first request establishes a reusable prompt prefix. */
export interface WarmingCacheHealth {
    readonly state: 'warming';
    readonly requestCount: number;
    readonly latest: CacheRequestMetrics;
}

/** Cache state when the provider has not reported cache reads or writes. */
export interface UnavailableCacheHealth {
    readonly state: 'unavailable';
    readonly requestCount: number;
    readonly latest: CacheRequestMetrics;
}

/** Measured prompt-cache health after the expected first cold request. */
export interface MeasuredCacheHealth {
    readonly state: 'measured';
    readonly grade: 'healthy' | 'partial' | 'cold';
    readonly requestCount: number;
    readonly recentRequestCount: number;
    readonly latest: CacheRequestMetrics;
    readonly recentHitPercent: number;
    readonly consecutiveColdRequests: number;
}

/** Prompt-cache state for the current model segment since the latest context reset. */
export type CacheHealth =
    | WaitingCacheHealth
    | WarmingCacheHealth
    | UnavailableCacheHealth
    | MeasuredCacheHealth;

function normalizeTokenCount(value: number) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function createCacheRequestMetrics(sample: CacheUsageSample): CacheRequestMetrics {
    const input = normalizeTokenCount(sample.input);
    const cacheReadTokens = normalizeTokenCount(sample.cacheRead);
    const cacheWrite = normalizeTokenCount(sample.cacheWrite);
    const promptTokens = input + cacheReadTokens + cacheWrite;

    return {
        promptTokens,
        cacheReadTokens,
        freshTokens: input + cacheWrite,
        hitPercent: promptTokens > 0 ? (cacheReadTokens / promptTokens) * 100 : 0,
    };
}

function selectCacheHealthGrade(hitPercent: number): MeasuredCacheHealth['grade'] {
    if (hitPercent >= HEALTHY_CACHE_HIT_PERCENT) return 'healthy';
    if (hitPercent >= PARTIAL_CACHE_HIT_PERCENT) return 'partial';
    return 'cold';
}

/** Calculates latest and recent weighted prompt-cache hit rates for one uninterrupted model segment. */
export function calculateCacheHealth(samples: ReadonlyArray<CacheUsageSample>): CacheHealth {
    if (samples.length === 0) return { state: 'waiting' };

    const requests = samples.map(createCacheRequestMetrics);
    const latest = requests[requests.length - 1];
    if (!latest) return { state: 'waiting' };

    if (requests.length === 1) {
        return { state: 'warming', requestCount: 1, latest };
    }

    const cacheActivityReported = samples.some(
        (sample) => normalizeTokenCount(sample.cacheRead) + normalizeTokenCount(sample.cacheWrite) > 0,
    );
    if (!cacheActivityReported) {
        return { state: 'unavailable', requestCount: requests.length, latest };
    }

    // The first request after a new session, compaction, branch change, or model switch is expected to be cold.
    const recentRequests = requests.slice(1).slice(-RECENT_REQUEST_LIMIT);
    const recentPromptTokens = recentRequests.reduce((total, request) => total + request.promptTokens, 0);
    const recentCacheReadTokens = recentRequests.reduce((total, request) => total + request.cacheReadTokens, 0);
    const recentHitPercent = recentPromptTokens > 0 ? (recentCacheReadTokens / recentPromptTokens) * 100 : 0;

    let consecutiveColdRequests = 0;
    for (let index = recentRequests.length - 1; index >= 0; index -= 1) {
        const request = recentRequests[index];
        if (!request || request.hitPercent >= PARTIAL_CACHE_HIT_PERCENT) break;
        consecutiveColdRequests += 1;
    }

    return {
        state: 'measured',
        grade: selectCacheHealthGrade(latest.hitPercent),
        requestCount: requests.length,
        recentRequestCount: recentRequests.length,
        latest,
        recentHitPercent,
        consecutiveColdRequests,
    };
}

/** Formats a token count compactly for the cache-health footer. */
export function formatCacheTokenCount(tokens: number) {
    const normalizedTokens = Math.max(0, tokens);
    if (normalizedTokens < 1_000) return `${Math.round(normalizedTokens)}`;
    if (normalizedTokens < 10_000) return `${(normalizedTokens / 1_000).toFixed(1)}k`;
    if (normalizedTokens < 1_000_000) return `${Math.round(normalizedTokens / 1_000)}k`;
    return `${(normalizedTokens / 1_000_000).toFixed(1)}m`;
}

/** Formats the one-word prompt-cache state displayed in Pi's footer. */
export function formatCacheHealthStatus(cacheHealth: CacheHealth) {
    if (cacheHealth.state === 'waiting') return 'Waiting';
    if (cacheHealth.state === 'warming') return 'Warming';
    if (cacheHealth.state === 'unavailable') return 'Unknown';
    if (cacheHealth.grade === 'healthy') return 'Warm';
    if (cacheHealth.grade === 'partial') return 'Cooling';
    return 'Cold';
}

/** Formats the detailed cache report shown by the /cache command. */
export function formatCacheHealthReport(cacheHealth: CacheHealth, contextPercent: number | null) {
    const contextLine =
        contextPercent === null ? 'Context: unavailable' : `Context: ${contextPercent.toFixed(1)}% used`;

    if (cacheHealth.state === 'waiting') {
        return [
            'Cache: waiting for the first response from this model.',
            contextLine,
            'Decision: wait; a new session also starts cold.',
        ].join('\n');
    }

    if (cacheHealth.state === 'warming') {
        const promptTokens = formatCacheTokenCount(cacheHealth.latest.promptTokens);
        const freshTokens = formatCacheTokenCount(cacheHealth.latest.freshTokens);
        return [
            'Cache: warming after a session or context reset.',
            `Latest prompt: ${promptTokens} tokens (${freshTokens} fresh).`,
            contextLine,
            'Decision: wait for the next response before judging cache health.',
        ].join('\n');
    }

    if (cacheHealth.state === 'unavailable') {
        return [
            `Cache: this provider has not reported cache data across ${cacheHealth.requestCount} requests.`,
            contextLine,
            'Decision: use task boundaries and context pressure, because cache data cannot guide a reset.',
        ].join('\n');
    }

    const latest = cacheHealth.latest;
    const cachedTokens = formatCacheTokenCount(latest.cacheReadTokens);
    const promptTokens = formatCacheTokenCount(latest.promptTokens);
    const freshTokens = formatCacheTokenCount(latest.freshTokens);
    const measurements = [
        `Cache: ${cacheHealth.grade}.`,
        [
            `Latest: ${latest.hitPercent.toFixed(1)}% hit`,
            `(${cachedTokens} cached / ${promptTokens} prompt; ${freshTokens} fresh).`,
        ].join(' '),
        [
            `Recent: ${cacheHealth.recentHitPercent.toFixed(1)}% weighted across`,
            `${cacheHealth.recentRequestCount} requests.`,
        ].join(' '),
        contextLine,
    ];

    if (cacheHealth.grade === 'healthy') {
        measurements.push('Decision: keep this session; a new session would begin with a cold request.');
    } else if (cacheHealth.consecutiveColdRequests >= 2) {
        measurements.push(
            [
                'Decision: the cache has stayed cold, but reset only when the task changed',
                'or you can drop the current context.',
            ].join(' '),
        );
    } else {
        measurements.push('Decision: watch one more response; a single partial or cold request is not a reset signal.');
    }

    return measurements.join('\n');
}
