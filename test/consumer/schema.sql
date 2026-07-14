create table public.widgets (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text
);
