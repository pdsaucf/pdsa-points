// UI copy reads as software labels, not as an assistant's pronouncements.
// See "UI copy style" in CLAUDE.md and scripts/check_ui_copy.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { findTerminalPeriods, readsAsPronouncement } from '../scripts/check_ui_copy.mjs';

test('no page or script carries pronouncement-style copy', async () => {
  assert.deepEqual(await findTerminalPeriods(), []);
});

test('the checker catches the shapes it exists for', () => {
  for (const copy of [
    'Everything.',
    'Nobody has checked in yet.',
    'Points, honorary status and this year\'s attendance, by name.',
    'Upcoming published events. No sign-in',
    'Nobody on the roster',
    'Nothing waiting',
    'Saved by x. Reload the page',
  ]) {
    assert.equal(readsAsPronouncement(copy), true, copy);
  }
  for (const copy of ['No check-ins', 'All permissions', 'Try again', 'eq.', './rest.js', 'Loading…', '2.5']) {
    assert.equal(readsAsPronouncement(copy), false, copy);
  }
});
