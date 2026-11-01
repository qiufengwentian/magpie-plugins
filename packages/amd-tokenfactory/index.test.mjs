import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import http from "node:http";

import { AmdPlugin } from "./index.mjs";

const BASE_MODELS = {
  "DeepSeek-V4-Flash": {
    id: "DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash from models.dev",
    limit: { context: 1000, output: 2000 },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0 },
  },
};

function clone(value) {
  return structuredClone(value);
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function makeProvider(models = {}) {
  return {
    id: "amd",
    name: "AMD Token Factory",
    api: baseUrl,
    models: clone(models),
  };
}

function makeAuth(keys, accountId = "acct-1") {
  return { access: JSON.stringify(keys), accountId };
}

async function makePlugin() {
  const plugin = await AmdPlugin({
    client: { app: { log: async () => undefined } },
  });
  const config = {};
  await plugin.config(config);
  return { plugin, config };
}

async function startLogin(plugin, inputs) {
  const method = plugin.auth.methods[0];
  const start = await method.authorize(inputs);
  assert.equal(typeof start.callback, "function");
  return start;
}

async function login(plugin, inputs) {
  return (await startLogin(plugin, inputs)).callback();
}

async function loginFailure(plugin, inputs) {
  try {
    await login(plugin, inputs);
  } catch (error) {
    return error;
  }
  assert.fail("expected login to fail");
}

async function makeLoader(plugin, provider, keys, accountId = "acct-1") {
  return plugin.auth.loader(async () => makeAuth(keys, accountId), provider);
}

let server;
let baseUrl;
let handler;
let requests = [];

const defaultHandler = (req, res) => {
  sendJson(res, 404, { error: "not found" });
};

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    };
    requests.push(record);
    try {
      await handler(req, res, record);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: String(error) });
      else res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = "http://127.0.0.1:" + server.address().port;
  process.env.AMD_TOKENFACTORY_BASE_URL = baseUrl;
  process.env.AMD_TOKENFACTORY_LOAD_URL = baseUrl + "/tokenfactory/load";
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  handler = defaultHandler;
});

describe("config", () => {
  it("空配置时写入 AMD 默认供应商", async () => {
    const { plugin } = await makePlugin();
    const cfg = {};
    await plugin.config(cfg);
    assert.equal(cfg.provider.amd.name, "AMD TokenFactory");
    assert.equal(cfg.provider.amd.npm, "@ai-sdk/openai-compatible");
    assert.equal(cfg.provider.amd.api, baseUrl);
    assert.deepEqual(cfg.provider.amd.models, {});
  });

  it("已有 amd 配置不被覆盖", async () => {
    const { plugin } = await makePlugin();
    const existing = {
      name: "Custom AMD",
      api: "https://example.test/v1",
      models: { custom: { id: "custom" } },
    };
    const cfg = { provider: { amd: existing } };
    await plugin.config(cfg);
    assert.strictEqual(cfg.provider.amd, existing);
  });
});

