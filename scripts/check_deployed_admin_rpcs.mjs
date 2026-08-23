// Stops the static admin UI from getting ahead of the linked Supabase schema.
//
// GitHub Pages deploys web/ independently from the database. PostgREST resolves
// requested functions, columns and embedded relationships before refusing the
// anonymous caller. That makes a deployment check possible without storing an
// officer credential in GitHub Actions or allowing the guard to read or write
// any row.

import { pathToFileURL } from 'node:url';

import {
  IS_CONFIGURED,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from '../web/config.js';
import { eventsStartupQuery } from '../web/src/events-contract.js';

const PROBES = [
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

export const EVENTS_STARTUP_PROBE = {
  name: 'Events startup GET',
  path: '/rest/v1/events',
  query: eventsStartupQuery(PROBE_YEAR_ID),
};

async function responseBody(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Verifies the RPC signatures and Events startup read used by the page. The
 * anonymous caller must be denied after each contract resolves.
 */
export async function checkDeployedAdminRpcs({
  baseUrl = SUPABASE_URL,
  anonKey = SUPABASE_ANON_KEY,
  fetchImpl = globalThis.fetch,
  probes = PROBES,
  eventsProbe = EVENTS_STARTUP_PROBE,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const checked = [];
  const failures = [];

  for (const probe of probes) {
    let response;
    try {
      response = await fetchImpl(`${base}/rest/v1/rpc/${probe.name}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(probe.args),
      });
    } catch (err) {
      failures.push(`Could not verify ${probe.name}: ${err?.message ?? 'request failed'}`);
      continue;
    }

    const body = await responseBody(response);
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
      let body;
      try {
        body = await responseBody(response);
      } catch (err) {
        failures.push(
          `Could not verify ${eventsProbe.name}: ${err?.message ?? 'response failed'}`,
        );
        body = null;
        response = null;
      }

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

  if (failures.length) throw new Error(failures.join('\n'));
  return checked;
}

async function main() {
  if (!IS_CONFIGURED) throw new Error('web/config.js does not name a Supabase project');
  const checked = await checkDeployedAdminRpcs();
  process.stdout.write(`Verified deployed admin contracts: ${checked.join(', ')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

export { PROBES };
