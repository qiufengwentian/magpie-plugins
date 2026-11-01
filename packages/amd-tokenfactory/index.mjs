/**
 * magpie provider plugin: AMD TokenFactory (Radeon Cloud).
 *
 * Provider id: amd
 * API base:   https://developer.amd.com.cn/radeon/api/v1
 *
 * The plugin is intentionally dependency-free. It implements only the public
 * magpie provider hooks: config, provider.models and auth.
 */

import { createHash } from "node:crypto";

const PROVIDER_ID = "amd";
const PROVIDER_NAME = "AMD TokenFactory";
const OPENAI_NPM = "@ai-sdk/openai-compatible";
const DEFAULT_BASE_URL = "https://developer.amd.com.cn/radeon/api/v1";
const DEFAULT_LOAD_URL = "https://developer.amd.com.cn/radeon/api/tokenfactory/load";

const CATALOG_TTL_MS = 10 * 60 * 1000;
const FLEET_TTL_MS = 5 * 60 * 1000;
const FLEET_TIMEOUT_MS = 30 * 1000;

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;

const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 5 * 1000;
const PROBE_BUDGET_MS = 10 * 1000;
const PROBE_MAX_RETRY_DELAY_MS = 1000;

const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_OUTPUT_TOKENS = 65536;
const THINKING_MIN_OUTPUT_TOKENS = 16384;

const DROPPED_PARAMS = ["stop", "seed", "logit_bias", "logprobs", "top_logprobs", "n", "user"];

const THINKING_MODEL_ID_PATTERNS = [
  /(^|[/_-])deepseek-r1([/_-]|$)/i,
  /(^|[/_-])deepseek-v4([/_-]|$)/i,
  /(^|[/_-])kimi-k\d([.\/_-]|$)/i,
  /(^|[/_-])glm-5([.\/_-]|$)/i,
  /(^|[/_-])gpt-oss([/_-]|$)/i,
  /(^|[/_-])minimax-m3([/_-]|$)/i,
  /(^|[/_-])nemotron-3([/_-]|$)/i,
  /(^|[/_-])nemotron-super([/_-]|$)/i,
  /(^|[/_-])cosmos-reason\d*([/_-]|$)/i,
  /(^|[/_-])qwq([/_-]|$)/i,
];

const NON_CHAT_MODEL_ID_PATTERNS = [
  /(^|[/_-])d3(?:-flash)?([-_/]|$)/i,
  /(^|[/_-])clef([-_/]|$)/i,
  /(^|[/_-])omnivoice([-_/]|$)/i,
  /(^|[/_-])mineru2(?:[.-]5)?-pro([-_/]|$)/i,
  /(^|[/_-])bge([-_/]|$)/i,
  /(^|[/_-])(clip|detector|embed|embedcode|embedqa|embedding|gliner|parse|rerank|retriever|reward)([-_/]|$)/i,
  /(^|[/_-])nv(clip|embed|embedcode|embedqa|retriever|rerank)([-_/]|$)/i,
  /(^|[/_-])(guard|safety|nemoguard)([-_/]|$)/i,
  /(^|[/_-])(codegemma|codellama|starcoder\d*)([-_/]|$)/i,
  /(^|[/_-])llama2([-_/]|$)/i,
  /(^|[/_-])(gemma-2b|recurrentgemma|diffusiongemma)([-_/]|$)/i,
  /(^|[/_-])(riva|translate|calibration)([-_/]|$)/i,
];

