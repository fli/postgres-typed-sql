-- @param code text
select id, code, label
from public.widgets
where code = :code