describe("登录与 API Key 池", () => {
  it("单 key 登录只探活一次，并保存 JSON 数组", async () => {
    handler = (req, res) => {
      assert.equal(req.url, "/models");
      assert.equal(req.headers.authorization, "Bearer key-1234567890");
      sendJson(res, 200, { data: [{ id: "m1" }] });
    };
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: "key-1234567890" });
    assert.equal(result.type, "success");
    assert.deepEqual(JSON.parse(result.access), ["key-1234567890"]);
    assert.equal(result.refresh, "");
    assert.match(result.accountId, /^AMD key-123/);
    assert.ok(!result.accountId.includes("1234567890"));
    assert.equal(requests.length, 1);
  });

  it("多 key 支持逗号、换行、分号并去重", async () => {
    handler = (req, res) => sendJson(res, 200, { data: [{ id: "m1" }] });
    const { plugin } = await makePlugin();
    const result = await login(plugin, {
      keys: " key-a ,\nkey-a; key-b，key-b ",
      note: "主力号",
    });
    assert.deepEqual(JSON.parse(result.access), ["key-a", "key-b"]);
    assert.equal(result.accountId, "主力号");
    assert.equal(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.headers.authorization).sort(),
      ["Bearer key-a", "Bearer key-b"],
    );
  });

  it("401/403 提示 API Key 无效或已过期", async () => {
    handler = (req, res) => sendJson(res, 401, { error: "invalid" });
    const { plugin } = await makePlugin();
    await assert.rejects(
      () => login(plugin, { keys: "bad-key" }),
      (error) => {
        assert.equal(error.signIn, "expired");
        assert.match(error.message, /API Key 无效或已过期/);
        return true;
      },
    );
  });

  it("登录遇到 5xx 提示网关错误", async () => {
    handler = (req, res) => sendJson(res, 500, { error: "gateway" });
    const { plugin } = await makePlugin();
    await assert.rejects(
      () => login(plugin, { keys: "key-a" }),
      (error) => {
        assert.match(error.message, /key 校验失败：HTTP 500/);
        assert.notEqual(error.signIn, "expired");
        return true;
      },
    );
  });

  it("429/502/503/504 最多 3 次尝试并尊重 Retry-After", async () => {
    let attempts = 0;
    handler = (req, res) => {
      attempts++;
      if (attempts < 3) {
        sendJson(res, 503, { error: "busy" }, { "retry-after": "1" });
        return;
      }
      sendJson(res, 200, { data: [{ id: "m1" }] });
    };
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: "key-a" });
    assert.equal(result.type, "success");
    assert.equal(attempts, 3);
  });

  it("空 key 输入被拒绝", async () => {
    const { plugin } = await makePlugin();
    await assert.rejects(
      () => login(plugin, { keys: " , ; " }),
      (error) => {
        assert.match(error.message, /至少填写一个/);
        return true;
      },
    );
  });
});

