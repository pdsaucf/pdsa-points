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
// The same trigram measure the review queue ranks with, so the duplicate view
// here pairs the same people the database's pg_trgm one would.
import { normaliseName, similarity } from '../src/match.js';

const ACCESS_TTL_SECONDS = 3600;

let db = buildDatabase();

const sessions = new Map(); // access token -> { userId, email, expiresAt }
const refreshTokens = new Map(); // refresh token -> { userId, email }
const magicLinks = new Map(); // email -> the URL the email would contain
const auditCalls = []; // every officer-side request, for the checks to read

// ---------------------------------------------------------------------------
// One injected failure
// ---------------------------------------------------------------------------
// Bad wifi, on the officer side. The anonymous half of the mock already has
// dropSubmits for this; the roster needed the same thing, because "an import
// that died halfway converges when it is run again" cannot be asserted against
// a server that never dies halfway.
//
// Set from the check process, never over HTTP and never from anything the page
// can reach, and cleared the moment it fires.
let pendingFailure = null; // { fn, nth, seen }

export function failRpcOnce(fn, nth = 1) {
  pendingFailure = { fn, nth, seen: 0 };
}

function injectedFailure(res, fn, helpers) {
  if (!pendingFailure || pendingFailure.fn !== fn) return false;
  pendingFailure.seen += 1;
  if (pendingFailure.seen !== pendingFailure.nth) return false;
  pendingFailure = null;
  record({ fn, outcome: 'injected failure' });
  helpers.pds(res, 'PDS03', 'The mock was asked to fail this call once.');
  return true;
}

