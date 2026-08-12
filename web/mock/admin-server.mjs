// The officer half of the mock: magic-link auth, PostgREST reads and writes
// with a stand-in for RLS, the two officer RPCs, and signed photo URLs.
//
// It is not a Postgres emulator and it is not GoTrue. It reproduces the parts
// of the real thing the admin screens have to survive, and one part they have
// to be REFUSED by, which is the more valuable half:
//
//   * a request carrying the anon key, or no key, is refused rather than
//     quietly served, so "the queue is behind a login" is a thing this suite
//     can actually prove
//   * profiles.role decides what comes back, so a member account gets nothing
//     from attendance_records rather than everything
//   * review_records() raises PDS06 for an approve on a record with no member,
//     which is the constraint the whole unmatched-name flow exists to satisfy
//   * a PATCH that the policy refuses is a 200 with an empty array, not an
//     error, because that is what PostgREST does and a client that treats it
//     as success reports a write that never happened
//
// Kept in its own file so nothing here can change how the anonymous check-in
// mock behaves. server.mjs imports it and routes to it.

import { randomBytes } from 'node:crypto';
import { buildDatabase, ACCOUNTS } from './admin-fixtures.mjs';

const ACCESS_TTL_SECONDS = 3600;

let db = buildDatabase();

const sessions = new Map(); // access token -> { userId, email, expiresAt }
const refreshTokens = new Map(); // refresh token -> { userId, email }
const magicLinks = new Map(); // email -> the URL the email would contain
const auditCalls = []; // every officer-side request, for the checks to read

export function resetAdmin() {
  db = buildDatabase();
  sessions.clear();
  refreshTokens.clear();
  magicLinks.clear();
  auditCalls.length = 0;
}

export function adminState() {
  return {
    auditLog: db.audit_log,
    calls: auditCalls,
    magicLinks: [...magicLinks.entries()].map(([email, url]) => ({ email, url })),
    attendance: db.attendance_records.map((r) => ({
      id: r.id,
      event_id: r.event_id,
      member_id: r.member_id,
      claimed_name: r.claimed_name,
      status: r.status,
      flags: r.flags,
      review_note: r.review_note,
      reviewed_by: r.reviewed_by,
    })),
    members: db.members.map((m) => ({ id: m.id, display_name: m.display_name, email: m.email })),
    enrollments: db.member_enrollments,
    claims: db.member_claims,
    profiles: db.profiles,
  };
}

const record = (entry) => auditCalls.push({ at: new Date().toISOString(), ...entry });

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A structurally real JWT with a fake signature. The client decodes the payload
 * to learn its own user id without a round trip (see decodeToken in auth.js),
 * so a token that is merely a random string would not exercise that path.
 */
function mintAccessToken(userId, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    sub: userId,
    email,
    role: 'authenticated',
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
  });
  return `${header}.${payload}.mock-signature-not-verified`;
}

function issueSession(userId, email) {
  const access = mintAccessToken(userId, email);
  const refresh = randomBytes(16).toString('hex');
  sessions.set(access, { userId, email, expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000 });
  refreshTokens.set(refresh, { userId, email });
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_SECONDS };
}

const STAFF_ROLES = ['officer', 'admin', 'viewer'];
const OFFICER_ROLES = ['officer', 'admin'];

/**
 * @returns {{kind:'anon'}|{kind:'invalid'}|{kind:'user', userId, email, role, profile}}
 */
export function resolveAuth(req, anonKey) {
  const header = req.headers.authorization ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token || token === anonKey) return { kind: 'anon' };

  const session = sessions.get(token);
  if (!session) return { kind: 'invalid' };
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return { kind: 'invalid' };
  }

  const profile = db.profiles.find((p) => p.user_id === session.userId) ?? null;
  return {
    kind: 'user',
    userId: session.userId,
    email: session.email,
    role: profile?.role ?? 'authenticated',
    profile,
  };
}

const isStaff = (auth) => auth.kind === 'user' && STAFF_ROLES.includes(auth.role);
const isOfficer = (auth) => auth.kind === 'user' && OFFICER_ROLES.includes(auth.role);
const isAdmin = (auth) => auth.kind === 'user' && auth.role === 'admin';

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

