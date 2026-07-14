-- @param email text
select jsonb_build_object(
  'email', a.email,
  'display_name', a.display_name,
  'post_count', count(p.id)
) as summary
from public.accounts a
left join public.posts p on p.account_id = a.id
where a.email = :email
group by a.id
