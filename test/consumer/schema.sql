create schema audit;

create type audit.widget_state as enum ('active', 'archived');
create type audit.control_label as enum (E'line\nbreak');

create table public.widgets (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text,
  state audit.widget_state not null default 'active',
  metrics numeric[] not null default '{}',
  search_document tsquery not null default ''::tsquery
);