export function handleAuth(req, res, url, body, helpers) {
  const { json } = helpers;
  const path = url.pathname;

  if (path === '/auth/v1/otp') {
    const email = String(body?.email ?? '').trim().toLowerCase();
    const redirectTo = url.searchParams.get('redirect_to') ?? 'http://localhost/admin/';
    const account = ACCOUNTS[email];

    // Answered the same way whether or not the address has an account. GoTrue
    // does this so a sign-in form cannot be used to test which addresses
    // exist, and the copy in admin.js is written to match.
    record({ fn: 'auth.otp', email, known: Boolean(account), create_user: body?.create_user });

    if (account) {
      const session = issueSession(account.user_id, email);
      magicLinks.set(
        email,
        `${redirectTo}#access_token=${session.access_token}` +
          `&refresh_token=${session.refresh_token}` +
          `&expires_in=${session.expires_in}&token_type=bearer&type=magiclink`,
      );
    }

    json(res, 200, {});
    return true;
  }

  if (path === '/auth/v1/token') {
    if (url.searchParams.get('grant_type') !== 'refresh_token') {
      json(res, 400, { error: 'unsupported_grant_type', error_description: 'Unsupported grant type' });
      return true;
    }
    const held = refreshTokens.get(String(body?.refresh_token ?? ''));
    if (!held) {
      record({ fn: 'auth.refresh', outcome: 'invalid' });
      json(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
      return true;
    }
    // Rotated, exactly as GoTrue rotates it. A second caller presenting the old
    // one is refused, which is why refreshing is single flight in auth.js.
    refreshTokens.delete(String(body.refresh_token));
    const session = issueSession(held.userId, held.email);
    record({ fn: 'auth.refresh', outcome: 'rotated', userId: held.userId });
    json(res, 200, {
      ...session,
      token_type: 'bearer',
      user: { id: held.userId, email: held.email },
    });
    return true;
  }

  if (path === '/auth/v1/logout') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    sessions.delete(token);
    record({ fn: 'auth.logout' });
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return true;
  }

  return false;
}

