import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
    calculateCacheHealth,
    type CacheHealth,
    formatCacheHealthReport,
    formatCacheHealthStatus,
    type CacheUsageSample,
} from './cache-health-metrics.ts';

const CACHE_HEALTH_STATUS_ID = 'cache-health';

interface ModelCacheUsageSample extends CacheUsageSample {
    readonly modelKey: string;
}

function createModelKey(provider: string, model: string) {
    return `${provider}/${model}`;
}

function createAssistantCacheSample(message: AssistantMessage): ModelCacheUsageSample {
    return {
        modelKey: createModelKey(message.provider, message.model),
        input: message.usage.input,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
    };
}

function collectCurrentModelCacheSamples(ctx: ExtensionContext, pendingMessage?: AssistantMessage) {
    const activeModelKey = ctx.model
        ? createModelKey(ctx.model.provider, ctx.model.id)
        : pendingMessage
          ? createModelKey(pendingMessage.provider, pendingMessage.model)
          : null;
    let samples: ModelCacheUsageSample[] = [];

    for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === 'compaction' || entry.type === 'branch_summary' || entry.type === 'model_change') {
            samples = [];
            continue;
        }

        if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
        const sample = createAssistantCacheSample(entry.message);
        if (activeModelKey !== null && sample.modelKey !== activeModelKey) {
            samples = [];
            continue;
        }
        if (samples.length > 0 && samples[0]?.modelKey !== sample.modelKey) samples = [];
        samples.push(sample);
    }

    if (pendingMessage) {
        const pendingSample = createAssistantCacheSample(pendingMessage);
        if (activeModelKey === null || pendingSample.modelKey === activeModelKey) samples.push(pendingSample);
    }

    return samples;
}

function selectCacheHealthTone(cacheHealth: CacheHealth) {
    if (cacheHealth.state !== 'measured') return 'dim' as const;
    if (cacheHealth.grade === 'healthy') return 'success' as const;
    if (cacheHealth.grade === 'partial') return 'warning' as const;
    return 'error' as const;
}

function publishCacheHealthStatus(ctx: ExtensionContext, pendingMessage?: AssistantMessage) {
    const cacheHealth = calculateCacheHealth(collectCurrentModelCacheSamples(ctx, pendingMessage));
    const tone = selectCacheHealthTone(cacheHealth);
    ctx.ui.setStatus(CACHE_HEALTH_STATUS_ID, ctx.ui.theme.fg(tone, formatCacheHealthStatus(cacheHealth)));
}

/** Installs a local Pi cache-rate footer and the detailed /cache command. */
export default function cacheHealthExtension(pi: ExtensionAPI) {
    pi.on('session_start', (_event, ctx) => publishCacheHealthStatus(ctx));
    pi.on('model_select', (_event, ctx) => publishCacheHealthStatus(ctx));
    pi.on('session_compact', (_event, ctx) => publishCacheHealthStatus(ctx));
    pi.on('session_tree', (_event, ctx) => publishCacheHealthStatus(ctx));

    pi.on('message_end', (event, ctx) => {
        if (event.message.role !== 'assistant') return;
        publishCacheHealthStatus(ctx, event.message);
    });

    pi.registerCommand('cache', {
        description: 'Show prompt-cache hit rates and session reset guidance',
        handler: async (_args, ctx) => {
            const cacheHealth = calculateCacheHealth(collectCurrentModelCacheSamples(ctx));
            const contextPercent = ctx.getContextUsage()?.percent ?? null;
            ctx.ui.notify(formatCacheHealthReport(cacheHealth, contextPercent), 'info');
        },
    });

    pi.on('session_shutdown', (_event, ctx) => {
        ctx.ui.setStatus(CACHE_HEALTH_STATUS_ID, undefined);
    });
}