function trimSlash(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function resolveBaseUrl(provider) {
  const api = provider?.api;
  const fromProvider = typeof api === "string" ? api : typeof api?.url === "string" ? api.url : "";
  return trimSlash(fromProvider) || trimSlash(process.env.AMD_TOKENFACTORY_BASE_URL) || DEFAULT_BASE_URL;
}

function resolveLoadUrl() {
  return trimSlash(process.env.AMD_TOKENFACTORY_LOAD_URL) || DEFAULT_LOAD_URL;
}

function envDurationMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pickPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function deriveDisplayName(modelId) {
  const lastSegment = modelId.split("/").at(-1);
  return lastSegment && lastSegment.length > 0 ? lastSegment : modelId;
}

function isThinkingModelId(modelId) {
  return THINKING_MODEL_ID_PATTERNS.some((pattern) => pattern.test(modelId));
}

function isNonChatModelId(modelId) {
  return NON_CHAT_MODEL_ID_PATTERNS.some((pattern) => pattern.test(modelId));
}

function isTextModality(value) {
  return typeof value === "string" && value.toLowerCase().includes("text");
}

function isTextChatModel(row) {
  if (!row || typeof row.id !== "string" || !row.id.trim()) return false;
  const input = row.architecture?.input_modalities;
  const output = row.architecture?.output_modalities;
  if (Array.isArray(input) && input.length > 0 && !input.some(isTextModality)) return false;
  if (Array.isArray(output) && output.length > 0 && !output.some(isTextModality)) return false;
  return !isNonChatModelId(row.id.trim());
}

function aggregateCapability(providers, field) {
  let seen = false;
  let supported = false;
  for (const provider of providers) {
    if (typeof provider?.[field] !== "boolean") continue;
    seen = true;
    if (provider[field]) supported = true;
  }
  return seen ? supported : undefined;
}

function normalizeCatalogModel(row, base) {
  if (!row || typeof row.id !== "string" || !row.id.trim()) return null;
  const id = row.id.trim();
  if (!isTextChatModel(row)) return null;

  const providers = Array.isArray(row.providers) ? row.providers : [];
  const baseCaps = isPlainObject(base?.capabilities) ? base.capabilities : {};
  const baseLimit = isPlainObject(base?.limit) ? base.limit : {};
  const inputModalities = Array.isArray(row.architecture?.input_modalities)
    ? row.architecture.input_modalities.map((value) => String(value).toLowerCase())
    : [];
  const apiVision = aggregateCapability(providers, "vision");
  const apiTools = aggregateCapability(providers, "tools");
  const apiReasoning = aggregateCapability(providers, "reasoning");

  let vision;
  if (apiVision !== undefined) vision = apiVision;
  else if (inputModalities.length > 0) vision = inputModalities.includes("image");
  else vision = baseCaps.attachment === true;

  const tools =
    apiTools !== undefined
      ? apiTools
      : typeof baseCaps.toolcall === "boolean"
        ? baseCaps.toolcall
        : true;
  const reasoning =
    apiReasoning !== undefined
      ? apiReasoning
      : typeof baseCaps.reasoning === "boolean"
        ? baseCaps.reasoning
        : isThinkingModelId(id);

  const context =
    pickPositiveNumber(row.context_length) ??
    pickPositiveNumber(baseLimit.context) ??
    DEFAULT_CONTEXT_WINDOW;
  const output =
    pickPositiveNumber(row.max_output_tokens) ??
    pickPositiveNumber(baseLimit.output) ??
    DEFAULT_MAX_OUTPUT_TOKENS;

  return {
    ...base,
    id,
    name:
      typeof row.name === "string" && row.name.trim()
        ? row.name.trim()
        : typeof base?.name === "string" && base.name.trim()
          ? base.name
          : deriveDisplayName(id),
    context,
    output,
    tools,
    vision,
    reasoning,
    free: row.free === true || base?.free === true,
    limit: { ...baseLimit, context, output },
    capabilities: {
      ...baseCaps,
      temperature: baseCaps.temperature !== false,
      reasoning,
      attachment: vision,
      toolcall: tools,
      input: {
        ...(isPlainObject(baseCaps.input) ? baseCaps.input : {}),
        text: true,
        image: vision,
      },
      output: {
        ...(isPlainObject(baseCaps.output) ? baseCaps.output : {}),
        text: true,
      },
      interleaved: baseCaps.interleaved === true,
    },
  };
}

function catalogRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function parseCatalogModels(payload, baseModels) {
  const rows = catalogRows(payload);
  const baseById = isPlainObject(baseModels) ? baseModels : {};
  const models = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== "string") continue;
    const id = row.id.trim();
    if (!id || seen.has(id)) continue;
    const model = normalizeCatalogModel(row, isPlainObject(baseById[id]) ? baseById[id] : {});
    if (!model) continue;
    seen.add(id);
    models.push(model);
  }
  return models;
}

