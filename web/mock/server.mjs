// A local stand-in for Supabase, so the real pages can be driven end to end
// without a project. It serves web/ as static files as well, so
// http://localhost:8787/c/ is the check-in page exactly as it ships and
// http://localhost:8787/admin/ is the review queue exactly as it ships.
//
// The anonymous check-in half is below. The officer half (passcode auth,
// PostgREST with a stand-in for RLS, the two officer RPCs, signed photo URLs)
// lives in admin-server.mjs and is routed to from here, so nothing added for
// the review queue can change how the check-in page behaves.
//
// It is not a Postgres emulator. It reproduces the parts of
// supabase/migrations/20260811101000_rpcs.sql the client has to survive:
// the return shapes, the PDS* error codes, the check-in window, the unique
// index behind PDS05, the one-shot upload grant, and the rate limiter.
//
// It is also stricter than the real thing in one deliberate way. See
// NONCE ENFORCEMENT below.
//
//   node web/mock/server.mjs [--port 8787]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENTS, MEMBERS, ACADEMIC_YEAR_ID } from './fixtures.mjs';
import {
  ADMIN_RPC,
  adminState,
  handleAuth,
  handleRest,
  handleStorageDelete,
  handleStorageInfo,
  handleStorageSign,
  resetAdmin,
  serveSignedObject,
} from './admin-server.mjs';
import { MOCK_PASSCODE } from './admin-fixtures.mjs';

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 8787;
const ANON_KEY = 'mock-anon-key';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const nonces = new Map(); // nonce -> { eventId, issuedAt }
const grants = new Map(); // upload_token -> { eventId, memberId, kind, objectPath, consumed, uploaded }
const pathToGrant = new Map(); // object_path -> upload_token
const submissions = []; // filed attendance records
const counters = new Map(); // token -> { submits }
const audit = { calls: [], violations: [] };

const reset = () => {
  nonces.clear();
  grants.clear();
  pathToGrant.clear();
  submissions.length = 0;
  counters.clear();
  audit.calls.length = 0;
  audit.violations.length = 0;
  // The officer fixtures are rebuilt from scratch rather than rewound, so one
  // check can never leave an approved record behind for the next one.
  resetAdmin();
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
};

/** The PostgREST error body shape: code, message, details, hint. */
const pds = (res, code, message) =>
  json(res, 400, { code, message, details: null, hint: null });

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
};

function record(entry) {
  audit.calls.push({ at: new Date().toISOString(), ...entry });
}

function violation(entry) {
  audit.violations.push({ at: new Date().toISOString(), ...entry });
  process.stderr.write(`\n  NONCE VIOLATION  ${JSON.stringify(entry)}\n`);
}

// ---------------------------------------------------------------------------
// NONCE ENFORCEMENT
// ---------------------------------------------------------------------------
// The real database treats a missing or invalid client_nonce as a shrug: it
// silently drops the caller into the rate-limit bucket the whole event shares,
// and everything keeps working. That is the failure this mock exists to catch,
// because it only bites at a 167-person GBM and never in a test.
//
// So the mock refuses the call outright and records a violation. A refactor
// that drops the nonce from any of the three call sites fails loudly here
// instead of passing quietly and failing at an event.
// ---------------------------------------------------------------------------

function requireNonce(res, fn, token, event, body) {
  const nonce = body.p_client_nonce;
  if (!nonce) {
    violation({ fn, token, reason: 'p_client_nonce was missing from the request body' });
    pds(
      res,
      'PDSMOCK01',
      `${fn}() was called with no client_nonce. The real server would silently fall back to the shared per-event rate-limit bucket, which works in testing and turns away most of the room at a real event. Pass the client_nonce from get_checkin_context().`,
    );
    return null;
  }
  const known = nonces.get(nonce);
  if (!known) {
    violation({ fn, token, nonce, reason: 'nonce was never issued by get_checkin_context()' });
    pds(res, 'PDSMOCK02', `${fn}() sent a client_nonce this server never issued.`);
    return null;
  }
  if (known.eventId !== event.event.id) {
    violation({ fn, token, nonce, reason: 'nonce belongs to a different event' });
    pds(res, 'PDSMOCK03', `${fn}() sent a client_nonce issued for a different event.`);
    return null;
  }
  return nonce;
}

// ---------------------------------------------------------------------------
// Shared token resolution, mirroring fn_checkin_event()
// ---------------------------------------------------------------------------

