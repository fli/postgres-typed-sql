-- @param code text
select
  id,
  code,
  label,
  state,
  jsonb_build_object('URL', code, 'display_name', label) as details_json
from public.widgets
where code = :code
