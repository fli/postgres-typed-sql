select
  a.id,
  a.public_id,
  a.email,
  a.display_name,
  a.status,
  a.role
from public.accounts a
where a.email = :email
