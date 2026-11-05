// magpie-agentrouter-fix — an AgentRouter provider for magpie whose
// Responses requests are filtered before they reach the upstream, so
// cross-account history item IDs and encrypted reasoning never leave this
// machine.
//
// The single model-request path:
//
//   Codex → magpie gateway → this provider's fetch → request filter → AgentRouter
//
// magpie owns the plugin lifecycle, the account credentials, gateway routing
// and protocol conversion (Chat/Anthropic → Responses). This plugin, in the
// fetch its auth.loader returns, owns upstream authentication, the request
// filter and forwarding. There is no local filtering service, no gateway
// middleware, and no retry: a model request is sent to the upstream once.

import {
  FilterError, filterResponsesRequest, filterErrorResponse,
  normalizeBase, classifyResponsesTarget, readBodyLimited, decodeBody,
  RESPONSES_LIMIT,
} from './request.mjs';

export const PROVIDER = 'agentrouter-fix';
export const DEFAULT_BASE = 'https://ps.air-outer.com/v1';

// AgentRouter's gateway only answers clients it recognises, so the default
// here is the Codex CLI's own identifier, as the working agentrouter plugin
// sends it. This is a compatibility default for the upstream model API; its
// actual acceptance is confirmed by live verification, not assumed.
const DEFAULT_USER_AGENT = 'codex_cli_rs/0.101.0';
const MODELS_TIMEOUT_MS = 30_000;

// endpointOf reads the upstream base an account keeps, whether magpie hands
// the auth flat ({type, key, metadata: {endpoint}}) or with the answers at
// the top level. An empty answer means the plugin's default endpoint.
function meta(auth, name) {
  if (!auth) return undefined;
  const flat = auth[name];
  if (flat !== undefined && flat !== null && String(flat).trim() !== '') return flat;
  const nested = auth.metadata?.[name];
  return nested === undefined || nested === null ? undefined : nested;
}

function endpointOf(auth) {
  const said = String(meta(auth, 'endpoint') ?? '').trim();
  return said ? normalizeBase(said) : DEFAULT_BASE;
}

function apiKeyOf(auth) {
  return String(auth?.key ?? '').trim();
}

// MAGPIE_ONLY are magpie's own request-to-plugin headers. They are for the
// plugin to read, never for its vendor; the host strips them from what a
// plugin sends, and they are dropped here as well so nothing relies on that.
const MAGPIE_ONLY = ['x-magpie-work-dir', 'x-magpie-work-git', 'x-magpie-fallback', 'x-magpie-session', 'x-magpie-subagent'];

// Hop-by-hop headers, as fix/proxy.cjs strips them, plus the body headers a
// rewritten body invalidates: fetch computes the new length itself.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
const BODY_HEADERS = new Set(['content-length', 'content-encoding', 'content-digest', 'expect']);

function mergeHeaders(input, init) {
  const h = new Headers(typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
  const given = init?.headers;
  if (given) {
    if (typeof given.forEach === 'function') given.forEach((v, k) => h.set(k, v));
    else if (Array.isArray(given)) for (const [k, v] of given) h.set(k, v);
    else for (const [k, v] of Object.entries(given)) if (v !== undefined && v !== null) h.set(k, v);
  }
  for (const key of MAGPIE_ONLY) h.delete(key);
  return h;
}

// requestFacts resolves fetch's (input, init) the way Web Fetch merges them:
// init fields override the input, whatever its form (string, URL, Request).
function requestFacts(input, init = {}) {
  const isRequest = typeof Request !== 'undefined' && input instanceof Request;
  const url = isRequest ? new URL(input.url) : input instanceof URL ? input : new URL(String(input));
  const method = String(init.method ?? (isRequest ? input.method : 'GET') ?? 'GET').toUpperCase();
  const headers = mergeHeaders(input, init);
  const signal = init.signal ?? (isRequest ? input.signal : undefined);
  const body = init.body !== undefined ? init.body : isRequest ? input.body : null;
  return {url, method, headers, signal, body, isRequest, input};
}

// upstreamHeaders is what goes to the vendor: hop-by-hop headers gone, the
// account's key overriding any leftover Authorization, and the Codex
// client identification the gateway expects.
function upstreamHeaders(headers, key) {
  const out = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'authorization') continue;
    out.set(name, value);
  }
  if (key) out.set('authorization', `Bearer ${key}`);
  out.set('user-agent', DEFAULT_USER_AGENT);
  return out;
}

