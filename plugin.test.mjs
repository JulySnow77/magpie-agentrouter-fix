import {test} from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import http from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
// fix/ is the compatible baseline: the new filter must agree with it on the
// same inputs (bodies, counts, error codes). fix/ itself stays untouched.
const fix = require('../fix/proxy.cjs');

import plugin, {_internal} from './index.mjs';
import {
  FilterError, filterResponsesRequest, filterErrorResponse,
  normalizeBase, classifyResponsesTarget, decodeBody, RESPONSES_LIMIT,
} from './request.mjs';

const RUNTIME = globalThis.Bun ? 'bun' : 'node';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(resolve));
}

// A plugin instance wired to a mock account: endpoint points at `origin`,
// the key is a mock key. No real network leaves the machine.
async function pluginFetchFor(origin, key = 'mock-secret') {
  const instance = await plugin({});
  const loader = instance.auth.loader;
  const opts = await loader(async () => ({type: 'api', key, metadata: {endpoint: origin}}), {});
  assert.equal(opts.baseURL, normalizeBase(origin));
  return opts.fetch;
}

// sample is the fixture from fix/filter.test.cjs, reused verbatim so the
// two implementations are compared on the same inputs.
const sample = {
  model: 'mock-model', store: true, stream: true, reasoning: {effort: 'xhigh', summary: 'auto'},
  include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
  input: [
    {role: 'user', content: [{type: 'input_text', text: '你好'}, {type: 'input_image', image_url: 'data:image/png;base64,AAAA'}]},
    {type: 'reasoning', id: 'rs_old', encrypted_content: 'foreign-account-ciphertext', summary: []},
    {type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"x":1}'},
    {type: 'function_call_output', id: 'fco_1', call_id: 'call_1', output: 'result'},
    {type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_2', name: 'exec', input: 'a'},
    {type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_2', output: 'ok'},
    {type: 'message', id: 'msg_old', role: 'assistant', phase: 'final_answer',
      content: [{type: 'output_text', text: 'done', annotations: [{type: 'file_citation', file_id: 'file_keep', index: 0, filename: 'evidence.txt'}]}]}
  ]
};

// ---- filter behavior (ported from fix/filter.test.cjs) -----------------------

test('removes historical reasoning while preserving tools, images, effort, and original input', () => {
  const snapshot = JSON.stringify(sample);
  const result = filterResponsesRequest(sample);
  assert.equal(result.removed, 1);
  assert.equal(result.removedItemIds, 5);
  assert.equal(result.body.store, false);
  assert.deepEqual(result.body.include, ['message.output_text.logprobs']);
  assert.deepEqual(result.body.input, [
    sample.input[0],
    {type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"x":1}'},
    {type: 'function_call_output', call_id: 'call_1', output: 'result'},
    {type: 'custom_tool_call', call_id: 'call_2', name: 'exec', input: 'a'},
    {type: 'custom_tool_call_output', call_id: 'call_2', output: 'ok'},
    {type: 'message', role: 'assistant', phase: 'final_answer', content: sample.input[6].content}
  ]);
  assert.deepEqual(result.body.reasoning, sample.reasoning);
  assert.equal(JSON.stringify(sample), snapshot);
  assert.deepEqual(filterResponsesRequest({input: 'hello'}).body, {input: 'hello', store: false});
});

test('strips only optional history item IDs, keeping call IDs and resource references', () => {
  const input = [
    {id: 'msg_shorthand', role: 'user', content: [{type: 'input_file', file_id: 'file_keep'}]},
    {type: 'function_call', id: 'fc_outer', call_id: 'call_keep', name: 'lookup', arguments: '{"id":"business_1"}'},
    {type: 'function_call_output', id: 'fco_outer', call_id: 'call_keep', output: [{type: 'input_text', text: '{"id":"business_2"}'}]},
    {type: 'file_search_call', id: 'fs_required', status: 'completed', queries: ['test'], results: []},
    {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'ok'}]}
  ];
  const result = filterResponsesRequest({input});
  assert.equal(result.removedItemIds, 3);
  assert.equal(result.body.input[0].id, undefined);
  assert.equal(result.body.input[0].content[0].file_id, 'file_keep');
  assert.equal(result.body.input[1].call_id, result.body.input[2].call_id);
  assert.equal(result.body.input[1].arguments, input[1].arguments);
  assert.deepEqual(result.body.input[2].output, input[2].output);
  assert.deepEqual(result.body.input.slice(3), input.slice(3));
  assert.equal(input[0].id, 'msg_shorthand');
  // Idempotent: a second pass finds nothing left to remove.
  assert.equal(filterResponsesRequest(result.body).removedItemIds, 0);
});

