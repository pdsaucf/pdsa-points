// Stops the static admin UI from getting ahead of the linked Supabase schema.
//
// GitHub Pages deploys web/ independently from the database. An admin-only
// function that exists is resolved by PostgREST before the anonymous caller is
// refused with 42501 or PDS07. A function that is absent, or whose parameter
// names do not match the client, is refused earlier with PGRST202. That makes a
// read-only deployment check possible without storing an officer credential in
// GitHub Actions.

import { pathToFileURL } from 'node:url';

import {
  IS_CONFIGURED,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from '../web/config.js';

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

async function responseBody(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Verifies that each RPC resolves with the parameter names used by the page.
 * The anonymous caller must then be denied, so this never reaches a mutation.
 */
export async function checkDeployedAdminRpcs({
  baseUrl = SUPABASE_URL,
  anonKey = SUPABASE_ANON_KEY,
  fetchImpl = globalThis.fetch,
  probes = PROBES,
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

  if (failures.length) throw new Error(failures.join('\n'));
  return checked;
}

async function main() {
  if (!IS_CONFIGURED) throw new Error('web/config.js does not name a Supabase project');
  const checked = await checkDeployedAdminRpcs();
  process.stdout.write(`Verified deployed admin RPCs: ${checked.join(', ')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  });
}

export { PROBES };
