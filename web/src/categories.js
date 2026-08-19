// Categories: the things requirements measure.
//
// A CATEGORY WITH ANY HISTORY ARCHIVES, AND NEVER DELETES (invariant 4). Every
// reference from a rule or an event is `on delete restrict`, so a delete would
// be refused by the database anyway; what this screen offers instead is Retire,
// which sets archived_at and takes the category out of every list that offers a
// choice, while last year's rules and last year's events keep resolving. The
// #REF! column in the old spreadsheet is what happens when that is not true.
//
// Retiring one a rule still measures is allowed, and is sometimes exactly what
// an officer means to do, so it is not refused. It is explained: the dialog
// names the requirements that measure it before anybody presses the button.
//
// DELETE IS OFFERED TOO, AND IS NOT A VIOLATION OF INVARIANT 4. The invariant
// exists so a reference can never dangle; a category nothing references, ever
// (zero events in any year, zero requirements), cannot dangle, because there
// is nothing for it to leave behind. canDelete() in category-model.js is what
// decides "nothing" honestly: it reads the all-year event count, not the
// current year's display count, because a category retired from this year's
// events can still be attached to one from last year. Even so, the button is
// only ever a shortcut for the database's own answer: del() still catches the
// on-delete-restrict error the database throws if this screen's copy of the
// data was stale, and reloads rather than pretending the delete happened.
//
// `slug` is the identity and `name` is only a label, so renaming "Visits" to
// "Dental School Visits" rewrites nothing and is not a decision anybody needs
// to be warned about. The slug is generated once, at creation, and is never
// shown: it is an identifier, and an officer has no use for it.
//
// A CATEGORY IS A NAME AND AN ORDER, AND THAT IS THE WHOLE SCREEN. It used to
// carry two more controls, and migration 22 removed both because neither did
// anything:
//
//   the unit picker     events, hours or points. It changed the word beside a
//                       number and nothing else, the club stopped tracking
//                       hours, and there is no arithmetic anywhere that ever
//                       branched on it. Whether the member types the number is
//                       credit_mode on the event, which is a different question
//                       asked in a different place.
//   Counts toward points  false for exactly one category ever, Volunteering,
//                       because 29.5 hours could not honestly be added to a
//                       count of events. With hours gone it was a checkbox whose
//                       only remaining use was making somebody's total wrong.

import { select, insert, patch, remove } from './rest.js';
import { READ_ONLY } from './officer-errors.js';
import { reorderWithin, nextOrder } from './requirement-model.js';
import { uniqueSlug, countByCategory, groupRequirementUses, canDelete } from './category-model.js';
import { $, h, announce, moveButton, setHidden, plural } from './ui.js';

const CATEGORY_SELECT = 'id,slug,name,sort_order,archived_at';
const REQUIREMENT_USE_SELECT =
  'category_id,requirement_nodes(id,label,requirement_sets(name,version,status,academic_year_id))';

const NOT_CHANGED = 'Nothing was changed. Reload the page.';

