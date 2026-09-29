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
  const signedOutDom = installDom(await readFile(new URL('../admin/index.html', import.meta.url), 'utf8'));
  const { start } = await import('../src/admin.js');
  start();
  await until(() => !signedOutDom.$('view-signin').hidden);
  assert.equal(signedOutDom.$('signin-passcode'), null);
  assert.equal(signedOutDom.$('signin-form'), null);
  assert.equal(signedOutDom.$('signin-google').textContent, 'Continue with Google');
  assert.equal(signedOutDom.$('signin-google').disabled, false);
  window.location.assign = () => { throw new Error('Navigation failed'); };
  signedOutDom.$('signin-google').click();
  await until(() => signedOutDom.$('google-status').textContent === 'Google sign-in failed, try again');
  assert.equal(signedOutDom.$('signin-google').disabled, false, 'Google sign-in can be retried');
  let destination = null;
  window.location.assign = (url) => { destination = url; };
  signedOutDom.$('signin-google').click();
  await until(() => destination !== null);
  assert.equal(new URL(destination).searchParams.get('provider'), 'google');
  assert.equal(signedOutDom.$('google-status').textContent, '', 'retry clears the earlier error');
  assert.equal(auth.currentSession(), null);
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
  start();
  await until(() => !dom.$('view-app').hidden && dom.$('event-list').childNodes.length && dom.$('loading-roster').hidden);
  for (const id of ['tab-review','tab-requirements','tab-storage','tab-access','events-auto-publish','roster-add','roster-paste','roster-import']) {
    assert.equal(dom.$(id)?.hidden, true, `${id} must be hidden`);
  }
  const calls = (await fetch(`${base}/__mock/audit`).then((r) => r.json())).admin.calls;
  assert.ok(!calls.some((c) => c.fn === 'storage.sign' && c.outcome !== 'refused'), 'officer fetched photos');
  assert.ok(!calls.some((c) => ['fn_storage_usage','preview_requirement_set','validate_requirement_set'].includes(c.fn)), 'officer eagerly loaded admin panels');
  auth.forgetSession();
  // Secretary Director: attendance, roster and Storage, no admin settings.
  await callback('secretary_director'); await auth.completeGoogleSignIn();
  assert.equal((await callRpc('leadership_session', {})).role, 'secretary_director');
  await assert.rejects(callRpc('list_leadership_access', {}), (e) => e.code === 'PDS07');
  await assert.rejects(callRpc('validate_requirement_set', { p_set_id: null }), (e) => e.code === 'PDS07');
  assert.equal(await callRpc('review_records', { p_record_ids: [], p_decision: 'approve' }), 0);
  const secdirDom = installDom(await readFile(new URL('../admin/index.html', import.meta.url), 'utf8'));
  start();
  await until(() => !secdirDom.$('view-app').hidden && secdirDom.$('event-list').childNodes.length && secdirDom.$('loading-roster').hidden);
  for (const id of ['tab-requirements','tab-categories','tab-access','events-auto-publish']) {
    assert.equal(secdirDom.$(id)?.hidden, true, `${id} must be hidden for a Secretary Director`);
  }
  for (const id of ['tab-review','settings-menu','tab-storage','roster-add','roster-paste','roster-import']) {
    assert.equal(secdirDom.$(id)?.hidden, false, `${id} must be shown for a Secretary Director`);
  }
  auth.forgetSession();
  await callback('stranger'); await auth.completeGoogleSignIn();
  assert.equal((await callRpc('leadership_session', {})).role, null);
  await assert.rejects(select('members', {}));
  auth.forgetSession();
  await auth.signInWithPasscode('mock-passcode');
  assert.equal((await callRpc('leadership_session', {})).role, 'admin');
  // An admin's own screen, then the officer preview opened from Access.
  const adminDom = installDom(await readFile(new URL('../admin/index.html', import.meta.url), 'utf8'));
  start();
  await until(() => !adminDom.$('view-app').hidden && adminDom.$('event-list').childNodes.length);
  assert.equal(adminDom.$('tab-access').hidden, false);
  assert.equal(adminDom.$('role-preview-bar').hidden, true);
  window.location.search = '?as=officer';
  const previewDom = installDom(await readFile(new URL('../admin/index.html', import.meta.url), 'utf8'));
  start();
  await until(() => !previewDom.$('view-app').hidden && previewDom.$('event-list').childNodes.length && previewDom.$('loading-roster').hidden);
  assert.equal(previewDom.$('role-preview-bar').hidden, false);
  for (const id of ['tab-review','settings-menu','events-auto-publish','roster-add','roster-paste','roster-import']) {
    assert.equal(previewDom.$(id)?.hidden, true, `${id} must be hidden in the officer preview`);
  }
  window.location.search = '?as=secretary_director';
  const secdirPreview = installDom(await readFile(new URL('../admin/index.html', import.meta.url), 'utf8'));
  start();
  await until(() => !secdirPreview.$('view-app').hidden && secdirPreview.$('event-list').childNodes.length && secdirPreview.$('loading-roster').hidden);
  assert.equal(secdirPreview.$('role-preview-role').textContent, 'Secretary Director preview');
  assert.equal(secdirPreview.$('tab-storage').hidden, false);
  assert.equal(secdirPreview.$('tab-access').hidden, true);
  delete window.location.search;
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
  console.log('Leadership mock checks passed: Google-only entry, sign-in retry, shared fallback, PKCE, refresh, refusals, role-aware shell, officer and Secretary Director previews, access changes, callback rejection and logout races.');
} finally { await new Promise((resolve) => server.close(resolve)); }
