'use strict';
// Single Lightspeed R-Series client for the import module.
// Handles: OAuth refresh, rate limiting, 429/5xx backoff, and the domain
// operations used by the import queue (matrix create, variant create, tag,
// order create, order line create).
//
// SAFETY INVARIANTS enforced here (do not move to callers):
//   1. FORBIDDEN_TAGS — the tag "add" is reserved for the Shopify team and
//      must NEVER be applied by this module. Every PUT that touches Tags
//      goes through tagItem(), which strips forbidden tags and throws if
//      the caller tried to set one explicitly.
//   2. CREATE-ONLY writes — this client exposes NO update/delete method
//      beyond tagItem() (a PUT scoped to Tags on variants we just created).
//      No generic put()/delete() is exported.
//   3. Rate-limited requests — a single shared queue serializes calls at
//      3 req/s (below the 3.5/s sustained ceiling) plus 429 backoff.
//
// Public methods:
//   searchMatrixByPrefix(styleRef)      → matrices whose description LIKE 'styleRef%'
//   getMatrixWithVariants(matrixId)     → matrix + its Items array
//   getItemWithTags(itemId)             → variant + Tags relation
//   createMatrix(payload)               → POST /ItemMatrix
//   createItemVariant(payload)          → POST /Item
//   tagItem(itemId, tagsToAdd)          → GET-then-PUT merge, forbidden-tag guarded
//   createOrder(payload)                → POST /Order
//   createOrderLine(orderId, payload)   → POST /OrderLine
//
// Everything else — search, deletes, non-tag PUTs — is intentionally absent.

const axios = require('axios');

const FORBIDDEN_TAGS = ['add'];
const TOKEN_URL      = 'https://cloud.lightspeedapp.com/oauth/access_token.php';

// Rate limit: 3 req/s sustained (below the 3.5/s bucket refill rate).
// The bucket-level header lets us react to burst pressure, but sequential
// pacing at 3/s is enough for the import volumes we handle.
const RATE_PER_SECOND = 3;

// Retry policy: 429 → wait N seconds (from Retry-After if present, else 5), retry up to 3×.
// 5xx → exponential backoff (1s, 2s, 4s), retry up to 3×.
// 401 → refresh token once, retry once.
const MAX_RETRIES_429 = 3;
const MAX_RETRIES_5XX = 3;
const DEFAULT_429_WAIT_MS = 5000;

class LightspeedError extends Error {
  constructor(message, { method, path, status, body, cause } = {}) {
    super(message);
    this.name = 'LightspeedError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

class LightspeedClient {
  constructor({ accountId, clientId, clientSecret, refreshToken, timeoutMs = 30000 }) {
    if (!accountId || !clientId || !clientSecret || !refreshToken) {
      throw new Error('LightspeedClient: accountId, clientId, clientSecret, refreshToken all required');
    }
    this.accountId    = accountId;
    this.clientId     = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.baseURL      = `https://api.lightspeedapp.com/API/V3/Account/${accountId}`;
    this.timeoutMs    = timeoutMs;

    this.token = null;
    this.tokenExpiresAt = 0;

    // Serial pacing state
    this._lastRequestAt = 0;
    this._chain = Promise.resolve(); // serialises all requests

    // Last observed rate bucket ("current/max"), for diagnostics
    this.lastBucketLevel = null;
  }

  // ─── OAuth ───────────────────────────────────────────────────────────────
  async _getAccessToken() {
    // Cache 55 minutes (real TTL is 1h)
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const { data } = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        client_id:     this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type:    'refresh_token',
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: this.timeoutMs }
    );
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    return this.token;
  }

