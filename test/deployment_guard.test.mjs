import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDeployedContracts,
  ADMIN_RPC_PROBES,
  EVENTS_STARTUP_PROBE,
  PORTAL_LOOKUP_PROBE,
  PORTAL_EVENTS_PROBE,
} from '../scripts/check_deployed_contracts.mjs';

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('the deployed event mutation contract is revision-aware save_event_config', () => {
  const eventMutations = ADMIN_RPC_PROBES.filter((probe) => probe.name === 'save_event_config');
  assert.equal(eventMutations.length, 1);
  assert.ok(
    Object.hasOwn(eventMutations[0].args, 'p_expected_config_version'),
    'the deployment check would accept the pre-revision event RPC signature',
  );
  assert.equal(eventMutations[0].args.p_create, false);
});

test('the deployment guard probes the event mutation signatures without officer credentials', async () => {
  const requests = [];
  const checked = await checkDeployedContracts({
    baseUrl: 'https://example.supabase.co/',
    anonKey: 'public-anon-key',
    eventsProbe: null,
    portalLookupProbe: null,
    portalEventsProbe: null,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(401, { code: '42501', message: 'permission denied for function' });
    },
  });

  assert.deepEqual(checked, [
    'save_event_config',
    'add_officer_attendance',
    'remove_attendance_record',
    'add_officer_attendance_batch',
    'recover_officer_attendance_batch',
  ]);
  assert.equal(requests.length, ADMIN_RPC_PROBES.length);
  for (let index = 0; index < ADMIN_RPC_PROBES.length; index += 1) {
    const request = requests[index];
    const probe = ADMIN_RPC_PROBES[index];
    assert.equal(request.url, `https://example.supabase.co/rest/v1/rpc/${probe.name}`);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers.apikey, 'public-anon-key');
    assert.equal(request.init.headers.Authorization, 'Bearer public-anon-key');
    assert.deepEqual(JSON.parse(request.init.body), probe.args);
  }
});

test('the deployment guard probes the exact Events startup GET without officer credentials', async () => {
  const requests = [];
  const checked = await checkDeployedContracts({
    baseUrl: 'https://example.supabase.co/',
    anonKey: 'public-anon-key',
    adminRpcProbes: [],
    portalLookupProbe: null,
    portalEventsProbe: null,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(401, { code: '42501', message: 'permission denied for table events' });
    },
  });

  assert.deepEqual(checked, ['Events startup GET']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.headers.apikey, 'public-anon-key');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer public-anon-key');
  assert.equal(requests[0].init.body, undefined);
  assert.equal(
    requests[0].url,
    'https://example.supabase.co/rest/v1/events?select=id%2Ctitle%2Coccurred_on%2Cstarts_at%2Cends_at%2Cterm_id%2Ccheckin_token%2Ccheckin_closes_at%2Cconfig_version%2Clocation%2Cattire%2Csignup%2Cdescription%2Cis_published%2Crelease_at%2Cis_visible%2Cevent_categories%28category_id%2Ccredit_mode%2Cfixed_credit%2Ccategories%28id%2Cname%29%29%2Cevent_evidence_requirements%28id%2Ckind%2Cis_required%2Cprompt%29&academic_year_id=eq.a0000000-0000-4000-a000-000000000001&order=occurred_on.desc',
  );
  assert.equal(EVENTS_STARTUP_PROBE.query, new URL(requests[0].url).search.slice(1));
});

test('the deployment guard rejects the reproduced missing Events column', async () => {
  await assert.rejects(
    () =>
      checkDeployedContracts({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        adminRpcProbes: [],
        portalLookupProbe: null,
        portalEventsProbe: null,
        fetchImpl: async () =>
          jsonResponse(400, {
            code: '42703',
            details: null,
            hint: null,
            message: 'column events.starts_at does not exist',
          }),
      }),
    /Events startup GET does not match the deployed schema: 42703/,
  );
});

test('the deployment guard rejects a missing RPC or stale parameter signature', async () => {
  await assert.rejects(
    () =>
      checkDeployedContracts({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        eventsProbe: null,
        portalLookupProbe: null,
        portalEventsProbe: null,
        adminRpcProbes: [ADMIN_RPC_PROBES[2]],
        fetchImpl: async () =>
          jsonResponse(404, {
            code: 'PGRST202',
            message: 'Could not find the function in the schema cache',
          }),
      }),
    /remove_attendance_record is missing/,
  );
});