function runtimeModel(provider, model, baseURL) {
  const base = isPlainObject(provider?.models?.[model.id]) ? provider.models[model.id] : {};
  const baseCaps = isPlainObject(base.capabilities) ? base.capabilities : {};
  const baseInput = isPlainObject(baseCaps.input) ? baseCaps.input : {};
  const baseOutput = isPlainObject(baseCaps.output) ? baseCaps.output : {};
  const baseApi = isPlainObject(base.api) ? base.api : {};

  return {
    ...base,
    id: model.id,
    name: model.name || base.name || model.id,
    api: {
      ...baseApi,
      id: model.id,
      url: baseURL,
      npm: OPENAI_NPM,
    },
    limit: {
      ...(isPlainObject(base.limit) ? base.limit : {}),
      context: model.context,
      output: model.output,
    },
    capabilities: {
      temperature: baseCaps.temperature !== false,
      reasoning: model.reasoning === true,
      attachment: model.vision === true,
      toolcall: model.tools !== false,
      input: {
        ...baseInput,
        text: true,
        image: model.vision === true,
        audio: baseInput.audio === true,
        video: baseInput.video === true,
        pdf: baseInput.pdf === true,
      },
      output: {
        ...baseOutput,
        text: true,
        image: baseOutput.image === true,
        audio: baseOutput.audio === true,
        video: baseOutput.video === true,
        pdf: baseOutput.pdf === true,
      },
      interleaved: baseCaps.interleaved === true,
    },
    ...(model.free || base.free === true ? { free: true } : {}),
    ...(model.reasoning
      ? {
          variants:
            isPlainObject(base.variants) && Object.keys(base.variants).length > 0
              ? base.variants
              : { low: {}, medium: {}, high: {} },
        }
      : {}),
  };
}

function splitKeysInput(raw) {
  const keys = [];
  for (const piece of String(raw ?? "").split(/[\n,，;；]+/)) {
    const key = piece.trim();
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function parseKeyPool(access) {
  const raw = typeof access === "string" ? access.trim() : "";
  if (!raw) return [];
  if (!raw.startsWith("[")) return [raw];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [raw];
    const keys = [];
    for (const entry of parsed) {
      const key = typeof entry === "string" ? entry.trim() : "";
      if (key && !keys.includes(key)) keys.push(key);
    }
    return keys;
  } catch {
    return [raw];
  }
}

function serializeKeyPool(keys) {
  return JSON.stringify([...keys]);
}

function maskApiKey(key) {
  const trimmed = String(key ?? "").trim();
  if (trimmed.length <= 12) return "********";
  return trimmed.slice(0, 7) + "..." + trimmed.slice(-4);
}

function hashKeys(keys) {
  return createHash("sha256").update(keys.join("\n")).digest("hex");
}

function cacheKeyOf(baseURL, keys) {
  return trimSlash(baseURL) + "|" + hashKeys(keys);
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(status);
}

function getRetryAfterMs(response) {
  const raw = response?.headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const dateValue = Date.parse(raw);
  if (!Number.isFinite(dateValue)) return undefined;
  const delta = dateValue - Date.now();
  return delta > 0 ? delta : undefined;
}

function calculateRetryDelay(attempt, retryAfter, maxDelayMs = MAX_RETRY_DELAY_MS) {
  if (retryAfter !== undefined && retryAfter > 0) {
    return Math.min(Math.round(retryAfter * (0.9 + Math.random() * 0.2)), maxDelayMs);
  }
  const exponential = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  return Math.round(Math.random() * Math.min(exponential, maxDelayMs));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // A response body may already be consumed or locked; cancellation is best effort.
  }
}

async function fetchWithRetry(url, init = {}, maxRetryDelayMs = MAX_RETRY_DELAY_MS) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);
      if (!isRetryableStatus(response.status)) return response;
      lastError = gatewayError(response.status, "HTTP " + response.status);
      if (attempt === MAX_ATTEMPTS - 1) return response;
      const retryAfter = getRetryAfterMs(response);
      await cancelBody(response);
      await sleep(calculateRetryDelay(attempt, retryAfter, maxRetryDelayMs), init.signal);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(calculateRetryDelay(attempt, undefined, maxRetryDelayMs), init.signal);
      }
    }
  }
  throw lastError ?? gatewayError(502, "AMD TokenFactory 网络请求失败");
}