describe("登录探活", () => {
  const KEY_A = "key-aaaa-1111-1111";
  const KEY_B = "key-bbbb-2222-2222";
  const KEY_C = "key-cccc-3333-3333";
  const MASK_A = "key-aaa...1111";

  const probeHandler = (statusByKey) => (req, res) => {
    const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    const status = statusByKey[key] ?? 200;
    if (status === 200) sendJson(res, 200, { data: [{ id: "m1" }] });
    else sendJson(res, status, { error: "HTTP " + status });
  };

  const probeCountOf = (key) =>
    requests.filter((request) => request.headers.authorization === "Bearer " + key).length;

  it("3 个 key 全部可用时各探活一次并全部入池", async () => {
    handler = probeHandler({});
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: [KEY_A, KEY_B, KEY_C].join(",") });

    assert.deepEqual(JSON.parse(result.access), [KEY_A, KEY_B, KEY_C]);
    assert.equal(requests.length, 3);
    assert.equal(
      requests.every((request) => request.url === "/models"),
      true,
    );
    assert.equal(probeCountOf(KEY_A), 1);
    assert.equal(probeCountOf(KEY_B), 1);
    assert.equal(probeCountOf(KEY_C), 1);
  });

  it("第一个 key 401、第二个可用时登录成功并只保留第二个", async () => {
    handler = probeHandler({ [KEY_A]: 401 });
    const { plugin } = await makePlugin();
    const start = await startLogin(plugin, { keys: KEY_A + "," + KEY_B });
    const result = await start.callback();

    assert.deepEqual(JSON.parse(result.access), [KEY_B]);
    assert.equal(requests.length, 2);
    assert.match(start.instructions, /（1 个无效已剔除）/);
    assert.match(result.accountId, /key-bbb/);
    assert.equal(result.accountId.includes("1111"), false);
  });

  it("中间 key 无效时入池保持用户输入顺序", async () => {
    handler = probeHandler({ [KEY_B]: 401 });
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: [KEY_A, KEY_B, KEY_C].join(",") });

    assert.deepEqual(JSON.parse(result.access), [KEY_A, KEY_C]);
    assert.equal(requests.length, 3);
  });

  it("3 个 key 全部 401 时登录失效且不写凭据", async () => {
    const { plugin } = await makePlugin();
    handler = probeHandler({});
    const existing = await login(plugin, { keys: KEY_A });

    handler = probeHandler({ [KEY_A]: 401, [KEY_B]: 401, [KEY_C]: 401 });
    requests = [];
    let credential;
    await assert.rejects(
      async () => {
        credential = await login(plugin, { keys: [KEY_A, KEY_B, KEY_C].join(",") });
      },
      (error) => {
        assert.equal(error.signIn, "expired");
        assert.match(error.message, /所有 3 个 API Key 均无效或已过期/);
        return true;
      },
    );
    assert.equal(credential, undefined);
    assert.equal(requests.length, 3);
    assert.deepEqual(JSON.parse(existing.access), [KEY_A]);
  });

  it("一个可用加一个持续限流时两个都保留并提示未验证", async () => {
    handler = probeHandler({ [KEY_B]: 429 });
    const { plugin } = await makePlugin();
    const start = await startLogin(plugin, { keys: KEY_A + "," + KEY_B });
    const result = await start.callback();

    assert.deepEqual(JSON.parse(result.access), [KEY_A, KEY_B]);
    assert.match(start.instructions, /未验证/);
    assert.equal(probeCountOf(KEY_B), 3);
  });

  it("全部 502 时抛出网关错误并说明探活失败", async () => {
    handler = probeHandler({ [KEY_A]: 502, [KEY_B]: 502, [KEY_C]: 502 });
    const { plugin } = await makePlugin();
    await assert.rejects(
      () => login(plugin, { keys: [KEY_A, KEY_B, KEY_C].join(",") }),
      (error) => {
        assert.match(error.message, /key 探活失败/);
        assert.notEqual(error.signIn, "expired");
        return true;
      },
    );
    assert.equal(requests.length, 9);
  });

  it("账号名与提示按实际入池数量生成", async () => {
    handler = probeHandler({ [KEY_C]: 401 });
    const { plugin } = await makePlugin();
    const start = await startLogin(plugin, { keys: [KEY_A, KEY_B, KEY_C].join(",") });
    const result = await start.callback();

    assert.deepEqual(JSON.parse(result.access), [KEY_A, KEY_B]);
    assert.equal(result.accountId, "AMD " + MASK_A + " +1");
    assert.equal(
      start.instructions,
      "已配置 2 个 AMD TokenFactory API key，请求将轮换使用。（1 个无效已剔除）",
    );
  });

  it("探活并发上限为 4", async () => {
    let inFlight = 0;
    let peak = 0;
    handler = async (req, res) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight--;
      sendJson(res, 200, { data: [{ id: "m1" }] });
    };
    const keys = Array.from({ length: 6 }, (_, index) => "key-" + index + "-abcdefghijkl");
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: keys.join(",") });

    assert.equal(JSON.parse(result.access).length, 6);
    assert.equal(requests.length, 6);
    assert.equal(peak, 4);
  });

  it("单 key 场景的四条错误文案与成功提示保持原样", async () => {
    for (const status of [401, 403]) {
      handler = (req, res) => sendJson(res, status, { error: "invalid" });
      const { plugin } = await makePlugin();
      const error = await loginFailure(plugin, { keys: KEY_A });
      assert.equal(error.message, "API Key 无效或已过期（HTTP " + status + "）");
      assert.equal(error.signIn, "expired");
    }

    handler = (req, res) => sendJson(res, 500, { error: "gateway" });
    let { plugin } = await makePlugin();
    let error = await loginFailure(plugin, { keys: KEY_A });
    assert.equal(error.message, "key 校验失败：HTTP 500");
    assert.notEqual(error.signIn, "expired");

    handler = (req) => {
      req.socket.destroy();
    };
    ({ plugin } = await makePlugin());
    error = await loginFailure(plugin, { keys: KEY_A });
    assert.equal(error.message, "key 校验失败：超时或网络异常");

    ({ plugin } = await makePlugin());
    error = await loginFailure(plugin, { keys: " , ; " });
    assert.equal(error.message, "请至少填写一个 AMD TokenFactory API Key");

    handler = (req, res) => sendJson(res, 200, { data: [{ id: "m1" }] });
    ({ plugin } = await makePlugin());
    const start = await startLogin(plugin, { keys: "key-1234567890" });
    assert.equal(start.instructions, "已配置 AMD TokenFactory API key（key-123...7890）。");
  });

  it("登录成功后立刻请求模型目录不再产生网络请求", async () => {
    handler = probeHandler({});
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: KEY_A });
    const afterLogin = requests.length;

    const models = await plugin.provider.models(makeProvider(), {
      auth: { access: result.access, accountId: result.accountId },
    });

    assert.equal(models.m1.id, "m1");
    assert.equal(requests.length, afterLogin);
  });

  it("缓存键按最终入池的池计算，剔除无效 key 后仍能命中", async () => {
    handler = probeHandler({ [KEY_A]: 401 });
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: KEY_A + "," + KEY_B });
    const afterLogin = requests.length;

    const models = await plugin.provider.models(makeProvider(), {
      auth: { access: result.access, accountId: result.accountId },
    });

    assert.deepEqual(JSON.parse(result.access), [KEY_B]);
    assert.equal(models.m1.id, "m1");
    assert.equal(requests.length, afterLogin);
  });

  it("模型目录无法解析时登录仍然成功，且不写入坏缓存", async () => {
    handler = (req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("not-json");
    };
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: KEY_A });

    assert.deepEqual(JSON.parse(result.access), [KEY_A]);
    assert.equal(requests.length, 1);

    handler = probeHandler({});
    const models = await plugin.provider.models(makeProvider(), {
      auth: { access: result.access, accountId: result.accountId },
    });
    assert.equal(models.m1.id, "m1");
    assert.equal(requests.length, 2);
  });
});

