// The Events list read shared by the shipped page and the deployment guard.
// Keep the select, filter and order together so a frontend change cannot ship
// without the anonymous guard probing the same PostgREST contract.

export const EVENT_SELECT = [
  'id,title,occurred_on,starts_at,ends_at,term_id,checkin_token,checkin_closes_at,config_version',
  'location,attire,signup,description,is_published,release_at,is_visible',
  'event_categories(category_id,credit_mode,fixed_credit,categories(id,name))',
  'event_evidence_requirements(id,kind,is_required,prompt)',
].join(',');

export function eventsStartupOptions(academicYearId) {
  return {
    select: EVENT_SELECT,
    filters: { academic_year_id: `eq.${academicYearId}` },
    order: 'occurred_on.desc',
  };
}

export function eventsStartupQuery(academicYearId) {
  const options = eventsStartupOptions(academicYearId);
  const params = new URLSearchParams();
  params.set('select', options.select);
  for (const [column, test] of Object.entries(options.filters)) params.append(column, test);
  params.set('order', options.order);
  return params.toString();
}