/** What clicking the link in the email would open. */
export function magicLinkFor(email) {
  return magicLinks.get(String(email).trim().toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// PostgREST
// ---------------------------------------------------------------------------

const RELATIONS = {
  attendance_records: {
    members: { table: 'members', kind: 'one', from: 'member_id', to: 'id' },
    events: { table: 'events', kind: 'one', from: 'event_id', to: 'id' },
    attendance_evidence: {
      table: 'attendance_evidence',
      kind: 'many',
      from: 'id',
      to: 'attendance_record_id',
    },
  },
  events: {
    event_categories: { table: 'event_categories', kind: 'many', from: 'id', to: 'event_id' },
  },
  event_categories: {
    categories: { table: 'categories', kind: 'one', from: 'category_id', to: 'id' },
  },
  member_claims: {
    members: { table: 'members', kind: 'one', from: 'member_id', to: 'id' },
  },
  attendance_evidence: {
    attendance_records: {
      table: 'attendance_records',
      kind: 'one',
      from: 'attendance_record_id',
      to: 'id',
    },
  },
};

function parseSelect(spec) {
  const text = String(spec ?? '*');
  let at = 0;

  const leaf = (raw) => ({ name: raw.trim(), children: null, inner: false });
  const branch = (raw, children) => {
    const name = raw.trim();
    const inner = name.endsWith('!inner');
    return { name: inner ? name.slice(0, -6) : name, children, inner };
  };

  function list() {
    const out = [];
    let buffer = '';
    while (at < text.length) {
      const char = text[at];
      if (char === ',') {
        at += 1;
        if (buffer.trim()) out.push(leaf(buffer));
        buffer = '';
      } else if (char === '(') {
        at += 1;
        const children = list();
        out.push(branch(buffer, children));
        buffer = '';
      } else if (char === ')') {
        at += 1;
        if (buffer.trim()) out.push(leaf(buffer));
        return out;
      } else {
        buffer += char;
        at += 1;
      }
    }
    if (buffer.trim()) out.push(leaf(buffer));
    return out;
  }

  return list();
}

function matches(row, column, test) {
  const [op, ...rest] = String(test).split('.');
  const wanted = rest.join('.');
  const value = row?.[column];

  switch (op) {
    case 'eq':
      return String(value) === wanted;
    case 'neq':
      return String(value) !== wanted;
    case 'is':
      if (wanted === 'null') return value === null || value === undefined;
      return String(Boolean(value)) === wanted;
    case 'in': {
      const list = wanted
        .replace(/^\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .map((item) => item.trim().replace(/^"|"$/g, ''));
      return list.includes(String(value));
    }
    case 'gt':
      return value > wanted;
    case 'gte':
      return value >= wanted;
    case 'lt':
      return value < wanted;
    case 'lte':
      return value <= wanted;
    default:
      return true;
  }
}

/**
 * The RLS table from docs/01-data-model.md section 8, in the crude form the
 * client can actually be tested against. Reads only: writes are checked at
 * their own call sites below.
 */
function visibleRows(table, auth) {
  const rows = db[table];
  if (!rows) return null;

  if (isStaff(auth)) return rows;

  const memberId = auth.profile?.member_id ?? null;

  switch (table) {
    // Everybody signed in can read the calendar, the categories and the events
    // they are being judged on.
    case 'academic_years':
    case 'terms':
    case 'categories':
    case 'events':
    case 'event_categories':
      return rows;

    case 'profiles':
      return rows.filter((row) => row.user_id === auth.userId);

    case 'member_claims':
      return rows.filter((row) => row.user_id === auth.userId);

    case 'members':
      return memberId ? rows.filter((row) => row.id === memberId) : [];

    case 'member_enrollments':
    case 'attendance_records':
      return memberId ? rows.filter((row) => row.member_id === memberId) : [];

    case 'attendance_evidence':
      return memberId
        ? rows.filter((row) => {
            const parent = db.attendance_records.find((r) => r.id === row.attendance_record_id);
            return parent?.member_id === memberId;
          })
        : [];

    // purge_runs, audit_log, app_settings and everything else are officer or
    // admin only, and a member reading them gets nothing rather than an error,
    // which is what an RLS policy with no matching rows does.
    default:
      return [];
  }
}

/** Filters written for a child, with the child's own prefix taken off. */
function descend(filters, name) {
  const out = {};
  for (const [key, test] of Object.entries(filters)) {
    if (key.startsWith(`${name}.`)) out[key.slice(name.length + 1)] = test;
  }
  return out;
}

const ownFilters = (filters) =>
  Object.fromEntries(Object.entries(filters).filter(([key]) => !key.includes('.')));

function shape(table, row, nodes, auth, filters) {
  const out = {};
  let dropped = false;

  for (const node of nodes) {
    if (node.name === '*') {
      Object.assign(out, row);
      continue;
    }

    if (!node.children) {
      out[node.name] = row[node.name] ?? null;
      continue;
    }

    const relation = RELATIONS[table]?.[node.name];
    if (!relation) {
      out[node.name] = relation?.kind === 'many' ? [] : null;
      continue;
    }

    const childFilters = descend(filters, node.name);
    const own = ownFilters(childFilters);

    let related = (visibleRows(relation.table, auth) ?? []).filter(
      (candidate) => String(candidate[relation.to]) === String(row[relation.from]),
    );
    for (const [column, test] of Object.entries(own)) {
      related = related.filter((candidate) => matches(candidate, column, test));
    }

    if (relation.kind === 'one') {
      out[node.name] = related[0]
        ? shape(relation.table, related[0], node.children, auth, childFilters).row
        : null;
      if (node.inner && !out[node.name]) dropped = true;
    } else {
      out[node.name] = related.map(
        (candidate) => shape(relation.table, candidate, node.children, auth, childFilters).row,
      );
      if (node.inner && !out[node.name].length) dropped = true;
    }
  }

  return { row: out, dropped };
}

function runSelect(table, params, auth) {
  const rows = visibleRows(table, auth);
  if (!rows) return { error: { status: 404, body: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } } };

  const filters = {};
  for (const [key, value] of params.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    filters[key] = value;
  }

  let working = rows;
  for (const [column, test] of Object.entries(ownFilters(filters))) {
    working = working.filter((row) => matches(row, column, test));
  }

  const order = params.get('order');
  if (order) {
    const [column, direction = 'asc'] = order.split('.');
    working = [...working].sort((a, b) => {
      const left = a[column];
      const right = b[column];
      if (left === right) return 0;
      if (left === null || left === undefined) return 1;
      if (right === null || right === undefined) return -1;
      const compare = left < right ? -1 : 1;
      return direction.startsWith('desc') ? -compare : compare;
    });
  }

  const nodes = parseSelect(params.get('select') ?? '*');
  const shaped = [];
  for (const row of working) {
    const result = shape(table, row, nodes, auth, filters);
    if (!result.dropped) shaped.push(result.row);
  }

  const limit = Number(params.get('limit'));
  return { rows: limit ? shaped.slice(0, limit) : shaped };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Who may write what. The insert and update halves of the policies in migration 11. */
const WRITE_POLICY = {
  member_enrollments: (auth) => isOfficer(auth),
  attendance_records: (auth) => isOfficer(auth),
  members: (auth) => isOfficer(auth),
  member_claims: (auth) => isOfficer(auth),
  profiles: (auth) => isAdmin(auth),
};

function runInsert(table, payload, auth) {
  const allowed = WRITE_POLICY[table];
  if (!allowed || !allowed(auth)) {
    return {
      error: {
        status: 403,
        body: {
          code: '42501',
          message: `new row violates row-level security policy for table "${table}"`,
        },
      },
    };
  }

  const incoming = Array.isArray(payload) ? payload : [payload];
  const written = [];

  for (const row of incoming) {
    if (table === 'member_enrollments') {
      const existing = db.member_enrollments.find(
        (e) => e.member_id === row.member_id && e.academic_year_id === row.academic_year_id,
      );
      if (existing) {
        // resolution=merge-duplicates. Two officers pressing the same button is
        // not an error worth showing anybody.
        written.push(existing);
        continue;
      }
      const created = {
        member_id: row.member_id,
        academic_year_id: row.academic_year_id,
        status: row.status ?? 'active',
        joined_on: row.joined_on ?? new Date().toISOString().slice(0, 10),
      };
      db.member_enrollments.push(created);
      written.push(created);
      continue;
    }

    return {
      error: {
        status: 400,
        body: { code: 'PGRST102', message: `The mock does not implement inserts into ${table}` },
      },
    };
  }

  record({ fn: `insert.${table}`, actor: auth.userId, count: written.length });
  return { rows: written };
}

function runPatch(table, params, payload, auth) {
  const rows = visibleRows(table, auth);
  if (!rows) {
    return { error: { status: 404, body: { code: 'PGRST205', message: `Unknown table ${table}` } } };
  }

  const filters = ownFilters(
    Object.fromEntries(
      [...params.entries()].filter(([key]) => !['select', 'order', 'limit'].includes(key)),
    ),
  );

  let targets = rows;
  for (const [column, test] of Object.entries(filters)) {
    targets = targets.filter((row) => matches(row, column, test));
  }

  const allowed = WRITE_POLICY[table];
  if (!allowed || !allowed(auth)) {
    // THE IMPORTANT CASE. PostgREST does not raise here: the USING clause
    // simply matches no row, so the answer is 200 with an empty array. A
    // client that reads that as success reports a write that never happened,
    // which is exactly the officer-versus-admin distinction in claims.js.
    record({ fn: `patch.${table}`, actor: auth.userId, outcome: 'refused by policy', matched: 0 });
    return { rows: [] };
  }

  // profiles.member_id is unique: one roster row cannot be held by two
  // accounts. Enforced here because it is the failure a second claim on the
  // same member would produce.
  if (table === 'profiles' && payload?.member_id) {
    const clash = db.profiles.find(
      (p) => p.member_id === payload.member_id && !targets.includes(p),
    );
    if (clash) {
      return {
        error: {
          status: 409,
          body: {
            code: '23505',
            message: 'duplicate key value violates unique constraint "profiles_member_id_key"',
          },
        },
      };
    }
  }

  for (const row of targets) Object.assign(row, payload);
  record({
    fn: `patch.${table}`,
    actor: auth.userId,
    matched: targets.length,
    payload,
  });
  return { rows: targets.map((row) => ({ ...row })) };
}

export function handleRest(req, res, url, body, helpers, anonKey) {
  const { json } = helpers;
  const table = url.pathname.slice('/rest/v1/'.length);
  const auth = resolveAuth(req, anonKey);

  if (auth.kind === 'anon') {
    // `revoke all on all tables in schema public from anon` is what produces
    // this. The anonymous check-in page never reaches a table, so anything
    // arriving here with the anon key is a bug worth failing loudly.
    record({ fn: `rest.${table}`, outcome: 'refused, anon key' });
    json(res, 401, {
      code: '42501',
      message: `permission denied for table ${table}`,
      details: null,
      hint: null,
    });
    return;
  }

  if (auth.kind === 'invalid') {
    record({ fn: `rest.${table}`, outcome: 'refused, bad or expired token' });
    json(res, 401, { message: 'invalid claim: missing sub claim', code: 'PGRST301' });
    return;
  }

  let result;
  if (req.method === 'GET') {
    result = runSelect(table, url.searchParams, auth);
    record({ fn: `rest.${table}`, actor: auth.userId, role: auth.role, rows: result.rows?.length });
  } else if (req.method === 'POST') {
    result = runInsert(table, body, auth);
  } else if (req.method === 'PATCH') {
    result = runPatch(table, url.searchParams, body, auth);
  } else {
    json(res, 405, { message: 'Method not allowed' });
    return;
  }

  if (result.error) {
    json(res, result.error.status, result.error.body);
    return;
  }

  const prefer = String(req.headers.prefer ?? '');
  if (req.method !== 'GET' && !prefer.includes('return=representation')) {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  json(res, req.method === 'POST' ? 201 : 200, result.rows);
}

// ---------------------------------------------------------------------------
// Officer RPCs
// ---------------------------------------------------------------------------

function audit(auth, action, entityType, entityId, detail) {
  db.audit_log.push({
    id: db.audit_log.length + 1,
    actor_user_id: auth.userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    detail,
    created_at: new Date().toISOString(),
  });
}

export const ADMIN_RPC = {
  /** review_records(p_ids uuid[], p_decision text, p_note text) returns int */
  review_records(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'review_records', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const ids = Array.isArray(body.p_ids) ? body.p_ids : [];
    const decision = body.p_decision;
    if (!['approve', 'reject'].includes(decision)) {
      pds(res, 'PDS03', 'Decision must be approve or reject.');
      return;
    }

    const targets = db.attendance_records.filter((row) => ids.includes(row.id));

    if (decision === 'approve') {
      const unmatched = targets.filter((row) => !row.member_id);
      if (unmatched.length) {
        // The check constraint on attendance_records made this unrepresentable
        // in the database, so the function refuses before it tries.
        record({ fn: 'review_records', outcome: 'PDS06', ids, actor: auth.userId });
        pds(
          res,
          'PDS06',
          `Cannot approve ${unmatched.length} record(s) that are not linked to a member. Resolve the unmatched name first.`,
        );
        return;
      }

      // one_live_record_per_member_event
      for (const row of targets) {
        const clash = db.attendance_records.find(
          (other) =>
            other.id !== row.id &&
            other.event_id === row.event_id &&
            other.member_id === row.member_id &&
            other.member_id !== null &&
            other.status !== 'rejected',
        );
        if (clash) {
          pds(res, 'PDS05', 'That member already has a live record for this event.');
          return;
        }
      }
    }

    const status = decision === 'approve' ? 'approved' : 'rejected';
    for (const row of targets) {
      row.status = status;
      row.reviewed_by = auth.userId;
      row.reviewed_at = new Date().toISOString();
      row.review_note = body.p_note ?? row.review_note;
    }

    audit(auth, 'review_records', 'attendance_record', null, {
      decision,
      count: targets.length,
      ids,
      note: body.p_note ?? null,
    });
    record({
      fn: 'review_records',
      actor: auth.userId,
      decision,
      count: targets.length,
      note: body.p_note ?? null,
      ids,
    });

    json(res, 200, targets.length);
  },

  /** resolve_unmatched(p_record_id uuid, p_member_id uuid, p_new_member jsonb) returns uuid */
  resolve_unmatched(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'resolve_unmatched', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const target = db.attendance_records.find((row) => row.id === body.p_record_id);
    if (!target) {
      pds(res, 'PDS03', 'Unknown attendance record.');
      return;
    }
    if (target.member_id) {
      pds(res, 'PDS03', 'That record is already linked to a member.');
      return;
    }

    let memberId = null;
    let created = false;

    if (body.p_member_id) {
      const member = db.members.find((m) => m.id === body.p_member_id);
      if (!member) {
        pds(res, 'PDS03', 'Unknown member.');
        return;
      }
      memberId = member.id;
    } else if (body.p_new_member) {
      const first = String(body.p_new_member.first_name ?? '').trim();
      const last = String(body.p_new_member.last_name ?? '').trim();
      if (!first || !last) {
        pds(res, 'PDS03', 'A new member needs a first name and a last name.');
        return;
      }
      const member = {
        id: `m2000000-0000-4000-a000-${String(db.members.length + 1).padStart(12, '0')}`,
        first_name: first,
        last_name: last,
        preferred_name: null,
        email: body.p_new_member.email || null,
        ucf_nid: null,
        display_name: `${first} ${last}`,
        notes: null,
        merged_into_id: null,
        created_at: new Date().toISOString(),
        archived_at: null,
      };
      db.members.push(member);
      memberId = member.id;
      created = true;
    } else {
      pds(res, 'PDS03', 'Give either an existing member id or the details for a new one.');
      return;
    }

    const event = db.events.find((e) => e.id === target.event_id);

    // Whoever they turned out to be, they are on this year's roster now.
    const enrolled = db.member_enrollments.find(
      (e) => e.member_id === memberId && e.academic_year_id === event?.academic_year_id,
    );
    if (!enrolled && event) {
      db.member_enrollments.push({
        member_id: memberId,
        academic_year_id: event.academic_year_id,
        status: 'active',
        joined_on: new Date().toISOString().slice(0, 10),
      });
    }

    const clash = db.attendance_records.find(
      (other) =>
        other.id !== target.id &&
        other.event_id === target.event_id &&
        other.member_id === memberId &&
        other.status !== 'rejected',
    );
    if (clash) {
      pds(res, 'PDS05', 'That member already has a live record for this event.');
      return;
    }

    target.member_id = memberId;
    target.flags = (target.flags ?? []).filter((flag) => flag !== 'unmatched_name');

    audit(auth, 'resolve_unmatched', 'attendance_record', target.id, {
      member_id: memberId,
      created_member: created,
      claimed_name: target.claimed_name,
    });
    record({
      fn: 'resolve_unmatched',
      actor: auth.userId,
      recordId: target.id,
      memberId,
      createdMember: created,
      claimedName: target.claimed_name,
    });

    json(res, 200, memberId);
  },
};

// ---------------------------------------------------------------------------
// Signed photo URLs
// ---------------------------------------------------------------------------

const signedTokens = new Map(); // object path -> token

export function handleStorageSign(req, res, url, body, helpers, anonKey) {
  const { json } = helpers;
  const auth = resolveAuth(req, anonKey);

  // The evidence bucket is private. Only staff may sign a URL for it, which is
  // the storage policy evidence_read_staff, and it is why the grid cannot be
  // rebuilt by anybody who happens to know an object path.
  if (!isStaff(auth)) {
    record({ fn: 'storage.sign', outcome: 'refused', role: auth.role ?? auth.kind });
    json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    return;
  }

  const paths = Array.isArray(body?.paths) ? body.paths : [];
  const out = paths.map((path) => {
    const exists = db.attendance_evidence.some((row) => row.object_path === path);
    if (!exists) return { path, error: 'Object not found', signedURL: null };
    const token = randomBytes(8).toString('hex');
    signedTokens.set(path, token);
    return { path, error: null, signedURL: `/object/sign/evidence/${path}?token=${token}` };
  });

  record({ fn: 'storage.sign', actor: auth.userId, count: paths.length });
  json(res, 200, out);
}

const SWATCHES = ['#2f6f8f', '#7a4a06', '#1c5c34', '#5b3f8a', '#8a1f16', '#0b3d69'];

/**
 * Serves the "photo".
 *
 * A signed URL is deliberately not authenticated: the signature is the
 * authority, which is why the client can put it straight in an <img src>. The
 * image itself is generated so a person driving the screen sees forty-three
 * distinguishable tiles with names on them, and can tell at a glance whether
 * the grid rendered the right photo against the right person.
 */
export function serveSignedObject(res, url, helpers) {
  const path = decodeURIComponent(url.pathname.slice('/storage/v1/object/sign/evidence/'.length));
  const evidence = db.attendance_evidence.find((row) => row.object_path === path);

  if (!evidence || url.searchParams.get('token') !== signedTokens.get(path)) {
    helpers.json(res, 400, { statusCode: '400', error: 'InvalidJWT', message: 'invalid signature' });
    return;
  }

  const parent = db.attendance_records.find((row) => row.id === evidence.attendance_record_id);
  const member = db.members.find((m) => m.id === parent?.member_id);
  const name = member?.display_name ?? parent?.claimed_name ?? 'Unknown';
  const initials = name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const swatch = SWATCHES[name.length % SWATCHES.length];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <rect width="200" height="200" fill="${swatch}"/>
  <circle cx="100" cy="78" r="42" fill="rgba(255,255,255,0.22)"/>
  <text x="100" y="92" font-family="ui-sans-serif, sans-serif" font-size="38" font-weight="700"
        fill="#ffffff" text-anchor="middle">${initials}</text>
  <text x="100" y="160" font-family="ui-sans-serif, sans-serif" font-size="15"
        fill="#ffffff" text-anchor="middle">${name.replace(/[<>&]/g, '')}</text>
</svg>`;

  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(svg);
}