function gatewayError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function authError(message) {
  return Object.assign(gatewayError(401, message), { signIn: "expired" });
}

/**
 * Probe one API key with a single GET /models request. The verdict is decided by
 * the HTTP status only: 2xx alive, 401/403 invalid, everything else unverified.
 * Alive results carry the raw response so the model catalog can be reused later
 * without a second request.
 */
async function probeKey(key, baseURL) {
  const timeoutMs = envDurationMs("AMD_TOKENFACTORY_PROBE_TIMEOUT_MS", PROBE_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchWithRetry(
      trimSlash(baseURL) + "/models",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      },
      PROBE_MAX_RETRY_DELAY_MS,
    );
  } catch {
    return { key, state: "unknown" };
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  if (response.ok) return { key, state: "alive", status, response };
  await cancelBody(response);
  if (status === 401 || status === 403) return { key, state: "invalid", status };
  return { key, state: "unknown", status };
}

/**
 * Probe every key in the pool, keeping at most PROBE_CONCURRENCY requests in
 * flight. Results keep the input order. Keys that have not started when the
 * total budget runs out are reported as unverified without a request.
 */
async function probeKeys(keys, baseURL) {
  const results = new Array(keys.length);
  const deadline = Date.now() + envDurationMs("AMD_TOKENFACTORY_PROBE_BUDGET_MS", PROBE_BUDGET_MS);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < keys.length) {
      if (Date.now() >= deadline) {
        while (nextIndex < keys.length) {
          const index = nextIndex++;
          results[index] = { key: keys[index], state: "unknown" };
        }
        return;
      }
      const index = nextIndex++;
      results[index] = await probeKey(keys[index], baseURL);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, keys.length) }, worker));
  return results;
}

function summarizeFleetLoad(load) {
  if (!isPlainObject(load) || !load.models) return "";
  let entries;
  if (Array.isArray(load.models)) {
    entries = load.models.map((item, index) => ({
      name: item?.model ?? item?.name ?? String(index),
      item,
    }));
  } else if (isPlainObject(load.models)) {
    entries = Object.entries(load.models).map(([name, item]) => ({ name, item }));
  } else {
    return "";
  }
  if (entries.length === 0) return "";

  let available = 0;
  let busy = 0;
  let full = 0;
  const utilizations = [];
  for (const { item } of entries) {
    const state = String(item?.state ?? item?.status ?? "").toLowerCase();
    if (state === "idle" || state === "available") available++;
    else if (state === "busy") busy++;
    else if (state === "full" || state === "at capacity" || state === "at_capacity") full++;
    const utilization = Number(item?.utilization);
    if (Number.isFinite(utilization)) utilizations.push(utilization);
  }

  const parts = [
    "可用 " + available,
    "总数 " + entries.length,
    "Busy " + busy,
    "满载 " + full,
  ];
  if (utilizations.length > 0) {
    const average = utilizations.reduce((sum, value) => sum + value, 0) / utilizations.length;
    parts.push("平均利用率 " + Math.round(average * 10) / 10 + "%");
  }
  return parts.join(" · ");
}

function rewriteRequestBody(bodyText, reasoningModelIds) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return bodyText;

  const modelId = typeof body.model === "string" ? body.model : "";
  let changed = false;

  for (const key of DROPPED_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      delete body[key];
      changed = true;
    }
  }

  if (Array.isArray(body.messages)) {
    const reordered = systemFirst(body.messages);
    if (reordered !== body.messages) {
      body.messages = reordered;
      changed = true;
    }

    if (modelId && modelId.toLowerCase().includes("kimi")) {
      const patched = patchKimiReasoning(body.messages);
      if (patched !== body.messages) {
        body.messages = patched;
        changed = true;
      }
    }
  }

  if (modelId) {
    const isThinking =
      isThinkingModelId(modelId) || (reasoningModelIds instanceof Set && reasoningModelIds.has(modelId));
    if (
      isThinking &&
      typeof body.max_tokens === "number" &&
      body.max_tokens < THINKING_MIN_OUTPUT_TOKENS
    ) {
      body.max_tokens = THINKING_MIN_OUTPUT_TOKENS;
      changed = true;
    }
  }

  return changed ? JSON.stringify(body) : bodyText;
}

