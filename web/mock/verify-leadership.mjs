// Contract and browser-DOM checks against local stand-ins, never real Google.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startMock } from './server.mjs';
import { installDom } from './dom.mjs';
const PORT = 8791;
const base = `http://localhost:${PORT}`;
globalThis.__PDSA_CONFIG__ = { SUPABASE_URL: base, SUPABASE_ANON_KEY: 'mock-anon-key' };
const storage = () => { const data = new Map(); return { getItem: (k) => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: (k) => data.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
let replaced = null;
globalThis.window = {
  location: { href: `${base}/admin/`, pathname: '/admin/', origin: base, replace: (path) => { replaced = path; } },
  history: { replaceState: (_state,_title,path) => { window.location.href = `${base}${path}`; } },
  addEventListener() {},
};
const auth = await import('../src/auth.js');
const { callRpc, select, signPhotoUrls } = await import('../src/rest.js');
const server = await startMock(PORT);
const until = async (fn) => { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise((r) => setTimeout(r,20)); } throw new Error('DOM did not settle'); };
async function callback(role) {
  window.location.href = `${base}/admin/`;
  const url = new URL(await auth.googleSignInUrl());
  assert.equal(url.searchParams.get('code_challenge_method'), 's256');
  assert.equal(url.searchParams.get('provider'), 'google');
  assert.equal(url.searchParams.get('redirect_to'), `${base}/admin/`);
  assert.equal(url.searchParams.get('code_challenge').length, 43);
  url.searchParams.set('mock_account', role);
  const response = await fetch(url, { redirect: 'manual' });
  window.location.href = response.headers.get('location');
  return window.location.href;
}
try {
  await callback('officer');
  await auth.completeGoogleSignIn();
  assert.equal(window.location.href, `${base}/admin/`);
  assert.equal((await callRpc('leadership_session', {})).role, 'officer');
  await auth.accessToken({ force: true });
  assert.equal((await callRpc('leadership_session', {})).role, 'officer');
  await assert.rejects(callRpc('list_leadership_access', {}), (e) => e.code === 'PDS07');
  await assert.rejects(signPhotoUrls(['photo.jpg']));
  await assert.rejects(callRpc('review_records', { p_record_ids: [], p_decision: 'approve' }), (e) => e.code === 'PDS07');
  const dom = installDom(await readFile(new URL('../admin/index.html', import.meta.url), 'utf8'));
  const { start } = await import('../src/admin.js');
  start();
  await until(() => !dom.$('view-app').hidden && dom.$('event-list').childNodes.length);
  for (const id of ['tab-review','tab-requirements','tab-storage','tab-access','events-auto-publish','roster-add','roster-paste','roster-import']) {
    assert.equal(dom.$(id)?.hidden, true, `${id} must be hidden`);
  }
  const calls = (await fetch(`${base}/__mock/audit`).then((r) => r.json())).admin.calls;
  assert.ok(!calls.some((c) => c.fn === 'storage.sign' && c.outcome !== 'refused'), 'officer fetched photos');
  assert.ok(!calls.some((c) => ['fn_storage_usage','preview_requirement_set','validate_requirement_set'].includes(c.fn)), 'officer eagerly loaded admin panels');
  auth.forgetSession();
  await callback('stranger'); await auth.completeGoogleSignIn();
  assert.equal((await callRpc('leadership_session', {})).role, null);
  await assert.rejects(select('members', {}));
  auth.forgetSession();
  await auth.signInWithPasscode('mock-passcode');
  assert.equal((await callRpc('leadership_session', {})).role, 'admin');
  const added = await callRpc('authorize_leadership_access', { p_email: 'new@example.com', p_role: 'officer' });
  assert.equal(added.user_id, null);
  await callRpc('set_leadership_role', { p_access_id: added.id, p_role: 'admin' });
  await callRpc('revoke_leadership_access', { p_access_id: 'access-officer' });
  assert.ok((await callRpc('list_leadership_audit', {})).some((a) => a.action === 'revoke'));
  await assert.rejects(callRpc('revoke_leadership_access', { p_access_id: 'access-admin' }), (e) => e.code === 'PDS16');
  auth.forgetSession();
  await callback('officer'); await auth.completeGoogleSignIn();
  assert.equal((await callRpc('leadership_session', {})).role, null);
  auth.forgetSession();
  window.location.href = `${base}/admin/?code=unsolicited`;
  await assert.rejects(auth.completeGoogleSignIn());
  assert.equal(window.location.href, `${base}/admin/`);
  await callback('admin');
  const verifierKey = `pdsa:auth:${base}:pkce`;
  const expired = JSON.parse(sessionStorage.getItem(verifierKey));
  expired.createdAt = Date.now() - 11 * 60 * 1000;
  sessionStorage.setItem(verifierKey, JSON.stringify(expired));
  await assert.rejects(auth.completeGoogleSignIn());
  assert.equal(sessionStorage.getItem(verifierKey), null);
  window.location.href = `${base}/admin/#access_token=untrusted&refresh_token=untrusted`;
  await assert.rejects(auth.completeGoogleSignIn());
  assert.equal(auth.currentSession(), null);
  // A late PKCE or refresh response cannot undo local logout.
  const originalFetch = globalThis.fetch;
  for (const flow of ['pkce','refresh_token']) {
    if (flow === 'pkce') await callback('admin');
    else await auth.signInWithPasscode('mock-passcode');
    let release;
    let seen;
    const started = new Promise((r) => { seen = r; });
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (String(args[0]).includes(`grant_type=${flow}`)) { seen(); await new Promise((r) => { release = r; }); }
      return response;
    };
    const pending = flow === 'pkce' ? auth.completeGoogleSignIn() : auth.accessToken({ force: true });
    await started;
    auth.forgetSession(); release();
    await assert.rejects(pending);
    assert.equal(auth.currentSession(), null);
    globalThis.fetch = originalFetch;
  }
  console.log('Leadership mock checks passed: PKCE, refresh, refusals, role-aware shell, access changes, callback rejection and logout races.');
} finally { await new Promise((resolve) => server.close(resolve)); }