async function bodyText(facts, limit) {
  const {body} = facts;
  if (body == null) return null;
  if (typeof body === 'string') {
    const buffer = Buffer.from(body, 'utf8');
    if (buffer.length > limit) throw new FilterError('request_too_large', 'Request exceeds filter size limit.', 413);
    return buffer;
  }
  if (typeof body.getLength === 'function' || Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const buffer = Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body);
    if (buffer.length > limit) throw new FilterError('request_too_large', 'Request exceeds filter size limit.', 413);
    return buffer;
  }
  return readBodyLimited(body, limit);
}

// tiedResponse gives the caller a body whose reads end as soon as the
// request's signal fires. This is needed because runtimes differ: Node's
// fetch tears the upstream connection down on abort, while Bun's fetch
// (magpie's host runtime) neither closes an established connection nor
// stops delivering buffered chunks to a caller that is mid-read. Piping
// through a signal-controlled TransformStream makes the observable contract
// the same on both: after a cancellation, reads through this Response end
// at once and the upstream read stops instead of draining on. Chunks pass
// through as they arrive, so SSE first-chunk timing is unchanged.
function tiedResponse(upstream, signal) {
  if (!upstream.body || !signal) return upstream;
  if (signal.aborted) {
    try { upstream.body.cancel(); } catch {}
    throw new DOMException('The request was aborted.', 'AbortError');
  }
  const pass = new TransformStream();
  const piping = upstream.body.pipeTo(pass.writable, {signal}).catch(() => {});
  void piping;
  return new Response(pass.readable, {status: upstream.status, statusText: upstream.statusText, headers: upstream.headers});
}

// responsesFetch is the fetch the loader hands to magpie. Filtered model
// requests are sent upstream exactly once; filter refusals come back as the
// JSON Response fix's status and code semantics define; network failures and
// cancellations propagate as Fetch errors, untouched and unretried.
async function responsesFetch(input, init, account) {
  let facts;
  try {
    facts = requestFacts(input, init);
    const target = classifyResponsesTarget(facts.url, facts.method);
    if (target === 'compact') {
      return filterErrorResponse(new FilterError('encrypted_compaction_disabled',
        'Encrypted Responses compaction is disabled. Use a text summary and start a new session.', 409));
    }
    const headers = upstreamHeaders(facts.headers, account.key);
    if (target !== 'responses') {
      // Not the filtered model endpoint: forward as it came, with the
      // account's authentication applied. A Request input is forwarded
      // itself so its body (unread) stays with it; a string or URL input
      // carries its body through init as fetch would.
      const forwardTo = facts.isRequest ? facts.input : facts.url;
      return tiedResponse(await fetch(forwardTo, {...init, method: facts.method, headers, signal: facts.signal}), facts.signal);
    }
    const raw = await bodyText(facts, RESPONSES_LIMIT);
    const decoded = decodeBody(raw, facts.headers.get('content-encoding'), RESPONSES_LIMIT);
    let parsed;
    try {
      parsed = JSON.parse(decoded.toString('utf8'));
    } catch {
      throw new FilterError('invalid_request_json', 'Responses request is not valid JSON.');
    }
    const filtered = filterResponsesRequest(parsed);
    const body = Buffer.from(JSON.stringify(filtered.body), 'utf8');
    const out = new Headers();
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (HOP_BY_HOP.has(lower) || BODY_HEADERS.has(lower) || lower === 'authorization') continue;
      out.set(name, value);
    }
    if (account.key) out.set('authorization', `Bearer ${account.key}`);
    out.set('user-agent', DEFAULT_USER_AGENT);
    out.set('content-type', 'application/json');
    return tiedResponse(await fetch(facts.url, {method: facts.method, headers: out, body, signal: facts.signal}), facts.signal);
  } catch (error) {
    if (error instanceof FilterError) return filterErrorResponse(error);
    // Only filter-phase failures are converted. Everything else — a bug in
    // argument handling, say — is not a filter verdict; rethrow it rather
    // than answer the model request with a fabricated HTTP error.
    if (error instanceof TypeError || error?.name === 'AbortError') throw error;
    throw error;
  }
}