describe("请求链路与网关兼容层", () => {
  it("注入 key、删除旧认证头并重写请求体", async () => {
    handler = (req, res) => sendJson(res, 200, { ok: true });
    const { plugin } = await makePlugin();
    const provider = makeProvider();
    const loader = await makeLoader(plugin, provider, ["key-a", "key-b"]);
    const response = await loader.fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer stale",
        "x-api-key": "stale",
        "x-keep": "yes",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "kimi-k2",
        max_tokens: 100,
        stop: ["x"],
        seed: 1,
        logit_bias: { a: 1 },
        logprobs: true,
        top_logprobs: 2,
        n: 2,
        user: "u",
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "system" },
          { role: "assistant", content: "old" },
          { role: "assistant", content: "old2", reasoning_content: "exists" },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    const sent = requests[0];
    assert.equal(sent.headers.authorization, "Bearer key-a");
    assert.equal(sent.headers["x-api-key"], undefined);
    assert.equal(sent.headers["x-keep"], "yes");
    const body = JSON.parse(sent.body);
    for (const key of ["stop", "seed", "logit_bias", "logprobs", "top_logprobs", "n", "user"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(body, key), false);
    }
    assert.equal(body.max_tokens, 16384);
    assert.deepEqual(body.messages.map((message) => message.role), ["system", "user", "assistant", "assistant"]);
    assert.equal(body.messages[2].reasoning_content, " ");
    assert.equal(body.messages[3].reasoning_content, "exists");
  });

  it("thinking 模型原本没有 max_tokens 时不新增", async () => {
    handler = (req, res) => sendJson(res, 200, { ok: true });
    const { plugin } = await makePlugin();
    const loader = await makeLoader(plugin, makeProvider(), ["key-a"]);
    await loader.fetch(baseUrl + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "deepseek-v4", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = JSON.parse(requests[0].body);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "max_tokens"), false);
  });

  it("坏 JSON 原样转发", async () => {
    handler = (req, res) => sendJson(res, 200, { ok: true });
    const { plugin } = await makePlugin();
    const loader = await makeLoader(plugin, makeProvider(), ["key-a"]);
    await loader.fetch(baseUrl + "/chat/completions", {
      method: "POST",
      body: "{not json",
    });
    assert.equal(requests[0].body, "{not json");
  });

  it("5xx 不切换 key", async () => {
    handler = (req, res) => sendJson(res, 500, { error: "boom" });
    const { plugin } = await makePlugin();
    const loader = await makeLoader(plugin, makeProvider(), ["key-a", "key-b"]);
    const response = await loader.fetch(baseUrl + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m1", messages: [] }),
    });
    assert.equal(response.status, 500);
    assert.equal(requests.length, 1);
  });

  it("401/403/429 切换 key，且全部失败返回最后一个响应", async () => {
    for (const status of [401, 403, 429]) {
      requests = [];
      handler = (req, res) => {
        if (req.headers.authorization === "Bearer key-a") {
          sendJson(res, status, { error: "fail" });
        } else {
          sendJson(res, 200, { ok: true });
        }
      };
      const { plugin } = await makePlugin();
      const loader = await makeLoader(plugin, makeProvider(), ["key-a", "key-b"]);
      const response = await loader.fetch(baseUrl + "/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m1", messages: [] }),
      });
      assert.equal(response.status, 200);
      assert.equal(requests.length, 2);
      assert.equal(requests[1].headers.authorization, "Bearer key-b");
    }

    requests = [];
    handler = (req, res) => {
      if (req.headers.authorization === "Bearer key-a") sendJson(res, 401, { error: "a" });
      else sendJson(res, 429, { error: "b" });
    };
    const { plugin } = await makePlugin();
    const loader = await makeLoader(plugin, makeProvider(), ["key-a", "key-b"]);
    const response = await loader.fetch(baseUrl + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m1", messages: [] }),
    });
    assert.equal(response.status, 429);
    assert.equal(requests.length, 2);
  });

  it("每个账号独立轮询 key", async () => {
    handler = (req, res) => sendJson(res, 200, { ok: true });
    const { plugin } = await makePlugin();
    const loader = await makeLoader(plugin, makeProvider(), ["key-a", "key-b"], "acct-1");
    await loader.fetch(baseUrl + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m1", messages: [] }),
    });
    await loader.fetch(baseUrl + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m1", messages: [] }),
    });
    assert.equal(requests[0].headers.authorization, "Bearer key-a");
    assert.equal(requests[1].headers.authorization, "Bearer key-b");
  });

  it("空 key 池时 loader 抛出可重登录错误", async () => {
    const { plugin } = await makePlugin();
    const loader = await makeLoader(plugin, makeProvider(), []);
    await assert.rejects(
      () => loader.fetch(baseUrl + "/chat/completions", { method: "POST", body: "{}" }),
      (error) => {
        assert.equal(error.signIn, "expired");
        assert.match(error.message, /缺少 API Key/);
        return true;
      },
    );
  });
});

