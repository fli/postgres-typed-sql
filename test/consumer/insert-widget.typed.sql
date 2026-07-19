insert into public.widgets (code, label)
values (:code, :widget_label)
returning id