export function createCategories(ctx) {
  const el = {
    form: $('category-form'),
    name: $('category-name'),
    add: $('category-add'),
    error: $('category-error'),
    loading: $('loading-categories'),
    list: $('category-list'),
    retiredZone: $('retired-zone'),
    retired: $('category-retired'),
    dialog: $('retire-dialog'),
    dialogForm: $('retire-form'),
    dialogTitle: $('retire-title'),
    dialogMeta: $('retire-meta'),
    dialogUses: $('retire-uses'),
    deleteDialog: $('delete-category-dialog'),
    deleteDialogForm: $('delete-category-form'),
    deleteDialogMeta: $('delete-category-meta'),
  };

  const state = {
    categories: [],
    // Current-year event usage, for the subline. Reloaded whenever the year
    // changes (see admin.js's year select handler), because this count is the
    // one thing on this row that is not true for every year at once.
    displayEventCounts: new Map(),
    // Every-year event usage, for delete-eligibility only. Never shown: a
    // count on screen that nobody asked "since when" about is read as "right
    // now", and this one deliberately is not.
    allEventCounts: new Map(),
    requirementUses: new Map(),
    busy: false,
    loaded: false,
  };

  const active = () => state.categories.filter((row) => !row.archived_at);
  const retired = () => state.categories.filter((row) => row.archived_at);

  async function load() {
    setHidden(el.loading, false);
    try {
      // Four bulk reads, never one request per row: the categories themselves,
      // this year's event usage (for the subline), every year's event usage
      // (for delete-eligibility, which must not be fooled by a category that
      // is merely unused THIS year), and every requirement's category links.
      const [categories, yearEventRows, allEventRows, requirementRows] = await Promise.all([
        select('categories', { select: CATEGORY_SELECT, order: 'sort_order.asc' }),
        select('event_categories', {
          select: 'category_id,events!inner(id,academic_year_id)',
          filters: { 'events.academic_year_id': `eq.${ctx.year.id}` },
        }),
        select('event_categories', { select: 'category_id' }),
        select('requirement_node_categories', { select: REQUIREMENT_USE_SELECT }),
      ]);

      state.categories = categories;
      state.displayEventCounts = countByCategory(yearEventRows);
      state.allEventCounts = countByCategory(allEventRows);
      state.requirementUses = groupRequirementUses(requirementRows, ctx.years);
      state.loaded = true;
      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
  }

  /** The subline under a row's name: '4 events · 2 requirements'. Either half
   *  is omitted when zero, and the whole line is omitted when both are. */
  function usageSubline(categoryId) {
    const events = state.displayEventCounts.get(categoryId) ?? 0;
    const requirements = state.requirementUses.get(categoryId)?.length ?? 0;
    const parts = [];
    if (events) parts.push(plural(events, 'event'));
    if (requirements) parts.push(plural(requirements, 'requirement'));
    return parts.length ? parts.join(' · ') : null;
  }

  function render() {
    setHidden(el.loading, true);
    setHidden(el.form, !ctx.canReview);

    const live = active();
    el.list.replaceChildren(
      ...(live.length
        ? live.map((row, index) => renderRow(row, index, live.length))
        : [h('p', { class: 'muted' }, 'No categories yet.')]),
    );

    const gone = retired();
    setHidden(el.retiredZone, gone.length === 0);
    el.retired.replaceChildren(...gone.map(renderRetired));
  }

  function renderRow(category, index, count) {
    const row = h('div', { class: 'category-row', dataset: { id: category.id } });

    const main = h('div', { class: 'category-row-main' });
    main.append(
      h('input', {
        class: 'rule-label',
        type: 'text',
        value: category.name,
        maxlength: '60',
        autocomplete: 'off',
        disabled: !ctx.canReview,
        'aria-label': 'Category name',
        onChange: (event) => rename(category, event.target.value),
      }),
    );
    const subline = usageSubline(category.id);
    if (subline) main.append(h('p', { class: 'muted small' }, subline));
    row.append(main);

    const actions = h('div', { class: 'rule-actions' });
    if (ctx.canReview) {
      actions.append(
        moveButton({
          direction: 'up',
          title: `Move ${category.name} up`,
          disabled: state.busy || index === 0,
          onClick: () => move(category, -1),
        }),
        moveButton({
          direction: 'down',
          title: `Move ${category.name} down`,
          disabled: state.busy || index === count - 1,
          onClick: () => move(category, 1),
        }),
        h(
          'button',
          {
            type: 'button',
            class: 'button button-small',
            disabled: state.busy,
            'aria-label': `Retire ${category.name}`,
            onClick: () => retire(category),
          },
          'Retire',
        ),
      );

      // Delete is appended separately, and only when it exists. Node.append()
      // is not h(): it stringifies what it is given, so appending a null
      // branch inline puts the word "null" on screen beside Retire.
      if (
        canDelete(category, {
          allEventCount: state.allEventCounts.get(category.id) ?? 0,
          requirementUses: state.requirementUses.get(category.id) ?? [],
        })
      ) {
        actions.append(
          h(
            'button',
            {
              type: 'button',
              class: 'button button-small button-danger',
              disabled: state.busy,
              'aria-label': `Delete ${category.name}`,
              onClick: () => del(category),
            },
            'Delete',
          ),
        );
      }
    } else {
      actions.append(h('p', { class: 'muted small' }, READ_ONLY));
    }
    row.append(actions);
    return row;
  }

  function renderRetired(category) {
    return h(
      'div',
      { class: 'category-row category-row-retired', dataset: { id: category.id } },
      h('span', { class: 'category-name' }, category.name),
      h(
        'div',
        { class: 'rule-actions' },
        ctx.canReview
          ? h(
              'button',
              {
                type: 'button',
                class: 'button button-small',
                disabled: state.busy,
                'aria-label': `Restore ${category.name}`,
                onClick: () => write(category, { archived_at: null }, `${category.name} restored.`),
              },
              'Restore',
            )
          : null,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  function setBusy(on) {
    state.busy = on;
    for (const node of [el.list, el.retired].flatMap((parent) => [
      ...parent.querySelectorAll('button'),
    ])) {
      node.disabled = on;
    }
  }

  async function write(category, changes, said) {
    setBusy(true);
    ctx.clearMessage();
    try {
      const rows = await patch('categories', { id: `eq.${category.id}` }, changes);
      if (!rows.length) {
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
      Object.assign(category, rows[0]);
      if (said) {
        ctx.note(said);
        announce(said);
      }
      render();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  function rename(category, value) {
    const name = value.trim();
    if (!name || name === category.name) {
      render();
      return;
    }
    write(category, { name }, '');
  }

  async function move(category, delta) {
    const changes = reorderWithin(active(), category.id, delta);
    if (!changes.length) return;

    setBusy(true);
    try {
      for (const change of changes) {
        await patch('categories', { id: `eq.${change.id}` }, { sort_order: change.sort_order });
        const row = state.categories.find((item) => item.id === change.id);
        if (row) row.sort_order = change.sort_order;
      }
      state.categories.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      render();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  async function add(event) {
    event.preventDefault();
    const name = el.name.value.trim();
    if (!name) {
      el.error.textContent = 'Type a name.';
      setHidden(el.error, false);
      el.name.focus();
      return;
    }
    setHidden(el.error, true);

    setBusy(true);
    try {
      const rows = await insert('categories', [
        {
          slug: uniqueSlug(
            name,
            state.categories.map((row) => row.slug),
          ),
          name,
          sort_order: nextOrder(state.categories),
        },
      ]);
      if (!rows?.length) throw new Error('nothing came back');
      state.categories.push(rows[0]);
      el.name.value = '';
      el.name.focus();
      const said = `${name} added.`;
      ctx.note(said);
      announce(said);
      render();
    } catch (err) {
      ctx.fail(err, null);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Retiring, which has to explain itself
  // -------------------------------------------------------------------------

  async function retire(category) {
    const uses = state.requirementUses.get(category.id) ?? [];
    if (uses.length) {
      const go = await confirmRetire(category, uses);
      if (!go) return;
    }
    await write(category, { archived_at: new Date().toISOString() }, `${category.name} retired.`);
  }

  function confirmRetire(category, uses) {
    return new Promise((resolve) => {
      el.dialogTitle.textContent = 'Category in use';
      el.dialogMeta.textContent = `${category.name} · ${plural(uses.length, 'requirement')}`;
      el.dialogUses.replaceChildren(
        ...uses.map((use) =>
          h(
            'li',
            { class: 'problem' },
            h('span', { class: 'problem-title' }, use.label),
            use.where ? ` ${use.where}` : '',
          ),
        ),
      );

      // Same guard as the review queue's dialogs: a close event queued behind
      // the submit path must not undo the decision the submit path made.
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        el.dialogForm.removeEventListener('submit', onSubmit);
        el.dialog.removeEventListener('close', onClose);
        resolve(value);
      };
      const onSubmit = () => {
        el.dialog.close();
        finish(true);
      };
      const onClose = () => finish(false);

      el.dialogForm.addEventListener('submit', onSubmit);
      el.dialog.addEventListener('close', onClose, { once: true });
      el.dialog.showModal();
    });
  }

  // -------------------------------------------------------------------------
  // Deleting, offered only when nothing references the category at all
  // -------------------------------------------------------------------------

  async function del(category) {
    const go = await confirmDelete(category);
    if (!go) return;

    setBusy(true);
    ctx.clearMessage();
    try {
      const rows = await remove('categories', { id: `eq.${category.id}` });
      if (!rows.length) {
        ctx.note(NOT_CHANGED, 'warn');
        return;
      }
      state.categories = state.categories.filter((row) => row.id !== category.id);
      const said = `${category.name} deleted.`;
      ctx.note(said);
      announce(said);
      render();
    } catch (err) {
      // A race: something attached this category to an event or a
      // requirement between page load and this button press, so the database
      // refuses with a genuine foreign-key error rather than an empty array.
      // Reloading is what makes the Delete button disappear once the fresh
      // data shows the reference (see the file header).
      ctx.fail(err, null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(category) {
    return new Promise((resolve) => {
      el.deleteDialogMeta.textContent = category.name;

      // Same guard as confirmRetire(): a close event queued behind submit
      // must not undo the decision submit already made.
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        el.deleteDialogForm.removeEventListener('submit', onSubmit);
        el.deleteDialog.removeEventListener('close', onClose);
        resolve(value);
      };
      const onSubmit = () => {
        el.deleteDialog.close();
        finish(true);
      };
      const onClose = () => finish(false);

      el.deleteDialogForm.addEventListener('submit', onSubmit);
      el.deleteDialog.addEventListener('close', onClose, { once: true });
      el.deleteDialog.showModal();
    });
  }

  function wire() {
    el.form.addEventListener('submit', add);
    el.dialog.querySelector('[data-close]')?.addEventListener('click', () => el.dialog.close());
    el.deleteDialog
      .querySelector('[data-close]')
      ?.addEventListener('click', () => el.deleteDialog.close());
  }

  return {
    mount() {
      wire();
      return load();
    },
    reload: load,
    hasLoaded: () => state.loaded,
  };
}
