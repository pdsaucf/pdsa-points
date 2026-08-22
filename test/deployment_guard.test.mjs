import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkDeployedAdminRpcs,
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

test('the deployment guard rejects a missing RPC or stale parameter signature', async () => {
  await assert.rejects(
    () =>
      checkDeployedAdminRpcs({
        baseUrl: 'https://example.supabase.co',
        anonKey: 'public-anon-key',
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
        probes: [PROBES[0]],
        fetchImpl: async () => {
          throw new Error('offline');
        },
      }),
    /Could not verify add_officer_attendance: offline/,
  );
});
