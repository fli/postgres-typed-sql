-- @nullable display_name
insert into public.accounts (email, display_name)
values (:email, :display_name)
returning id, public_id, email, display_name, status, role