function resolveEvent(res, fn, token, body, { enforceWindow }) {
  // A refusal is still a call that arrived, so it belongs in the audit exactly
  // like an accepted one. Leaving it out makes a client that retried a refusal
  // four times indistinguishable from one that showed it once, because both
  // record nothing: the count reads zero either way, and the check that exists
  // to catch the retry cannot see it. The oddstatus branch in
  // get_checkin_context() already records its refusal for this reason; these
  // are the same thing raised a few lines earlier.
  const refuse = (code, message) => {
    record({ fn, token, nonce: body?.p_client_nonce ?? null, outcome: code });
    pds(res, code, message);
    return null;
  };

  const event = EVENTS[token];
  if (!event) return refuse('PDS01', 'That check-in link is not valid.');

  const window = event.behaviour?.window;

  // PDS02 and PDS10 are separate codes on purpose. One asks the member to come
  // back later, the other asks them to go and find an officer, and a client
  // that cannot tell them apart shows the wrong one.
  if (window === 'early') {
    return refuse('PDS02', 'Check-in for this event has not opened yet.');
  }

  // Closed before the page even loaded. Inside the grace period submit_checkin
  // is more forgiving and files the record with an outside_window flag, which
  // is why this one only fires when the window is being enforced.
  if (window === 'closed' && enforceWindow) {
    return refuse('PDS10', 'Check-in for this event has closed.');
  }

  // Loaded while check-in was open, submitted after the grace period ran out.
  // This is the one route by which PDS10 reaches somebody who is already
  // filling the form in, so it needs its own screen.
  if (window === 'closed_past_grace' && !enforceWindow) {
    return refuse('PDS10', 'Check-in for this event has closed.');
  }

  return event;
}

// ---------------------------------------------------------------------------
// The four RPCs
// ---------------------------------------------------------------------------

