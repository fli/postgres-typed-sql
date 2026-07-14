create extension if not exists pgcrypto;

create type public.account_status as enum ('active', 'suspended');

create table public.accounts (
  id bigint generated always as identity primary key,
  public_id uuid not null default gen_random_uuid(),
  email text not null unique,
  display_name text,
  status public.account_status not null default 'active',
  role text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamp with time zone not null default now()
);

create table public.posts (
  id bigint generated always as identity primary key,
  account_id bigint not null references public.accounts(id),
  title text not null,
  body text,
  published_at timestamp with time zone,
  unique (account_id, title)
);

create view public.published_posts as
select id, account_id, title, published_at
from public.posts
where published_at is not null;
