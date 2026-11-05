// request.mjs — the plugin's single implementation of the filtering rules
// and of the request-side adaptation (endpoint rules, body limits,
// compression, JSON error responses).
//
// The filtering semantics are a port of the author's own fix/proxy.cjs
// (the local Codex reasoning/ID filter). fix/ remains the compatible
// baseline: rule changes here must go through the behavior tests that
// compare both implementations on the same inputs. The two do not sync
// automatically.
//
// Pure filtering functions depend on nothing: no network, no files, no
// account or magpie state. index.mjs is their only consumer.

import zlib from 'node:zlib';

export const RESPONSES_LIMIT = 64 * 1024 * 1024;

// These input forms carry their own contents; the server-issued item id is
// optional. Other tool/resource types may require their IDs, so don't
// recursively strip IDs.
const PORTABLE_ITEMS = new Set(['message', 'function_call', 'function_call_output',
  'custom_tool_call', 'custom_tool_call_output']);

// Codex attaches internal chat metadata to input messages. Some keys are
// understood by the upstream Responses API, others are Codex-private and
// rejected as "Unknown parameter". Only the rejected keys are removed;
// accepted metadata is passed through untouched.
const PASSTHROUGH_KEY = 'internal_chat_message_metadata_passthrough';
const UNSUPPORTED_PASSTHROUGH_KEYS = new Set(['content_item_metadata']);

export class FilterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'FilterError';
    this.code = code;
    this.status = status;
  }
}

function stripUnsupportedMetadata(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return {item, changed: false};
  const metadata = item[PASSTHROUGH_KEY];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {item, changed: false};
  let changed = false;
  const kept = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (UNSUPPORTED_PASSTHROUGH_KEYS.has(key)) { changed = true; continue; }
    kept[key] = value;
  }
  if (!changed) return {item, changed: false};
  const result = {...item};
  if (Object.keys(kept).length) result[PASSTHROUGH_KEY] = kept;
  else delete result[PASSTHROUGH_KEY];
  return {item: result, changed: true};
}

export function filterResponsesRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new FilterError('invalid_request_json', 'Responses request must be a JSON object.');
  }
  if (body.previous_response_id || body.conversation) {
    throw new FilterError('response_reference_not_portable',
      'Complete message/tool history is required, not previous_response_id or conversation references. Start a new session with a text summary.');
  }
  if (body.include !== undefined && !Array.isArray(body.include)) {
    throw new FilterError('invalid_include', 'include must be an array.');
  }
  if (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input)) {
    throw new FilterError('invalid_input', 'input must be a string or an array.');
  }
  if (Array.isArray(body.context_management) && body.context_management.some(item => item?.type === 'compaction')) {
    throw new FilterError('encrypted_compaction_disabled',
      'Encrypted compaction is disabled by this filter. Use a text summary and start a new session.');
  }
  const clean = {...body, store: false};
  let removed = 0, removedItemIds = 0, removedMetadata = 0;
  if (body.include) clean.include = body.include.filter(value => value !== 'reasoning.encrypted_content');
  if (Array.isArray(body.input)) {
    clean.input = body.input.filter(item => {
      if (item?.type === 'reasoning') { removed++; return false; }
      return true;
    });
    clean.input = clean.input.map(item => {
      if (item?.type === 'compaction' || item?.type === 'item_reference' || item?.encrypted_content) {
        throw new FilterError('encrypted_context_not_portable',
          'Encrypted compaction/context references cannot safely cross accounts. Start a new session with a text summary; history has NOT been silently discarded.');
      }
      const isMessage = item && item.type === undefined && typeof item.role === 'string' && item.content !== undefined;
      const portable = item && (PORTABLE_ITEMS.has(item.type) || isMessage);
      const {item: stripped, changed: metadataChanged} = stripUnsupportedMetadata(item);
      if (metadataChanged) removedMetadata++;
      if (portable && Object.hasOwn(item, 'id')) {
        const withId = {...stripped};
        delete withId.id;
        removedItemIds++;
        return withId;
      }
      return stripped;
    });
  }
  // call_id pairs calls/results and is not the server-side item id.
  // Preserve it, this turn's effort, all message contents, and nested resource IDs.
  return {body: clean, removed, removedItemIds, removedMetadata};
}