export function resetAdmin() {
  db = buildDatabase();
  sessions.clear();
  refreshTokens.clear();
  magicLinks.clear();
  auditCalls.length = 0;
  pendingFailure = null;
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
    categories: db.categories,
    requirementSets: db.requirement_sets,
    requirementNodes: db.requirement_nodes,
    requirementNodeCategories: db.requirement_node_categories,
    merges: db.member_merges,
    dismissals: db.duplicate_dismissals,
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
  member_enrollments: {
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
  requirement_sets: {
    requirement_nodes: {
      table: 'requirement_nodes',
      kind: 'many',
      from: 'id',
      to: 'requirement_set_id',
    },
  },
  requirement_nodes: {
    requirement_node_categories: {
      table: 'requirement_node_categories',
      kind: 'many',
      from: 'id',
      to: 'node_id',
    },
    requirement_sets: {
      table: 'requirement_sets',
      kind: 'one',
      from: 'requirement_set_id',
      to: 'id',
    },
  },
  requirement_node_categories: {
    requirement_nodes: { table: 'requirement_nodes', kind: 'one', from: 'node_id', to: 'id' },
    categories: { table: 'categories', kind: 'one', from: 'category_id', to: 'id' },
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

// ---------------------------------------------------------------------------
// The derived views
// ---------------------------------------------------------------------------
// These are not tables and are not stored. Each one is recomputed on every
// read, which is exactly what the real ones do, and is why the progress board
// cannot be tested against a fixture somebody hand-wrote to agree with it.
//
// The point of computing them here rather than storing an answer: the board is
// forbidden from recomputing a point total or an honorary flag in JavaScript
// (invariant 2). If this mock simply echoed back numbers the fixtures declared,
// a board that quietly did its own arithmetic would still pass. Because these
// come out of the same attendance rows and the same requirement rows the real
// views read, a board that computed its own answer would disagree with them.

/** v_attendance_credit: one row per approved record per category it counts for. */
function creditRows() {
  const eventById = new Map(db.events.map((event) => [event.id, event]));
  const out = [];
  for (const record of db.attendance_records) {
    if (record.status !== 'approved' || !record.member_id) continue;
    const event = eventById.get(record.event_id);
    if (!event) continue;
    for (const link of db.event_categories.filter((row) => row.event_id === event.id)) {
      out.push({
        attendance_id: record.id,
        member_id: record.member_id,
        event_id: event.id,
        academic_year_id: event.academic_year_id,
        occurred_on: event.occurred_on,
        category_id: link.category_id,
        credit:
          link.credit_mode === 'fixed'
            ? Number(link.fixed_credit ?? 0)
            : Number(record.submitted_value ?? 0),
      });
    }
  }
  return out;
}

/** v_member_category_totals. */
function categoryTotalRows() {
  const totals = new Map();
  for (const row of creditRows()) {
    const key = `${row.member_id}:${row.academic_year_id}:${row.category_id}`;
    const held = totals.get(key);
    if (held) held.total += row.credit;
    else
      totals.set(key, {
        member_id: row.member_id,
        academic_year_id: row.academic_year_id,
        category_id: row.category_id,
        total: row.credit,
      });
  }
  return [...totals.values()];
}

/** member_id -> category_id -> total, for one year. */
function totalsByMember(yearId) {
  const out = new Map();
  for (const row of categoryTotalRows()) {
    if (row.academic_year_id !== yearId) continue;
    if (!out.has(row.member_id)) out.set(row.member_id, new Map());
    out.get(row.member_id).set(row.category_id, row.total);
  }
  return out;
}

const publishedSetFor = (yearId) =>
  db.requirement_sets.find((row) => row.academic_year_id === yearId && row.status === 'published') ??
  null;

/**
 * fn_member_requirement_status(), in the mock.
 *
 * One row per requirement in the set, deepest first so a group sees its
 * children's verdicts, which is the shape the real function returns and the
 * shape the member screen's checklist is built from.
 */
function evaluateSet(setId, memberId, index) {
  const set = setOf(setId);
  if (!set) return [];

  const nodes = db.requirement_nodes.filter((row) => row.requirement_set_id === setId);
  const totals = (index ?? totalsByMember(set.academic_year_id)).get(memberId) ?? new Map();

  const byOrder = (a, b) =>
    (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.label).localeCompare(String(b.label));
  const childrenOf = (id) => nodes.filter((row) => row.parent_id === id).sort(byOrder);
  const categoryIdsOf = (id) =>
    db.requirement_node_categories.filter((link) => link.node_id === id).map((link) => link.category_id);

  const verdicts = new Map();
  const evaluate = (node) => {
    const held = verdicts.get(node.id);
    if (held) return held;

    let value;
    let target;
    if (node.type === 'threshold') {
      value = categoryIdsOf(node.id).reduce((sum, id) => sum + (totals.get(id) ?? 0), 0);
      target = Number(node.min_value ?? 0);
    } else {
      const children = childrenOf(node.id);
      value = children.filter((child) => evaluate(child).passed).length;
      target =
        node.min_children_passing === null || node.min_children_passing === undefined
          ? children.length
          : Number(node.min_children_passing);
    }

    const result = { node, value, target, passed: value >= target };
    verdicts.set(node.id, result);
    return result;
  };

  for (const node of nodes) evaluate(node);

  // The real function orders by parent, then by sort order. The member screen
  // rebuilds the tree from the parent ids, so what this has to preserve is
  // that siblings arrive together and in their own order.
  return [...verdicts.values()]
    .sort(
      (a, b) =>
        String(a.node.parent_id ?? '').localeCompare(String(b.node.parent_id ?? '')) ||
        byOrder(a.node, b.node),
    )
    .map(({ node, value, target, passed }) => ({
      node_id: node.id,
      parent_id: node.parent_id,
      type: node.type,
      label: node.label,
      value,
      target,
      passed,
    }));
}

/**
 * v_member_status: the point total and the honorary flag, per member per year.
 *
 * point_total sums only the categories flagged as counting toward it, which is
 * what reproduces a Total column that excludes Volunteering hours while still
 * requiring them for Honorary. is_honorary is the root requirement's verdict.
 */
function memberStatusRows() {
  const countsToward = new Map(db.categories.map((row) => [row.id, row.counts_toward_point_total]));
  const indexByYear = new Map();
  const out = [];

  for (const enrollment of db.member_enrollments) {
    const yearId = enrollment.academic_year_id;
    if (!indexByYear.has(yearId)) indexByYear.set(yearId, totalsByMember(yearId));
    const index = indexByYear.get(yearId);
    const totals = index.get(enrollment.member_id) ?? new Map();

    let points = 0;
    for (const [categoryId, total] of totals) {
      if (countsToward.get(categoryId)) points += total;
    }

    const set = publishedSetFor(yearId);
    const root = set
      ? evaluateSet(set.id, enrollment.member_id, index).find((row) => row.node_id === set.root_node_id)
      : null;

    out.push({
      member_id: enrollment.member_id,
      academic_year_id: yearId,
      point_total: points,
      is_honorary: Boolean(root?.passed),
      requirement_set_id: set?.id ?? null,
    });
  }

  return out;
}

/**
 * v_possible_duplicate_members.
 *
 * Written against supabase/migrations/20260813100000_duplicate_people.sql, and
 * the parts of it the screen depends on are reproduced rather than approximated:
 *
 *   * each pair appears once, in canonical id order, never in both. The roster
 *     screen renders what comes back and does no deduping of its own
 *   * `reason` is one of four stable codes, strongest only, in the same
 *     priority order the SQL applies. The screen branches on the code, so a
 *     mock that invented its own vocabulary would let a screen that cannot read
 *     the real one pass here
 *   * archived, merged and dismissed pairs are already gone
 *   * records_a counts every attendance record, whatever its status, because
 *     that is the number an officer weighs when choosing which row lives
 *   * joined_a is the earliest enrollment, falling back to when the row was
 *     created
 */
const WHOLE_NAME_FLOOR = 0.55;
const VARIANT_FLOOR = 0.4;

function duplicatePairRows() {
  const live = db.members.filter((row) => !row.archived_at && !row.merged_into_id);
  const dismissed = new Set(
    db.duplicate_dismissals.map((row) => `${row.member_a}:${row.member_b}`),
  );

  const recordsOf = (memberId) =>
    db.attendance_records.filter((row) => row.member_id === memberId).length;
  const joinedOf = (member) =>
    db.member_enrollments
      .filter((row) => row.member_id === member.id)
      .map((row) => row.joined_on)
      .sort()[0] ?? String(member.created_at ?? '').slice(0, 10) ?? null;

  const initial = (member) =>
    normaliseName(member.preferred_name || member.first_name).slice(0, 1);

  const out = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      // Canonical order, so a pair has exactly one spelling.
      const [a, b] = [live[i], live[j]].sort((x, y) => x.id.localeCompare(y.id));

      const measured = similarity(a.display_name, b.display_name);
      let reason = null;
      let score = 0;

      if (a.email && b.email && String(a.email).toLowerCase() === String(b.email).toLowerCase()) {
        reason = 'exact_email';
        score = 1;
      } else if (a.ucf_nid && b.ucf_nid && a.ucf_nid === b.ucf_nid) {
        reason = 'exact_nid';
        score = 0.999;
      } else if (
        normaliseName(a.display_name) &&
        normaliseName(a.display_name) === normaliseName(b.display_name)
      ) {
        reason = 'exact_name';
        score = 0.998;
      } else if (
        measured >= WHOLE_NAME_FLOOR ||
        (measured >= VARIANT_FLOOR &&
          normaliseName(a.last_name) === normaliseName(b.last_name) &&
          initial(a) === initial(b) &&
          initial(a))
      ) {
        // The nickname shape: same surname, same first initial, a name that is
        // merely a variant. Abigail and Abby Catto are exactly this.
        reason = 'close_name';
        score = Math.min(Number(measured.toFixed(3)), 0.997);
      }

      if (!reason) continue;
      if (dismissed.has(`${a.id}:${b.id}`)) continue;

      out.push({
        member_a: a.id,
        member_b: b.id,
        display_a: a.display_name,
        display_b: b.display_name,
        email_a: a.email,
        email_b: b.email,
        reason,
        score,
        records_a: recordsOf(a.id),
        records_b: recordsOf(b.id),
        joined_a: joinedOf(a),
        joined_b: joinedOf(b),
      });
    }
  }
  return out.sort(
    (x, y) => y.score - x.score || x.display_a.localeCompare(y.display_a),
  );
}

const VIEWS = {
  v_attendance_credit: creditRows,
  v_member_category_totals: categoryTotalRows,
  v_member_status: memberStatusRows,
  v_possible_duplicate_members: duplicatePairRows,
};

/**
 * The RLS table from docs/01-data-model.md section 8, in the crude form the
 * client can actually be tested against. Reads only: writes are checked at
 * their own call sites below.
 */
function visibleRows(table, auth) {
  if (VIEWS[table]) {
    const rows = VIEWS[table]();
    if (isStaff(auth)) return rows;

    // Every view here is security_invoker, so a member reads it through their
    // own policies: their own numbers, and nothing about anybody else. The
    // duplicate view is over the whole roster, which a member cannot read at
    // all, so it comes back empty rather than partly filled.
    const memberId = auth.profile?.member_id ?? null;
    if (table === 'v_possible_duplicate_members') return [];
    return memberId ? rows.filter((row) => row.member_id === memberId) : [];
  }

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
    // "Everyone signed in can read the rules they are being judged by", which
    // is req_sets_read and its two siblings in migration 11.
    case 'requirement_sets':
    case 'requirement_nodes':
    case 'requirement_node_categories':
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
      // Loud, on purpose. PostgREST resolves an embed from the foreign keys and
      // answers PGRST200 when there is none; this mock has to be told about
      // each one, and a missing entry used to come back as `null` on every row.
      // A screen reading that gets an empty list rather than an error, which is
      // exactly the silent failure these suites exist to catch: it cost an
      // afternoon once, and it is not costing another.
      throw new Error(
        `the mock has no relation from ${table} to ${node.name}. Add it to RELATIONS.`,
      );
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

const setOf = (setId) => db.requirement_sets.find((row) => row.id === setId) ?? null;
const setOfNode = (nodeId) => {
  const node = db.requirement_nodes.find((row) => row.id === nodeId);
  return node ? setOf(node.requirement_set_id) : null;
};
const isDraft = (set) => Boolean(set) && set.status === 'draft';

/**
 * Who may write what, per row. The insert and update halves of the policies in
 * migration 11.
 *
 * Per row rather than per table, because the requirements policies are: an
 * admin may write anything, an officer may write a DRAFT and nothing else.
 * That distinction is the whole published/draft lifecycle, and a stand-in that
 * only looked at the caller's role would let an officer edit a published set
 * here and be refused in production.
 */
const WRITE_POLICY = {
  member_enrollments: (auth) => isOfficer(auth),
  attendance_records: (auth) => isOfficer(auth),
  members: (auth) => isOfficer(auth),
  member_claims: (auth) => isOfficer(auth),
  profiles: (auth) => isAdmin(auth),
  categories: (auth) => isOfficer(auth),
  requirement_sets: (auth, row) =>
    isAdmin(auth) || (isOfficer(auth) && isDraft(row ?? { status: 'draft' })),
  requirement_nodes: (auth, row) =>
    isAdmin(auth) || (isOfficer(auth) && isDraft(setOf(row?.requirement_set_id))),
  requirement_node_categories: (auth, row) =>
    isAdmin(auth) || (isOfficer(auth) && isDraft(setOfNode(row?.node_id))),
};

const uuid = (prefix) => `${prefix}${randomBytes(6).toString('hex')}`;

/** The defaults each table's columns carry, for a row the client did not fill in. */
const INSERT_DEFAULTS = {
  categories: (row) => ({
    id: uuid('c9000000-0000-4000-a000-'),
    unit: 'event_count',
    unit_label: null,
    counts_toward_point_total: true,
    sort_order: 0,
    created_at: new Date().toISOString(),
    archived_at: null,
    ...row,
  }),
  requirement_sets: (row) => ({
    id: uuid('d9000000-0000-4000-a000-'),
    name: 'Honorary Member',
    version: 1,
    status: 'draft',
    root_node_id: null,
    published_at: null,
    created_at: new Date().toISOString(),
    ...row,
  }),
  requirement_nodes: (row) => ({
    id: uuid('f9000000-0000-4000-a000-'),
    parent_id: null,
    sort_order: 0,
    min_children_passing: null,
    min_value: null,
    term_id: null,
    ...row,
  }),
  requirement_node_categories: (row) => ({ ...row }),

  // display_name is `coalesce(preferred_name, first_name) || ' ' || last_name`,
  // generated and stored, so a client that sent one would have it ignored.
  members: (row) => ({
    id: uuid('m9000000-0000-4000-a000-'),
    preferred_name: null,
    email: null,
    ucf_nid: null,
    notes: null,
    merged_into_id: null,
    created_at: new Date().toISOString(),
    archived_at: null,
    ...row,
    display_name: `${row.preferred_name || row.first_name} ${row.last_name}`,
  }),

  // status is deliberately NOT taken from the caller. An officer filing a
  // record by hand files it pending and then approves it through
  // review_records(), exactly as the queue does, so the reviewer and the audit
  // row are stamped either way. A client that tried to write 'approved'
  // straight in would find it overwritten here.
  attendance_records: (row) => ({
    id: uuid('r9000000-0000-4000-a000-'),
    member_id: null,
    claimed_name: null,
    claimed_email: null,
    source: 'self_checkin',
    submitted_value: null,
    flags: [],
    submitted_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    reviewed_by: null,
    reviewed_at: null,
    review_note: null,
    ...row,
    status: 'pending',
  }),
};

function runInsert(table, payload, auth) {
  const allowed = WRITE_POLICY[table];
  const incoming = Array.isArray(payload) ? payload : [payload];

  const refuse = () => ({
    error: {
      status: 403,
      body: {
        code: '42501',
        message: `new row violates row-level security policy for table "${table}"`,
      },
    },
  });

  if (!allowed || incoming.some((row) => !allowed(auth, row))) return refuse();

  const written = [];

  for (const row of incoming) {
    if (INSERT_DEFAULTS[table]) {
      // The check constraint on requirement_nodes: a requirement carries a
      // number and no child count, a group carries a child count and no number.
      if (table === 'requirement_nodes') {
        const bad =
          (row.type === 'threshold' && (row.min_value === null || row.min_value === undefined)) ||
          (row.type === 'group' && row.min_value !== null && row.min_value !== undefined);
        if (bad) {
          return {
            error: {
              status: 400,
              body: {
                code: '23514',
                message: 'new row violates check constraint on "requirement_nodes"',
              },
            },
          };
        }
      }
      if (table === 'categories' && db.categories.some((c) => c.slug === row.slug)) {
        return {
          error: {
            status: 409,
            body: {
              code: '23505',
              message: 'duplicate key value violates unique constraint "categories_slug_key"',
            },
          },
        };
      }
      if (table === 'requirement_node_categories') {
        const existing = db.requirement_node_categories.find(
          (link) => link.node_id === row.node_id && link.category_id === row.category_id,
        );
        if (existing) {
          written.push(existing);
          continue;
        }
      }

      if (table === 'members') {
        // Both columns are NOT NULL with a non-empty check.
        if (!String(row.first_name ?? '').trim() || !String(row.last_name ?? '').trim()) {
          return {
            error: {
              status: 400,
              body: {
                code: '23514',
                message: 'new row violates check constraint on "members"',
              },
            },
          };
        }
        // members.email is citext UNIQUE. This is the constraint an import that
        // skipped its own preview would hit, and it has to be an error rather
        // than a second row.
        if (
          row.email &&
          db.members.some(
            (m) => String(m.email ?? '').toLowerCase() === String(row.email).toLowerCase(),
          )
        ) {
          return {
            error: {
              status: 409,
              body: {
                code: '23505',
                message: 'duplicate key value violates unique constraint "members_email_key"',
              },
            },
          };
        }
      }

      if (table === 'attendance_records') {
        // one_live_record_per_member_event. An officer filing a record by hand
        // for an event the member already attended is refused, not doubled.
        const clash =
          row.member_id &&
          db.attendance_records.find(
            (other) =>
              other.event_id === row.event_id &&
              other.member_id === row.member_id &&
              other.status !== 'rejected',
          );
        if (clash) {
          return {
            error: {
              status: 409,
              body: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "one_live_record_per_member_event"',
              },
            },
          };
        }
      }

      const created = INSERT_DEFAULTS[table](row);
      db[table].push(created);
      written.push(created);
      continue;
    }

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

  // A WITH CHECK violation is different from a USING one: it raises. An officer
  // moving a set out of draft is refused loudly, which is what stops a published
  // set being edited by anybody but an admin.
  if (table === 'requirement_sets' && payload?.status && payload.status !== 'draft' && !isAdmin(auth)) {
    return {
      error: {
        status: 403,
        body: {
          code: '42501',
          message: 'new row violates row-level security policy for table "requirement_sets"',
        },
      },
    };
  }

  targets = allowed ? targets.filter((row) => allowed(auth, row)) : [];
  if (!targets.length) {
    // THE IMPORTANT CASE. PostgREST does not raise here: the USING clause
    // simply matches no row, so the answer is 200 with an empty array. A
    // client that reads that as success reports a write that never happened,
    // which is exactly the officer-versus-admin distinction in claims.js, and
    // is also what an officer's edit to a PUBLISHED requirement set comes back
    // as.
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

/**
 * DELETE, which only the requirements editor uses.
 *
 * `on delete cascade` on requirement_nodes.parent_id is reproduced here: taking
 * out a group takes out everything inside it. A mock that left the children
 * behind would show a tree the database could never hold.
 */
function runDelete(table, params, auth) {
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
  targets = allowed ? targets.filter((row) => allowed(auth, row)) : [];
  if (!targets.length) {
    record({ fn: `delete.${table}`, actor: auth.userId, outcome: 'refused by policy', matched: 0 });
    return { rows: [] };
  }

  const removed = targets.map((row) => ({ ...row }));
  const gone = new Set(targets);

  if (table === 'requirement_nodes') {
    const ids = new Set(targets.map((row) => row.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of db.requirement_nodes) {
        if (node.parent_id && ids.has(node.parent_id) && !ids.has(node.id)) {
          ids.add(node.id);
          grew = true;
        }
      }
    }
    db.requirement_nodes = db.requirement_nodes.filter((node) => !ids.has(node.id));
    db.requirement_node_categories = db.requirement_node_categories.filter(
      (link) => !ids.has(link.node_id),
    );
    for (const set of db.requirement_sets) {
      if (ids.has(set.root_node_id)) set.root_node_id = null;
    }
  } else {
    db[table] = db[table].filter((row) => !gone.has(row));
  }

  record({ fn: `delete.${table}`, actor: auth.userId, matched: removed.length });
  return { rows: removed };
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
  } else if (req.method === 'DELETE') {
    result = runDelete(table, url.searchParams, auth);
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

  // -------------------------------------------------------------------------
  // Putting somebody on this year's roster
  // -------------------------------------------------------------------------

  /**
   * upsert_member_and_enroll(p_first_name text, p_last_name text,
   *   p_email citext, p_ucf_nid citext, p_academic_year_id uuid,
   *   p_matched_member_id uuid) returns jsonb
   *
   * Written against supabase/migrations/20260814100000_member_upsert.sql, and
   * the properties the roster screen depends on are reproduced rather than
   * approximated:
   *
   *   * the member and the enrollment are one operation. There is no state in
   *     which one exists without the other, which is the defect the function
   *     exists to remove
   *   * enrolling somebody already enrolled is a no-op, not an error, so
   *     running the same file twice writes nothing the second time
   *   * with no p_matched_member_id it matches on email and student id itself.
   *     That is what makes the retry after a half-finished import land on the
   *     row the first attempt created
   *   * a merged row resolves to the survivor rather than being enrolled or
   *     colliding with the unique index on the way to a second row
   */
  upsert_member_and_enroll(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'upsert_member_and_enroll', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    if (injectedFailure(res, 'upsert_member_and_enroll', helpers)) return;

    const first = String(body.p_first_name ?? '').trim();
    const last = String(body.p_last_name ?? '').trim();
    if (!first || !last) {
      pds(res, 'PDS03', 'A member needs a first name and a last name.');
      return;
    }

    const yearId = body.p_academic_year_id;
    if (!yearId || !db.academic_years.some((year) => year.id === yearId)) {
      pds(res, 'PDS03', 'Unknown academic year.');
      return;
    }

    const email = String(body.p_email ?? '').trim().toLowerCase() || null;
    const nid = String(body.p_ucf_nid ?? '').trim().toLowerCase() || null;

    let member = null;
    if (body.p_matched_member_id) {
      member = db.members.find((row) => row.id === body.p_matched_member_id) ?? null;
      if (!member) {
        pds(res, 'PDS03', 'Unknown member.');
        return;
      }
    } else {
      if (email) {
        member =
          db.members.find((row) => String(row.email ?? '').toLowerCase() === email) ?? null;
      }
      if (!member && nid) {
        member =
          db.members.find((row) => String(row.ucf_nid ?? '').toLowerCase() === nid) ?? null;
      }
    }

    // Follow a tombstone. merge_members() leaves the loser's address on the
    // merged row, so last year's file still resolves to it.
    for (let hops = 0; hops < 10 && member?.merged_into_id; hops += 1) {
      member = db.members.find((row) => row.id === member.merged_into_id) ?? null;
    }
    if (member?.archived_at) {
      pds(res, 'PDS03', 'That member is archived.');
      return;
    }

    let created = false;
    if (!member) {
      member = {
        id: uuid('m9000000-0000-4000-a000-'),
        first_name: first,
        last_name: last,
        preferred_name: null,
        email: body.p_email || null,
        ucf_nid: body.p_ucf_nid || null,
        display_name: `${first} ${last}`,
        notes: null,
        merged_into_id: null,
        created_at: new Date().toISOString(),
        archived_at: null,
      };
      db.members.push(member);
      created = true;
    }

    const held = db.member_enrollments.find(
      (row) => row.member_id === member.id && row.academic_year_id === yearId,
    );
    let enrolled = false;
    if (!held) {
      db.member_enrollments.push({
        member_id: member.id,
        academic_year_id: yearId,
        status: 'active',
        joined_on: new Date().toISOString().slice(0, 10),
      });
      enrolled = true;
    }

    audit(auth, 'upsert_member_and_enroll', 'member', member.id, {
      academic_year_id: yearId,
      was_created: created,
      was_enrolled: enrolled,
    });
    record({
      fn: 'upsert_member_and_enroll',
      actor: auth.userId,
      memberId: member.id,
      created,
      enrolled,
    });

    json(res, 200, { member_id: member.id, was_created: created, was_enrolled: enrolled });
  },

  // -------------------------------------------------------------------------
  // Duplicate people
  // -------------------------------------------------------------------------

  /** merge_members(p_from_id uuid, p_into_id uuid) returns jsonb */
  merge_members(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'merge_members', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const from = body.p_from_id;
    const into = body.p_into_id;
    if (from === into) {
      pds(res, 'PDS03', 'Cannot merge a member into themselves.');
      return;
    }
    if (!db.members.some((m) => m.id === from) || !db.members.some((m) => m.id === into)) {
      pds(res, 'PDS03', 'Unknown member.');
      return;
    }

    // Collisions first: where the survivor already holds a live record for the
    // same event, the duplicate cannot be moved, so it goes. Doing this the
    // other way round would violate one_live_record_per_member_event halfway
    // through, which is why the real function has the same order.
    const collisions = db.attendance_records.filter(
      (row) =>
        row.member_id === from &&
        row.status !== 'rejected' &&
        db.attendance_records.some(
          (other) =>
            other.member_id === into &&
            other.event_id === row.event_id &&
            other.status !== 'rejected',
        ),
    );
    const dropped = collisions.length;
    const gone = new Set(collisions);
    db.attendance_records = db.attendance_records.filter((row) => !gone.has(row));

    const moving = db.attendance_records.filter((row) => row.member_id === from);
    for (const row of moving) row.member_id = into;
    const moved = moving.length;

    for (const enrollment of db.member_enrollments.filter((row) => row.member_id === from)) {
      const held = db.member_enrollments.find(
        (row) => row.member_id === into && row.academic_year_id === enrollment.academic_year_id,
      );
      if (!held) {
        db.member_enrollments.push({ ...enrollment, member_id: into });
      }
    }
    db.member_enrollments = db.member_enrollments.filter((row) => row.member_id !== from);

    // A tombstone, not a delete. Old links still resolve, which is the whole
    // reason merged_into_id exists.
    const loser = db.members.find((m) => m.id === from);
    loser.merged_into_id = into;
    loser.archived_at = loser.archived_at ?? new Date().toISOString();

    const mergeId = uuid('g0000000-0000-4000-a000-');
    db.member_merges.push({
      id: mergeId,
      from_member_id: from,
      into_member_id: into,
      moved_records: moved,
      dropped_records: dropped,
      performed_by: auth.userId,
      performed_at: new Date().toISOString(),
    });

    audit(auth, 'merge_members', 'member', into, { from_member_id: from, moved, dropped });
    record({ fn: 'merge_members', actor: auth.userId, from, into, moved, dropped });

    json(res, 200, { merge_id: mergeId, moved, dropped });
  },

  /** dismiss_duplicate_pair(p_member_a uuid, p_member_b uuid) returns void */
  dismiss_duplicate_pair(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    // Officer only. A member who could dismiss a pair could hide their own
    // duplicate row from the people whose job it is to fix it.
    if (!isOfficer(auth)) {
      record({ fn: 'dismiss_duplicate_pair', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const a = body.p_member_a;
    const b = body.p_member_b;
    if (!a || !b || a === b) {
      pds(res, 'PDS03', 'Two different members are required.');
      return;
    }

    // Order-independent. The pair is stored the one way round the view spells
    // it, so dismissing (a, b) and dismissing (b, a) are the same dismissal
    // and neither comes back.
    const [first, second] = [a, b].sort((x, y) => String(x).localeCompare(String(y)));
    const held = db.duplicate_dismissals.some(
      (row) => row.member_a === first && row.member_b === second,
    );
    if (!held) {
      db.duplicate_dismissals.push({
        member_a: first,
        member_b: second,
        dismissed_by: auth.userId,
        dismissed_at: new Date().toISOString(),
      });
    }

    audit(auth, 'dismiss_duplicate_pair', 'member', first, { member_b: second });
    record({ fn: 'dismiss_duplicate_pair', actor: auth.userId, memberA: first, memberB: second });

    json(res, 200, null);
  },

  // -------------------------------------------------------------------------
  // One member's progress
  // -------------------------------------------------------------------------

  /**
   * fn_member_requirement_status(p_member_id uuid, p_requirement_set_id uuid)
   * returns table (node_id, parent_id, type, label, value, target, passed)
   *
   * Staff may ask about anybody, a member only about themselves, which is
   * fn_can_view_member() and is what stops the member portal being a roster.
   */
  fn_member_requirement_status(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    const memberId = body.p_member_id;
    const mine = auth.profile?.member_id ?? null;
    if (!isStaff(auth) && mine !== memberId) {
      record({ fn: 'fn_member_requirement_status', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'Not allowed to read that members progress.');
      return;
    }

    const set = setOf(body.p_requirement_set_id);
    if (!set) {
      pds(res, 'PDS08', 'Unknown requirement set.');
      return;
    }

    record({ fn: 'fn_member_requirement_status', actor: auth.userId, memberId, setId: set.id });
    json(res, 200, evaluateSet(set.id, memberId));
  },

  // -------------------------------------------------------------------------
  // The requirements engine
  // -------------------------------------------------------------------------
  // These four are the contract the editor is written against. The evaluator
  // below is a second implementation of fn_member_requirement_status(), in
  // JavaScript, which is exactly what it is for: if the editor and the database
  // disagree about what a rule means, one of the two is wrong, and a mock that
  // simply echoed a number back would never say so.

  /** clone_requirement_set(p_set_id uuid) returns uuid */
  clone_requirement_set(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);
    if (!isOfficer(auth)) {
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const source = setOf(body.p_set_id);
    if (!source) {
      pds(res, 'PDS08', 'Unknown requirement set.');
      return;
    }

    const version =
      db.requirement_sets
        .filter((row) => row.academic_year_id === source.academic_year_id && row.name === source.name)
        .reduce((max, row) => Math.max(max, Number(row.version) || 0), 0) + 1;

    const clone = {
      id: uuid('d9000000-0000-4000-a000-'),
      academic_year_id: source.academic_year_id,
      name: source.name,
      version,
      status: 'draft',
      root_node_id: null,
      published_at: null,
      created_at: new Date().toISOString(),
    };
    db.requirement_sets.push(clone);

    const remap = new Map();
    const originals = db.requirement_nodes.filter((row) => row.requirement_set_id === source.id);
    for (const node of originals) remap.set(node.id, uuid('f9000000-0000-4000-a000-'));

    for (const node of originals) {
      db.requirement_nodes.push({
        ...node,
        id: remap.get(node.id),
        requirement_set_id: clone.id,
        parent_id: node.parent_id ? remap.get(node.parent_id) ?? null : null,
      });
      for (const link of db.requirement_node_categories.filter((row) => row.node_id === node.id)) {
        db.requirement_node_categories.push({
          node_id: remap.get(node.id),
          category_id: link.category_id,
        });
      }
    }

    clone.root_node_id = source.root_node_id ? remap.get(source.root_node_id) ?? null : null;

    audit(auth, 'clone_requirement_set', 'requirement_set', clone.id, {
      from: source.id,
      version,
    });
    record({ fn: 'clone_requirement_set', actor: auth.userId, from: source.id, to: clone.id });
    json(res, 200, clone.id);
  },

  /** publish_requirement_set(p_set_id uuid) returns jsonb */
  publish_requirement_set(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    // Only an admin publishes. An officer builds the draft and asks.
    if (!isAdmin(auth)) {
      record({ fn: 'publish_requirement_set', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'Publishing a requirement set requires an admin account.');
      return;
    }

    const set = setOf(body.p_set_id);
    if (!set) {
      pds(res, 'PDS08', 'Unknown requirement set.');
      return;
    }
    if (set.status !== 'draft') {
      pds(res, 'PDS03', 'That version is already published.');
      return;
    }

    // one_published_set_per_year_name: the one that was live is archived, not
    // overwritten, so last year's members keep the numbers they were judged by.
    const previous = db.requirement_sets.find(
      (row) =>
        row.academic_year_id === set.academic_year_id &&
        row.name === set.name &&
        row.status === 'published',
    );
    if (previous) previous.status = 'archived';

    set.status = 'published';
    set.published_at = new Date().toISOString();

    audit(auth, 'publish_requirement_set', 'requirement_set', set.id, {
      version: set.version,
      archived_set_id: previous?.id ?? null,
    });
    record({ fn: 'publish_requirement_set', actor: auth.userId, setId: set.id });

    json(res, 200, {
      version: set.version,
      published_at: set.published_at,
      archived_set_id: previous?.id ?? null,
    });
  },

  /** validate_requirement_set(p_set_id uuid) returns table (code, node_id, message) */
  validate_requirement_set(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);
    if (!isStaff(auth)) {
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const set = setOf(body.p_set_id);
    if (!set) {
      pds(res, 'PDS08', 'Unknown requirement set.');
      return;
    }

    const nodes = db.requirement_nodes.filter((row) => row.requirement_set_id === set.id);
    const childrenOf = (id) => nodes.filter((row) => row.parent_id === id);
    const categoriesOf = (id) =>
      db.requirement_node_categories
        .filter((link) => link.node_id === id)
        .map((link) => db.categories.find((c) => c.id === link.category_id))
        .filter(Boolean);

    const problems = [];
    const say = (code, nodeId, message) => problems.push({ code, node_id: nodeId, message });

    if (!nodes.length || !set.root_node_id) {
      say('set_without_root', null, 'This set has no requirements in it.');
    }

    for (const node of nodes) {
      if (!String(node.label ?? '').trim()) {
        say('label_missing', node.id, 'This requirement has no name.');
      }
      if (node.type === 'threshold') {
        const categories = categoriesOf(node.id);
        if (!categories.length) {
          say('threshold_without_category', node.id, 'This requirement measures no categories.');
        }
        for (const category of categories) {
          if (category.archived_at) {
            say(
              'rule_on_archived_category',
              node.id,
              `Requirement node measures category "${category.name}", which is archived.`,
            );
          }
        }
        const units = new Set(categories.map((category) => category.unit));
        if (units.size > 1) {
          say('mixed_units', node.id, 'This requirement adds up more than one kind of unit.');
        }
      } else {
        const children = childrenOf(node.id);
        if (!children.length) {
          say('empty_group_node', node.id, 'Group node has no children, so it passes for everybody.');
        } else if (
          node.min_children_passing !== null &&
          node.min_children_passing !== undefined &&
          node.min_children_passing > children.length
        ) {
          say(
            'min_children_exceeds_children',
            node.id,
            'This group asks for more than it contains.',
          );
        }
      }
    }

    record({ fn: 'validate_requirement_set', actor: auth.userId, setId: set.id, count: problems.length });
    json(res, 200, problems);
  },

  /** preview_requirement_set(p_set_id uuid) returns table (node_id, label, passing, total) */
  preview_requirement_set(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);
    if (!isStaff(auth)) {
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const set = setOf(body.p_set_id);
    if (!set) {
      pds(res, 'PDS08', 'Unknown requirement set.');
      return;
    }

    const nodes = db.requirement_nodes.filter((row) => row.requirement_set_id === set.id);

    const members = db.member_enrollments
      .filter((row) => row.academic_year_id === set.academic_year_id)
      .map((row) => row.member_id);

    // The same evaluator v_member_status and fn_member_requirement_status()
    // use, run once per member. The preview and the board therefore cannot
    // disagree about who passes what, which is the property that makes the
    // preview worth putting a threshold change behind.
    const index = totalsByMember(set.academic_year_id);
    const passing = new Map(nodes.map((node) => [node.id, 0]));

    for (const memberId of members) {
      for (const row of evaluateSet(set.id, memberId, index)) {
        if (row.passed) passing.set(row.node_id, (passing.get(row.node_id) ?? 0) + 1);
      }
    }

    record({ fn: 'preview_requirement_set', actor: auth.userId, setId: set.id });
    json(
      res,
      200,
      nodes.map((node) => ({
        node_id: node.id,
        label: node.label,
        passing: passing.get(node.id) ?? 0,
        total: members.length,
      })),
    );
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