const RPC = {
  get_checkin_context(res, body) {
    const token = body.p_token;

    // PostgREST does not recognise the PDS SQLSTATE class, so a raise carrying
    // errcode 'PDS01' may reach the browser as a 500 rather than a 400. This
    // token reproduces that, because a client that reads 500 as "the network
    // hiccuped" would retry a refusal four times before showing it.
    if (token === 'oddstatus') {
      const counter = counters.get(token) ?? { submits: 0, calls: 0 };
      counter.calls = (counter.calls ?? 0) + 1;
      counters.set(token, counter);
      record({ fn: 'get_checkin_context', token, outcome: 'PDS01 as HTTP 500' });
      json(res, 500, {
        code: 'PDS01',
        message: 'That check-in link is not valid.',
        details: null,
        hint: null,
      });
      return;
    }
    const event = resolveEvent(res, 'get_checkin_context', token, body, { enforceWindow: true });
    if (!event) return;

    const nonce = randomBytes(16).toString('hex');
    nonces.set(nonce, { eventId: event.event.id, issuedAt: Date.now() });
    record({ fn: 'get_checkin_context', token, issuedNonce: nonce });

    json(res, 200, {
      client_nonce: nonce,
      event: event.event,
      categories: event.categories,
      collect_value: event.collect_value,
      evidence_requirements: event.evidence_requirements,
    });
  },

  search_members(res, body) {
    const token = body.p_token;
    const event = resolveEvent(res, 'search_members', token, body, { enforceWindow: true });
    if (!event) return;
    const nonce = requireNonce(res, 'search_members', token, event, body);
    if (!nonce) return;

    const q = String(body.p_q ?? '').trim();
    if (q.length < 3) {
      pds(res, 'PDS03', 'Type at least three letters of your name.');
      return;
    }
    record({ fn: 'search_members', token, nonce, q });

    if (event.behaviour?.emptyRoster) {
      json(res, 200, []);
      return;
    }

    const needle = q.toLowerCase();
    const rows = MEMBERS.filter((m) => m.display_name.toLowerCase().includes(needle))
      .sort((a, b) => {
        const aPrefix = a.display_name.toLowerCase().startsWith(needle) ? 0 : 1;
        const bPrefix = b.display_name.toLowerCase().startsWith(needle) ? 0 : 1;
        return aPrefix - bPrefix || a.display_name.localeCompare(b.display_name);
      })
      .slice(0, 10);
    json(res, 200, rows);
  },

  create_evidence_upload(res, body) {
    const token = body.p_token;
    const event = resolveEvent(res, 'create_evidence_upload', token, body, { enforceWindow: true });
    if (!event) return;
    const nonce = requireNonce(res, 'create_evidence_upload', token, event, body);
    if (!nonce) return;

    const kind = body.p_kind;
    const wanted = event.evidence_requirements.some((r) => r.kind === kind);
    if (!wanted) {
      pds(res, 'PDS04', 'This event does not collect that kind of photo.');
      return;
    }

    // Outstanding grants are counted per member when there is one, and per
    // client nonce when there is not, matching the SQL. Counting unmatched
    // callers together would give the whole room one allowance of three, which
    // on an empty roster is the whole room.
    const memberId = body.p_member_id ?? null;
    const outstanding = [...grants.values()].filter(
      (g) =>
        g.eventId === event.event.id &&
        !g.consumed &&
        (memberId ? g.memberId === memberId : g.memberId === null && g.clientNonce === nonce),
    ).length;
    if (outstanding >= 3) {
      pds(
        res,
        'PDS04',
        'There are already several photo uploads pending for you at this event. Finish or abandon one before starting another.',
      );
      return;
    }

    const outstandingForEvent = [...grants.values()].filter(
      (g) => g.eventId === event.event.id && !g.consumed,
    ).length;
    if (outstandingForEvent >= 1200) {
      pds(res, 'PDS04', 'Too many photo uploads are pending for this event. Please try again shortly.');
      return;
    }

    const uploadToken = randomBytes(16).toString('hex');
    const objectPath = `${ACADEMIC_YEAR_ID}/${event.event.id}/${kind}/${randomBytes(16).toString('hex')}.jpg`;
    grants.set(uploadToken, {
      eventId: event.event.id,
      memberId,
      clientNonce: nonce,
      kind,
      objectPath,
      consumed: false,
      uploaded: false,
    });
    pathToGrant.set(objectPath, uploadToken);
    record({ fn: 'create_evidence_upload', token, nonce, kind, objectPath });

    json(res, 200, {
      upload_token: uploadToken,
      bucket: 'evidence',
      object_path: objectPath,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
  },

  submit_checkin(res, body, req) {
    const token = body.p_token;
    const event = resolveEvent(res, 'submit_checkin', token, body, { enforceWindow: false });
    if (!event) return;
    const nonce = requireNonce(res, 'submit_checkin', token, event, body);
    if (!nonce) return;

    const counter = counters.get(token) ?? { submits: 0 };
    counter.submits += 1;
    counters.set(token, counter);

    // Bad wifi: the connection dies after the request was sent, so the client
    // cannot know whether it landed. Here it did not.
    if (counter.submits <= (event.behaviour?.dropSubmits ?? 0)) {
      record({ fn: 'submit_checkin', token, nonce, outcome: 'connection dropped' });
      req.destroy();
      return;
    }

    // The limiter, which means "come back", not "no".
    if (counter.submits <= (event.behaviour?.rateLimitSubmits ?? 0) + (event.behaviour?.dropSubmits ?? 0)) {
      record({ fn: 'submit_checkin', token, nonce, outcome: 'PDS09' });
      pds(res, 'PDS09', 'Too many requests. Please wait a moment and try again.');
      return;
    }

    const memberId = body.p_member_id ?? null;
    const claimedName = String(body.p_claimed_name ?? '').trim();
    if (!memberId && !claimedName) {
      pds(res, 'PDS03', 'Pick your name from the list, or tell us your full name.');
      return;
    }

    const flags = [];
    if (!memberId) flags.push('unmatched_name');
    if (event.behaviour?.window === 'closed') flags.push('outside_window');

    if (event.behaviour?.alwaysDuplicate) {
      record({ fn: 'submit_checkin', token, nonce, outcome: 'PDS05' });
      pds(res, 'PDS05', 'You are already checked in to this event.');
      return;
    }

    // The partial unique index: one live record per member per event.
    if (
      memberId &&
      submissions.some((s) => s.eventId === event.event.id && s.memberId === memberId)
    ) {
      record({ fn: 'submit_checkin', token, nonce, outcome: 'PDS05' });
      pds(res, 'PDS05', 'You are already checked in to this event.');
      return;
    }

    if (event.collect_value) {
      if (body.p_value === null || body.p_value === undefined) {
        pds(
          res,
          'PDS03',
          'This event needs a number (hours, for example) before it can be submitted.',
        );
        return;
      }
      if (Number(body.p_value) < 0) {
        pds(res, 'PDS03', 'That value cannot be negative.');
        return;
      }
    }

    const evidence = Array.isArray(body.p_evidence) ? body.p_evidence : [];
    const givenKinds = [];
    for (const item of evidence) {
      const grant = grants.get(item.upload_token);
      if (!grant || grant.consumed || grant.eventId !== event.event.id) {
        pds(res, 'PDS04', 'That photo upload is no longer valid. Please retake it.');
        return;
      }
      grant.consumed = true;
      givenKinds.push(grant.kind);
    }

    const missing = event.evidence_requirements.filter(
      (r) => r.is_required && !givenKinds.includes(r.kind),
    );
    if (missing.length) flags.push('missing_evidence');

    const recordId = randomBytes(16).toString('hex');
    submissions.push({
      id: recordId,
      eventId: event.event.id,
      memberId,
      claimedName: claimedName || null,
      claimedEmail: body.p_claimed_email ?? null,
      value: body.p_value ?? null,
      evidence: evidence.map((e) => ({ ...e })),
      flags,
    });
    record({
      fn: 'submit_checkin',
      token,
      nonce,
      outcome: 'filed',
      memberId,
      claimedName: claimedName || null,
      value: body.p_value ?? null,
      evidenceCount: evidence.length,
      flags,
    });

    json(res, 200, { record_id: recordId, status: 'pending', flags });
  },
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function handleStorage(req, res, url) {
  // POST /storage/v1/object/evidence/<object path>
  const prefix = '/storage/v1/object/';
  const rest = decodeURIComponent(url.pathname.slice(prefix.length));
  const [bucket, ...pathParts] = rest.split('/');
  const objectPath = pathParts.join('/');

  if (req.method !== 'POST') {
    // The bucket policies grant anon INSERT only, so anything else is refused
    // exactly as Storage would refuse it.
    json(res, 403, { error: 'Unauthorized', message: 'new row violates row-level security policy' });
    return;
  }

  const uploadToken = pathToGrant.get(objectPath);
  const grant = uploadToken ? grants.get(uploadToken) : null;
  if (!grant || grant.consumed) {
    json(res, 403, {
      error: 'Unauthorized',
      message: 'new row violates row-level security policy for table "objects"',
    });
    return;
  }
  if (grant.uploaded) {
    json(res, 409, { error: 'Duplicate', message: 'The resource already exists' });
    return;
  }

  const body = await readBody(req);
  grant.uploaded = true;
  grant.byteSize = body.length;
  grant.contentType = req.headers['content-type'];
  record({
    fn: 'storage.upload',
    bucket,
    objectPath,
    byteSize: body.length,
    contentType: req.headers['content-type'],
  });

  json(res, 200, { Key: `${bucket}/${objectPath}`, Id: uploadToken });
}

// ---------------------------------------------------------------------------
// Static files, including a config.js pointed at this server
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

async function serveStatic(req, res, url) {
  let pathname = url.pathname;

  // The only file the mock substitutes. Everything else, including the page and
  // every module under src/, is served exactly as it ships: the two constants
  // below are precisely what changes between this and a real project.
  if (pathname === '/config.js') {
    // Matches by which exported constant a line assigns, not by the literal
    // placeholder text: config.js is meant to carry real project values once
    // an officer fills it in, and a match on 'YOUR-PROJECT-REF' would silently
    // stop working the moment it does, sending this page's real fetches at
    // whatever production project happens to be configured.
    const source = await readFile(join(WEB_ROOT, 'config.js'), 'utf8');
    const patched = source
      .replace(
        /export const SUPABASE_URL = .*;/,
        `export const SUPABASE_URL = 'http://localhost:${PORT}';`,
      )
      .replace(
        /export const SUPABASE_ANON_KEY =[\s\S]*?;/,
        `export const SUPABASE_ANON_KEY = '${ANON_KEY}';`,
      );
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
    res.end(patched);
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = join(WEB_ROOT, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// ---------------------------------------------------------------------------

export function startMock(port = PORT) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      });
      res.end();
      return;
    }

    // What the page asked for, and anything it got wrong. Used by verify.mjs
    // and worth reading by hand after a manual run.
    if (url.pathname === '/__mock/audit') {
      json(res, 200, {
        calls: audit.calls,
        violations: audit.violations,
        submissions,
        grants: [...grants.values()],
        admin: adminState(),
      });
      return;
    }
    if (url.pathname === '/__mock/reset') {
      reset();
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith('/auth/v1/')) {
      const raw = await readBody(req);
      let body = {};
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        body = {};
      }
      if (handleAuth(req, res, url, body, { json, pds })) return;
      json(res, 404, { error: 'not found', message: `No auth endpoint ${url.pathname}` });
      return;
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const name = url.pathname.slice('/rest/v1/rpc/'.length);
      const handler = RPC[name] ?? ADMIN_RPC[name];
      if (!handler) {
        json(res, 404, {
          code: 'PGRST202',
          message: `Could not find the function public.${name} in the schema cache`,
        });
        return;
      }
      const raw = await readBody(req);
      let body;
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        json(res, 400, { code: 'PGRST102', message: 'Invalid JSON body' });
        return;
      }
      handler(res, body, req, { json, pds }, ANON_KEY);
      return;
    }

    // Everything else under /rest/v1/ is a table, which only a signed-in
    // officer surface ever touches. The anonymous page reaches no table at all.
    if (url.pathname.startsWith('/rest/v1/')) {
      const raw = await readBody(req);
      let body = null;
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : null;
      } catch {
        json(res, 400, { code: 'PGRST102', message: 'Invalid JSON body' });
        return;
      }
      handleRest(req, res, url, body, { json, pds }, ANON_KEY);
      return;
    }

    // Signing has to be matched before the upload route below, because both
    // live under /storage/v1/object/.
    if (url.pathname === '/storage/v1/object/sign/evidence' && req.method === 'POST') {
      const raw = await readBody(req);
      let body = {};
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        body = {};
      }
      handleStorageSign(req, res, url, body, { json, pds }, ANON_KEY);
      return;
    }

    if (url.pathname.startsWith('/storage/v1/object/sign/evidence/')) {
      serveSignedObject(res, url, { json });
      return;
    }

    // The purge screen's bulk delete: deleteEvidenceObjects() (src/rest.js)
    // sends a DELETE straight to the bucket, not to an object path, so this
    // has to be matched before the upload route below, the same way signing
    // is.
    if (url.pathname === '/storage/v1/object/evidence' && req.method === 'DELETE') {
      const raw = await readBody(req);
      let body = {};
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        body = {};
      }
      handleStorageDelete(req, res, url, body, { json, pds }, ANON_KEY);
      return;
    }

    // evidenceObjectExists() (src/rest.js): the one question a bulk delete's
    // response cannot answer for a path it did not echo back. Matched before
    // the generic upload route below, the same way signing and the bulk
    // delete are.
    if (
      url.pathname.startsWith('/storage/v1/object/info/evidence/') &&
      req.method === 'GET'
    ) {
      handleStorageInfo(req, res, url, { json, pds }, ANON_KEY);
      return;
    }

    if (url.pathname.startsWith('/storage/v1/object/')) {
      await handleStorage(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  });

  return new Promise((resolve, reject) => {
    // Without this, a port clash leaves the promise pending and the caller
    // waits forever with no output. A verify run that hangs looks exactly like
    // a verify run that is slow, and the honest failure is worth having.
    server.once('error', (err) => {
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `Port ${port} is already in use. Another mock server is probably still running: stop it, or pass a different --port.`,
            )
          : err,
      );
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const server = await startMock(PORT);
  const base = `http://localhost:${PORT}/c/`;
  process.stdout.write(
    [
      `Mock Supabase on http://localhost:${PORT}`,
      '',
      'Check-in scenarios:',
      ...Object.keys(EVENTS).map((token) => `  ${base}?e=${token}`),
      `  ${base}?e=nosuchtoken   (unknown token, PDS01)`,
      '',
      `Review queue:  http://localhost:${PORT}/admin/`,
      `  The passcode box takes ${MOCK_PASSCODE}, which signs in as admin.`,
      '  Anything else is refused, which is the other half worth looking at.',
      '',
      `Member portal:  http://localhost:${PORT}/me/`,
      '  No sign-in. Type a name: Priya Raman, Abigail Catto, Marcus Bell.',
      '',
      'Audit: http://localhost:' + PORT + '/__mock/audit',
      '',
    ].join('\n'),
  );
  void server;
}
