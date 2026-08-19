// The officer half of the mock: passcode auth, PostgREST reads and writes
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
import { buildDatabase, ACCOUNTS, MOCK_PASSCODE } from './admin-fixtures.mjs';
// The same trigram measure the review queue ranks with, so the duplicate view
// here pairs the same people the database's pg_trgm one would.
import { normaliseName, similarity } from '../src/match.js';

const ACCESS_TTL_SECONDS = 3600;

let db = buildDatabase();

/**
 * Which evidence-bucket object paths this mock's Storage stand-in currently
 * holds bytes for: every unpurged attendance_evidence row's object_path, plus
 * any purge_run_objects row nobody has confirmed deleting yet (some of
 * these, like the fixture's "outstanding" run, do not correspond to a live
 * attendance_evidence row at all, purging having already happened; they are
 * still real objects sitting in the bucket until something deletes them).
 * A path with a purge_run_objects row already marked deleted_at, or an
 * attendance_evidence row already purged and confirmed, is left out: this
 * mock's Storage stand-in never held it, or no longer does.
 */
function seedBucketObjects() {
  const set = new Set();
  for (const evidence of db.attendance_evidence) {
    if (evidence.object_path && !evidence.purged_at) set.add(evidence.object_path);
  }
  for (const object of db.purge_run_objects) {
    if (!object.deleted_at) set.add(object.object_path);
  }
  return set;
}

// The one piece of real bucket state this mock keeps: what handleStorageDelete
// (this file) actually removes a path from, and what handleStorageInfo (this
// file) answers evidenceObjectExists() (src/rest.js) against. Everything else
// about Storage in this mock is a stand-in; this Set is what makes "was this
// path really deleted, or only claimed to be" answerable at all.
let bucketObjects = seedBucketObjects();

const sessions = new Map(); // access token -> { userId, email, expiresAt }
const refreshTokens = new Map(); // refresh token -> { userId, email }
const auditCalls = []; // every officer-side request, for the checks to read

// fn_rate_limit_check(), keyed the same way and counted per calendar minute,
// because that is what makes a full bucket clear on its own rather than ease
// off. Two of the six portal functions are limited: see 18.9 of the migration.
const rateCounters = new Map(); // `${bucket}:${minute}` -> count

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

// ---------------------------------------------------------------------------
// One refused import row
// ---------------------------------------------------------------------------
// The other half of the same idea, one level down. upsert_members_and_enroll()
// refuses a row on its own without discarding the batch, and the screen has to
// list that row for the officer to fix. Provoking it needs a row the database
// will not write, and the honest example is an archived member, which this
// fixture deliberately does not have: adding one would change what the roster
// table, the matcher and the duplicate banner all see, so a check about a
// refused import row would be paid for by every other check on the screen.
//
// Set from the check process, never over HTTP, and cleared the moment it
// fires. The message is one the real function actually raises.
let pendingRowRefusal = null; // the CSV line number to refuse

export function refuseImportRowOnce(row) {
  pendingRowRefusal = row;
}

// A batch response that does not account for every row it was sent. A proxy
// that truncates a body, or a server change that starts skipping rows, both
// look like this, and the interesting part is entirely on the client: rows it
// gets no answer about must not be counted as written. The mock still writes
// the rows, because that is the honest version of the problem. The client
// genuinely cannot tell.
let pendingShortResult = false;

export function dropImportResultOnce() {
  pendingShortResult = true;
}

function shortenResults(results) {
  if (!pendingShortResult) return results;
  pendingShortResult = false;
  record({ fn: 'upsert_members_and_enroll', outcome: 'short result', sent: results.length - 1 });
  return results.slice(0, -1);
}

function refusedImportRow(line) {
  if (pendingRowRefusal === null || pendingRowRefusal !== line) return null;
  pendingRowRefusal = null;
  record({ fn: 'upsert_members_and_enroll', outcome: 'refused row', row: line });
  return { error: 'PDS03', message: 'That member is archived.' };
}

export function resetAdmin() {
  db = buildDatabase();
  bucketObjects = seedBucketObjects();
  sessions.clear();
  refreshTokens.clear();
  rateCounters.clear();
  auditCalls.length = 0;
  pendingFailure = null;
  pendingRowRefusal = null;
  pendingShortResult = false;
  pendingDeleteFailures = null;
}