test('removes Codex-internal metadata the upstream rejects, keeping supported keys', () => {
  const input = [
    {type: 'message', id: 'msg_1', role: 'user', content: [{type: 'input_text', text: 'hi'}],
      internal_chat_message_metadata_passthrough: {
        turn_id: 'turn_1', create_time: 1792833140.5,
        content_item_kinds: ['model.base_instructions'],
        content_item_metadata: [{provenance: {type: 'harness', hook: false}}]
      }},
    {type: 'message', role: 'user', content: [{type: 'input_text', text: 'plain'}]},
    {type: 'message', role: 'user', content: [{type: 'input_text', text: 'only-bad'}],
      internal_chat_message_metadata_passthrough: {content_item_metadata: [{provenance: {type: 'harness'}}]}}
  ];
  const result = filterResponsesRequest({input});
  assert.equal(result.removedMetadata, 2);
  assert.equal(result.body.input[0].internal_chat_message_metadata_passthrough.content_item_metadata, undefined);
  assert.deepEqual(result.body.input[0].internal_chat_message_metadata_passthrough, {
    turn_id: 'turn_1', create_time: 1792833140.5, content_item_kinds: ['model.base_instructions']
  });
  assert.equal(result.body.input[2].internal_chat_message_metadata_passthrough, undefined);
  assert.deepEqual(result.body.input[1], input[1]);
  assert.equal(input[0].internal_chat_message_metadata_passthrough.content_item_metadata.length, 1);
  assert.equal(filterResponsesRequest(result.body).removedMetadata, 0);
});

test('fails explicitly on cross-account references and compaction', () => {
  for (const body of [
    {previous_response_id: 'resp_old'}, {conversation: {id: 'conv_old'}},
    {input: [{type: 'compaction', encrypted_content: 'x'}]}, {input: [{type: 'item_reference', id: 'old'}]},
    {input: [{type: 'new_opaque_type', encrypted_content: 'x'}]}, {context_management: [{type: 'compaction'}]}
  ]) assert.throws(() => filterResponsesRequest(body), /text summary/);
  for (const body of [null, [], {include: 'x'}, {input: {type: 'message'}}]) {
    assert.throws(() => filterResponsesRequest(body));
  }
});

test('parity with fix/proxy.cjs: same bodies, counts and error codes on the same inputs', () => {
  const valid = [
    sample,
    {input: 'hello'},
    {input: [{id: 'msg_a', role: 'user', content: 'hi'}]},
    {include: ['reasoning.encrypted_content'], input: [
      {type: 'function_call', id: 'fc', call_id: 'c1', name: 'f', arguments: '{}'},
      {type: 'file_search_call', id: 'fs', queries: [], results: []}
    ]},
    {store: true, input: [{type: 'reasoning'}, {type: 'reasoning', id: 'rs'}]},
    {input: [{role: 'assistant', content: [{type: 'output_text', text: 'x'}], id: 'm1'}], metadata: {a: 1}}
  ];
  for (const body of valid) {
    const expected = fix.filterResponsesRequest(JSON.parse(JSON.stringify(body)));
    const actual = filterResponsesRequest(JSON.parse(JSON.stringify(body)));
    assert.deepEqual(actual.body, expected.body, `body mismatch for ${JSON.stringify(body).slice(0, 60)}`);
    assert.deepEqual(
      {removed: actual.removed, removedItemIds: actual.removedItemIds, removedMetadata: actual.removedMetadata},
      {removed: expected.removed, removedItemIds: expected.removedItemIds, removedMetadata: expected.removedMetadata});
  }
  const invalid = [
    {previous_response_id: 'r'}, {conversation: 'c'}, {include: 'x'}, {input: 5},
    {input: [{type: 'compaction'}]}, {input: [{type: 'item_reference', id: 'x'}]},
    {input: [{encrypted_content: 'x'}]}, {context_management: [{type: 'compaction'}]},
    null, [], 'str', {include: {}}, {input: {}}
  ];
  for (const body of invalid) {
    let expectedCode = null, actualCode = null;
    try { fix.filterResponsesRequest(body); } catch (e) { expectedCode = e.code; }
    try { filterResponsesRequest(body); } catch (e) { actualCode = e.code; assert(e instanceof FilterError); }
    assert.equal(actualCode, expectedCode, `error code mismatch for ${JSON.stringify(body)}`);
  }
});

