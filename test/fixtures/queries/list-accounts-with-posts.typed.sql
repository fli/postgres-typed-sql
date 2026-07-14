select
  a.email,
  p.title,
  p.published_at
from public.accounts a
left join public.posts p on p.account_id = a.id
order by a.email, p.title
