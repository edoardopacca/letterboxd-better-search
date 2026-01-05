-- Supabase/Postgres search layer for Letterboxd Better Search.
-- Contains required extensions, indexes, and SQL functions:
--   search_movies(q), search_people(q), search_all(q).
-- Note: requires tables public.movies/public.people and normalized columns (e.g., title_normalized, overview_tsv).
-- Enable required extensions 
create extension if not exists pg_trgm;
create extension if not exists unaccent;

-- =========================
-- Indexes
-- =========================
-- Movies: trigram su campi già normalizzati
create index if not exists movies_title_norm_trgm
on public.movies using gin (title_normalized gin_trgm_ops);

create index if not exists movies_original_title_norm_trgm
on public.movies using gin (original_title_normalized gin_trgm_ops);

-- Movies: title_it (tu lo calcoli al volo: lower(unaccent(title_it)))
create index if not exists movies_title_it_expr_trgm
on public.movies using gin ((lower(public.unaccent_immutable(title_it))) gin_trgm_ops);

-- Movies: full-text
create index if not exists movies_overview_tsv_gin
on public.movies using gin (overview_tsv);

-- People: trigram (meglio anche parziale “Acting”)
create index if not exists people_acting_name_norm_trgm
on public.people using gin (name_normalized gin_trgm_ops)
where known_for_department = 'Acting';


-- =========================
-- Movies search
-- =========================
create or replace function public.search_movies(
  q text,
  limit_count integer default 10
)
returns table (
  id                bigint,
  title             text,
  original_title    text,
  overview          text,
  release_date      date,
  release_year      int,
  popularity        double precision,
  vote_average      double precision,
  vote_count        int,
  original_language text,
  genre_ids         int[],
  poster_path       text,
  total_score       double precision,
  sim_best          double precision,
  ft_rank           double precision,
  year_bonus        double precision
)
language plpgsql
stable
as $$
declare
  q_trimmed text;
  q_norm    text;
  q_year    int;
  q_len     int;
  min_vote  int := 0;