// ---- adapter: endpoints, bodies, compression, error responses ----------------

test('normalizeBase accepts origins and /v1 bases, rejects everything else', () => {
  assert.equal(normalizeBase('https://ps.air-outer.com'), 'https://ps.air-outer.com/v1');
  assert.equal(normalizeBase('https://ps.air-outer.com/'), 'https://ps.air-outer.com/v1');
  assert.equal(normalizeBase('https://ps.air-outer.com/v1'), 'https://ps.air-outer.com/v1');
  assert.equal(normalizeBase('https://ps.air-outer.com/v1/'), 'https://ps.air-outer.com/v1');
  assert.equal(normalizeBase('http://127.0.0.1:8123'), 'http://127.0.0.1:8123/v1');
  for (const bad of [
    'https://user:pw@api.example.com', 'https://api.example.com/?x=1', 'https://api.example.com#f',
    'https://api.example.com/v1/chat', 'https://api.example.com/api', 'ftp://api.example.com',
    'https://api.example.com/v2', 'not a url', ''
  ]) assert.throws(() => normalizeBase(bad), FilterError, `should reject ${bad}`);
});

test('classifyResponsesTarget filters only POST responses endpoints', () => {
  const u = path => new URL('https://up.example.com/v1' + path);
  assert.equal(classifyResponsesTarget(u('/responses'), 'POST'), 'responses');
  assert.equal(classifyResponsesTarget(u('/responses/'), 'POST'), 'responses');
  assert.equal(classifyResponsesTarget(u('/responses'), 'post'), 'responses');
  assert.equal(classifyResponsesTarget(u('/responses/compact'), 'POST'), 'compact');
  assert.equal(classifyResponsesTarget(u('/responses/compact/'), 'POST'), 'compact');
  assert.equal(classifyResponsesTarget(u('/responses'), 'GET'), 'other');
  assert.equal(classifyResponsesTarget(u('/models'), 'GET'), 'other');
  assert.equal(classifyResponsesTarget(u('/responses/compact'), 'GET'), 'other');
  assert.equal(classifyResponsesTarget(u('/embeddings'), 'POST'), 'other');
  assert.equal(classifyResponsesTarget(new URL('https://up.example.com/v2/responses'), 'POST'), 'responses');
});

test('decodeBody handles supported encodings, limits size, and rejects the rest', () => {
  const raw = Buffer.from('{"a":1}');
  assert.equal(decodeBody(raw, undefined, 1024).toString(), '{"a":1}');
  assert.equal(decodeBody(raw, 'identity', 1024).toString(), '{"a":1}');
  const cases = [['gzip', zlib.gzipSync(raw)], ['deflate', zlib.deflateSync(raw)], ['br', zlib.brotliCompressSync(raw)]];
  if (typeof zlib.zstdDecompressSync === 'function' && typeof zlib.zstdCompressSync === 'function') {
    cases.push(['zstd', zlib.zstdCompressSync(raw)]);
  }
  for (const [encoding, body] of cases) {
    assert.equal(decodeBody(body, encoding, 1024).toString(), '{"a":1}', `encoding ${encoding}`);
  }
  if (typeof zlib.zstdDecompressSync !== 'function') {
    // This runtime has no zstd decoder: the codec must say so, not pass garbage on.
    assert.throws(() => decodeBody(Buffer.alloc(8), 'zstd', 1024), e => e instanceof FilterError && e.status === 415);
  }
  assert.throws(() => decodeBody(raw, 'pack200-gzip', 1024), e => e instanceof FilterError && e.status === 415);
  assert.throws(() => decodeBody(Buffer.from('not gzip'), 'gzip', 1024), FilterError);
  const big = Buffer.from('x'.repeat(1000));
  assert.throws(() => decodeBody(zlib.gzipSync(big), 'gzip', 100), e => e instanceof FilterError && e.status === 413);
  // A small compressed body whose decoded form exceeds the limit is rejected too.
  assert.throws(() => decodeBody(zlib.gzipSync(big), 'gzip', 500), e => e instanceof FilterError && e.status === 413);
  assert.equal(RESPONSES_LIMIT, 64 * 1024 * 1024);
});

