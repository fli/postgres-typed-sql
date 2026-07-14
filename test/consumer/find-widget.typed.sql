-- @param code text
select
  id,
  code,
  label,
  state,
  search_document,
  jsonb_build_object('URL', code, 'display_name', label, 'count', 1) as details_json
from public.widgets
where code = :code
