select
  id,
  code,
  label,
  state,
  metrics,
  search_document,
  jsonb_build_object('URL', code, 'display_name', label, 'count', 1) as details_json
from public.widgets
where code = :code and metrics = :metrics
