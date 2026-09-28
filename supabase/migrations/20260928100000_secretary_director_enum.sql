-- Secretary Director, a role between admin and officer. See docs/07-officer-roles.md.
--
-- Its own file: a value added to an enum cannot be used in the transaction
-- that adds it, and 20260928100100 uses it in a check constraint and in the
-- role predicates.
alter type public.app_role add value if not exists 'secretary_director' after 'admin';
