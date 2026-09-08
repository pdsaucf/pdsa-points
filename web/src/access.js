// Leadership authorization is separate from the member roster. Every operation
// below is admin-checked and audited by Postgres.
import { callRpc } from './rest.js';
import { $, h } from './ui.js';

const roleName = (role) => role === 'admin' ? 'Secretary / Admin' : 'Officer / Director';
export function createAccess(ctx) {
  let busy = false;
  function lock(value) {
    busy = value;
    $('panel-access').querySelectorAll('button, input, select').forEach((node) => { node.disabled = value; });
  }
  async function load() {
    try {
      const [entries, audit] = await Promise.all([
        callRpc('list_leadership_access', {}), callRpc('list_leadership_audit', {}),
      ]);
      $('access-rows').replaceChildren(...entries.map((entry) => {
        const picker = h('select', { class: 'select', 'aria-label': `Role for ${entry.email}` },
          ...['officer', 'admin'].map((role) => h('option', { value: role, selected: role === entry.role }, roleName(role))));
        return h('tr', {}, h('td', {}, entry.email),
          h('td', {}, entry.revoked_at ? 'Revoked' : entry.user_id ? 'Approved' : 'Pending first sign-in'),
          h('td', {}, entry.revoked_at ? roleName(entry.role) : picker),
          h('td', {}, entry.revoked_at ? null : h('div', { class: 'rule-actions' },
            h('button', { type: 'button', class: 'button button-small', onClick: () => mutate('set_leadership_role', { p_access_id: entry.id, p_role: picker.value }) }, 'Save role'),
            h('button', { type: 'button', class: 'button button-small button-danger', onClick: () => {
              if (window.confirm(`Revoke PDSA access for ${entry.email}?`)) mutate('revoke_leadership_access', { p_access_id: entry.id });
            } }, 'Revoke'))));
      }));
      const actions = { authorize: 'Authorized', change_role: 'Role changed', revoke: 'Revoked', bind: 'Google identity verified' };
      $('access-audit').replaceChildren(...audit.map((entry) => h('tr', {},
        h('td', {}, new Date(entry.created_at).toLocaleString()), h('td', {}, entry.target_email),
        h('td', {}, `${actions[entry.action] ?? entry.action}${entry.new_role ? `: ${roleName(entry.new_role)}` : ''}`),
        h('td', {}, entry.actor_email || 'System'))));
      if (!entries.length) $('access-status').textContent = 'No leadership accounts authorized.';
    } catch (err) { ctx.fail(err, load); }
  }
  async function mutate(name, args) {
    if (busy) return;
    lock(true);
    $('access-status').textContent = '';
    try {
      await callRpc(name, args);
      const identity = await callRpc('leadership_session', {});
      if (identity?.role !== 'admin') { window.location.replace(window.location.pathname); return; }
      $('access-status').textContent = 'Access updated.';
      if (name === 'authorize_leadership_access') $('access-email').value = '';
      await load();
    } catch (err) {
      if (err?.code === 'PDS16') $('access-status').textContent = 'Keep at least one individual Secretary / Admin.';
      else if (err?.code === 'PDS03') $('access-status').textContent = err.message;
      else ctx.fail(err, load);
    } finally { lock(false); }
  }
  return {
    mount() {
      $('access-form').addEventListener('submit', (event) => {
        event.preventDefault();
        if (!$('access-form').reportValidity()) return;
        mutate('authorize_leadership_access', { p_email: $('access-email').value.trim(), p_role: $('access-role').value });
      });
      return load();
    },
    reload: load,
  };
}
