// Authenticated reads and writes, for the signed-in officer screens.
//
// The check-in page touches no table, which is invariant 3 and is why api.js
// only speaks RPC. The review queue is the opposite case: it is behind a login,
// every table it reads is behind RLS keyed on the caller's role, and PostgREST
// with an embedded select fetches the whole queue in one request rather than in
// forty-four.
//
// What is NOT allowed to happen here, ever: writing `status` on an
// attendance_records row. Approving and rejecting go through review_records(),
// resolving an unmatched name goes through resolve_unmatched(). RLS would in
// fact permit an officer to UPDATE the column directly, so this is a rule the
// client keeps rather than one the database enforces, and it is kept because
// those RPCs are also what write the audit trail and what refuse to approve a
// record with no member attached.

import { rpc, API_BASE, authHeaders, withRetries, requestOnce, RpcError } from './api.js';
import { accessToken, SessionExpiredError } from './auth.js';

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/**
 * Filters arrive as { column: 'eq.value' }, which is PostgREST's own spelling,
 * so a reader can compare a call here against the PostgREST documentation
 * without a translation layer in between. Embedded columns use a dotted key,
 * 'events.academic_year_id', exactly as the wire format does.
 */
function queryString({ select, filters = {}, order, limit, extra = {} } = {}) {
  const params = new URLSearchParams();
  if (select) params.set('select', select);
  for (const [column, test] of Object.entries(filters)) {
    if (test !== undefined && test !== null) params.append(column, test);
  }
  if (order) params.set('order', order);
  if (limit) params.set('limit', String(limit));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * One request, with the officer's token on it.
 *
 * A 401 gets exactly one recovery attempt: force a refresh and send it again.
 * Anything past that is a session that is genuinely finished, and the caller
 * turns it into the sign-in screen rather than an error toast, because there
 * is nothing the officer can do about it from where they are.
 */
async function send(path, { method = 'GET', body, prefer, opts = {} } = {}) {
  const run = async (token) =>
    withRetries(async () => {
      const res = await requestOnce(
        `${API_BASE}${path}`,
        {
          method,
          headers: authHeaders(
            {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...(prefer ? { Prefer: prefer } : {}),
            },
            token,
          ),
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        opts.signal,
      );

      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (res.ok) return parsed;

      throw new RpcError(
        parsed?.code ?? `HTTP_${res.status}`,
        parsed?.message ?? parsed?.error ?? `Request failed with status ${res.status}.`,
        res.status,
        parsed?.hint,
      );
    }, opts);

  let token = await accessToken();
  try {
    return await run(token);
  } catch (err) {
    if (!(err instanceof RpcError) || err.status !== 401) throw err;
    token = await accessToken({ force: true });
    return run(token);
  }
}

// ---------------------------------------------------------------------------
// The four verbs the admin screens use
// ---------------------------------------------------------------------------

export async function select(table, options = {}) {
  const rows = await send(`/rest/v1/${table}${queryString(options)}`, { opts: options });
  return Array.isArray(rows) ? rows : [];
}

export async function insert(table, rows, options = {}) {
  return send(`/rest/v1/${table}`, {
    method: 'POST',
    body: rows,
    // merge-duplicates because the one insert this screen makes, enrolling a
    // member so their record can be approved, is something two officers can
    // reasonably do at the same moment. A primary key collision there is not
    // an error worth showing anybody.
    prefer: options.prefer ?? 'return=representation,resolution=merge-duplicates',
    opts: options,
  });
}

export async function patch(table, filters, body, options = {}) {
  return send(`/rest/v1/${table}${queryString({ filters, select: options.select })}`, {
    method: 'PATCH',
    body,
    // return=representation is how the caller learns that RLS matched no row.
    // A PATCH the policy refuses is not an error: it is a 200 with an empty
    // array, and a UI that does not check gets to report success for a write
    // that did not happen. See requirements.js, where an officer editing a
    // PUBLISHED set comes back as exactly that: req_sets_write admits an
    // officer for drafts only, and the empty array is the whole refusal.
    prefer: options.prefer ?? 'return=representation',
    opts: options,
  });
}

/**
 * DELETE, for the one screen that has any: the requirements editor, where
 * removing a requirement removes a row.
 *
 * Same counting rule as patch(). A DELETE whose policy matches no row is a 200
 * with an empty array, not an error, so every caller reads the length rather
 * than assuming the row is gone. On a published set that is exactly what an
 * officer's delete would come back as.
 */
export async function remove(table, filters, options = {}) {
  return send(`/rest/v1/${table}${queryString({ filters, select: options.select })}`, {
    method: 'DELETE',
    prefer: options.prefer ?? 'return=representation',
    opts: options,
  });
}

/** An officer RPC. Same transport as the anonymous ones, with a token on it. */
export async function callRpc(name, args, opts = {}) {
  const token = await accessToken();
  try {
    return await rpc(name, args, { ...opts, accessToken: token });
  } catch (err) {
    if (err instanceof RpcError && err.status === 401) {
      const fresh = await accessToken({ force: true });
      return rpc(name, args, { ...opts, accessToken: fresh });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/**
 * The evidence bucket is private, so an <img src> needs a signed URL. Signing
 * is done in one batch call for the whole screen rather than one per photo,
 * because the routine zone is a wall of forty-three of them and forty-three
 * round trips is a visibly slow screen.
 *
 * Storage answers with a path beginning /object/sign/..., which is relative to
 * /storage/v1. A path that cannot be signed (already purged, never uploaded)
 * comes back with an error field instead, and is simply left out of the map:
 * the card then shows "no photo" rather than a broken image.
 *
 * @returns {Promise<Map<string, string>>} object_path -> full signed URL
 */
export async function signPhotoUrls(paths, { expiresIn = 3600, bucket = 'evidence', ...opts } = {}) {
  const wanted = [...new Set(paths.filter(Boolean))];
  const urls = new Map();
  if (!wanted.length) return urls;

  const signed = await send(`/storage/v1/object/sign/${encodeURIComponent(bucket)}`, {
    method: 'POST',
    body: { expiresIn, paths: wanted },
    opts,
  });

  for (const entry of Array.isArray(signed) ? signed : []) {
    const url = entry?.signedURL ?? entry?.signedUrl;
    if (!url || entry?.error) continue;
    const path = entry.path ?? entry.name;
    urls.set(path, `${API_BASE}/storage/v1${url.startsWith('/') ? '' : '/'}${url}`);
  }
  return urls;
}

/**
 * Removes objects from a private bucket, for the storage screen's purge flow.
 * Storage's bulk delete is a DELETE to the bucket itself with the paths in
 * the body, not one request per photo: a run can name hundreds of objects,
 * and a request per photo is the same "forty-three round trips" problem
 * signPhotoUrls() above already avoids for reading.
 *
 * Deletion is the officer's own RLS, not a grant: migration 12's
 * evidence_delete_officer policy already admits fn_is_officer() on the
 * evidence bucket, so this rides the signed-in session like every other call
 * in this file.
 *
 * @returns {Promise<string[]>} the paths Storage actually reports deleting.
 *   A path that was already gone, or never existed, is simply absent from
 *   this list rather than an error: the caller (storage.js) checks any
 *   absent path with evidenceObjectExists() before deciding whether it is a
 *   real failure or already-gone and safe to finish.
 */
export async function deleteEvidenceObjects(paths, { bucket = 'evidence', ...opts } = {}) {
  const wanted = [...new Set(paths.filter(Boolean))];
  if (!wanted.length) return [];

  const result = await send(`/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: 'DELETE',
    body: { prefixes: wanted },
    opts,
  });

  return (Array.isArray(result) ? result : [])
    .map((entry) => entry?.name)
    .filter(Boolean);
}

/**
 * Whether an object is still in the bucket, for the one question a bulk
 * delete's response cannot answer on its own: a path Storage did not echo
 * back as deleted. That can mean two different things: Storage genuinely
 * failed to remove it (still there, a real failure worth reporting), or the
 * object was already gone before this call ran (deleted out of band, or
 * claimed by a second purge run racing for the same object_path, see
 * purge_evidence()'s eligibility locking in
 * supabase/migrations/20260815100000_storage_ops.sql). Only the first is
 * something an officer needs to hear about; the second is safe to record as
 * finished.
 *
 * Storage's own object-info endpoint answers this directly: 200 with the
 * object's metadata if it is there, an error if it is not. One request per
 * path, not a bulk call: this only runs for the handful of paths a delete
 * call did not confirm, never for the common case of a clean run, so the
 * "forty-three round trips" problem signPhotoUrls() and
 * deleteEvidenceObjects() exist to avoid does not apply here.
 *
 * The route is `/object/info/{bucket}/{path}`, with no `authenticated`
 * segment: that segment belongs to the download routes (`/object/
 * authenticated|public|sign/...`), a different endpoint family, and does not
 * exist on `/object/info`. Confirmed against @supabase/storage-js's own
 * `StorageFileApi.info()`, which builds `${url}/object/info/${bucketId}/
 * ${path}`. Sending the wrong route here would 404 unconditionally, and
 * this function treats any 404 as "confirmed absent", so a wrong route
 * would silently mark objects Storage never actually deleted as finished,
 * the opposite of what the object-info check exists to guard against.
 */
export async function evidenceObjectExists(path, { bucket = 'evidence', ...opts } = {}) {
  const encodedPath = String(path)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  try {
    await send(`/storage/v1/object/info/${encodeURIComponent(bucket)}/${encodedPath}`, {
      opts,
    });
    return true;
  } catch (err) {
    if (err instanceof RpcError && err.status === 404) return false;
    throw err;
  }
}

export { RpcError, SessionExpiredError };
