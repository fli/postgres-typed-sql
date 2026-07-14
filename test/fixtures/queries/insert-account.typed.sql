-- @param email text
-- @param display_name text?
insert into public.accounts (email, display_name)
values (:email, :display_name)
returning id, public_id, email, display_name, status, role