  // ─── Rate limiter: serialised pacing at 3 req/s ──────────────────────────
  async _paceGate() {
    const interval = 1000 / RATE_PER_SECOND;
    const wait = Math.max(0, this._lastRequestAt + interval - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastRequestAt = Date.now();
  }

  // ─── Core request with retry/backoff ─────────────────────────────────────
  // All requests funnel through here — sequentially chained via _chain so
  // pacing and 429 backoff apply globally, not per-call.
  _request(method, path, { params, body, isRetryAfterRefresh = false } = {}) {
    const run = async () => {
      await this._paceGate();
      const token = await this._getAccessToken();
      const url = `${this.baseURL}${path}`;
      try {
        const res = await axios({
          method,
          url,
          params,
          data: body,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
          validateStatus: () => true, // handle status manually
        });
        this.lastBucketLevel = res.headers['x-ls-api-bucket-level'] || this.lastBucketLevel;

        if (res.status >= 200 && res.status < 300) return res.data;

        // 401 → refresh once and retry
        if (res.status === 401 && !isRetryAfterRefresh) {
          this.token = null;
          this.tokenExpiresAt = 0;
          return await this._request(method, path, { params, body, isRetryAfterRefresh: true });
        }

        // 429 → backoff and retry up to N
        if (res.status === 429) {
          for (let attempt = 1; attempt <= MAX_RETRIES_429; attempt++) {
            const waitMs = Number(res.headers['retry-after']) * 1000 || DEFAULT_429_WAIT_MS;
            await new Promise(r => setTimeout(r, waitMs));
            const retryRes = await axios({
              method, url, params, data: body,
              headers: { Authorization: `Bearer ${await this._getAccessToken()}`, 'Content-Type': 'application/json' },
              timeout: this.timeoutMs,
              validateStatus: () => true,
            });
            this.lastBucketLevel = retryRes.headers['x-ls-api-bucket-level'] || this.lastBucketLevel;
            if (retryRes.status >= 200 && retryRes.status < 300) return retryRes.data;
            if (retryRes.status !== 429) {
              throw new LightspeedError(
                `${method} ${path} failed after 429 retry: HTTP ${retryRes.status}`,
                { method, path, status: retryRes.status, body: retryRes.data }
              );
            }
          }
          throw new LightspeedError(
            `${method} ${path} still 429 after ${MAX_RETRIES_429} retries`,
            { method, path, status: 429 }
          );
        }

        // 5xx → exponential backoff, retry up to N
        if (res.status >= 500 && res.status < 600) {
          for (let attempt = 1; attempt <= MAX_RETRIES_5XX; attempt++) {
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
            const retryRes = await axios({
              method, url, params, data: body,
              headers: { Authorization: `Bearer ${await this._getAccessToken()}`, 'Content-Type': 'application/json' },
              timeout: this.timeoutMs,
              validateStatus: () => true,
            });
            this.lastBucketLevel = retryRes.headers['x-ls-api-bucket-level'] || this.lastBucketLevel;
            if (retryRes.status >= 200 && retryRes.status < 300) return retryRes.data;
            if (retryRes.status < 500 || retryRes.status >= 600) {
              throw new LightspeedError(
                `${method} ${path} failed after 5xx retry: HTTP ${retryRes.status}`,
                { method, path, status: retryRes.status, body: retryRes.data }
              );
            }
          }
          throw new LightspeedError(
            `${method} ${path} still 5xx after ${MAX_RETRIES_5XX} retries`,
            { method, path, status: res.status }
          );
        }

        // Any other 4xx → non-retryable, surface as structured error
        throw new LightspeedError(
          `${method} ${path} → HTTP ${res.status}`,
          { method, path, status: res.status, body: res.data }
        );
      } catch (e) {
        if (e instanceof LightspeedError) throw e;
        // Network / timeout — retry once
        if (!isRetryAfterRefresh && (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED')) {
          await new Promise(r => setTimeout(r, 2000));
          return await this._request(method, path, { params, body, isRetryAfterRefresh: true });
        }
        throw new LightspeedError(
          `${method} ${path} network error: ${e.message}`,
          { method, path, cause: e }
        );
      }
    };
    // Chain into the serialised queue: every request awaits the previous one
    const next = this._chain.then(run, run); // run regardless of prior outcome
    // Prevent the chain from breaking on rejection
    this._chain = next.catch(() => {});
    return next;
  }

  // ═══════════════════════ Domain methods ══════════════════════════════════

  // GET /ItemMatrix?description=~,styleRef% — matrices whose description
  // starts with the styleRef. Matches bare "99103" AND "99103 a26".
  async searchMatrixByPrefix(styleRef, limit = 100) {
    if (!styleRef) throw new Error('searchMatrixByPrefix: styleRef required');
    const data = await this._request('GET', '/ItemMatrix.json', {
      params: { description: `~,${styleRef}%`, limit },
    });
    let arr = data.ItemMatrix ?? [];
    if (!Array.isArray(arr)) arr = [arr];
    return arr;
  }

  // GET /ItemMatrix/{id}?load_relations=["Items"] — variants list.
  // Note: does NOT include per-variant Tags; use getItemWithTags() for that.
  async getMatrixWithVariants(matrixId) {
    if (!matrixId) throw new Error('getMatrixWithVariants: matrixId required');
    const data = await this._request('GET', `/ItemMatrix/${matrixId}.json`, {
      params: { load_relations: '["Items"]' },
    });
    const m = data.ItemMatrix ?? {};
    let items = m.Items?.Item ?? [];
    if (!Array.isArray(items)) items = [items];
    return { matrix: m, items };
  }

  // GET /Item/{id}?load_relations=["Tags","ItemAttributes"] — variant + tags + attributes
  async getItemWithTags(itemId) {
    if (!itemId) throw new Error('getItemWithTags: itemId required');
    const data = await this._request('GET', `/Item/${itemId}.json`, {
      params: { load_relations: '["Tags","ItemAttributes"]' },
    });
    return data.Item ?? null;
  }

  // GET /Item?itemMatrixID=X&load_relations=["Tags","ItemAttributes"]
  // Returns ALL variants of a matrix in one call, with tags and attributes
  // eagerly loaded. Replaces the naive pattern of 1 call per variant.
  //
  // Paginates by extracting the `after` cursor from @attributes.next and
  // re-issuing with the original params. We cannot just follow next URL
  // verbatim: Lightspeed's next URL carries only cursor/sort/limit, so
  // load_relations and filters would be dropped on page 2+ (silent data loss
  // where tags/attributes go missing on later pages). Same trick sync.js uses
  // in rebuildUrl().
  async listVariantsForMatrix(matrixId, limit = 100) {
    if (!matrixId) throw new Error('listVariantsForMatrix: matrixId required');
    const out = [];
    const baseParams = {
      itemMatrixID:   matrixId,
      load_relations: '["Tags","ItemAttributes"]',
      limit,
    };
    let after = null;
    for (;;) {
      const params = after ? { ...baseParams, after } : baseParams;
      const response = await this._request('GET', '/Item.json', { params });
      let items = response.Item ?? [];
      if (!Array.isArray(items)) items = [items];
      out.push(...items);
      const nextUrl = response['@attributes']?.next;
      if (!nextUrl) break;
      const parsed = new URL(nextUrl);
      after = parsed.searchParams.get('after');
      if (!after) break; // defensive: next present but no cursor → stop
    }
    return out;
  }

  // GET /Category.json — paginated list of all categories. Returns flat
  // array; parent-child relationships are in categoryID / parentID fields
  // on each row (Lightspeed doesn't have a native tree endpoint).
  async listCategories(limit = 100) {
    const out = [];
    const baseParams = { limit };
    let after = null;
    for (;;) {
      const params = after ? { ...baseParams, after } : baseParams;
      const response = await this._request('GET', '/Category.json', { params });
      let items = response.Category ?? [];
      if (!Array.isArray(items)) items = [items];
      out.push(...items);
      const nextUrl = response['@attributes']?.next;
      if (!nextUrl) break;
      const parsed = new URL(nextUrl);
      after = parsed.searchParams.get('after');
      if (!after) break;
    }
    return out;
  }

  // GET /Vendor.json — paginated list of all vendors on the account.
  // Returns [{vendorID, name, ...}]. Used by the brand→vendor mapping UI
  // so operators can pick from the actual Lightspeed vendor list rather
  // than hand-typing IDs.
  async listVendors(limit = 100) {
    const out = [];
    const baseParams = { limit, sort: 'name' };
    let after = null;
    for (;;) {
      const params = after ? { ...baseParams, after } : baseParams;
      const response = await this._request('GET', '/Vendor.json', { params });
      let items = response.Vendor ?? [];
      if (!Array.isArray(items)) items = [items];
      out.push(...items);
      const nextUrl = response['@attributes']?.next;
      if (!nextUrl) break;
      const parsed = new URL(nextUrl);
      after = parsed.searchParams.get('after');
      if (!after) break;
    }
    return out;
  }

  // POST /ItemMatrix — creates the matrix shell. Variants are created
  // separately with createItemVariant(). Payload shape is the caller's
  // responsibility (built by the queue processor from parser output).
  async createMatrix(payload) {
    if (!payload) throw new Error('createMatrix: payload required');
    const data = await this._request('POST', '/ItemMatrix.json', { body: payload });
    return data.ItemMatrix ?? data;
  }

  // POST /Item — creates one variant of a matrix.
  async createItemVariant(payload) {
    if (!payload) throw new Error('createItemVariant: payload required');
    if (!payload.itemMatrixID) throw new Error('createItemVariant: payload.itemMatrixID required');
    const data = await this._request('POST', '/Item.json', { body: payload });
    return data.Item ?? data;
  }

  // Tag application on a variant we just created.
  // - Enforces FORBIDDEN_TAGS: throws if caller passes 'add' (or any future forbidden entry)
  // - Preserves any existing tags on the item (GET-then-merge-then-PUT)
  // - Idempotent: if all requested tags are already present, no PUT is made
  async tagItem(itemId, tagsToAdd) {
    if (!itemId) throw new Error('tagItem: itemId required');
    if (!Array.isArray(tagsToAdd) || !tagsToAdd.length) {
      throw new Error('tagItem: tagsToAdd must be a non-empty array of strings');
    }
    const requested = tagsToAdd.map(t => String(t).trim()).filter(Boolean);
    const forbidden = requested.filter(t => FORBIDDEN_TAGS.includes(t.toLowerCase()));
    if (forbidden.length) {
      throw new LightspeedError(
        `tagItem: refused to apply forbidden tags [${forbidden.join(', ')}] to item ${itemId}. ` +
        `FORBIDDEN_TAGS is reserved for external tooling (e.g. Shopify sync).`,
        { method: 'PUT', path: `/Item/${itemId}`, status: null }
      );
    }

    // GET current tags
    const item = await this.getItemWithTags(itemId);
    const existing = _extractTagNames(item?.Tags);
    const merged = _uniqueCaseInsensitive([...existing, ...requested]);

    // No-op if nothing new
    if (merged.length === existing.length && merged.every(t => existing.some(e => e.toLowerCase() === t.toLowerCase()))) {
      return { itemId, tags: existing, skipped: 'already_present' };
    }

    const putBody = {
      Tags: { tag: merged.map(name => ({ name })) },
    };
    const data = await this._request('PUT', `/Item/${itemId}.json`, { body: putBody });
    return { itemId, tags: merged, response: data.Item ?? data };
  }

  // Tag application on a MATRIX (not to be confused with tagItem() which
  // targets a variant). Confirmed 2026-08 during B8.5: tags do NOT propagate
  // from matrix to its variants (and vice-versa), so both levels must be
  // tagged explicitly. Same FORBIDDEN_TAGS guard, same GET-merge-PUT to
  // preserve any existing tags on the matrix.
  async tagMatrix(matrixId, tagsToAdd) {
    if (!matrixId) throw new Error('tagMatrix: matrixId required');
    if (!Array.isArray(tagsToAdd) || !tagsToAdd.length) {
      throw new Error('tagMatrix: tagsToAdd must be a non-empty array');
    }
    const requested = tagsToAdd.map(t => String(t).trim()).filter(Boolean);
    const forbidden = requested.filter(t => FORBIDDEN_TAGS.includes(t.toLowerCase()));
    if (forbidden.length) {
      throw new LightspeedError(
        `tagMatrix: refused to apply forbidden tags [${forbidden.join(', ')}] to matrix ${matrixId}. ` +
        `FORBIDDEN_TAGS is reserved for external tooling (e.g. Shopify sync).`,
        { method: 'PUT', path: `/ItemMatrix/${matrixId}`, status: null }
      );
    }

    const data = await this._request('GET', `/ItemMatrix/${matrixId}.json`, {
      params: { load_relations: '["Tags"]' },
    });
    const matrix = data.ItemMatrix ?? {};
    const existing = _extractTagNames(matrix.Tags);
    const merged = _uniqueCaseInsensitive([...existing, ...requested]);

    if (merged.length === existing.length && merged.every(t => existing.some(e => e.toLowerCase() === t.toLowerCase()))) {
      return { matrixId, tags: existing, skipped: 'already_present' };
    }

    const putBody = { Tags: { tag: merged.map(name => ({ name })) } };
    const res = await this._request('PUT', `/ItemMatrix/${matrixId}.json`, { body: putBody });
    return { matrixId, tags: merged, response: res.ItemMatrix ?? res };
  }

  // POST /Order — creates an empty PO header. OrderLines are added separately.
  async createOrder(payload) {
    if (!payload) throw new Error('createOrder: payload required');
    const data = await this._request('POST', '/Order.json', { body: payload });
    return data.Order ?? data;
  }

  // POST /OrderLine — adds one line to a PO.
  // The `orderId` argument is for clarity/logging; Lightspeed reads orderID
  // from the payload itself.
  async createOrderLine(orderId, payload) {
    if (!orderId) throw new Error('createOrderLine: orderId required');
    if (!payload) throw new Error('createOrderLine: payload required');
    if (String(payload.orderID) !== String(orderId)) {
      throw new Error(`createOrderLine: payload.orderID (${payload.orderID}) mismatch with arg orderId (${orderId})`);
    }
    const data = await this._request('POST', '/OrderLine.json', { body: payload });
    return data.OrderLine ?? data;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────
// Lightspeed returns Tags in one of several shapes; normalise to string[].
function _extractTagNames(tagsField) {
  if (!tagsField) return [];
  const raw = tagsField.tag ?? tagsField.Tag ?? tagsField;
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .map(t => (typeof t === 'string' ? t : (t.name ?? t.Name)))
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter(Boolean);
}

function _uniqueCaseInsensitive(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

// Convenience factory: build from env vars.
function fromEnv() {
  return new LightspeedClient({
    accountId:    process.env.LIGHTSPEED_ACCOUNT_ID,
    clientId:     process.env.LIGHTSPEED_CLIENT_ID,
    clientSecret: process.env.LIGHTSPEED_CLIENT_SECRET,
    refreshToken: process.env.LIGHTSPEED_REFRESH_TOKEN,
  });
}

module.exports = { LightspeedClient, LightspeedError, FORBIDDEN_TAGS, fromEnv };
