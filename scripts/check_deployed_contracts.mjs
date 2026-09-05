// Stops the static frontend from getting ahead of the linked Supabase schema.
//
// GitHub Pages deploys web/ independently from the database. PostgREST resolves
// requested functions, columns and embedded relationships before refusing the
// anonymous caller. Public RPCs can be checked with synthetic inputs. That makes
// a deployment check possible without storing an officer credential in GitHub
// Actions or allowing the guard to read or write any row.

import { pathToFileURL } from 'node:url';

import {
  IS_CONFIGURED,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from '../web/config.js';
import { eventsStartupQuery } from '../web/src/events-contract.js';

const ADMIN_RPC_PROBES = [
  {
    name: 'save_event_config',
    args: {
      p_event_id: '00000000-0000-4000-a000-000000000001',
      p_academic_year_id: '00000000-0000-4000-a000-000000000001',
      p_event: {},
      p_categories: [],
      p_evidence: null,
      p_expected_config_version: null,
      p_create: false,
    },
  },
  {
    name: 'add_officer_attendance',
    args: {
      p_event_id: '00000000-0000-4000-a000-000000000001',
      p_member_ids: [],
      p_submitted_value: null,
    },
  },
  {
    name: 'remove_attendance_record',
    args: { p_record_id: '00000000-0000-4000-a000-000000000001' },
  },
  {
    name: 'add_officer_attendance_batch',
    args: {
      p_event_id: '00000000-0000-4000-a000-000000000001',
      p_entries: [],
      p_submitted_value: null,
    },
  },
  {
    name: 'recover_officer_attendance_batch',
    args: {
      p_event_id: '00000000-0000-4000-a000-000000000001',
      p_batch_key: 'deployment-contract-probe',
    },
  },
];

const EXPECTED_DENIALS = new Set(['42501', 'PDS07']);
const EXPECTED_TABLE_DENIALS = new Set(['42501']);
const SCHEMA_MISMATCH_CODES = new Set([
  '42703',
  'PGRST200',
  'PGRST201',
  'PGRST202',
  'PGRST204',
  'PGRST205',
]);

const PROBE_YEAR_ID = 'a0000000-0000-4000-a000-000000000001';
const SYNTHETIC_PORTAL_LOOKUP_NAME =
  'No Such PDSA Portal Contract Probe 00000000';

export const EVENTS_STARTUP_PROBE = {
  name: 'Events startup GET',
  path: '/rest/v1/events',
  query: eventsStartupQuery(PROBE_YEAR_ID),
};

export const PORTAL_LOOKUP_PROBE = {
  name: 'portal_find_members',
  newArgs: { p_name: SYNTHETIC_PORTAL_LOOKUP_NAME },
  oldArgs: {
    p_first_name: 'No Such PDSA Portal',
    p_last_name: 'Contract Probe 00000000',
  },
};

// The public /events page calls this one RPC and nothing else (invariant 3).
// Without a probe here, the guard could go green while portal_events() is
// missing or shaped differently than web/events/index.html expects, and the
// page would 404 or throw the moment it deployed.
export const PORTAL_EVENTS_PROBE = {
  name: 'portal_events',
  args: {},
};

async function responseBody(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function readResponseBody(response, label, failures) {
  try {
    return { ok: true, body: await responseBody(response) };
  } catch (err) {
    failures.push(`Could not verify ${label}: ${err?.message ?? 'response failed'}`);
    return { ok: false, body: null };
  }
}

function rpcRequest(base, anonKey, name, args) {
  return {
    url: `${base}/rest/v1/rpc/${name}`,
    init: {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
    },
  };
}

/**
 * Verifies the RPC signatures and Events startup read used by the page. The
 * private admin contracts must deny anon after resolving. The public portal
 * lookup must accept the current synthetic lookup and reject the retired
 * overload.
 */
export async function checkDeployedContracts({
  baseUrl = SUPABASE_URL,
  anonKey = SUPABASE_ANON_KEY,
  fetchImpl = globalThis.fetch,
  adminRpcProbes = ADMIN_RPC_PROBES,
  eventsProbe = EVENTS_STARTUP_PROBE,
  portalLookupProbe = PORTAL_LOOKUP_PROBE,
  portalEventsProbe = PORTAL_EVENTS_PROBE,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const checked = [];
  const failures = [];

  for (const probe of adminRpcProbes ?? []) {
    let response;
    try {
      const request = rpcRequest(base, anonKey, probe.name, probe.args);
      response = await fetchImpl(request.url, request.init);
    } catch (err) {
      failures.push(`Could not verify ${probe.name}: ${err?.message ?? 'request failed'}`);
      continue;
    }

    const result = await readResponseBody(response, probe.name, failures);
    if (!result.ok) continue;
    const body = result.body;
    if (body?.code === 'PGRST202' || response.status === 404) {
      failures.push(
        `${probe.name} is missing from the deployed database or its parameters do not match the page`,
      );
      continue;
    }

    if (response.ok) {
      failures.push(`${probe.name} accepted an anonymous request`);
      continue;
    }

    if (!EXPECTED_DENIALS.has(body?.code)) {
      failures.push(
        `Could not verify ${probe.name}: expected an authorization refusal, got ${body?.code ?? `HTTP ${response.status}`}`,
      );
      continue;
    }

    checked.push(probe.name);
  }

  if (eventsProbe) {
    let response;
    try {
      response = await fetchImpl(`${base}${eventsProbe.path}?${eventsProbe.query}`, {
        method: 'GET',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      failures.push(
        `Could not verify ${eventsProbe.name}: ${err?.message ?? 'request failed'}`,
      );
      response = null;
    }

    if (response) {
      const result = await readResponseBody(response, eventsProbe.name, failures);
      const body = result.body;
      if (!result.ok) response = null;

      if (response) {
        if (SCHEMA_MISMATCH_CODES.has(body?.code)) {
          failures.push(
            `${eventsProbe.name} does not match the deployed schema: ${body.code}`,
          );
        } else if (response.ok) {
          failures.push(`${eventsProbe.name} exposed data to an anonymous request`);
        } else if (!EXPECTED_TABLE_DENIALS.has(body?.code)) {
          failures.push(
            `Could not verify ${eventsProbe.name}: expected an authorization refusal, got ${body?.code ?? `HTTP ${response.status}`}`,
          );
        } else {
          checked.push(eventsProbe.name);
        }
      }
    }
  }

  if (portalLookupProbe) {
    const currentLabel = `${portalLookupProbe.name}(p_name)`;
    let currentResponse;
    try {
      const request = rpcRequest(
        base,
        anonKey,
        portalLookupProbe.name,
        portalLookupProbe.newArgs,
      );
      currentResponse = await fetchImpl(request.url, request.init);
    } catch (err) {
      failures.push(
        `Could not verify ${currentLabel}: ${err?.message ?? 'request failed'}`,
      );
      currentResponse = null;
    }

    if (currentResponse) {
      const result = await readResponseBody(currentResponse, currentLabel, failures);
      const body = result.body;
      if (result.ok) {
        if (body?.code === 'PGRST202' || currentResponse.status === 404) {
          failures.push(
            `${currentLabel} is missing from the deployed database or its parameters do not match the page`,
          );
        } else if (!currentResponse.ok) {
          failures.push(
            `Could not verify ${currentLabel}: expected a successful JSON array, got ${body?.code ?? `HTTP ${currentResponse.status}`}`,
          );
        } else if (!Array.isArray(body)) {
          failures.push(`Could not verify ${currentLabel}: expected a JSON array`);
        } else {
          checked.push(currentLabel);
        }
      }
    }

    const retiredLabel = `${portalLookupProbe.name}(p_first_name, p_last_name)`;
    let retiredResponse;
    try {
      const request = rpcRequest(
        base,
        anonKey,
        portalLookupProbe.name,
        portalLookupProbe.oldArgs,
      );
      retiredResponse = await fetchImpl(request.url, request.init);
    } catch (err) {
      failures.push(
        `Could not verify ${retiredLabel}: ${err?.message ?? 'request failed'}`,
      );
      retiredResponse = null;
    }

    if (retiredResponse) {
      const result = await readResponseBody(retiredResponse, retiredLabel, failures);
      const body = result.body;
      if (result.ok) {
        if (retiredResponse.status === 404 && body?.code === 'PGRST202') {
          checked.push(`${retiredLabel} absent`);
        } else if (retiredResponse.ok) {
          failures.push(`${retiredLabel} is still callable in the deployed database`);
        } else {
          failures.push(
            `Could not verify ${retiredLabel}: expected 404/PGRST202, got ${body?.code ?? `HTTP ${retiredResponse.status}`}`,
          );
        }
      }
    }
  }

  if (portalEventsProbe) {
    let response;
    try {
      const request = rpcRequest(base, anonKey, portalEventsProbe.name, portalEventsProbe.args ?? {});
      response = await fetchImpl(request.url, request.init);
    } catch (err) {
      failures.push(`Could not verify ${portalEventsProbe.name}: ${err?.message ?? 'request failed'}`);
      response = null;
    }

    if (response) {
      const result = await readResponseBody(response, portalEventsProbe.name, failures);
      const body = result.body;
      if (result.ok) {
        if (body?.code === 'PGRST202' || response.status === 404) {
          failures.push(
            `${portalEventsProbe.name} is missing from the deployed database or its parameters do not match the page`,
          );
        } else if (!response.ok) {
          failures.push(
            `Could not verify ${portalEventsProbe.name}: expected a successful JSON object, got ${body?.code ?? `HTTP ${response.status}`}`,
          );
        } else if (!body || !Array.isArray(body.events)) {
          failures.push(
            `Could not verify ${portalEventsProbe.name}: expected an object with an events array`,
          );
        } else {
          checked.push(portalEventsProbe.name);
        }
      }
    }
  }

  if (failures.length) throw new Error(failures.join('\n'));
  return checked;
}

async function main() {
  if (!IS_CONFIGURED) throw new Error('web/config.js does not name a Supabase project');
  const checked = await checkDeployedContracts();
  process.stdout.write(`Verified deployed contracts: ${checked.join(', ')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

export { ADMIN_RPC_PROBES };