test('filterErrorResponse keeps fix error codes and status semantics', async () => {
  const res = filterErrorResponse(new FilterError('response_reference_not_portable', 'Complete message/tool history is required.', 400));
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.deepEqual(body, {error: {type: 'invalid_request_error', code: 'response_reference_not_portable', message: 'Complete message/tool history is required.'}});
  assert.equal(filterErrorResponse(new Error('boom')).status, 500);
  const wrapped = await filterErrorResponse(new Error('boom')).json();
  assert.equal(wrapped.error.code, 'local_filter_error');
  assert.equal(filterErrorResponse(new FilterError('encrypted_compaction_disabled', 'no', 409)).status, 409);
  assert.equal(filterErrorResponse(new FilterError('request_too_large', 'big', 413)).status, 413);
  assert.equal(filterErrorResponse(new FilterError('unsupported_content_encoding', 'enc', 415)).status, 415);
});

// ---- plugin fetch against a local mock upstream ------------------------------

function mockUpstream(handler) {
  const captured = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const entry = {path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks)};
    captured.push(entry);
    await handler(entry, res);
  });
  return {server, captured};
}

test('plugin filters the actual POST /v1/responses body sent upstream', async t => {
  const {server, captured} = mockUpstream(async (entry, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}');
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const fetchModel = await pluginFetchFor(origin);
  const res = await fetchModel(new Request(origin + '/v1/responses', {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: 'Bearer stale-key', 'user-agent': 'magpie/1.0'},
    body: JSON.stringify(sample),
  }));
  assert.equal(res.status, 200);
  const sent = captured[0];
  assert.equal(sent.path, '/v1/responses');
  assert.equal(sent.headers.authorization, 'Bearer mock-secret');
  assert.ok(sent.headers['user-agent'].startsWith('codex_cli_rs/'), `UA should be the Codex-compatible default, got ${sent.headers['user-agent']}`);
  assert.equal(sent.headers['content-encoding'], undefined);
  assert.equal(Number(sent.headers['content-length']), sent.body.length);
  assert.deepEqual(JSON.parse(sent.body.toString()), filterResponsesRequest(sample).body);
  // Encrypted reasoning from history never reaches the upstream.
  assert.ok(!sent.body.toString().includes('foreign-account-ciphertext'));
});

