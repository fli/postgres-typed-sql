create schema audit;

create type audit.widget_state as enum ('active', 'archived');

create table public.widgets (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text,
  state audit.widget_state not null default 'active'
);