export function adminState() {
  return {
    auditLog: db.audit_log,
    calls: auditCalls,
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

/**
 * auth.users.email, for one user id.
 *
 * ACCOUNTS is keyed by address because that is what a sign-in form sends, so
 * the reverse lookup is a scan. It is here rather than inlined because it is
 * the whole reason list_pending_claims() exists: PostgREST serves the `public`
 * schema, auth.users is not in it, and no view in P0 surfaces this column.
 */
const emailOfUser = (userId) =>
  Object.entries(ACCOUNTS).find(([, account]) => account.user_id === userId)?.[0] ?? null;

/** An auth.users row, or null for an address this mock has never seen. */
const accountFor = (email) => ACCOUNTS[email] ?? null;

const isStaff = (auth) => auth.kind === 'user' && STAFF_ROLES.includes(auth.role);
const isOfficer = (auth) => auth.kind === 'user' && OFFICER_ROLES.includes(auth.role);
const isAdmin = (auth) => auth.kind === 'user' && auth.role === 'admin';

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

export function handleAuth(req, res, url, body, helpers) {
  const { json } = helpers;
  const path = url.pathname;

  if (path === '/auth/v1/token') {
    const grant = url.searchParams.get('grant_type');

    // The passcode. GoTrue refuses a wrong password with 400 invalid_grant and
    // an unknown address with the same 400, which is what makes the sign-in
    // screen's one message ("Incorrect passcode.") the honest one: this
    // endpoint does not distinguish either, and neither should the copy.
    if (grant === 'password') {
      const email = String(body?.email ?? '').trim().toLowerCase();
      const account = accountFor(email);
      const ok = Boolean(account) && String(body?.password ?? '') === MOCK_PASSCODE;
      record({ fn: 'auth.password', email, outcome: ok ? 'signed in' : 'refused' });

      if (!ok) {
        json(res, 400, {
          error: 'invalid_grant',
          error_description: 'Invalid login credentials',
        });
        return true;
      }

      const session = issueSession(account.user_id, email);
      json(res, 200, {
        ...session,
        token_type: 'bearer',
        user: { id: account.user_id, email },
      });
      return true;
    }

    if (grant !== 'refresh_token') {
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
    event_evidence_requirements: {
      table: 'event_evidence_requirements',
      kind: 'many',
      from: 'id',
      to: 'event_id',
    },
  },
  event_categories: {
    categories: { table: 'categories', kind: 'one', from: 'category_id', to: 'id' },
    events: { table: 'events', kind: 'one', from: 'event_id', to: 'id' },
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

/** fn_portal_year(): the one year with is_current set. */
const portalYear = () => db.academic_years.find((row) => row.is_current) ?? null;

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
 * point_total is every category's credit added up: one unit, and it is points.
 * is_honorary is the root requirement's verdict.
 */
function memberStatusRows() {
  const indexByYear = new Map();
  const out = [];

  for (const enrollment of db.member_enrollments) {
    const yearId = enrollment.academic_year_id;
    if (!indexByYear.has(yearId)) indexByYear.set(yearId, totalsByMember(yearId));
    const index = indexByYear.get(yearId);
    const totals = index.get(enrollment.member_id) ?? new Map();

    // Every category's credit is points. There used to be a
    // counts_toward_point_total flag here, false for Volunteering hours alone,
    // and migration 22 dropped it with the unit it existed for.
    let points = 0;
    for (const total of totals.values()) points += total;

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

// fn_retroactive_match_candidates()'s similarity floor (migration
// 20260814140000, section 19.1's retroactive_name_similarity setting). Not
// modelled as a queryable app_settings row: nothing else in this mock reads
// app_settings as a table, and every other threshold here is a plain
// constant for the same reason.
const RETRO_NAME_FLOOR = 0.3;

/** One piece of a delimited string, 1-indexed, the way SQL's split_part() is. */
function splitPart(str, delim, n) {
  const parts = str.split(delim);
  return parts[n - 1] ?? '';
}

/**
 * fn_normalise_email() (migration 20260813100000_duplicate_people.sql),
 * reproduced exactly rather than with the plain case-insensitive compare
 * duplicatePairRows() below uses: a +tag and interior dots in the local part
 * collapse, so two spellings that reach one inbox count as the same address.
 */
function normaliseEmailForMatch(email) {
  const raw = String(email ?? '').trim().toLowerCase();
  const local = splitPart(raw, '@', 1).replace(/\+.*$/, '').replace(/\./g, '');
  const domain = splitPart(raw, '@', 2);
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

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
 * v_purge_runs_outstanding, computed the way the SQL view does: purge runs
 * with at least one purge_run_objects row nobody has confirmed deleting.
 */
function purgeRunsOutstandingRows() {
  const counts = new Map(); // purge_run_id -> { total, outstanding }
  for (const object of db.purge_run_objects) {
    const entry = counts.get(object.purge_run_id) ?? { total: 0, outstanding: 0 };
    entry.total += 1;
    if (!object.deleted_at) entry.outstanding += 1;
    counts.set(object.purge_run_id, entry);
  }

  const rows = [];
  for (const [runId, entry] of counts) {
    if (entry.outstanding === 0) continue;
    const run = db.purge_runs.find((r) => r.id === runId);
    if (!run) continue;
    rows.push({
      purge_run_id: runId,
      kind: run.kind,
      performed_by: run.performed_by,
      performed_at: run.performed_at,
      outstanding_count: entry.outstanding,
      total_count: entry.total,
    });
  }
  return rows;
}

// purge_runs_read, upload_grants_read and this view's own policy in the real
// RLS (migration 11) are all fn_is_officer(), narrower than fn_is_staff(): a
// viewer reads the storage screen's usage bar but not its operational detail.
// That is narrower than every other table below, which the blanket
// `isStaff(auth) return rows` a few lines down would otherwise grant, so
// these are checked first and returned early.
const OFFICER_ONLY_TABLES = new Set(['purge_runs', 'purge_run_objects', 'evidence_upload_grants']);
const OFFICER_VIEWS = { v_purge_runs_outstanding: purgeRunsOutstandingRows };

/**
 * The RLS table from docs/01-data-model.md section 8, in the crude form the
 * client can actually be tested against. Reads only: writes are checked at
 * their own call sites below.
 */
function visibleRows(table, auth) {
  if (OFFICER_ONLY_TABLES.has(table)) {
    return isOfficer(auth) ? (db[table] ?? []) : [];
  }
  if (OFFICER_VIEWS[table]) {
    return isOfficer(auth) ? OFFICER_VIEWS[table]() : [];
  }
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
    case 'event_evidence_requirements':
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
  events: (auth) => isOfficer(auth),
  event_categories: (auth) => isOfficer(auth),
  event_evidence_requirements: (auth) => isOfficer(auth),
  requirement_sets: (auth, row) =>
    isAdmin(auth) || (isOfficer(auth) && isDraft(row ?? { status: 'draft' })),
  requirement_nodes: (auth, row) =>
    isAdmin(auth) || (isOfficer(auth) && isDraft(setOf(row?.requirement_set_id))),
  requirement_node_categories: (auth, row) =>
    isAdmin(auth) || (isOfficer(auth) && isDraft(setOfNode(row?.node_id))),
  // settings_write (migration 11) is fn_is_admin(), narrower than purging
  // itself (fn_assert_officer()): an officer can clear photos but only an
  // admin can change how long they are kept.
  app_settings: (auth) => isAdmin(auth),
};

const uuid = (prefix) => `${prefix}${randomBytes(6).toString('hex')}`;

/** The defaults each table's columns carry, for a row the client did not fill in. */
const INSERT_DEFAULTS = {
  categories: (row) => ({
    id: uuid('c9000000-0000-4000-a000-'),
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

  // checkin_token is generated here the way a database default would
  // generate it: the client never sends one. checkin_opens_at is NOT forced
  // to null here, on purpose: the point of leaving it out of this default
  // object entirely (below, as `null` only via the spread's absence) is that
  // if events.js ever started sending a value, this mock would write it
  // rather than silently discarding it, which is what makes "checkin_opens_at
  // is never written" a check on the CLIENT rather than a check on this mock
  // masking a client bug.
  events: (row, auth) => ({
    id: uuid('e9000000-0000-4000-a000-'),
    term_id: null,
    location: null,
    notes: null,
    review_policy: 'manual_review',
    checkin_token: randomBytes(9).toString('base64url'),
    checkin_opens_at: null,
    checkin_closes_at: null,
    token_rotated_at: null,
    is_published: true,
    created_by: auth?.userId ?? null,
    created_at: new Date().toISOString(),
    ...row,
  }),
  event_categories: (row) => ({ fixed_credit: 1, ...row, credit_mode: row.credit_mode ?? 'fixed' }),
  event_evidence_requirements: (row) => ({
    id: uuid('v9000000-0000-4000-a000-'),
    prompt: null,
    is_required: true,
    ...row,
  }),

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
    // The member's own words. request_missing_credit() is its only writer, so
    // an officer's insert leaves it null.
    member_note: null,
    ...row,
    status: 'pending',
  }),
};

/**
 * fn_rate_limit_check(p_key, p_max_per_minute), in the mock.
 *
 * Counted per calendar minute exactly as the SQL counts it, so a full bucket
 * clears when the minute rolls over rather than easing off, which is the
 * behaviour api.js's second retry budget is written against.
 *
 * @returns {boolean} false when the caller has been refused and answered
 */
function rateLimited(res, helpers, key, maxPerMinute) {
  const bucket = `${key}:${Math.floor(Date.now() / 60_000)}`;
  const count = rateCounters.get(bucket) ?? 0;
  if (count >= maxPerMinute) {
    record({ fn: 'fn_rate_limit_check', key, outcome: 'PDS09' });
    helpers.pds(res, 'PDS09', 'Too many requests. Please wait a moment and try again.');
    return true;
  }
  rateCounters.set(bucket, count + 1);
  return false;
}

// 18.9 of the migration, as rows in app_settings there and as the same two
// numbers here. Raising one is a settings edit rather than a deploy.
const CLAIM_SEARCH_MAX_PER_MIN = 30;
const MISSING_CREDIT_MAX_PER_MIN = 5;

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

      if (table === 'event_categories') {
        const pkClash = db.event_categories.some(
          (link) => link.event_id === row.event_id && link.category_id === row.category_id,
        );
        if (pkClash) {
          return {
            error: {
              status: 409,
              body: { code: '23505', message: 'duplicate key value violates unique constraint "event_categories_pkey"' },
            },
          };
        }
        // one_submitted_value_per_event. Checked against both what is already
        // written AND the rest of this same insert call: creating an event is
        // one insert carrying every category row at once, so a second
        // from_submission row can arrive in the same batch as the first, with
        // nothing in `db` yet to compare against.
        if (row.credit_mode === 'from_submission') {
          const already = [...db.event_categories, ...written].some(
            (link) => link.event_id === row.event_id && link.credit_mode === 'from_submission',
          );
          if (already) {
            return {
              error: {
                status: 409,
                body: {
                  code: '23505',
                  message:
                    'duplicate key value violates unique constraint "one_submitted_value_per_event"',
                },
              },
            };
          }
        }
      }

      if (table === 'event_evidence_requirements') {
        const clash = db.event_evidence_requirements.some(
          (existingRow) => existingRow.event_id === row.event_id && existingRow.kind === row.kind,
        );
        if (clash) {
          return {
            error: {
              status: 409,
              body: {
                code: '23505',
                message:
                  'duplicate key value violates unique constraint "event_evidence_requirements_event_id_kind_key"',
              },
            },
          };
        }
      }

      const created = INSERT_DEFAULTS[table](row, auth);
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

  // Real Postgres behaviour for `categories`: RLS passes, then the FK check
  // fails, distinct from the role-based refusal above (RLS filters the row
  // out entirely, 200 + empty array). Every reference to a category is `on
  // delete restrict` (invariant 4, docs/03-admin-ui.md), so a category that
  // event_categories or requirement_node_categories still points at, in any
  // year or any requirement set, is refused rather than removed.
  if (table === 'categories') {
    const referenced = targets.some(
      (row) =>
        db.event_categories.some((ec) => ec.category_id === row.id) ||
        db.requirement_node_categories.some((link) => link.category_id === row.id),
    );
    if (referenced) {
      record({ fn: `delete.${table}`, actor: auth.userId, outcome: 'refused by fk', matched: 0 });
      return {
        error: {
          status: 409,
          body: {
            code: '23503',
            message: 'update or delete on table "categories" violates foreign key constraint',
            details: null,
            hint: null,
          },
        },
      };
    }
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

/**
 * The bounded walk fn_retroactive_match_candidates() and
 * link_retroactive_matches() both open with, the same one
 * review_member_claim() already uses (migration 18, section 18.6): follow a
 * merge to the survivor, refuse an archived member or a chain that never
 * resolves. Shared here because both new handlers need exactly the same
 * three sentences the real migration raises.
 *
 * Lock semantics are not reproduced (this mock is single-threaded, per its
 * own module comment), only the walk and the refusals.
 */
function resolveRetroTarget(memberId) {
  let id = memberId;
  let member = null;
  for (let hops = 0; hops < 10; hops += 1) {
    member = db.members.find((row) => row.id === id) ?? null;
    if (!member) break;
    if (!member.merged_into_id) break;
    id = member.merged_into_id;
  }
  if (!member) return { error: 'PDS03', message: 'Unknown member.' };
  if (member.merged_into_id) {
    return { error: 'PDS03', message: 'That members record cannot be resolved.' };
  }
  if (member.archived_at) return { error: 'PDS03', message: 'That member is archived.' };
  return { target: member, followedMerge: member.id !== memberId };
}

/**
 * One roster row, found or created, and enrolled for the year.
 *
 * This is the body of upsert_member_and_enroll(), lifted out so that the batch
 * RPC calls it rather than carrying a second copy of the resolution rules. The
 * real batch function does the same thing for the same reason: two
 * implementations of "who is this row" drift, and the way they drift is by
 * quietly creating a second person for somebody the club already has.
 *
 * Returns the same three fields the RPC returns, or `{ error, message }` for a
 * row that cannot be written. The caller decides whether that is an HTTP error
 * (single row) or an entry in the results array (batch).
 *
 * @param {{first_name?: string, last_name?: string, email?: string|null,
 *   ucf_nid?: string|null, matched_member_id?: string|null}} row
 */
function upsertOne(auth, yearId, row) {
  const first = String(row.first_name ?? '').trim();
  const last = String(row.last_name ?? '').trim();
  if (!first || !last) {
    return { error: 'PDS03', message: 'A member needs a first name and a last name.' };
  }

  const email = String(row.email ?? '').trim().toLowerCase() || null;
  const nid = String(row.ucf_nid ?? '').trim().toLowerCase() || null;

  let member = null;
  if (row.matched_member_id) {
    member = db.members.find((one) => one.id === row.matched_member_id) ?? null;
    if (!member) return { error: 'PDS03', message: 'Unknown member.' };
  } else {
    if (email) {
      member = db.members.find((one) => String(one.email ?? '').toLowerCase() === email) ?? null;
    }
    if (!member && nid) {
      member = db.members.find((one) => String(one.ucf_nid ?? '').toLowerCase() === nid) ?? null;
    }
    // The name tier, from migration 20. It is what makes a re-run of an
    // interrupted import land on the rows the first attempt wrote, now that
    // nothing carries an address for the tier above to match on. Live rows
    // only, oldest first, both spellings of the name compared.
    if (!member) {
      const wanted = normaliseName(`${first} ${last}`);
      member =
        db.members
          .filter((one) => !one.archived_at && !one.merged_into_id)
          .filter(
            (one) =>
              normaliseName(one.display_name) === wanted ||
              normaliseName(`${one.first_name} ${one.last_name}`) === wanted,
          )
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null;
    }
  }

  // Follow a tombstone. merge_members() leaves the loser's address on the
  // merged row, so last year's file still resolves to it.
  for (let hops = 0; hops < 10 && member?.merged_into_id; hops += 1) {
    member = db.members.find((one) => one.id === member.merged_into_id) ?? null;
  }
  if (member?.archived_at) {
    return { error: 'PDS03', message: 'That member is archived.' };
  }

  let created = false;
  if (!member) {
    member = {
      id: uuid('m9000000-0000-4000-a000-'),
      first_name: first,
      last_name: last,
      preferred_name: null,
      email: row.email || null,
      ucf_nid: row.ucf_nid || null,
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
    (one) => one.member_id === member.id && one.academic_year_id === yearId,
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

  return { member_id: member.id, was_created: created, was_enrolled: enrolled };
}

// ---------------------------------------------------------------------------
// Storage: the purge flow
// ---------------------------------------------------------------------------
// Written against supabase/migrations/20260815100000_storage_ops.sql. The
// eligibility rule is reproduced once, in eligibleEvidence(), and both
// purge_evidence and fn_purge_preview read it, the same way the real
// migration writes the two queries to match on purpose: a preview that
// promised something the purge itself declined to do would be worse than no
// preview.

const settingInt = (key, fallback) => {
  const row = db.app_settings.find((s) => s.key === key);
  return row ? Number(row.value) : fallback;
};

const monthsAgo = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() - Number(months));
  return d;
};

/** Every unpurged, reviewed evidence row whose event is older than `months`. */
function eligibleEvidence(months) {
  const cutoff = monthsAgo(months);
  return db.attendance_evidence
    .filter((e) => !e.purged_at && e.object_path)
    .map((e) => {
      const record = db.attendance_records.find((r) => r.id === e.attendance_record_id);
      const event = record ? db.events.find((ev) => ev.id === record.event_id) : null;
      return { evidence: e, record, event };
    })
    .filter(
      ({ record, event }) =>
        record &&
        ['approved', 'rejected'].includes(record.status) &&
        event &&
        new Date(event.occurred_on) < cutoff,
    );
}

/** v_orphaned_uploads: an expired, unconsumed, unreclaimed grant nothing points at. */
function orphanedUploadRows() {
  const now = Date.now();
  return db.evidence_upload_grants.filter(
    (g) =>
      !g.consumed_at &&
      !g.reclaimed_at &&
      new Date(g.expires_at).getTime() < now &&
      !db.attendance_evidence.some((e) => e.object_path === g.object_path),
  );
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
  // Retroactive matching
  // -------------------------------------------------------------------------
  // Written against supabase/migrations/20260814140000_retroactive_matching.sql.
  // Officer only, no anon or member access, via the same isOfficer() gate
  // every other RPC here uses.

  /** fn_retroactive_match_candidates(p_member_id uuid) returns table(...) */
  fn_retroactive_match_candidates(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'fn_retroactive_match_candidates', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const resolved = resolveRetroTarget(body.p_member_id);
    if (resolved.error) {
      pds(res, resolved.error, resolved.message);
      return;
    }
    const { target, followedMerge } = resolved;

    const normEmail = normaliseEmailForMatch(target.email);
    const normName = normaliseName(target.display_name);
    const enrolledYears = new Set(
      db.member_enrollments
        .filter((row) => row.member_id === target.id)
        .map((row) => row.academic_year_id),
    );

    const rows = [];
    for (const rec of db.attendance_records) {
      if (rec.member_id !== null || rec.status !== 'pending') continue;
      const event = db.events.find((e) => e.id === rec.event_id);
      if (!event || !enrolledYears.has(event.academic_year_id)) continue;

      // Tier 1, an identity: the claimed email reaches the same inbox as the
      // member's own. Tier 2, a resemblance, only checked when tier 1 does
      // not match, so a record matching both collapses to the stronger
      // reason without any further bookkeeping.
      let reason = null;
      let score = 0;
      if (normEmail && normaliseEmailForMatch(rec.claimed_email) === normEmail) {
        reason = 'exact_email';
        score = 1;
      } else {
        const claimedNorm = normaliseName(rec.claimed_name);
        if (normName && claimedNorm) {
          const measured = similarity(claimedNorm, normName);
          if (measured >= RETRO_NAME_FLOOR) {
            reason = 'name_match';
            score = Math.min(Number(measured.toFixed(3)), 1);
          }
        }
      }
      if (!reason) continue;

      rows.push({
        record_id: rec.id,
        event_id: event.id,
        event_title: event.title,
        occurred_on: event.occurred_on,
        claimed_name: rec.claimed_name,
        claimed_email: rec.claimed_email,
        reason,
        score,
        resolved_member_id: target.id,
        followed_merge: followedMerge,
      });
    }

    rows.sort((a, b) => b.score - a.score || String(b.occurred_on).localeCompare(String(a.occurred_on)));

    record({
      fn: 'fn_retroactive_match_candidates',
      actor: auth.userId,
      memberId: body.p_member_id,
      resolvedMemberId: target.id,
      rows: rows.length,
    });
    json(res, 200, rows);
  },

  /** link_retroactive_matches(p_member_id uuid, p_record_ids uuid[]) returns table(...) */
  link_retroactive_matches(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'link_retroactive_matches', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const resolved = resolveRetroTarget(body.p_member_id);
    if (resolved.error) {
      pds(res, resolved.error, resolved.message);
      return;
    }
    const { target, followedMerge } = resolved;

    // Distinct and sorted, so a duplicate id in the input reports once, the
    // same as the real function.
    const ids = [...new Set(Array.isArray(body.p_record_ids) ? body.p_record_ids : [])].sort();

    const results = ids.map((id) => {
      const rec = db.attendance_records.find((row) => row.id === id);
      let outcome;

      if (!rec) {
        outcome = 'not_found';
      } else if (rec.member_id !== null) {
        outcome = 'already_linked';
      } else if (rec.status !== 'pending') {
        // Most likely rejected between the preview and this call: the write
        // re-reads status rather than trusting what the screen showed.
        outcome = 'not_pending';
      } else {
        const event = db.events.find((e) => e.id === rec.event_id);
        const enrolled =
          event &&
          db.member_enrollments.some(
            (row) => row.member_id === target.id && row.academic_year_id === event.academic_year_id,
          );
        if (!enrolled) {
          outcome = 'wrong_year';
        } else {
          // one_live_record_per_member_event: caught here rather than let a
          // batch abort, the same non-atomic reason as every other outcome.
          const clash = db.attendance_records.some(
            (other) =>
              other.id !== rec.id &&
              other.event_id === rec.event_id &&
              other.member_id === target.id &&
              other.status !== 'rejected',
          );
          if (clash) {
            outcome = 'conflict';
          } else {
            rec.member_id = target.id;
            rec.flags = (rec.flags ?? []).filter((flag) => flag !== 'unmatched_name');
            outcome = 'linked';
          }
        }
      }

      return { record_id: id, outcome, resolved_member_id: target.id, followed_merge: followedMerge };
    });

    audit(auth, 'link_retroactive_matches', 'attendance_record', null, {
      member_id: body.p_member_id,
      resolved_member_id: target.id,
      followed_merge: followedMerge,
      results,
    });
    record({
      fn: 'link_retroactive_matches',
      actor: auth.userId,
      memberId: body.p_member_id,
      resolvedMemberId: target.id,
      followedMerge,
      results,
    });

    json(res, 200, results);
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

    // Names before the year, which is the order the real function checks them
    // in. upsertOne() checks the names again; the year is checked here rather
    // than inside it because the batch RPC checks the year once for the whole
    // call, before any row runs.
    if (!String(body.p_first_name ?? '').trim() || !String(body.p_last_name ?? '').trim()) {
      pds(res, 'PDS03', 'A member needs a first name and a last name.');
      return;
    }

    const yearId = body.p_academic_year_id;
    if (!yearId || !db.academic_years.some((year) => year.id === yearId)) {
      pds(res, 'PDS03', 'Unknown academic year.');
      return;
    }

    const result = upsertOne(auth, yearId, {
      first_name: body.p_first_name,
      last_name: body.p_last_name,
      email: body.p_email,
      ucf_nid: body.p_ucf_nid,
      matched_member_id: body.p_matched_member_id,
    });

    if (result.error) {
      pds(res, result.error, result.message);
      return;
    }

    json(res, 200, {
      member_id: result.member_id,
      was_created: result.was_created,
      was_enrolled: result.was_enrolled,
    });
  },

  /**
   * upsert_members_and_enroll(p_rows jsonb, p_academic_year_id uuid)
   *   returns jsonb
   *
   * Written against supabase/migrations/20260814120000_member_import_batch.sql.
   * The reason the roster screen calls this instead of looping is that the
   * real file is 355 rows, and the reason it can trust the answer is the
   * per-row isolation, so both are reproduced here:
   *
   *   * it runs the same upsertOne() the single-row RPC above runs, so there
   *     is one implementation of who a row resolves to on this side too
   *   * a row that fails is a result with an error on it, not the end of the
   *     call. Its neighbours are written
   *   * results come back in input order, carrying the caller's own line
   *     number when it sent one and the 1-based ordinal when it did not
   *   * the whole call is refused for a caller who is not an officer, for an
   *     unknown year, and over the 500 row cap, before anything is written
   */
  upsert_members_and_enroll(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'upsert_members_and_enroll', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    // A whole call that never lands, which is what a dropped connection looks
    // like now that a chunk is one request rather than a hundred.
    if (injectedFailure(res, 'upsert_members_and_enroll', helpers)) return;

    const rows = body.p_rows;
    if (!Array.isArray(rows)) {
      pds(res, 'PDS03', 'Rows must be a JSON array.');
      return;
    }
    if (rows.length > 500) {
      pds(res, 'PDS03', 'An import is at most 500 rows per call.');
      return;
    }

    const yearId = body.p_academic_year_id;
    if (!yearId || !db.academic_years.some((year) => year.id === yearId)) {
      pds(res, 'PDS03', 'Unknown academic year.');
      return;
    }

    let created = 0;
    let enrolled = 0;
    let refused = 0;

    const results = rows.map((row, index) => {
      const line = typeof row?.row === 'number' ? row.row : index + 1;
      const outcome = refusedImportRow(line) ?? upsertOne(auth, yearId, row ?? {});

      if (outcome.error) {
        refused += 1;
        return {
          row: line,
          member_id: null,
          was_created: false,
          was_enrolled: false,
          error: outcome.error,
          message: outcome.message,
        };
      }

      if (outcome.was_created) created += 1;
      if (outcome.was_enrolled) enrolled += 1;
      return {
        row: line,
        member_id: outcome.member_id,
        was_created: outcome.was_created,
        was_enrolled: outcome.was_enrolled,
      };
    });

    audit(auth, 'upsert_members_and_enroll', 'member', null, {
      academic_year_id: yearId,
      rows: rows.length,
      created,
      enrolled,
      refused,
    });
    record({
      fn: 'upsert_members_and_enroll',
      actor: auth.userId,
      rows: rows.length,
      created,
      enrolled,
      refused,
    });

    json(res, 200, shortenResults(results));
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
  // Storage: the purge flow
  // -------------------------------------------------------------------------

  /** fn_storage_usage() returns table(...). Staff gated: a viewer reads it. */
  fn_storage_usage(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isStaff(auth)) {
      record({ fn: 'fn_storage_usage', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const live = db.attendance_evidence.filter((e) => !e.purged_at && e.object_path);
    const bytes = live.reduce((sum, e) => sum + (e.byte_size ?? 0), 0);
    const quota = settingInt('storage_quota_bytes', 1073741824);
    const percent = quota === 0 ? 0 : Math.round((bytes / quota) * 1000) / 10;

    json(res, 200, [
      {
        photo_count: live.length,
        bytes_held: bytes,
        quota_bytes: quota,
        warn_percent: settingInt('storage_warn_percent', 75),
        percent_used: percent,
        orphaned_count: orphanedUploadRows().length,
      },
    ]);
  },

  /** fn_purge_preview(p_retention_months) returns table(...). Officer only. */
  fn_purge_preview(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'fn_purge_preview', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const months = body.p_retention_months ?? settingInt('evidence_retention_months', 12);
    if (months < 1) {
      pds(res, 'PDS03', 'Retention window must be at least one month.');
      return;
    }

    const byEvent = new Map();
    for (const { evidence, event } of eligibleEvidence(months)) {
      const entry = byEvent.get(event.id) ?? { event, count: 0, bytes: 0 };
      entry.count += 1;
      entry.bytes += evidence.byte_size ?? 0;
      byEvent.set(event.id, entry);
    }

    const rows = [...byEvent.values()]
      .sort((a, b) => String(a.event.occurred_on).localeCompare(String(b.event.occurred_on)))
      .map(({ event, count, bytes }) => ({
        event_id: event.id,
        event_title: event.title,
        occurred_on: event.occurred_on,
        photo_count: count,
        bytes,
      }));

    json(res, 200, rows);
  },

  /**
   * purge_evidence(p_retention_months, p_event_ids) returns jsonb.
   *
   * p_event_ids null means every eligible event. Given, it is intersected
   * with the eligible set: a requested id that produced nothing eligible
   * comes back in ineligible_event_ids rather than being silently skipped or
   * silently purged, the same rule link_retroactive_matches() already keeps.
   */
  purge_evidence(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'purge_evidence', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const months = body.p_retention_months ?? settingInt('evidence_retention_months', 12);
    if (months < 1) {
      pds(res, 'PDS03', 'Retention window must be at least one month.');
      return;
    }

    let eligible = eligibleEvidence(months);
    let ineligible = [];
    if (Array.isArray(body.p_event_ids)) {
      const requested = [...new Set(body.p_event_ids)];
      const stillEligible = new Set(
        eligible.filter((row) => requested.includes(row.event.id)).map((row) => row.event.id),
      );
      ineligible = requested.filter((id) => !stillEligible.has(id));
      eligible = eligible.filter((row) => requested.includes(row.event.id));
    }

    const eventIds = [...new Set(eligible.map((row) => row.event.id))];
    const bytes = eligible.reduce((sum, row) => sum + (row.evidence.byte_size ?? 0), 0);
    const paths = eligible.map((row) => row.evidence.object_path);

    const runId = uuid('p9000000-0000-4000-a000-');
    db.purge_runs.push({
      id: runId,
      performed_by: auth.userId,
      performed_at: new Date().toISOString(),
      kind: 'evidence',
      retention_months: months,
      evidence_count: eligible.length,
      bytes_freed: bytes,
      event_ids: eventIds,
    });

    for (const row of eligible) {
      row.evidence.purged_at = new Date().toISOString();
      row.evidence.purge_run_id = runId;
    }

    for (const path of paths) {
      db.purge_run_objects.push({
        id: uuid('q9000000-0000-4000-a000-'),
        purge_run_id: runId,
        bucket: 'evidence',
        object_path: path,
        deleted_at: null,
      });
    }

    audit(auth, 'purge_evidence', 'purge_run', runId, {
      retention_months: months,
      evidence_count: eligible.length,
      bytes_freed: bytes,
      requested_event_ids: body.p_event_ids ?? null,
      ineligible_event_ids: ineligible,
    });
    record({
      fn: 'purge_evidence',
      actor: auth.userId,
      months,
      count: eligible.length,
      bytes,
      eventIds,
      ineligible,
    });

    json(res, 200, {
      purge_run_id: runId,
      evidence_count: eligible.length,
      bytes_freed: bytes,
      event_ids: eventIds,
      object_paths: paths,
      ineligible_event_ids: ineligible,
    });
  },

  /** purge_orphaned_uploads() returns jsonb. Officer only. */
  purge_orphaned_uploads(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'purge_orphaned_uploads', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const orphans = orphanedUploadRows();
    const runId = uuid('p9000000-0000-4000-a000-');

    db.purge_runs.push({
      id: runId,
      performed_by: auth.userId,
      performed_at: new Date().toISOString(),
      kind: 'orphaned_uploads',
      retention_months: null,
      evidence_count: orphans.length,
      bytes_freed: 0,
      event_ids: [...new Set(orphans.map((g) => g.event_id))],
    });

    for (const grant of orphans) {
      grant.reclaimed_at = new Date().toISOString();
      grant.purge_run_id = runId;
      db.purge_run_objects.push({
        id: uuid('q9000000-0000-4000-a000-'),
        purge_run_id: runId,
        bucket: grant.bucket_id ?? 'evidence',
        object_path: grant.object_path,
        deleted_at: null,
      });
    }

    audit(auth, 'purge_orphaned_uploads', 'purge_run', runId, {
      grants_reclaimed: orphans.length,
      objects_to_delete: orphans.length,
    });
    record({ fn: 'purge_orphaned_uploads', actor: auth.userId, count: orphans.length });

    json(res, 200, {
      purge_run_id: runId,
      grants_reclaimed: orphans.length,
      objects_to_delete: orphans.length,
      object_paths: orphans.map((g) => g.object_path),
    });
  },

  /**
   * finish_purge_run(p_run_id, p_object_paths) returns table(...). Stamps
   * the paths Storage actually confirmed deleting for one run, so a run the
   * browser only partly finished can be closed out later. Officer only.
   */
  finish_purge_run(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'finish_purge_run', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    // For a check to prove that a browser-side Storage delete succeeding is
    // never enough on its own: deleteAndFinish() (src/storage.js) has to
    // read "deleted" off what this call confirms, not off what Storage
    // echoed, and a finish_purge_run() that dies here is the case that
    // proves it.
    if (injectedFailure(res, 'finish_purge_run', helpers)) return;

    const run = db.purge_runs.find((r) => r.id === body.p_run_id);
    if (!run) {
      pds(res, 'PDS03', 'Unknown purge run.');
      return;
    }

    const paths = [...new Set(Array.isArray(body.p_object_paths) ? body.p_object_paths : [])];
    const results = paths.map((path) => {
      const row = db.purge_run_objects.find(
        (o) => o.purge_run_id === run.id && o.object_path === path,
      );
      if (!row) return { object_path: path, outcome: 'unknown_object' };
      if (row.deleted_at) return { object_path: path, outcome: 'already_marked' };
      row.deleted_at = new Date().toISOString();
      return { object_path: path, outcome: 'marked_deleted' };
    });

    audit(auth, 'finish_purge_run', 'purge_run', run.id, { object_paths: paths });
    record({ fn: 'finish_purge_run', actor: auth.userId, runId: run.id, results });

    json(res, 200, results);
  },

  // -------------------------------------------------------------------------
  // The member portal
  // -------------------------------------------------------------------------
  // The four functions of migration 18 that the portal calls and no officer
  // screen does. Written against the same file as the two below it, and held
  // to the same standard: a mock that is more forgiving than Postgres is a lie
  // that ships, so every refusal the SQL makes is made here, for the reason the
  // SQL makes it.

  /**
   * start_portal_session() returns jsonb
   *
   * The only call in this product that an account the database has never seen
   * can make, and the one that decides which of four screens the portal draws.
   *
   *   * it creates the profiles row, with role `member` written out rather than
   *     left to the column default, which is `viewer` and is read-only STAFF.
   *     A mock that defaulted it would let a privilege bug through
   *   * it never changes a role that already exists, so an officer who opens
   *     /me comes out an officer
   *   * it auto-links when the address matches exactly one live, unmerged,
   *     unclaimed roster row. That is the common path once officers collect
   *     emails, and it is the path nobody waits on
   *   * it returns the most recent claim in ANY status, because a rejected one
   *     is a screen too
   */
  start_portal_session(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    // Not a role check at all: this function's whole job is to serve a caller
    // who has no role yet. All it needs is an end user.
    if (auth.kind !== 'user') {
      record({ fn: 'start_portal_session', outcome: 'PDS07', role: auth.kind });
      pds(res, 'PDS07', 'Sign in first.');
      return;
    }

    const email = String(auth.email ?? '').trim().toLowerCase() || null;
    let profile = db.profiles.find((row) => row.user_id === auth.userId) ?? null;
    let created = false;
    let linked = false;

    if (!profile) {
      profile = {
        user_id: auth.userId,
        member_id: null,
        full_name: null,
        role: 'member',
        created_at: new Date().toISOString(),
      };
      db.profiles.push(profile);
      created = true;
    }

    if (!profile.member_id && email) {
      // members.email is citext UNIQUE, so "matches exactly one live member" is
      // the index's guarantee rather than this filter's. The three exclusions
      // are the ones that matter: an archived or merged row is not a person to
      // link to, and a row another profile holds is somebody else's record.
      const member = db.members.find(
        (row) =>
          String(row.email ?? '').toLowerCase() === email &&
          !row.archived_at &&
          !row.merged_into_id &&
          !db.profiles.some((other) => other.member_id === row.id),
      );
      if (member) {
        profile.member_id = member.id;
        linked = true;
      }
    }

    // Audited only when something changed. The portal calls this on every load,
    // and an audit row per page view would bury the rows that mean something.
    if (created || linked) {
      audit(auth, 'start_portal_session', 'profile', null, {
        created_profile: created,
        auto_linked: linked,
        member_id: profile.member_id,
      });
    }
    record({
      fn: 'start_portal_session',
      actor: auth.userId,
      created,
      linked,
      memberId: profile.member_id,
    });

    const member = db.members.find((row) => row.id === profile.member_id) ?? null;

    // The most recent claim in any status. At most one can be live:
    // one_live_claim_per_user says so.
    const claim =
      [...db.member_claims]
        .filter((row) => row.user_id === auth.userId)
        .filter((row) => db.members.some((m) => m.id === row.member_id)) // join members
        .sort(
          (a, b) =>
            String(b.requested_at).localeCompare(String(a.requested_at)) ||
            String(a.id).localeCompare(String(b.id)),
        )[0] ?? null;

    json(res, 200, {
      user_id: auth.userId,
      role: profile.role,
      member_id: profile.member_id,
      member_name: member?.display_name ?? null,
      auto_linked: linked,
      claim: claim
        ? {
            id: claim.id,
            status: claim.status,
            member_id: claim.member_id,
            member_name:
              db.members.find((row) => row.id === claim.member_id)?.display_name ?? null,
            requested_at: claim.requested_at,
            review_note: claim.review_note ?? null,
          }
        : null,
    });
  },

  /**
   * search_roster_for_claim(p_q text) returns table (id, display_name)
   *
   * Bounded on all four sides the migration bounds it on, because each one is
   * a way a member could read a roster they are not allowed to read:
   *
   *   WHO       a signed-in account with a profiles row that is not yet linked.
   *             Not "is a member": an officer who is also a member has to be
   *             able to claim their own row.
   *   WHAT      id and display_name. No email, no student id, no join date, no
   *             total, nothing about progress.
   *   HOW MUCH  ten rows, three letters minimum.
   *   HOW OFTEN rate limited per caller.
   *
   * And it hides anybody already spoken for, so a name on the list is a name
   * that can be claimed. Without that, two people pick Abigail Catto and the
   * second one is refused after they have already chosen.
   */
  search_roster_for_claim(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (auth.kind !== 'user') {
      pds(res, 'PDS07', 'Sign in first.');
      return;
    }

    const profile = db.profiles.find((row) => row.user_id === auth.userId) ?? null;
    if (!profile) {
      // start_portal_session() creates that row, and the portal calls it before
      // it can render this screen. A caller with no row has not come through
      // the front door.
      pds(res, 'PDS07', 'Start a portal session first.');
      return;
    }
    if (profile.member_id) {
      pds(res, 'PDS07', 'This account is already linked to a member.');
      return;
    }

    const q = String(body.p_q ?? '').trim();
    if (q.length < 3) {
      // The same floor search_members() holds on the check-in page: a
      // one-letter query is a way to walk the roster alphabetically.
      pds(res, 'PDS03', 'Type at least three letters of your name.');
      return;
    }

    if (rateLimited(res, helpers, `claim_search:${auth.userId}`, CLAIM_SEARCH_MAX_PER_MIN)) return;

    const needle = q.toLowerCase();
    const rows = db.members
      .filter((member) => {
        if (member.archived_at || member.merged_into_id) return false;
        if (db.profiles.some((row) => row.member_id === member.id)) return false;
        if (db.member_claims.some((row) => row.member_id === member.id && row.status !== 'rejected')) {
          return false;
        }
        // `ilike '%q%' or display_name % q`: contained, or close enough for the
        // trigram operator. similarity() here is the same measure the duplicate
        // view stands in with, and 0.3 is pg_trgm's own default threshold.
        return (
          member.display_name.toLowerCase().includes(needle) ||
          similarity(member.display_name, q) >= 0.3
        );
      })
      .sort((a, b) => {
        const aPrefix = a.display_name.toLowerCase().startsWith(needle) ? 0 : 1;
        const bPrefix = b.display_name.toLowerCase().startsWith(needle) ? 0 : 1;
        return (
          aPrefix - bPrefix ||
          similarity(b.display_name, q) - similarity(a.display_name, q) ||
          a.display_name.localeCompare(b.display_name)
        );
      })
      .slice(0, 10)
      .map((member) => ({ id: member.id, display_name: member.display_name }));

    record({ fn: 'search_roster_for_claim', actor: auth.userId, q, rows: rows.length });
    json(res, 200, rows);
  },

  /**
   * file_member_claim(p_member_id uuid, p_note text) returns jsonb
   *
   * The two partial unique indexes from migration 03 are the real guard, and
   * this does not try to be a second one: liveClaimConflict() below is those
   * two indexes written as predicates, and which one fires is what decides the
   * code. They are two codes because they are two situations.
   *
   *   one_live_claim_per_user    the caller already asked and is waiting. Not a
   *                              mistake, and nothing for them to do.
   *   one_live_claim_per_member  somebody else is claiming that person, which
   *                              is the wrong row picked or two roster rows for
   *                              one human. An officer has to look.
   *
   * Deliberately NOT refused for a member another profile already holds:
   * file_member_claim() does not check that either. search_roster_for_claim()
   * hides them, and review_member_claim() refuses at approval, which is the
   * step that actually grants the read.
   */
  file_member_claim(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (auth.kind !== 'user') {
      pds(res, 'PDS07', 'Sign in first.');
      return;
    }

    const profile = db.profiles.find((row) => row.user_id === auth.userId) ?? null;
    if (!profile) {
      pds(res, 'PDS07', 'Start a portal session first.');
      return;
    }
    if (profile.member_id) {
      pds(res, 'PDS07', 'This account is already linked to a member.');
      return;
    }

    const member = db.members.find(
      (row) => row.id === body.p_member_id && !row.archived_at && !row.merged_into_id,
    );
    if (!member) {
      pds(res, 'PDS03', 'Unknown member.');
      return;
    }

    const note = String(body.p_note ?? '').trim() || null;
    // A bound on what one caller can write into a column an officer reads. It
    // is also a check constraint on the column, because claims_insert_own lets
    // a claim be POSTed straight to the table without coming through here.
    if (note && note.length > 500) {
      pds(res, 'PDS03', 'That note is too long.');
      return;
    }

    // Which index would fire, read in the order Postgres would check them.
    const conflict = db.member_claims.some(
      (row) => row.user_id === auth.userId && row.status !== 'rejected',
    )
      ? 'one_live_claim_per_user'
      : db.member_claims.some(
            (row) => row.member_id === member.id && row.status !== 'rejected',
          )
        ? 'one_live_claim_per_member'
        : null;

    if (conflict === 'one_live_claim_per_user') {
      record({ fn: 'file_member_claim', actor: auth.userId, outcome: 'PDS13' });
      pds(res, 'PDS13', 'You already have a claim waiting.');
      return;
    }
    if (conflict === 'one_live_claim_per_member') {
      record({ fn: 'file_member_claim', actor: auth.userId, outcome: 'PDS14' });
      pds(res, 'PDS14', 'Somebody has already claimed that member.');
      return;
    }

    const claim = {
      id: uuid('k9000000-0000-4000-a000-'),
      user_id: auth.userId,
      member_id: member.id,
      status: 'pending',
      note,
      requested_at: new Date().toISOString(),
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
    };
    db.member_claims.push(claim);

    record({ fn: 'file_member_claim', actor: auth.userId, claimId: claim.id, memberId: member.id });
    json(res, 200, {
      claim_id: claim.id,
      status: 'pending',
      member_id: member.id,
      member_name: member.display_name,
    });
  },

  /**
   * request_missing_credit(p_event_id uuid, p_note text, p_value numeric)
   *   returns jsonb
   *
   * INVARIANT 6 IS THE WHOLE DESIGN. This files a request, not a credit. There
   * is no argument by which a caller could reach the status column: it is
   * forced pending, sourced member_request, flagged member_requested, and it
   * lands in the same review queue as a scanned check-in.
   *
   * Every refusal below is a refusal rather than a flag, and the migration says
   * why: submit_checkin() lets an unenrolled member through because somebody
   * physically standing at an event is evidence. Nobody is standing anywhere
   * here, so an event in a year they are not on the roster for is a mistake at
   * the point of asking.
   */
  request_missing_credit(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (auth.kind !== 'user') {
      pds(res, 'PDS07', 'Sign in first.');
      return;
    }

    const profile = db.profiles.find((row) => row.user_id === auth.userId) ?? null;
    if (!profile || !profile.member_id) {
      record({ fn: 'request_missing_credit', outcome: 'PDS07', actor: auth.userId });
      pds(res, 'PDS07', 'This account is not linked to a member yet.');
      return;
    }

    // Placed here so a caller cannot spend somebody else's allowance, and
    // cannot spend their own on arguments that were never going to be accepted.
    if (rateLimited(res, helpers, `missing_credit:${auth.userId}`, MISSING_CREDIT_MAX_PER_MIN)) {
      return;
    }

    const note = String(body.p_note ?? '').trim() || null;
    if (!note) {
      pds(res, 'PDS03', 'Say what is missing.');
      return;
    }
    if (note.length > 500) {
      pds(res, 'PDS03', 'That note is too long.');
      return;
    }

    const event = db.events.find((row) => row.id === body.p_event_id && row.is_published) ?? null;
    if (!event) {
      pds(res, 'PDS03', 'Unknown event.');
      return;
    }

    // The same definition of enrolled that submit_checkin() uses for its
    // not_enrolled flag, so the two paths agree about who is on this year's
    // roster.
    const enrolled = db.member_enrollments.some(
      (row) =>
        row.member_id === profile.member_id &&
        row.academic_year_id === event.academic_year_id &&
        row.status === 'active',
    );
    if (!enrolled) {
      record({ fn: 'request_missing_credit', outcome: 'PDS03 not enrolled', actor: auth.userId });
      pds(res, 'PDS03', 'You are not on the roster for that year.');
      return;
    }

    const needsValue = db.event_categories.some(
      (row) => row.event_id === event.id && row.credit_mode === 'from_submission',
    );
    let value = body.p_value ?? null;
    if (needsValue && (value === null || value === undefined)) {
      pds(res, 'PDS03', 'This event needs a number (hours, for example) before it can be submitted.');
      return;
    }
    if (needsValue && Number(value) < 0) {
      pds(res, 'PDS03', 'That value cannot be negative.');
      return;
    }
    if (!needsValue) value = null; // ignore a value nobody asked for

    // one_live_record_per_member_event. The member already has a live record
    // for this event, which is usually the answer they were looking for: it is
    // there, it is just not approved yet.
    const clash = db.attendance_records.some(
      (row) =>
        row.event_id === event.id &&
        row.member_id === profile.member_id &&
        row.status !== 'rejected',
    );
    if (clash) {
      record({ fn: 'request_missing_credit', outcome: 'PDS05', actor: auth.userId });
      pds(res, 'PDS05', 'You already have a record for that event.');
      return;
    }

    const now = new Date().toISOString();
    const created = {
      id: uuid('r9000000-0000-4000-a000-'),
      event_id: event.id,
      member_id: profile.member_id,
      claimed_name: null,
      claimed_email: null,
      status: 'pending', // forced, never an argument
      source: 'member_request', // forced, never an argument
      submitted_value: value,
      flags: ['member_requested'],
      member_note: note,
      submitted_at: now,
      created_at: now,
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
    };
    db.attendance_records.push(created);

    record({
      fn: 'request_missing_credit',
      actor: auth.userId,
      memberId: profile.member_id,
      eventId: event.id,
      recordId: created.id,
      value,
    });

    json(res, 200, {
      record_id: created.id,
      status: 'pending',
      flags: created.flags,
    });
  },

  // -------------------------------------------------------------------------
  // Account claims
  // -------------------------------------------------------------------------
  // Written against supabase/migrations/20260814130000_member_portal.sql, which
  // is the contract. Both of these exist because the claims screen cannot do
  // the job through PostgREST: one reads a column PostgREST does not serve, and
  // the other makes a write RLS reserves for an admin.

  /**
   * list_pending_claims() returns table (claim_id, user_id, account_email,
   *   account_name, member_id, member_name, note, requested_at)
   *
   * The address the person signed in with lives in auth.users.email, and
   * PostgREST serves the `public` schema only. ACCOUNTS is this mock's
   * auth.users, so the lookup below is the LEFT JOIN the real function makes:
   * a claim filed by an account this mock has no address for comes back with a
   * null email rather than being dropped, exactly as the join would.
   */
  list_pending_claims(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'list_pending_claims', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const rows = db.member_claims
      .filter((claim) => claim.status === 'pending')
      .sort(
        (a, b) =>
          String(a.requested_at).localeCompare(String(b.requested_at)) ||
          String(a.id).localeCompare(String(b.id)),
      )
      .map((claim) => {
        const member = db.members.find((m) => m.id === claim.member_id);
        const profile = db.profiles.find((p) => p.user_id === claim.user_id) ?? null;
        return {
          claim_id: claim.id,
          user_id: claim.user_id,
          account_email: emailOfUser(claim.user_id),
          account_name: profile?.full_name ?? null,
          member_id: claim.member_id,
          member_name: member?.display_name ?? null,
          note: claim.note ?? null,
          requested_at: claim.requested_at,
        };
      })
      // join members: a claim whose member is gone is not in the queue.
      .filter((row) => row.member_name !== null);

    record({ fn: 'list_pending_claims', actor: auth.userId, rows: rows.length });
    json(res, 200, rows);
  },

  /**
   * review_member_claim(p_claim_id uuid, p_decision text, p_note text)
   *   returns jsonb
   *
   * The properties the claims screen depends on, reproduced rather than
   * approximated:
   *
   *   * an OFFICER can finish the link. This is the only path by which one can
   *     write profiles.member_id, and it is still the only column of profiles
   *     it writes: no role is created, changed or removed by an approval of an
   *     account that already has a profiles row
   *   * the member is revalidated HERE, not trusted from when the claim was
   *     filed. A merge is followed to the survivor, which is where
   *     merge_members() put the records; an archived row is refused
   *   * the claim keeps naming the row the member picked. Following is reported
   *     in the return value and the audit row instead, which is the only place
   *     that records that Confirm on one row linked another
   *   * both refusals that can arrive from a race are the constraints
   *     themselves rather than a hardcoded message: PDS13 is an account that
   *     already holds a different member, PDS14 is the UNIQUE on
   *     profiles.member_id refusing a member another profile already holds
   */
  review_member_claim(res, body, req, helpers, anonKey) {
    const { json, pds } = helpers;
    const auth = resolveAuth(req, anonKey);

    if (!isOfficer(auth)) {
      record({ fn: 'review_member_claim', outcome: 'PDS07', role: auth.role ?? auth.kind });
      pds(res, 'PDS07', 'This action requires an officer account.');
      return;
    }

    const decision = body.p_decision;
    if (!['approve', 'reject'].includes(decision)) {
      pds(res, 'PDS03', 'Decision must be approve or reject.');
      return;
    }

    const claim = db.member_claims.find((row) => row.id === body.p_claim_id) ?? null;
    if (!claim) {
      pds(res, 'PDS03', 'Unknown claim.');
      return;
    }
    if (claim.status !== 'pending') {
      pds(res, 'PDS03', 'That claim has already been decided.');
      return;
    }

    const note = String(body.p_note ?? '').trim() || null;
    let member = null;

    if (decision === 'approve') {
      // The same bounded walk upsert_member_and_enroll() does. A merge means
      // the row moved, not that the person stopped existing.
      let memberId = claim.member_id;
      for (let hops = 0; hops < 10; hops += 1) {
        member = db.members.find((row) => row.id === memberId) ?? null;
        if (!member) break;
        if (!member.merged_into_id) break;
        memberId = member.merged_into_id;
      }

      if (!member) {
        pds(res, 'PDS03', 'Unknown member.');
        return;
      }
      if (member.merged_into_id) {
        // Ten deep and still pointing somewhere else: a cycle, or a chain
        // longer than any real merge history.
        pds(res, 'PDS03', 'That members record cannot be resolved.');
        return;
      }
      if (member.archived_at) {
        // search_roster_for_claim() declines to offer archived rows, so
        // approving one here would leave the two halves of one rule
        // disagreeing.
        pds(res, 'PDS03', 'That member is archived.');
        return;
      }

      let profile = db.profiles.find((row) => row.user_id === claim.user_id) ?? null;

      if (profile?.member_id && profile.member_id !== member.id) {
        pds(res, 'PDS13', 'That account is already linked to a member.');
        return;
      }

      // profiles.member_id is UNIQUE, and that constraint is what decides this
      // rather than a check the function makes first: an admin patching
      // profiles directly is a second writer with no interest in this
      // function's gap.
      const held = db.profiles.find(
        (row) => row.member_id === member.id && row.user_id !== claim.user_id,
      );
      if (held) {
        pds(res, 'PDS14', 'That member is already linked to another account.');
        return;
      }

      if (!profile) {
        // claims_insert_own lets any signed-in account file a claim without
        // ever calling start_portal_session(), so the profiles row may
        // genuinely not exist yet. Role comes out `member` on that path.
        profile = {
          user_id: claim.user_id,
          member_id: member.id,
          full_name: null,
          role: 'member',
          created_at: new Date().toISOString(),
        };
        db.profiles.push(profile);
      } else if (profile.member_id === null || profile.member_id === undefined) {
        // The do-update branch, guarded: an existing role is never touched.
        profile.member_id = member.id;
      }

      // THE POSTCONDITION. A wrong refusal gets retried and a wrong success
      // does not, so this function does not report a link it has not confirmed.
      if (profile.member_id !== member.id) {
        pds(res, 'PDS13', 'That account is already linked to a member.');
        return;
      }
    }

    claim.status = decision === 'approve' ? 'approved' : 'rejected';
    claim.reviewed_by = auth.userId;
    claim.reviewed_at = new Date().toISOString();
    claim.review_note = note ?? claim.review_note ?? null;

    const followedMerge = Boolean(member) && member.id !== claim.member_id;
    const resolved = member?.id ?? claim.member_id;

    audit(auth, 'review_member_claim', 'member_claim', claim.id, {
      decision,
      user_id: claim.user_id,
      claimed_member_id: claim.member_id,
      member_id: resolved,
      followed_merge: followedMerge,
      note,
    });
    record({
      fn: 'review_member_claim',
      actor: auth.userId,
      claimId: claim.id,
      decision,
      claimedMemberId: claim.member_id,
      memberId: resolved,
      followedMerge,
    });

    json(res, 200, {
      claim_id: claim.id,
      status: claim.status,
      user_id: claim.user_id,
      claimed_member_id: claim.member_id,
      member_id: resolved,
      followed_merge: followedMerge,
      linked: decision === 'approve',
    });
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

  // -------------------------------------------------------------------------
  // The public member portal
  // -------------------------------------------------------------------------
  // The four functions of migration 21, which any caller may make, including one
  // holding nothing but the anon key. Held to the same standard as everything
  // above: a mock that is more forgiving than Postgres is a lie that ships, so
  // the shape of each answer is the shape the SQL builds, key for key, and the
  // one refusal the SQL makes (a member who is not on this year's roster) is
  // made here too.
  //
  // Nothing here checks a role. That is the point of them.

  /** portal_find_members(p_first_name text, p_last_name text) returns table */
  portal_find_members(res, body, req, helpers) {
    const { json } = helpers;
    const wanted = normaliseName(
      `${String(body.p_first_name ?? '').trim()} ${String(body.p_last_name ?? '').trim()}`,
    );
    const first = String(body.p_first_name ?? '').trim();
    const last = String(body.p_last_name ?? '').trim();

    if (!first || !last || !wanted) {
      record({ fn: 'portal_find_members', outcome: 'empty' });
      json(res, 200, []);
      return;
    }

    const yearId = portalYear()?.id ?? null;
    const rows = db.member_enrollments
      .filter((row) => row.academic_year_id === yearId)
      .map((row) => ({
        enrollment: row,
        member: db.members.find((one) => one.id === row.member_id) ?? null,
      }))
      .filter((entry) => entry.member && !entry.member.archived_at && !entry.member.merged_into_id)
      .filter(
        (entry) =>
          normaliseName(entry.member.display_name) === wanted ||
          normaliseName(`${entry.member.first_name} ${entry.member.last_name}`) === wanted,
      )
      .sort((a, b) => String(a.enrollment.joined_on).localeCompare(String(b.enrollment.joined_on)))
      .slice(0, 10)
      .map((entry) => ({
        member_id: entry.member.id,
        display_name: entry.member.display_name,
        joined_on: entry.enrollment.joined_on ?? null,
      }));

    record({ fn: 'portal_find_members', count: rows.length });
    json(res, 200, rows);
  },

  /** portal_scorecard(p_member_id uuid) returns jsonb */
  portal_scorecard(res, body, req, helpers) {
    const { json, pds } = helpers;
    const year = portalYear();
    if (!year) {
      pds(res, 'PDS03', 'No academic year is set up yet.');
      return;
    }

    const member = db.members.find((row) => row.id === body.p_member_id) ?? null;
    const enrollment = db.member_enrollments.find(
      (row) => row.member_id === body.p_member_id && row.academic_year_id === year.id,
    );
    if (!member || member.archived_at || member.merged_into_id || !enrollment) {
      record({ fn: 'portal_scorecard', outcome: 'PDS03' });
      pds(res, 'PDS03', 'Nobody by that name is on this years roster.');
      return;
    }

    const status = memberStatusRows().find(
      (row) => row.member_id === member.id && row.academic_year_id === year.id,
    );
    const index = totalsByMember(year.id);
    const totals = index.get(member.id) ?? new Map();
    const set = publishedSetFor(year.id);

    const categories = db.categories
      .filter((row) => !row.archived_at)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((row) => ({
        id: row.id,
        name: row.name,
        total: totals.get(row.id) ?? 0,
      }));

    const requirements = set
      ? evaluateSet(set.id, member.id, index).map((row) => {
          const node = db.requirement_nodes.find((one) => one.id === row.node_id) ?? {};
          return {
            ...row,
            sort_order: node.sort_order ?? 0,
            category_ids: db.requirement_node_categories
              .filter((link) => link.node_id === row.node_id)
              .map((link) => link.category_id),
          };
        })
      : [];

    record({ fn: 'portal_scorecard', memberId: member.id });
    json(res, 200, {
      year: { id: year.id, label: year.label },
      member: {
        id: member.id,
        display_name: member.display_name,
        joined_on: enrollment.joined_on ?? null,
      },
      point_total: status?.point_total ?? 0,
      is_honorary: Boolean(status?.is_honorary),
      categories,
      requirements,
      root_node_id: set?.root_node_id ?? null,
    });
  },

  /** portal_leaderboard() returns jsonb */
  portal_leaderboard(res, body, req, helpers) {
    const { json, pds } = helpers;
    const year = portalYear();
    if (!year) {
      pds(res, 'PDS03', 'No academic year is set up yet.');
      return;
    }

    const status = memberStatusRows().filter((row) => row.academic_year_id === year.id);
    const index = totalsByMember(year.id);

    const rows = db.member_enrollments
      .filter((row) => row.academic_year_id === year.id)
      .map((row) => db.members.find((one) => one.id === row.member_id))
      .filter((member) => member && !member.archived_at && !member.merged_into_id)
      .map((member) => {
        const held = status.find((row) => row.member_id === member.id);
        const totals = {};
        for (const [categoryId, total] of index.get(member.id) ?? new Map()) {
          totals[categoryId] = total;
        }
        return {
          member_id: member.id,
          display_name: member.display_name,
          point_total: held?.point_total ?? 0,
          is_honorary: Boolean(held?.is_honorary),
          totals,
        };
      })
      .sort(
        (a, b) =>
          b.point_total - a.point_total || String(a.display_name).localeCompare(b.display_name),
      );

    // rank() over (order by point_total desc): ties share a rank, and the next
    // rank skips, which is what the window function does.
    let rank = 0;
    let seen = 0;
    let previous = null;
    for (const row of rows) {
      seen += 1;
      if (row.point_total !== previous) {
        rank = seen;
        previous = row.point_total;
      }
      row.rank = rank;
    }

    record({ fn: 'portal_leaderboard', count: rows.length });
    json(res, 200, {
      year: { id: year.id, label: year.label },
      categories: db.categories
        .filter((row) => !row.archived_at)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((row) => ({
          id: row.id,
          name: row.name,
        })),
      members: rows,
    });
  },

  /**
   * portal_attendance(p_member_id uuid) returns jsonb
   *
   * Migration 23. Every published event of this year, by category, with what
   * this member did about each one. The three rules that are easy to get
   * subtly wrong and are therefore written out rather than inlined: a live
   * record beats a superseded rejected one, an archived category still shows
   * when the member has a record in it, and credit comes off creditRows()
   * rather than being worked out a second time here.
   */
  portal_attendance(res, body, req, helpers) {
    const { json, pds } = helpers;
    const year = portalYear();
    if (!year) {
      pds(res, 'PDS03', 'No academic year is set up yet.');
      return;
    }

    const member = db.members.find((row) => row.id === body.p_member_id) ?? null;
    const enrollment = db.member_enrollments.find(
      (row) => row.member_id === body.p_member_id && row.academic_year_id === year.id,
    );
    if (!member || member.archived_at || member.merged_into_id || !enrollment) {
      record({ fn: 'portal_attendance', outcome: 'PDS03' });
      pds(res, 'PDS03', 'Nobody by that name is on this years roster.');
      return;
    }

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const eventById = new Map(db.events.map((row) => [row.id, row]));

    // distinct on (event_id) order by (status <> 'rejected') desc, submitted_at desc
    const live = (row) => (row.status === 'rejected' ? 0 : 1);
    const mine = new Map();
    for (const row of db.attendance_records) {
      if (row.member_id !== member.id) continue;
      const event = eventById.get(row.event_id);
      if (!event || event.academic_year_id !== year.id) continue;
      const held = mine.get(row.event_id);
      const wins =
        !held ||
        live(row) > live(held) ||
        (live(row) === live(held) &&
          String(row.submitted_at ?? '') > String(held.submitted_at ?? ''));
      if (wins) mine.set(row.event_id, row);
    }

    // v_attendance_credit, keyed the way the join reads it.
    const credit = new Map();
    for (const row of creditRows()) {
      credit.set(`${row.attendance_id}:${row.category_id}`, row.credit);
    }

    const heldCategories = new Set();
    for (const eventId of mine.keys()) {
      for (const link of db.event_categories) {
        if (link.event_id === eventId) heldCategories.add(link.category_id);
      }
    }

    const totals = totalsByMember(year.id).get(member.id) ?? new Map();

    const categories = db.categories
      .filter((row) => !row.archived_at || heldCategories.has(row.id))
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
      .map((category) => {
        const events = db.events
          .filter(
            (event) =>
              event.academic_year_id === year.id &&
              event.is_published &&
              db.event_categories.some(
                (link) => link.event_id === event.id && link.category_id === category.id,
              ),
          )
          .sort(
            (a, b) =>
              String(a.occurred_on).localeCompare(String(b.occurred_on)) ||
              a.title.localeCompare(b.title),
          )
          .map((event) => {
            const held = mine.get(event.id) ?? null;
            const open =
              event.checkin_closes_at && new Date(event.checkin_closes_at) > now ? true : false;
            const status =
              held?.status === 'approved'
                ? 'attended'
                : held?.status === 'pending'
                  ? 'waiting'
                  : held?.status === 'rejected'
                    ? 'declined'
                    : event.occurred_on > today || open
                      ? 'upcoming'
                      : 'none';
            return {
              id: event.id,
              title: event.title,
              occurred_on: event.occurred_on,
              status,
              credit:
                held?.status === 'approved'
                  ? (credit.get(`${held.id}:${category.id}`) ?? null)
                  : null,
            };
          });

        return {
          id: category.id,
          name: category.name,
          total: totals.get(category.id) ?? 0,
          events,
        };
      })
      .filter((section) => section.events.length > 0 || section.total !== 0);

    record({ fn: 'portal_attendance', memberId: member.id });
    json(res, 200, {
      year: { id: year.id, label: year.label },
      member: { id: member.id, display_name: member.display_name },
      categories,
    });
  },

  /** portal_requirements() returns jsonb */
  portal_requirements(res, body, req, helpers) {
    const { json, pds } = helpers;
    const year = portalYear();
    if (!year) {
      pds(res, 'PDS03', 'No academic year is set up yet.');
      return;
    }
    const set = publishedSetFor(year.id);

    record({ fn: 'portal_requirements', setId: set?.id ?? null });
    json(res, 200, {
      year: { id: year.id, label: year.label },
      set: set
        ? { id: set.id, name: set.name, version: set.version, root_node_id: set.root_node_id }
        : null,
      nodes: set
        ? db.requirement_nodes
            .filter((row) => row.requirement_set_id === set.id)
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
            .map((node) => ({
              node_id: node.id,
              parent_id: node.parent_id,
              type: node.type,
              label: node.label,
              sort_order: node.sort_order,
              min_value: node.min_value ?? null,
              min_children_passing: node.min_children_passing ?? null,
              categories: db.requirement_node_categories
                .filter((link) => link.node_id === node.id)
                .map((link) => db.categories.find((one) => one.id === link.category_id))
                .filter(Boolean)
                .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
                .map((category) => ({
                  id: category.id,
                  name: category.name,
                })),
            }))
        : [],
    });
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
// Deleting evidence objects: the purge screen's second step
// ---------------------------------------------------------------------------
// deleteEvidenceObjects() (src/rest.js) sends one bulk DELETE per run, the
// same shape Storage's own bulk delete takes: a JSON body of `prefixes`, and
// a response listing only the objects it actually removed. A path absent
// from that response is exactly what "not confirmed deleted" means, which is
// the state finish_purge_run() and purge_run_objects exist to track and let
// an officer close out later.
//
// Officer gated the same way migration 12's evidence_delete_officer policy
// gates the real bucket: purging is a decision only an officer or admin
// makes, and a viewer reading this screen has no delete button to press.

let pendingDeleteFailures = null; // Set of object paths to report as NOT deleted, next call only

/**
 * For a check to prove a partial Storage failure is never reported as a
 * clean success: a path named here is genuinely still in the bucket after
 * this call, the same as a real transient Storage failure, not merely
 * unreported. Set from the check process, never over HTTP, and cleared the
 * moment it fires.
 */
export function failStorageDeleteOnce(paths) {
  pendingDeleteFailures = new Set(paths);
}

/**
 * For a check to prove that a path a bulk delete does not echo back is not
 * automatically a failure: this removes it from the bucket directly,
 * simulating an object already gone before the delete call ran (deleted out
 * of band, or claimed by a second purge run racing for the same
 * object_path). evidenceObjectExists() (src/rest.js) is what is supposed to
 * tell these two cases apart; this is how a check makes one of them real.
 * Unlike failStorageDeleteOnce(), this is a direct, standing removal rather
 * than a one-shot flag: the object really is gone, for every call after
 * this one, exactly as it would be in the real bucket.
 */
export function removeFromBucket(paths) {
  for (const path of paths) bucketObjects.delete(path);
}

export function handleStorageDelete(req, res, url, body, helpers, anonKey) {
  const { json } = helpers;
  const auth = resolveAuth(req, anonKey);

  if (!isOfficer(auth)) {
    record({ fn: 'storage.delete', outcome: 'refused', role: auth.role ?? auth.kind });
    json(res, 400, {
      statusCode: '403',
      error: 'Unauthorized',
      message: 'new row violates row-level security policy',
    });
    return;
  }

  const requested = [...new Set(Array.isArray(body?.prefixes) ? body.prefixes : [])];
  const failing = pendingDeleteFailures;
  pendingDeleteFailures = null;

  // Real Storage only echoes back what it actually removed: a path already
  // missing from the bucket (never there, already deleted, claimed by a
  // second run) is silently absent from the response too, the same as a
  // path failing is. failing models the other case, an object that IS in
  // the bucket but this call could not remove.
  const deleted = requested.filter((path) => bucketObjects.has(path) && !failing?.has(path));
  for (const path of deleted) bucketObjects.delete(path);

  record({
    fn: 'storage.delete',
    actor: auth.userId,
    requested: requested.length,
    deleted: deleted.length,
  });
  json(res, 200, deleted.map((name) => ({ name })));
}

/**
 * Storage's own object-info endpoint, the question evidenceObjectExists()
 * (src/rest.js) asks for the one path deleteAndFinish() (src/storage.js)
 * cannot answer from a bulk delete's response alone. 200 with a stand-in
 * metadata body if the path is still in the bucket, 404 if it is not.
 * Officer gated the same as every other Storage endpoint here: a viewer has
 * no delete button, and so no reason to be asking this either.
 */
export function handleStorageInfo(req, res, url, helpers, anonKey) {
  const { json } = helpers;
  const auth = resolveAuth(req, anonKey);

  if (!isOfficer(auth)) {
    record({ fn: 'storage.info', outcome: 'refused', role: auth.role ?? auth.kind });
    json(res, 400, {
      statusCode: '403',
      error: 'Unauthorized',
      message: 'new row violates row-level security policy',
    });
    return;
  }

  const prefix = '/storage/v1/object/info/evidence/';
  const path = decodeURIComponent(url.pathname.slice(prefix.length));

  if (!bucketObjects.has(path)) {
    record({ fn: 'storage.info', actor: auth.userId, path, outcome: 'not_found' });
    json(res, 404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    return;
  }

  record({ fn: 'storage.info', actor: auth.userId, path, outcome: 'exists' });
  json(res, 200, { name: path, bucket_id: 'evidence' });
}

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