test('plugin accepts URL and string inputs and a compressed request body', async t => {
  const {server, captured} = mockUpstream(async (entry, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}');
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const fetchModel = await pluginFetchFor(origin);
  const gzipBody = zlib.gzipSync(Buffer.from(JSON.stringify(sample)));
  const res = await fetchModel(new URL(origin + '/v1/responses'), {
    method: 'POST',
    headers: {'content-type': 'application/json', 'content-encoding': 'gzip'},
    body: new Uint8Array(gzipBody),
  });
  assert.equal(res.status, 200);
  assert.equal(captured[0].headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(captured[0].body.toString()), filterResponsesRequest(sample).body);
  // Plain string input.
  await fetchModel(origin + '/v1/responses', {method: 'POST', body: JSON.stringify({input: 'hi'})});
  assert.deepEqual(JSON.parse(captured[1].body.toString()), {input: 'hi', store: false});
});

test('plugin rejects invalid or non-portable model requests without calling upstream', async t => {
  let upstreamCalls = 0;
  const {server, captured} = mockUpstream(async (entry, res) => {
    upstreamCalls++;
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{}');
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const fetchModel = await pluginFetchFor(origin);
  const cases = [
    ['{', 400, 'invalid_request_json'],
    [JSON.stringify({previous_response_id: 'r'}), 400, 'response_reference_not_portable'],
    [JSON.stringify({conversation: 'c'}), 400, 'response_reference_not_portable'],
    [JSON.stringify({input: [{type: 'compaction'}]}), 400, 'encrypted_context_not_portable'],
    [JSON.stringify({context_management: [{type: 'compaction'}]}), 400, 'encrypted_compaction_disabled'],
    [JSON.stringify({include: 'x'}), 400, 'invalid_include'],
  ];
  for (const [body, status, code] of cases) {
    const res = await fetchModel(new Request(origin + '/v1/responses', {method: 'POST', body}));
    assert.equal(res.status, status, `status for ${body.slice(0, 40)}`);
    const json = await res.json();
    assert.equal(json.error?.code, code, `code for ${body.slice(0, 40)}`);
    assert.ok(json.error?.message);
    assert.equal(json.error?.type, 'invalid_request_error');
  }
  // The compact endpoint is refused before anything is sent.
  const compact = await fetchModel(new Request(origin + '/v1/responses/compact', {method: 'POST', body: '{}'}));
  assert.equal(compact.status, 409);
  assert.equal((await compact.json()).error?.code, 'encrypted_compaction_disabled');
  assert.equal(upstreamCalls, 0);
  assert.equal(captured.length, 0);
});

test('plugin forwards non-model routes and passes upstream statuses through untouched', async t => {
  const statuses = [401, 429, 500];
  let n = 0;
  const {server, captured} = mockUpstream(async (entry, res) => {
    const status = statuses[n++] ?? 200;
    res.writeHead(status, {'content-type': 'application/json', 'x-test': 'unchanged'});
    res.end(JSON.stringify({from: 'upstream', status}));
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const fetchModel = await pluginFetchFor(origin);
  for (const status of statuses) {
    const res = await fetchModel(new Request(origin + '/v1/responses', {method: 'POST', body: JSON.stringify({input: 'hi'})}));
    assert.equal(res.status, status);
    assert.equal(res.headers.get('x-test'), 'unchanged');
    assert.deepEqual(await res.json(), {from: 'upstream', status});
  }
  // A non-responses route passes through with auth applied and body untouched.
  const other = await fetchModel(new Request(origin + '/v1/embeddings', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({input: [{id: 'keep-me'}]}),
  }));
  assert.equal(other.status, 200);
  assert.equal(captured[3].path, '/v1/embeddings');
  assert.equal(captured[3].headers.authorization, 'Bearer mock-secret');
  assert.deepEqual(JSON.parse(captured[3].body.toString()), {input: [{id: 'keep-me'}]});
  // GET pass-through (e.g. a routed model list).
  const models = await fetchModel(new Request(origin + '/v1/models'));
  assert.equal(captured[4].path, '/v1/models');
  assert.equal(captured[4].headers.authorization, 'Bearer mock-secret');
  assert.ok(models.status === 200);
});

test('accounts are isolated: each loader fetch uses only its own key and endpoint', async t => {
  const seen = [];
  const {server} = mockUpstream(async (entry, res) => {
    seen.push({auth: entry.headers.authorization, host: entry.headers.host});
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{}');
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const instance = await plugin({});
  const loader = instance.auth.loader;
  const a = await loader(async () => ({type: 'api', key: 'key-a', metadata: {endpoint: origin}}), {});
  const b = await loader(async () => ({type: 'api', key: 'key-b', metadata: {endpoint: origin}}), {});
  await a.fetch(new Request(origin + '/v1/responses', {method: 'POST', body: '{"input":"a"}'}));
  await b.fetch(new Request(origin + '/v1/responses', {method: 'POST', body: '{"input":"b"}'}));
  await a.fetch(new Request(origin + '/v1/responses', {method: 'POST', body: '{"input":"a2"}'}));
  assert.deepEqual(seen.map(s => s.auth), ['Bearer key-a', 'Bearer key-b', 'Bearer key-a']);
  // A signed-out account produces an inert loader, not a crash.
  const off = await loader(async () => undefined, {});
  assert.deepEqual(off, {});
});

test('network failures propagate and cancel stops the upstream read', {timeout: 15000}, async t => {
  // Unreachable upstream: the error must propagate, not be swallowed or retried.
  const unused = http.createServer();
  const gone = await listen(unused);
  await close(unused);
  const fetchModel = await pluginFetchFor(gone);
  await assert.rejects(
    fetchModel(new Request(gone + '/v1/responses', {method: 'POST', body: '{"input":"x"}'})),
    /fetch|ECONNREFUSED|refused|error|unable/i,
  );

  // Cancellation: the client aborts after the first SSE chunk; the upstream
  // must see its connection close without the stream having ended.
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  let disconnected;
  const canceled = new Promise(resolve => { disconnected = resolve; });
  const sse = http.createServer(async (req, res) => {
    req.resume();
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('event: response.output_text.delta\ndata: {"delta":"first"}\n\n');
    res.on('close', disconnected);
    await gate;
    res.end('event: response.completed\ndata: {"done":true}\n\n');
  });
  const sseOrigin = await listen(sse);
  t.after(async () => { finish(); await close(sse); });
  const fetchSSE = await pluginFetchFor(sseOrigin);
  const ac = new AbortController();
  const res = await fetchSSE(new Request(sseOrigin + '/v1/responses', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({input: 'hi'}),
  }), {signal: ac.signal});
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.ok(new TextDecoder().decode(first.value).includes('"first"'));
  ac.abort();
  // The caller's read must end promptly on every runtime: Node rejects with
  // AbortError; Bun rejects too (via the plugin's signal-controlled body).
  const settled = await Promise.race([
    reader.read().then(() => 'settled').catch(() => 'settled'),
    new Promise(r => setTimeout(() => r('HANG'), 3000)),
  ]);
  assert.equal(settled, 'settled', 'client read must settle after abort');
  if (!globalThis.Bun) {
    // Node's fetch tears the upstream socket down on abort.
    await canceled;
  } else {
    // Bun's fetch may leave the TCP connection pooled instead of closing it
    // (recorded runtime limitation in the README); the plugin still stops
    // reading, which the settled read above proves.
    void canceled;
  }
});

test('SSE first chunk arrives before the upstream finishes', {timeout: 15000}, async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const sse = http.createServer(async (req, res) => {
    req.resume();
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('event: response.output_text.delta\ndata: {"delta":"first"}\n\n');
    await gate;
    res.end('event: response.completed\ndata: {"done":true}\n\n');
  });
  const origin = await listen(sse);
  t.after(async () => { finish(); await close(sse); });
  const fetchModel = await pluginFetchFor(origin);
  const res = await fetchModel(new Request(origin + '/v1/responses', {method: 'POST', body: '{"input":"hi"}'}));
  const reader = res.body.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  assert.ok(text.includes('response.output_text.delta'), 'first upstream chunk must arrive before the stream ends');
  finish();
  const rest = [];
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    rest.push(new TextDecoder().decode(value));
  }
  assert.ok(rest.join('').includes('response.completed'), 'the rest of the stream still arrives');
});

test('oversized model requests are refused with 413 without contacting the upstream', async t => {
  let called = 0;
  const {server} = mockUpstream(async (entry, res) => { called++; res.end('{}'); });
  const origin = await listen(server);
  t.after(() => close(server));
  const instance = await plugin({});
  const loader = instance.auth.loader;
  const opts = await loader(async () => ({type: 'api', key: 'k', metadata: {endpoint: origin}}), {});
  // A body just over the 64 MiB limit must be cut off while reading, with a
  // JSON 413, and never reach the upstream.
  const over = '{"input":"' + 'x'.repeat(RESPONSES_LIMIT) + '"}';
  const res = await opts.fetch(new Request(origin + '/v1/responses', {
    method: 'POST', headers: {'content-type': 'application/json'}, body: over,
  }));
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error?.code, 'request_too_large');
  assert.equal(called, 0);
});

// ---- provider config, login metadata and model listing -----------------------

test('config declares the provider and one API-key login method', async () => {
  const instance = await plugin({});
  const cfg = {};
  await instance.config(cfg);
  const p = cfg.provider['agentrouter-fix'];
  assert.equal(p.name, 'AgentRouter Fix');
  assert.equal(p.npm, '@ai-sdk/openai');
  assert.match(p.api, /^https:\/\/ps\.air-outer\.com\/v1$/);
  const auth = instance.auth;
  assert.equal(auth.provider, 'agentrouter-fix');
  assert.equal(auth.methods.length, 1);
  const method = auth.methods[0];
  assert.equal(method.type, 'api');
  assert.ok(method.label);
  assert.ok(method.placeholder);
  const keys = method.prompts.map(p2 => p2.key);
  assert.deepEqual(keys, ['endpoint']);
  const endpointPrompt = method.prompts[0];
  assert.equal(endpointPrompt.validate('https://api.example.com/v1'), undefined);
  assert.equal(endpointPrompt.validate('https://api.example.com'), undefined);
  assert.ok(typeof endpointPrompt.validate('https://user:pw@x.example.com') === 'string');
  assert.ok(typeof endpointPrompt.validate('not a url') === 'string');
  // An empty answer is allowed: it means the default endpoint.
  assert.equal(endpointPrompt.validate(''), undefined);
  assert.ok(typeof instance.provider.models === 'function');
});

test('provider.models reads the account list and verifies its structure', async t => {
  const {server} = mockUpstream(async (entry, res) => {
    if (entry.path !== '/v1/models') { res.writeHead(404); res.end('{}'); return; }
    if (entry.headers.authorization !== 'Bearer mock-secret') { res.writeHead(401); res.end('{"error":"bad key"}'); return; }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({data: [
      {id: 'gpt-test-a', display_name: 'Test A', context_length: 400000, max_output_tokens: 64000},
      {id: 'gpt-test-b'},
      {no_id: 'skipped'}
    ]}));
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const instance = await plugin({});
  const models = instance.provider.models;
  const out = await models({}, {auth: {type: 'api', key: 'mock-secret', metadata: {endpoint: origin}}});
  assert.deepEqual(Object.keys(out).sort(), ['gpt-test-a', 'gpt-test-b']);
  assert.equal(out['gpt-test-a'].name, 'Test A');
  assert.equal(out['gpt-test-a'].responses, true);
  assert.deepEqual(out['gpt-test-a'].limit, {context: 400000, output: 64000});
  // Models without vendor limits stay without invented numbers.
  assert.equal(out['gpt-test-b'].limit, undefined);
  assert.equal(out['gpt-test-b'].name, 'gpt-test-b');

  // A refused key must surface as an error, not as a fake list.
  await assert.rejects(
    models({}, {auth: {type: 'api', key: 'wrong', metadata: {endpoint: origin}}}),
    /401|HTTP/,
  );
  // An endpoint that is not a URL fails with a clear error.
  await assert.rejects(
    models({}, {auth: {type: 'api', key: 'mock-secret', metadata: {endpoint: 'https://bad:1:a'}}}),
    FilterError,
  );
});

test('model listing and requests use the normalized endpoint without a doubled /v1', async t => {
  const paths = [];
  const {server} = mockUpstream(async (entry, res) => {
    paths.push(entry.path);
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(entry.path === '/v1/models' ? '{"data":[{"id":"m1"}]}' : '{"ok":true}');
  });
  const origin = await listen(server);
  t.after(() => close(server));
  const instance = await plugin({});
  // An account that stored the origin (no /v1) and one that stored a /v1 base
  // must both land on exactly one /v1.
  for (const endpoint of [origin, origin + '/v1', origin + '/v1/']) {
    const opts = await instance.auth.loader(async () => ({type: 'api', key: 'k', metadata: {endpoint}}), {});
    await opts.fetch(new Request(origin + '/v1/responses', {method: 'POST', body: '{"input":"x"}'}));
    await instance.provider.models({}, {auth: {type: 'api', key: 'k', metadata: {endpoint}}});
  }
  assert.deepEqual(paths, [
    '/v1/responses', '/v1/models',
    '/v1/responses', '/v1/models',
    '/v1/responses', '/v1/models',
  ]);
});