begin
  q_trimmed := trim(coalesce(q, ''));
  if q_trimmed = '' then
    return query
    select
      m.id, m.title, m.original_title, m.overview, m.release_date, m.release_year,
      m.popularity, m.vote_average, m.vote_count, m.original_language, m.genre_ids,
      m.poster_path,
      0.0 as total_score,
      null::double precision as sim_best,
      null::double precision as ft_rank,
      null::double precision as year_bonus
    from public.movies m
    order by m.popularity desc nulls last
    limit limit_count;
    return;
  end if;

  q_norm := lower(public.unaccent(q_trimmed));
  q_len := char_length(q_norm);

  -- soglia trigram: più alta per query corte = molti meno candidati = molto più veloce
  if q_len <= 3 then
    perform set_limit(0.30);
    min_vote := 100;
  elsif q_len = 4 then
    perform set_limit(0.22);
    min_vote := 50;
  elsif q_len = 5 then
    perform set_limit(0.18);
    min_vote := 20;
  elsif q_len = 6 then
    perform set_limit(0.15);
    min_vote := 5;
  else
    perform set_limit(0.08);
    min_vote := 0;
  end if;

  select cast(substring(q_trimmed from '(\d{4})') as int) into q_year;
  if q_year is not null and (q_year < 1900 or q_year > 2100) then
    q_year := null;
  end if;

  return query
  with candidates as (
    -- 1) title_normalized (usa indice GIN trigram)
    select m.id
    from public.movies m
    where m.title_normalized % q_norm
      and (min_vote = 0 or coalesce(m.vote_count, 0) > min_vote)

    union

    -- 2) original_title_normalized (usa indice)
    select m.id
    from public.movies m
    where m.original_title_normalized % q_norm
      and (min_vote = 0 or coalesce(m.vote_count, 0) > min_vote)

    union

    -- 3) title_it (usa indice su espressione che hai creato)
    select m.id
    from public.movies m
    where lower(public.unaccent_immutable(m.title_it)) % q_norm
      and (min_vote = 0 or coalesce(m.vote_count, 0) > min_vote)

    union

    -- 4) full-text overview (usa indice GIN tsv)
    select m.id
    from public.movies m
    where m.overview_tsv @@ plainto_tsquery('simple', q_norm)
      and (min_vote = 0 or coalesce(m.vote_count, 0) > min_vote)
  ),
  ranked as (
    select
      m.*,
      similarity(m.title_normalized, q_norm) as sim_title,
      similarity(m.original_title_normalized, q_norm) as sim_original_title,
      similarity(lower(public.unaccent_immutable(m.title_it)), q_norm) as sim_title_it,
      ts_rank(m.overview_tsv, plainto_tsquery('simple', q_norm)) as ft_rank_raw,
      case
        when m.popularity is null or m.popularity <= 0 then 0.0
        else ln(1.0 + m.popularity) / ln(1.0 + 10000.0)
      end as log_pop_norm,
      coalesce(m.vote_average, 0.0) / 10.0 as vote_avg_norm,
      case
        when m.vote_count is null or m.vote_count <= 0 then 0.0
        else ln(1.0 + m.vote_count) / ln(1.0 + 100000.0)
      end as vote_count_norm,
      case
        when q_year is not null and m.release_year is not null then abs(m.release_year - q_year)
        else null
      end as year_diff
    from public.movies m
    join candidates c on c.id = m.id
  ),
  scored as (
    select
      r.*,
      greatest(r.sim_title, r.sim_title_it, r.sim_original_title) as sim_best,
      r.ft_rank_raw as ft_rank,
      case
        when r.year_diff is null then 0.0
        when r.year_diff = 0 then 0.3
        when r.year_diff = 1 then 0.15
        else 0.0
      end as year_bonus
    from ranked r
  )
  select
    s.id, s.title, s.original_title, s.overview, s.release_date, s.release_year,
    s.popularity, s.vote_average, s.vote_count, s.original_language, s.genre_ids,
    s.poster_path,
    (
      (3.0 * s.sim_best
      + 1.0 * s.ft_rank
      + 0.8 * s.log_pop_norm
      + 0.8 * s.vote_count_norm
      + 0.4 * s.vote_avg_norm
      + s.year_bonus) / 4.0
    )::double precision as total_score,
    s.sim_best::double precision,
    s.ft_rank::double precision,
    s.year_bonus::double precision
  from scored s
  order by total_score desc nulls last, popularity desc nulls last
  limit limit_count;
end;
$$;
-- =========================
-- People search 
-- =========================

create or replace function public.search_people(
  q text,
  limit_count integer default 10
)
returns table (
  id                   bigint,
  name                 text,
  original_name        text,
  known_for_department text,
  profile_path         text,
  popularity           double precision,
  credits_count        integer,
  total_score          double precision,
  sim_name             double precision,
  credits_norm         double precision
)
language plpgsql
stable
as $$
declare
  q_trimmed text;
  q_norm    text;
begin
  q_trimmed := trim(coalesce(q, ''));
  if q_trimmed = '' then
    return query
    select
      p.id,
      p.name,
      p.original_name,
      p.known_for_department,
      p.profile_path,
      p.popularity,
      p.credits_count,
      0.0 as total_score,
      null::double precision as sim_name,
      null::double precision as credits_norm
    from public.people p
    where p.known_for_department = 'Acting'
    order by
      coalesce(p.credits_count, 0) desc,
      coalesce(p.popularity, 0) desc
    limit limit_count;
    return;
  end if;

  q_norm := lower(public.unaccent(q_trimmed));
  perform set_limit(0.1);

  return query
  with ranked as (
    select
      p.*,
      similarity(p.name_normalized, q_norm) as sim_name,
      case
        when p.popularity is null or p.popularity <= 0 then 0.0
        else ln(1.0 + p.popularity) / ln(1.0 + 1000.0)
      end as log_pop_norm,
      case
        when p.credits_count is null or p.credits_count <= 0 then 0.0
        else ln(1.0 + p.credits_count) / ln(1.0 + 200.0)
      end as log_credits_norm
    from public.people p
    where
      p.known_for_department = 'Acting'
      and p.name_normalized % q_norm
  )
  select
    r.id,
    r.name,
    r.original_name,
    r.known_for_department,
    r.profile_path,
    r.popularity,
    r.credits_count,
    (
      (4.0 * r.sim_name
      + 2.0 * r.log_pop_norm
      + 3.0 * r.log_credits_norm) / 7.0
    )::double precision        as total_score,
    r.sim_name::double precision       as sim_name,
    r.log_credits_norm::double precision as credits_norm
  from ranked r
  order by total_score desc nulls last,
           popularity desc nulls last
  limit limit_count;