// filterErrorResponse turns a thrown filter error into the JSON Response the
// caller sees, keeping fix's error codes and HTTP status semantics. The
// fixed error.type matches what fix/proxy.cjs sent.
export function filterErrorResponse(error) {
  const err = error instanceof FilterError
    ? error
    : new FilterError('local_filter_error', 'Local filter failed to handle request.', 500);
  return new Response(
    JSON.stringify({error: {type: 'invalid_request_error', code: err.code, message: err.message}}),
    {status: err.status, headers: {'content-type': 'application/json; charset=utf-8'}},
  );
}

// normalizeBase accepts an http(s) origin or a base ending in /v1 and
// normalizes both to `origin + /v1`, so /models and /responses join without
// a doubled or missing /v1. Credentials, query, fragment and any other path
// are refused.
export function normalizeBase(value) {
  const text = String(value ?? '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new FilterError('invalid_upstream_base',
      `Upstream must be an http(s) origin or a base ending in /v1, such as https://ps.air-outer.com or https://ps.air-outer.com/v1. Got: ${text || '(empty)'}`);
  }
  const path = url.pathname;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FilterError('invalid_upstream_base', `Upstream must be http(s): ${text}`);
  }
  if (url.username || url.password || url.search || url.hash || !(path === '/' || path === '/v1' || path === '/v1/')) {
    throw new FilterError('invalid_upstream_base',
      `Upstream must be a bare origin or a base ending in /v1, without credentials, query, fragment or other paths: ${text}`);
  }
  return url.origin + '/v1';
}

// classifyResponsesTarget decides what a request to the upstream is:
//   'responses' — POST to the model endpoint (…/responses with optional
//                 trailing slash); the body is filtered before forwarding.
//   'compact'   — POST to …/responses/compact; refused before sending.
//   'other'     — anything else; passed through with auth applied.
export function classifyResponsesTarget(url, method) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'POST') return 'other';
  if (path.endsWith('/responses/compact')) return 'compact';
  if (path.endsWith('/responses')) return 'responses';
  return 'other';
}

// readBodyLimited reads a request body stream with a size cap while it
// reads, so an oversized body is cut off instead of buffered whole.
export async function readBodyLimited(stream, limit) {
  if (!stream) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const part = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength ?? chunk.length ?? 0);
      size += part.length;
      if (size > limit) {
        throw new FilterError('request_too_large', 'Request exceeds filter size limit.', 413);
      }
      chunks.push(part);
    }
  } catch (error) {
    // Cut the sender off so an oversized upload does not keep streaming.
    try { await stream.cancel?.(); } catch {}
    throw error;
  }
  return Buffer.concat(chunks);
}

// decodeBody decodes a compressed request body. Every codec the runtime
// offers is used; one it cannot decode is refused with 415 rather than
// passed on as opaque bytes, and no dependency is installed for it.
export function decodeBody(buffer, encoding, limit) {
  const options = {maxOutputLength: limit};
  const name = String(encoding || 'identity').toLowerCase().trim();
  try {
    switch (name) {
      case 'identity': case '': return buffer;
      case 'gzip': case 'x-gzip': return zlib.gunzipSync(buffer, options);
      case 'deflate': return zlib.inflateSync(buffer, options);
      case 'br': case 'brotli': return zlib.brotliDecompressSync(buffer, options);
      case 'zstd': {
        if (typeof zlib.zstdDecompressSync !== 'function') {
          throw new FilterError('unsupported_content_encoding',
            `This runtime cannot decode Content-Encoding: ${name}.`, 415);
        }
        return zlib.zstdDecompressSync(buffer, options);
      }
      default: throw new FilterError('unsupported_content_encoding',
        `Unsupported request Content-Encoding: ${name}.`, 415);
    }
  } catch (error) {
    if (error instanceof FilterError) throw error;
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new FilterError('request_too_large', 'Decoded request exceeds filter size limit.', 413);
    }
    throw new FilterError('invalid_compressed_request', 'Cannot decode compressed request.');
  }
}