test('the deployment guard rejects an anonymously callable admin RPC', async () => {
  await assert.rejects(
    () =>
      checkDeployedContracts({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        eventsProbe: null,
        portalLookupProbe: null,
        portalEventsProbe: null,
        adminRpcProbes: [ADMIN_RPC_PROBES[1]],
        fetchImpl: async () => jsonResponse(200, []),
      }),
    /accepted an anonymous request/,
  );
});

test('the deployment guard fails closed when the database cannot be checked', async () => {
  await assert.rejects(
    () =>
      checkDeployedContracts({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        eventsProbe: null,
        portalLookupProbe: null,
        portalEventsProbe: null,
        adminRpcProbes: [ADMIN_RPC_PROBES[1]],
        fetchImpl: async () => {
          throw new Error('offline');
        },
      }),
    /Could not verify add_officer_attendance: offline/,
  );
});

test('the deployment guard probes the portal lookup contract with a synthetic name', async () => {
  const requests = [];
  const checked = await checkDeployedContracts({
    baseUrl: 'https://example.supabase.co/',
    anonKey: 'public-anon-key',
    adminRpcProbes: [],
    eventsProbe: null,
    portalEventsProbe: null,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const args = JSON.parse(init.body);
      if (Object.hasOwn(args, 'p_name')) return jsonResponse(200, []);
      return jsonResponse(404, {
        code: 'PGRST202',
        message: 'Could not find the function in the schema cache',
      });
    },
  });

  assert.deepEqual(checked, [
    'portal_find_members(p_name)',
    'portal_find_members(p_first_name, p_last_name) absent',
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://example.supabase.co/rest/v1/rpc/portal_find_members');
  assert.equal(requests[0].init.headers.apikey, 'public-anon-key');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer public-anon-key');
  assert.deepEqual(JSON.parse(requests[0].init.body), PORTAL_LOOKUP_PROBE.newArgs);
  assert.deepEqual(Object.keys(JSON.parse(requests[0].init.body)), ['p_name']);
  assert.deepEqual(JSON.parse(requests[1].init.body), PORTAL_LOOKUP_PROBE.oldArgs);
});

test('the deployment guard rejects a missing one-arg portal lookup', async () => {
  await assert.rejects(
    () =>
      checkDeployedContracts({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        adminRpcProbes: [],
        eventsProbe: null,
        portalEventsProbe: null,
        fetchImpl: async (url, init) => {
          const args = JSON.parse(init.body);
          if (Object.hasOwn(args, 'p_name')) {
            return jsonResponse(404, {
              code: 'PGRST202',
              message: 'Could not find the function in the schema cache',
            });
          }
          return jsonResponse(404, {
            code: 'PGRST202',
            message: 'Could not find the function in the schema cache',
          });
        },
      }),
    /portal_find_members\(p_name\) is missing/,
  );
});

test('the deployment guard rejects a still-callable two-arg portal lookup', async () => {
  await assert.rejects(
    () =>
      checkDeployedContracts({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        adminRpcProbes: [],
        eventsProbe: null,
        portalEventsProbe: null,
        fetchImpl: async () => jsonResponse(200, []),
      }),
    /portal_find_members\(p_first_name, p_last_name\) is still callable/,
  );
});

test('the deployment guard probes portal_events, the /events page own contract', async () => {
  const requests = [];
  const checked = await checkDeployedContracts({
    baseUrl: 'https://example.supabase.co/',
    anonKey: 'public-anon-key',
    adminRpcProbes: [],
    eventsProbe: null,
    portalLookupProbe: null,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, { year: { id: 'a0', label: '2025-2026' }, events: [] });
    },
  });

  assert.deepEqual(checked, ['portal_events']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.supabase.co/rest/v1/rpc/portal_events');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.apikey, 'public-anon-key');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer public-anon-key');
  assert.deepEqual(JSON.parse(requests[0].init.body), PORTAL_EVENTS_PROBE.args);
});

test('the deployment guard rejects a missing portal_events RPC', async () => {
  await assert.rejects(
    () =>
      checkDeployedContracts({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        adminRpcProbes: [],
        eventsProbe: null,
        portalLookupProbe: null,
        fetchImpl: async () =>
          jsonResponse(404, {
            code: 'PGRST202',
            message: 'Could not find the function in the schema cache',
          }),
      }),
    /portal_events is missing/,
  );
});

test('the deployment guard rejects a portal_events response with the wrong shape', async () => {
  await assert.rejects(
    () =>
      checkDeployedContracts({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        adminRpcProbes: [],
        eventsProbe: null,
        portalLookupProbe: null,
        fetchImpl: async () => jsonResponse(200, { year: null }),
      }),
    /Could not verify portal_events: expected an object with an events array/,
  );
});