end;
$$;

-- =========================
-- Unified search
-- =========================
create or replace function public.search_all(
  q text,
  limit_count integer default 10
)
returns table (
  result_type         text,
  id                  bigint,
  title               text,
  name                text,
  original_title      text,
  release_year        int,
  popularity          double precision,
  vote_average        double precision,
  vote_count          int,
  credits_count       integer,
  profile_path        text,
  poster_path         text,
  total_score         double precision,
  sim_best            double precision,
  ft_rank             double precision,
  year_bonus          double precision,
  sim_name            double precision,
  credits_norm        double precision
)
language sql
stable
as $$
  with movie_results as (
    select
      'movie'::text       as result_type,
      m.id                as id,
      m.title             as title,
      null::text          as name,
      m.original_title    as original_title,
      m.release_year      as release_year,
      m.popularity        as popularity,
      m.vote_average      as vote_average,
      m.vote_count        as vote_count,
      null::integer       as credits_count,
      null::text          as profile_path,
      m.poster_path       as poster_path,
      -- normalizzazione film su [0,1]
      greatest(0, least(1, (m.total_score - 0.30) / (0.60 - 0.30))) * 1.00 as total_score,
      m.sim_best          as sim_best,
      m.ft_rank           as ft_rank,
      m.year_bonus        as year_bonus,
      null::double precision as sim_name,
      null::double precision as credits_norm
    from public.search_movies(q, limit_count * 2) as m
  ),
  people_results as (
    select
      'person'::text         as result_type,
      p.id                   as id,
      null::text             as title,
      p.name                 as name,
      p.original_name        as original_title,
      null::int              as release_year,
      p.popularity           as popularity,
      null::double precision as vote_average,
      null::int              as vote_count,
      p.credits_count        as credits_count,
      p.profile_path         as profile_path,
      null::text             as poster_path,
      greatest(0, least(1, (p.total_score - 0.55) / (0.80 - 0.55))) * 0.95 as total_score,
      null::double precision as sim_best,
      null::double precision as ft_rank,
      null::double precision as year_bonus,
      p.sim_name             as sim_name,
      p.credits_norm         as credits_norm
    from public.search_people(q, limit_count * 2) as p
  ),
  combined as (
    select
      result_type,
      id,
      title,
      name,
      original_title,
      release_year,
      popularity,
      vote_average,
      vote_count,
      credits_count,
      profile_path,
      poster_path,
      total_score,
      sim_best,
      ft_rank,
      year_bonus,
      sim_name,
      credits_norm
    from movie_results

    union all

    select
      result_type,
      id,
      title,
      name,
      original_title,
      release_year,
      popularity,
      vote_average,
      vote_count,
      credits_count,
      profile_path,
      poster_path,
      total_score,
      sim_best,
      ft_rank,
      year_bonus,
      sim_name,
      credits_norm
    from people_results
  )
  select
    result_type,
    id,
    title,
    name,
    original_title,
    release_year,
    popularity,
    vote_average,
    vote_count,
    credits_count,
    profile_path,
    poster_path,
    total_score,
    sim_best,
    ft_rank,
    year_bonus,
    sim_name,
    credits_norm
  from combined
  order by total_score desc nulls last, popularity desc nulls last
  limit limit_count;
$$;


