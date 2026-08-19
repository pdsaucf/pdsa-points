// What reaches event_categories.fixed_credit.
//
// This column is multiplied by nothing and added to a member's total directly,
// so a wrong value here is wrong points on a real person's record, and it is
// invisible: the screen renders, the write succeeds, and the number is simply
// not the one the officer meant.
//
// The case that shipped: the credit input coerced an empty box to 0 on every
// keystroke, and 0 is a credit the database stores without complaint. Clearing
// the field and pressing Save awarded every attendee of that event nothing,
// and nothing anywhere said so.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCredit, validateCategoryRows } from '../web/src/events-model.js';

const fixed = (fixed_credit) => ({ category_id: 'c1', credit_mode: 'fixed', fixed_credit });

test('an empty credit box is not a zero', () => {
  assert.ok(Number.isNaN(parseCredit('')), 'empty is not a number');
  assert.ok(Number.isNaN(parseCredit('   ')), 'whitespace is not a number');
  assert.ok(Number.isNaN(parseCredit(null)), 'null is not a number');
  assert.ok(Number.isNaN(parseCredit(undefined)), 'undefined is not a number');
  assert.notEqual(parseCredit(''), 0, 'and above all it is not 0');
});

test('a blank credit is refused before any request goes out', () => {
  assert.match(
    validateCategoryRows([fixed(parseCredit(''))]) ?? '',
    /credit/i,
    'Save must refuse it rather than write a number nobody chose',
  );
});

test('text in the credit box is refused, not silently turned into something', () => {
  for (const junk of ['abc', '1.2.3', '--2']) {
    assert.ok(Number.isNaN(parseCredit(junk)), `${junk} is not a number`);
    assert.ok(validateCategoryRows([fixed(parseCredit(junk))]), `${junk} is refused`);
  }
});

test('ordinary credits pass through exactly', () => {
  for (const [input, expected] of [['1', 1], ['2', 2], ['0.5', 0.5], [' 3 ', 3], [1.5, 1.5]]) {
    assert.equal(parseCredit(input), expected);
    assert.equal(validateCategoryRows([fixed(parseCredit(input))]), null);
  }
});

test('an explicit zero is allowed, because only a BLANK box was the bug', () => {
  assert.equal(parseCredit('0'), 0);
  assert.equal(validateCategoryRows([fixed(0)]), null, 'typing 0 on purpose is a choice');
});

test('a negative credit is allowed on purpose', () => {
  // migration 05 comments this column: negatives exist so an officer can
  // record a correction without deleting history. Refusing them here would
  // take away the only non-destructive way to fix a mistake.
  assert.equal(parseCredit('-2'), -2);
  assert.equal(validateCategoryRows([fixed(-2)]), null);
});

test('a row that reads its number off the submission needs no credit typed', () => {
  const rows = [{ category_id: 'c1', credit_mode: 'from_submission', fixed_credit: NaN }];
  assert.equal(validateCategoryRows(rows), null);
});

test('still only one category per event may read the number off the submission', () => {
  const rows = [
    { category_id: 'c1', credit_mode: 'from_submission', fixed_credit: 1 },
    { category_id: 'c2', credit_mode: 'from_submission', fixed_credit: 1 },
  ];
  assert.match(validateCategoryRows(rows) ?? '', /one category/i);
});