function systemFirst(messages) {
  let seenNonSystem = false;
  let needsReorder = false;
  const system = [];
  const rest = [];
  for (const message of messages) {
    if (message?.role === "system") {
      system.push(message);
      if (seenNonSystem) needsReorder = true;
    } else {
      seenNonSystem = true;
      rest.push(message);
    }
  }
  return needsReorder ? [...system, ...rest] : messages;
}

function patchKimiReasoning(messages) {
  let patched;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.reasoning_content) continue;
    patched ??= [...messages];
    patched[index] = { ...message, reasoning_content: " " };
  }
  return patched ?? messages;
}

/**
 * @param {{ client?: unknown }} [options]
 * @returns {Promise<object>}
 */
export const AmdPlugin = async ({ client } = {}) => {
  const catalogCache = new Map();
  const keyCursors = new Map();
  let reasoningModelIds = new Set();
  let configuredBaseUrl = "";
  let fleetCache;
  let fleetInFlight;

  const log = (message) => {
    try {
      void client?.app?.log?.({ body: { service: "amd", level: "info", message } })?.catch?.(() => {});
    } catch {
      // Logging must never break a provider request.
    }
  };

  const baseURLFor = (provider) => configuredBaseUrl || resolveBaseUrl(provider);

  const rotationOrder = (keys, auth) => {
    const identity = auth?.accountId || "pool:" + hashKeys(keys);
    const start = keyCursors.get(identity) ?? 0;
    const order = keys.map((_, index) => keys[(start + index) % keys.length]);
    keyCursors.set(identity, (start + 1) % Number.MAX_SAFE_INTEGER);
    return order;
  };

  const fetchCatalogPayload = async (keys, baseURL) => {
    const cacheKey = cacheKeyOf(baseURL, keys);
    const cached = catalogCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.payload;

    let lastError;
    let onlyAuthFailures = true;

    for (const key of keys) {
      let response;
      try {
        response = await fetchWithRetry(trimSlash(baseURL) + "/models", {
          method: "GET",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
          },
        });
      } catch (error) {
        onlyAuthFailures = false;
        lastError = gatewayError(502, "模型目录请求失败（网络错误）：" + (error?.message ?? error));
        continue;
      }

      if (response.ok) {
        let payload;
        try {
          payload = await response.json();
        } catch {
          onlyAuthFailures = false;
          lastError = gatewayError(502, "模型目录返回的 JSON 无法解析");
          await cancelBody(response);
          continue;
        }
        if (catalogRows(payload).length > 0) {
          catalogCache.set(cacheKey, { payload, fetchedAt: Date.now() });
          return payload;
        }
        onlyAuthFailures = false;
        lastError = gatewayError(502, "模型目录为空或格式无法识别");
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        lastError = authError("API Key 无效或已过期（HTTP " + response.status + "）");
        await cancelBody(response);
        continue;
      }

      onlyAuthFailures = false;
      lastError = gatewayError(response.status, "模型目录查询返回 HTTP " + response.status);
      await cancelBody(response);
    }

    if (onlyAuthFailures && keys.length > 0) {
      throw authError("所有 API Key 均无效或已过期，请重新登录");
    }
    throw lastError ?? gatewayError(502, "模型目录查询失败");
  };

  const probePool = async (keys, baseURL) => {
    const results = await probeKeys(keys, baseURL);
    const invalid = results.filter((result) => result.state === "invalid");
    const unknown = results.filter((result) => result.state === "unknown");
    const alive = results.filter((result) => result.state === "alive");

    if (alive.length === 0) {
      if (keys.length === 1) {
        const [only] = results;
        if (only.state === "invalid") {
          throw authError("API Key 无效或已过期（HTTP " + only.status + "）");
        }
        if (only.status !== undefined) {
          throw gatewayError(only.status, "key 校验失败：HTTP " + only.status);
        }
        throw gatewayError(502, "key 校验失败：超时或网络异常");
      }
      if (unknown.length === 0) {
        throw authError("所有 " + keys.length + " 个 API Key 均无效或已过期，请重新登录");
      }
      throw gatewayError(
        502,
        "key 探活失败：" +
          keys.length +
          " 个 key 均未通过（" +
          invalid.length +
          " 个无效，" +
          unknown.length +
          " 个未出结论）",
      );
    }

    const pool = results.filter((result) => result.state !== "invalid").map((result) => result.key);
    return { results, pool, invalid, unknown };
  };

  /**
   * Reuse the probe responses as the model catalog: parse the first alive body and
   * seed the catalog cache under the final pool, so opening the model picker right
   * after sign-in costs no extra request. Unused bodies are released and catalog
   * failures stay silent — sign-in never depends on the catalog being readable.
   */
  const warmCatalogCache = async (results, pool, baseURL) => {
    const alive = results.filter((result) => result.state === "alive");
    const [first, ...unused] = alive;
    await Promise.all(unused.map((result) => cancelBody(result.response)));
    if (!first) return;

    try {
      const payload = await first.response.json();
      if (catalogRows(payload).length > 0) {
        catalogCache.set(cacheKeyOf(baseURL, pool), { payload, fetchedAt: Date.now() });
      }
    } catch {
      // An unreadable catalog must not block sign-in; provider.models refetches on its own.
    }
  };

  const fetchFleetLoad = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FLEET_TIMEOUT_MS);
    try {
      const response = await fetch(resolveLoadUrl(), { signal: controller.signal });
      if (!response.ok) {
        throw gatewayError(response.status, "负载查询返回 HTTP " + response.status);
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw gatewayError(504, "负载查询超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const fleetSummary = async () => {
    if (fleetCache && Date.now() - fleetCache.fetchedAt < FLEET_TTL_MS) {
      return fleetCache.summary;
    }
    if (fleetInFlight) return fleetInFlight;

    const task = (async () => {
      const load = await fetchFleetLoad();
      const summary = summarizeFleetLoad(load);
      if (!summary) throw gatewayError(502, "Fleet 负载数据为空");
      fleetCache = { summary, fetchedAt: Date.now() };
      return summary;
    })();
    const current = task.finally(() => {
      if (fleetInFlight === current) fleetInFlight = undefined;
    });
    fleetInFlight = current;
    return current;
  };

  return {
    config: async (cfg) => {
      if (!cfg || typeof cfg !== "object") return;
      cfg.provider ??= {};
      const existing = cfg.provider[PROVIDER_ID];
      if (existing && typeof existing === "object") {
        configuredBaseUrl = resolveBaseUrl(existing);
        return;
      }
      configuredBaseUrl = resolveBaseUrl();
      cfg.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: OPENAI_NPM,
        api: configuredBaseUrl,
        models: {},
      };
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        const given = isPlainObject(provider) ? provider : {};
        const baseModels = isPlainObject(given.models) ? given.models : {};
        const keys = parseKeyPool(auth?.access);
        if (keys.length === 0) return baseModels;

        const baseURL = baseURLFor(given);
        try {
          const payload = await fetchCatalogPayload(keys, baseURL);
          const models = parseCatalogModels(payload, baseModels);
          if (models.length === 0) return baseModels;
          reasoningModelIds = new Set(models.filter((model) => model.reasoning).map((model) => model.id));
          return Object.fromEntries(
            models.map((model) => [model.id, runtimeModel(given, model, baseURL)]),
          );
        } catch (error) {
          if (error?.signIn === "expired") throw error;
          return baseModels;
        }
      },
    },

    auth: {
      provider: PROVIDER_ID,

      async loader(getAuth, provider) {
        const baseURL = baseURLFor(provider);

        return {
          baseURL,
          apiKey: "amd-tokenfactory-key",
          async fetch(input, init = {}) {
            const request = input instanceof Request ? new Request(input, init) : null;
            const bodySource = request ? request.body : init.body;
            const rawBody =
              bodySource == null
                ? ""
                : typeof bodySource === "string"
                  ? bodySource
                  : await new Response(bodySource).text();
            const bodyText = rawBody ? rewriteRequestBody(rawBody, reasoningModelIds) : "";

            let auth;
            try {
              auth = await getAuth();
            } catch {
              throw authError("AMD TokenFactory 账号认证信息不可用，请重新登录");
            }
            const keys = parseKeyPool(auth?.access);
            if (keys.length === 0) {
              throw authError("AMD TokenFactory 账号缺少 API Key，请重新登录");
            }

            const headers = new Headers(request ? request.headers : init.headers);
            for (const key of ["authorization", "x-api-key", "content-length"]) {
              headers.delete(key);
            }
            headers.set("Content-Type", "application/json");

            const order = rotationOrder(keys, auth);
            let lastResponse;
            for (let index = 0; index < order.length; index++) {
              headers.set("Authorization", "Bearer " + order[index]);
              let response;
              try {
                response = await fetch(request ? request.url : input, {
                  ...init,
                  method: init.method ?? request?.method ?? "POST",
                  headers,
                  body: bodyText || undefined,
                  signal: init.signal ?? request?.signal,
                });
              } catch (error) {
                if (init.signal?.aborted || request?.signal?.aborted) throw error;
                throw gatewayError(502, "AMD TokenFactory 请求失败（网络错误）");
              }
              lastResponse = response;
              if (![401, 403, 429].includes(response.status) || index === order.length - 1) {
                return response;
              }
              await cancelBody(response);
            }
            return lastResponse;
          },
        };
      },

      async usage(getAuth) {
        let auth = {};
        try {
          auth = (await getAuth()) ?? {};
        } catch {
          // Usage is display-only; a missing auth record must not break the UI.
        }
        const keys = parseKeyPool(auth?.access);
        const windows = [
          {
            name: "API keys",
            display: keys.length + " 个",
            unit: "个",
            aside: true,
          },
        ];

        try {
          windows.push({ name: "Fleet 负载", display: await fleetSummary(), aside: true });
        } catch {
          windows.push({ name: "Fleet 负载", display: "负载暂不可用", aside: true });
        }

        return {
          plan: "Free",
          ...(auth?.accountId ? { user: auth.accountId } : {}),
          windows,
        };
      },

      methods: [
        {
          type: "oauth",
          label: "粘贴 API key（可一次粘贴多个，逗号/换行/分号分隔）",
          prompts: [
            {
              type: "password",
              key: "keys",
              message: "AMD TokenFactory API key（在 https://developer.amd.com.cn/radeon/tokenfactory 申请）",
              placeholder: "多个 key 用逗号或换行分隔",
            },
            {
              type: "text",
              key: "note",
              message: "备注名（可选）",
              placeholder: "例如 主力号",
              validate: () => undefined,
            },
          ],
          authorize: async (inputs) => {
            const keys = splitKeysInput(inputs?.keys);
            if (keys.length === 0) {
              throw gatewayError(400, "请至少填写一个 AMD TokenFactory API Key");
            }
            const baseURL = configuredBaseUrl || resolveBaseUrl();
            const { results, pool, invalid, unknown } = await probePool(keys, baseURL);
            await warmCatalogCache(results, pool, baseURL);

            const note = String(inputs?.note ?? "").trim();
            const accountId =
              note || "AMD " + maskApiKey(pool[0]) + (pool.length > 1 ? " +" + (pool.length - 1) : "");
            log(
              "已配置 " +
                pool.length +
                " 个 API key（剔除 " +
                invalid.length +
                " 个，未验证 " +
                unknown.length +
                " 个）",
            );

            const detail = [
              invalid.length > 0 ? invalid.length + " 个无效已剔除" : "",
              unknown.length > 0 ? unknown.length + " 个未验证" : "",
            ].filter(Boolean);

            return {
              url: "",
              method: "auto",
              instructions:
                keys.length > 1
                  ? "已配置 " +
                    pool.length +
                    " 个 AMD TokenFactory API key，请求将轮换使用。" +
                    (detail.length > 0 ? "（" + detail.join("，") + "）" : "")
                  : "已配置 AMD TokenFactory API key（" + maskApiKey(pool[0]) + "）。",
              callback: async () => ({
                type: "success",
                access: serializeKeyPool(pool),
                refresh: "",
                accountId,
              }),
            };
          },
        },
      ],
    },
  };
};

export default AmdPlugin;