describe("模型目录", () => {
  it("合并 models.dev、覆盖 API 字段并过滤非文本聊天模型", async () => {
    handler = (req, res) =>
      sendJson(res, 200, {
        data: [
          {
            id: "DeepSeek-V4-Flash",
            name: "DeepSeek API",
            context_length: 5000,
            max_output_tokens: 12345,
            free: true,
            providers: [{ tools: true, vision: false, reasoning: true }],
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          },
          {
            id: "plain-model",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          },
          {
            id: "image-only",
            architecture: { input_modalities: ["image"], output_modalities: ["text"] },
          },
          {
            id: "audio-output",
            architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
          },
          { id: "bge-embed", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
          {
            id: "DeepSeek-V4-Flash",
            name: "duplicate",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          },
        ],
      });
    const { plugin } = await makePlugin();
    const provider = makeProvider(BASE_MODELS);
    const models = await plugin.provider.models(provider, { auth: makeAuth(["key-a"]) });

    assert.equal(models["DeepSeek-V4-Flash"].name, "DeepSeek API");
    assert.equal(models["DeepSeek-V4-Flash"].limit.context, 5000);
    assert.equal(models["DeepSeek-V4-Flash"].limit.output, 12345);
    assert.equal(models["DeepSeek-V4-Flash"].capabilities.toolcall, true);
    assert.equal(models["DeepSeek-V4-Flash"].capabilities.attachment, false);
    assert.equal(models["DeepSeek-V4-Flash"].free, true);
    assert.equal(models["DeepSeek-V4-Flash"].api.url, baseUrl);
    assert.equal(models["plain-model"].limit.context, 131072);
    assert.equal(models["plain-model"].limit.output, 65536);
    assert.equal(models["plain-model"].capabilities.toolcall, true);
    assert.equal(models["image-only"], undefined);
    assert.equal(models["audio-output"], undefined);
    assert.equal(models["bge-embed"], undefined);
    assert.equal(requests.length, 1);
  });

  it("兼容裸数组并缓存 10 分钟", async () => {
    handler = (req, res) =>
      sendJson(res, 200, [
        { id: "m1", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      ]);
    const { plugin } = await makePlugin();
    const provider = makeProvider();
    const auth = makeAuth(["key-a"]);
    const first = await plugin.provider.models(provider, { auth });
    const second = await plugin.provider.models(provider, { auth });
    assert.equal(first.m1.id, "m1");
    assert.equal(second.m1.id, "m1");
    assert.equal(requests.length, 1);
  });

  it("API 缺少 max_output_tokens 时保留 models.dev 输出上限", async () => {
    handler = (req, res) =>
      sendJson(res, 200, {
        data: [
          {
            id: "DeepSeek-V4-Flash",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
          },
        ],
      });
    const { plugin } = await makePlugin();
    const models = await plugin.provider.models(makeProvider(BASE_MODELS), {
      auth: makeAuth(["key-a"]),
    });
    assert.equal(models["DeepSeek-V4-Flash"].limit.context, 1000);
    assert.equal(models["DeepSeek-V4-Flash"].limit.output, 2000);
  });

  it("无 auth 或空池直接回退 given.models", async () => {
    const { plugin } = await makePlugin();
    const provider = makeProvider(BASE_MODELS);
    const result = await plugin.provider.models(provider, { auth: { access: "[]" } });
    assert.strictEqual(result, provider.models);
    assert.equal(requests.length, 0);
  });

  it("全 401/403 抛 signIn: expired", async () => {
    handler = (req, res) => sendJson(res, 401, { error: "invalid" });
    const { plugin } = await makePlugin();
    await assert.rejects(
      () => plugin.provider.models(makeProvider(BASE_MODELS), { auth: makeAuth(["key-a", "key-b"]) }),
      (error) => {
        assert.equal(error.signIn, "expired");
        return true;
      },
    );
  });

  it("429/5xx/网络失败回退且不标记登录失效", async () => {
    handler = (req, res) => {
      if (req.headers.authorization === "Bearer key-a") sendJson(res, 401, { error: "a" });
      else sendJson(res, 500, { error: "b" });
    };
    const { plugin } = await makePlugin();
    const provider = makeProvider(BASE_MODELS);
    const result = await plugin.provider.models(provider, { auth: makeAuth(["key-a", "key-b"]) });
    assert.strictEqual(result, provider.models);
  });

  it("200 但过滤后无聊天模型时回退", async () => {
    handler = (req, res) =>
      sendJson(res, 200, {
        data: [{ id: "bge-embed", architecture: { input_modalities: ["text"], output_modalities: ["text"] } }],
      });
    const { plugin } = await makePlugin();
    const provider = makeProvider(BASE_MODELS);
    const result = await plugin.provider.models(provider, { auth: makeAuth(["key-a"]) });
    assert.strictEqual(result, provider.models);
  });
});

describe("用量展示", () => {
  const FLEET = {
    models: {
      A: { state: "idle", label: "Idle", utilization: 10 },
      B: { state: "busy", label: "Busy", utilization: 80 },
      C: { state: "full", label: "At capacity", utilization: 31.5 },
    },
    scope: "fleet",
  };

  it("plan Free、API keys 使用 display、Fleet 按 state/utilization 汇总", async () => {
    handler = (req, res) => {
      if (req.url === "/tokenfactory/load") sendJson(res, 200, FLEET);
      else sendJson(res, 404, {});
    };
    const { plugin } = await makePlugin();
    const usage = await plugin.auth.usage(async () => makeAuth(["key-a", "key-b"]));
    assert.equal(usage.plan, "Free");
    assert.equal(usage.windows[0].name, "API keys");
    assert.equal(usage.windows[0].display, "2 个");
    assert.equal(usage.windows[0].unit, "个");
    assert.equal(Object.prototype.hasOwnProperty.call(usage.windows[0], "amount"), false);
    assert.equal(usage.windows[1].name, "Fleet 负载");
    assert.equal(usage.windows[1].display, "可用 1 · 总数 3 · Busy 1 · 满载 1 · 平均利用率 40.5%");
    assert.equal(Object.prototype.hasOwnProperty.call(usage.windows[1], "amount"), false);
  });

  it("Fleet 数组兼容与 5 分钟缓存", async () => {
    handler = (req, res) =>
      sendJson(res, 200, {
        models: [
          { model: "A", state: "idle", utilization: 10 },
          { model: "B", state: "busy", utilization: 20 },
        ],
      });
    const { plugin } = await makePlugin();
    const auth = async () => makeAuth(["key-a"]);
    const first = await plugin.auth.usage(auth);
    const second = await plugin.auth.usage(auth);
    assert.equal(first.windows[1].display, "可用 1 · 总数 2 · Busy 1 · 满载 0 · 平均利用率 15%");
    assert.equal(second.windows[1].display, first.windows[1].display);
    assert.equal(requests.length, 1);
  });

  it("负载失败显示负载暂不可用且不标记登录失效", async () => {
    handler = (req, res) => sendJson(res, 500, { error: "down" });
    const { plugin } = await makePlugin();
    const usage = await plugin.auth.usage(async () => makeAuth(["key-a"]));
    assert.equal(usage.windows[1].display, "负载暂不可用");
    assert.equal(Object.prototype.hasOwnProperty.call(usage, "signIn"), false);
    assert.equal(usage.windows[0].display, "1 个");
  });

  it("Fleet 查询 30 秒超时返回负载暂不可用", async () => {
    handler = () => undefined;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms === 30000) return realSetTimeout(fn, 20, ...args);
      return realSetTimeout(fn, ms, ...args);
    };
    try {
      const { plugin } = await makePlugin();
      const usage = await plugin.auth.usage(async () => makeAuth(["key-a"]));
      assert.equal(usage.windows[1].display, "负载暂不可用");
      assert.equal(Object.prototype.hasOwnProperty.call(usage, "signIn"), false);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe("集成", () => {
  it("从登录到模型目录再到聊天", async () => {
    handler = (req, res, record) => {
      if (req.url === "/models") {
        sendJson(res, 200, {
          data: [
            {
              id: "DeepSeek-V4-Flash",
              architecture: { input_modalities: ["text"], output_modalities: ["text"] },
              providers: [{ tools: true, vision: false, reasoning: true }],
            },
          ],
        });
        return;
      }
      if (req.url === "/chat/completions") {
        assert.equal(record.headers.authorization, "Bearer key-a");
        sendJson(res, 200, { id: "chat-1" });
        return;
      }
      sendJson(res, 404, {});
    };
    const { plugin } = await makePlugin();
    const result = await login(plugin, { keys: "key-a" });
    const provider = makeProvider(BASE_MODELS);
    const models = await plugin.provider.models(provider, { auth: { access: result.access, accountId: result.accountId } });
    assert.equal(models["DeepSeek-V4-Flash"].id, "DeepSeek-V4-Flash");
    const loader = await plugin.auth.loader(
      async () => ({ access: result.access, accountId: result.accountId }),
      provider,
    );
    const response = await loader.fetch(baseUrl + "/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "DeepSeek-V4-Flash", messages: [] }),
    });
    assert.equal(response.status, 200);
  });
});

describe("真实端点冒烟", () => {
  it("AMD_LIVE_TEST=1 时检查公开端点", { skip: process.env.AMD_LIVE_TEST !== "1" }, async () => {
    const load = await fetch("https://developer.amd.com.cn/radeon/api/tokenfactory/load");
    assert.equal(load.status, 200);
    const models = await fetch("https://developer.amd.com.cn/radeon/api/v1/models");
    assert.equal(models.status, 401);
  });
});