// modelsOf reads the account's model list from the same endpoint, with the
// same key and client identification the model requests use. A failed or
// malformed listing throws: magpie shows the error and keeps its previous
// list; this plugin never disguises a failure as a success list, and it
// introduces no static models, context lengths, prices or free marks of
// its own.
async function modelsOf(provider, {auth} = {}) {
  const key = apiKeyOf(auth);
  if (!key) throw new Error('AgentRouter Fix：该账号还没有 API Key，请先登录');
  const base = endpointOf(auth);
  const headers = new Headers({
    authorization: `Bearer ${key}`,
    'user-agent': DEFAULT_USER_AGENT,
    accept: 'application/json',
  });
  let res;
  try {
    res = await fetch(`${base}/models`, {headers, signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)});
  } catch (error) {
    throw new Error(`AgentRouter Fix：无法读取模型列表（${base}/models）：${error?.message ?? error}`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`AgentRouter Fix：模型列表请求被拒绝（HTTP ${res.status}${detail ? `：${detail.slice(0, 120)}` : ''}）`);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('AgentRouter Fix：模型列表不是有效的 JSON');
  }
  if (!json || !Array.isArray(json.data)) {
    throw new Error('AgentRouter Fix：模型列表结构不符合预期（缺少 data 数组）');
  }
  const out = {};
  for (const model of json.data) {
    if (!model?.id || typeof model.id !== 'string') continue;
    const limit = {};
    if (Number.isFinite(Number(model.context_length)) && Number(model.context_length) > 0) limit.context = Number(model.context_length);
    if (Number.isFinite(Number(model.max_output_tokens)) && Number(model.max_output_tokens) > 0) limit.output = Number(model.max_output_tokens);
    out[model.id] = {
      name: String(model.name ?? model.display_name ?? model.id),
      // The vendor serves these models on its Responses API; magpie
      // translates an agent's Chat or Anthropic request into it.
      responses: true,
      tool_call: true,
      reasoning: true,
      ...(Object.keys(limit).length ? {limit} : {}),
    };
  }
  if (!Object.keys(out).length) {
    throw new Error('AgentRouter Fix：上游没有返回可用模型');
  }
  return out;
}

export const AgentRouterFixPlugin = async () => ({
  // The provider before anyone signs in: the Responses protocol (via the
  // @ai-sdk/openai package name) and the default endpoint. This field is
  // host-facing protocol metadata; it adds no runtime SDK dependency.
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: 'AgentRouter Fix',
      npm: '@ai-sdk/openai',
      api: DEFAULT_BASE,
      models: {},
    };
  },

  auth: {
    provider: PROVIDER,

    // One plain API-key sign-in. The key is saved by magpie; the only
    // prompt is the upstream base, which defaults to the plugin's endpoint
    // and may be changed per account.
    methods: [
      {
        type: 'api',
        label: 'AgentRouter API 密钥',
        placeholder: 'sk-…',
        prompts: [
          {
            type: 'text',
            key: 'endpoint',
            message: '上游地址（可选，默认 https://ps.air-outer.com；填写站点 origin 或以 /v1 结尾的地址）',
            placeholder: DEFAULT_BASE,
            validate: (v) => {
              const text = String(v ?? '').trim();
              if (!text) return undefined; // empty: use the default endpoint
              try {
                normalizeBase(text);
                return undefined;
              } catch {
                return '请填写 http(s) origin 或以 /v1 结尾的基址，不要带账号密码、查询参数或其他路径';
              }
            },
          },
        ],
        // No authorize: the host saves the key itself and the prompt answers
        // become the account's metadata. The key is checked on the first
        // request, where it actually goes.
      },
    ],

    // The loader runs once per account; everything it returns — including
    // this fetch — is scoped to that account. The key and endpoint live in
    // this closure, never in a cross-account global.
    async loader(getAuth) {
      const auth = await getAuth();
      if (!auth) return {};
      const key = apiKeyOf(auth);
      return {
        baseURL: endpointOf(auth),
        apiKey: key || 'agentrouter-fix',
        async fetch(input, init = {}) {
          return responsesFetch(input, init, {key});
        },
      };
    },
  },

  provider: {
    id: PROVIDER,
    models: modelsOf,
  },
});

export default AgentRouterFixPlugin;

export const _internal = {
  PROVIDER,
  DEFAULT_BASE,
  DEFAULT_USER_AGENT,
  endpointOf,
  meta,
};
