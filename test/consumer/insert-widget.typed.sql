insert into public.widgets (code, label)
values (:code, :label)
returning id
