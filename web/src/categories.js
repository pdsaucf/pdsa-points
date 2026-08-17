// Categories: the things requirements measure.
//
// CATEGORIES ARCHIVE, THEY NEVER DELETE (invariant 4). Every reference from a
// rule or an event is `on delete restrict`, so a delete would be refused by the
// database anyway; what this screen offers instead is Retire, which sets
// archived_at and takes the category out of every list that offers a choice,
// while last year's published rules and last year's events keep resolving. The
// #REF! column in the old spreadsheet is what happens when that is not true.
//
// Retiring one a rule still measures is allowed, and is sometimes exactly what
// an officer means to do, so it is not refused. It is explained: the dialog
// names the requirements that measure it before anybody presses the button.
//
// `slug` is the identity and `name` is only a label, so renaming "Visits" to
// "Dental School Visits" rewrites nothing and is not a decision anybody needs
// to be warned about. The slug is generated once, at creation, and is never
// shown: it is an identifier, and an officer has no use for it.

import { select, insert, patch } from './rest.js';
import { READ_ONLY } from './officer-errors.js';
import { reorderWithin, nextOrder } from './requirement-model.js';
import { UNIT_LABEL, UNIT_NAME, uniqueSlug } from './category-model.js';
import { $, h, announce, setHidden, plural } from './ui.js';

const CATEGORY_SELECT =
  'id,slug,name,unit,unit_label,counts_toward_point_total,sort_order,archived_at';

const NOT_CHANGED = 'Nothing was changed. Reload the page.';

export function createCategories(ctx) {
  const el = {
    form: $('category-form'),
    name: $('category-name'),
    unit: $('category-unit'),
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
  };

  const state = {
    categories: [],
    busy: false,
    loaded: false,
  };

  const active = () => state.categories.filter((row) => !row.archived_at);
  const retired = () => state.categories.filter((row) => row.archived_at);

  async function load() {
    setHidden(el.loading, false);
    try {
      state.categories = await select('categories', {
        select: CATEGORY_SELECT,
        order: 'sort_order.asc',
      });
      state.loaded = true;
      render();
    } catch (err) {
      setHidden(el.loading, true);
      ctx.fail(err, load);
    }
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

    row.append(
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

      h(
        'select',
        {
          class: 'select select-quiet',
          disabled: !ctx.canReview,
          'aria-label': `What ${category.name} is measured in`,
          onChange: (event) => setUnit(category, event.target.value),
        },
        ...Object.entries(UNIT_NAME).map(([value, label]) =>
          h('option', { value, selected: category.unit === value }, label),
        ),
      ),

      h(
        'label',
        { class: 'category-toggle' },
        h('input', {
          type: 'checkbox',
          checked: category.counts_toward_point_total,
          disabled: !ctx.canReview,
          onChange: (event) =>
            write(category, { counts_toward_point_total: event.target.checked }, ''),
        }),
        'Counts toward points',
      ),
    );

    const actions = h('div', { class: 'rule-actions' });
    if (ctx.canReview) {
      actions.append(
        h(
          'button',
          {
            type: 'button',
            class: 'button button-small',
            disabled: state.busy || index === 0,
            'aria-label': `Move ${category.name} up`,
            onClick: () => move(category, -1),
          },
          'Up',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'button button-small',
            disabled: state.busy || index === count - 1,
            'aria-label': `Move ${category.name} down`,
            onClick: () => move(category, 1),
          },
          'Down',
        ),
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
      h('span', { class: 'muted small' }, UNIT_NAME[category.unit] ?? ''),
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

  function setUnit(category, unit) {
    write(category, { unit, unit_label: UNIT_LABEL[unit] ?? null }, '');
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

    const unit = el.unit.value;
    setBusy(true);
    try {
      const rows = await insert('categories', [
        {
          slug: uniqueSlug(name, state.categories.map((row) => row.slug)),
          name,
          unit,
          unit_label: UNIT_LABEL[unit] ?? null,
          counts_toward_point_total: true,
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
    setBusy(true);
    let uses = [];
    try {
      uses = await usesOf(category);
    } catch (err) {
      setBusy(false);
      ctx.fail(err, null);
      return;
    }
    setBusy(false);

    if (uses.length) {
      const go = await confirmRetire(category, uses);
      if (!go) return;
    }
    await write(category, { archived_at: new Date().toISOString() }, `${category.name} retired.`);
  }

  /** Which requirements measure this category, and in which set. */
  async function usesOf(category) {
    const rows = await select('requirement_node_categories', {
      select:
        'category_id,requirement_nodes(id,label,requirement_sets(name,version,status,academic_year_id))',
      filters: { category_id: `eq.${category.id}` },
    });

    return rows
      .map((row) => row.requirement_nodes)
      .filter(Boolean)
      .map((node) => {
        const set = node.requirement_sets ?? {};
        const year = (ctx.years ?? []).find((row) => row.id === set.academic_year_id);
        return {
          label: node.label,
          where: [year?.label, set.status].filter(Boolean).join(' · '),
        };
      });
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

  function wire() {
    el.form.addEventListener('submit', add);
    el.dialog.querySelector('[data-close]')?.addEventListener('click', () => el.dialog.close());
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
