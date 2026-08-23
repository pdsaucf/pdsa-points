import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDeployedAdminRpcs,
  EVENTS_STARTUP_PROBE,
  PROBES,
} from '../scripts/check_deployed_admin_rpcs.mjs';

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('the deployment guard probes the add and remove signatures without officer credentials', async () => {
  const requests = [];
  const checked = await checkDeployedAdminRpcs({
    baseUrl: 'https://example.supabase.co/',
    anonKey: 'public-anon-key',
    eventsProbe: null,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(401, { code: '42501', message: 'permission denied for function' });
    },
  });

  assert.deepEqual(checked, ['add_officer_attendance', 'remove_attendance_record']);
  assert.equal(requests.length, PROBES.length);
  for (let index = 0; index < PROBES.length; index += 1) {
    const request = requests[index];
    const probe = PROBES[index];
    assert.equal(request.url, `https://example.supabase.co/rest/v1/rpc/${probe.name}`);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.headers.apikey, 'public-anon-key');
    assert.equal(request.init.headers.Authorization, 'Bearer public-anon-key');
    assert.deepEqual(JSON.parse(request.init.body), probe.args);
  }
});

test('the deployment guard probes the exact Events startup GET without officer credentials', async () => {
  const requests = [];
  const checked = await checkDeployedAdminRpcs({
    baseUrl: 'https://example.supabase.co/',
    anonKey: 'public-anon-key',
    probes: [],
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
    'https://example.supabase.co/rest/v1/events?select=id%2Ctitle%2Coccurred_on%2Cstarts_at%2Cends_at%2Cterm_id%2Ccheckin_token%2Ccheckin_closes_at%2Cevent_categories%28category_id%2Ccredit_mode%2Cfixed_credit%2Ccategories%28id%2Cname%29%29%2Cevent_evidence_requirements%28id%2Ckind%2Cis_required%2Cprompt%29&academic_year_id=eq.a0000000-0000-4000-a000-000000000001&order=occurred_on.desc',
  );
  assert.equal(EVENTS_STARTUP_PROBE.query, new URL(requests[0].url).search.slice(1));
});

test('the deployment guard rejects the reproduced missing Events column', async () => {
  await assert.rejects(
    () =>
      checkDeployedAdminRpcs({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        probes: [],
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
      checkDeployedAdminRpcs({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        eventsProbe: null,
        probes: [PROBES[1]],
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
      checkDeployedAdminRpcs({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        eventsProbe: null,
        probes: [PROBES[0]],
        fetchImpl: async () => jsonResponse(200, []),
      }),
    /accepted an anonymous request/,
  );
});

test('the deployment guard fails closed when the database cannot be checked', async () => {
  await assert.rejects(
    () =>
      checkDeployedAdminRpcs({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
        eventsProbe: null,
        probes: [PROBES[0]],
        fetchImpl: async () => {
          throw new Error('offline');
        },
      }),
    /Could not verify add_officer_attendance: offline/,
  );
});
