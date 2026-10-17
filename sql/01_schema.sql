-- =====================================================================
--  TOURNOIS DE PERSONNAGES — Schéma Supabase
--  À coller dans : Supabase > SQL Editor > New query > Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. PROFILS (liés à auth.users, créés automatiquement à l'inscription)
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text unique not null check (char_length(username) between 3 and 24),
  avatar_url  text,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8))
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 2. PERSONNAGES + IMAGES (plusieurs images par perso)
-- ---------------------------------------------------------------------
create table public.characters (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  universe    text not null check (char_length(universe) between 1 and 60), -- ex: "Naruto", "Star Wars"
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table public.character_images (
  id            uuid primary key default gen_random_uuid(),
  character_id  uuid not null references public.characters(id) on delete cascade,
  url           text not null,
  position      int  not null default 0,   -- ordre dans le carrousel
  created_at    timestamptz not null default now()
);
create index on public.character_images (character_id, position);

-- ---------------------------------------------------------------------
-- 3. TOURNOIS
-- ---------------------------------------------------------------------
create table public.tournaments (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 3 and 60),
  creator_id     uuid not null references public.profiles(id) on delete cascade,
  status         text not null default 'lobby' check (status in ('lobby', 'running', 'finished')),
  is_private     boolean not null default false,
  invite_code    text unique not null default substr(md5(gen_random_uuid()::text), 1, 8),
  current_round  int  not null default 0,
  winner_id      uuid references public.characters(id),
  created_at     timestamptz not null default now()
);

-- Personnages engagés dans un tournoi (seed = ordre dans le bracket)
create table public.tournament_characters (
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  character_id   uuid not null references public.characters(id) on delete cascade,
  seed           int  not null,
  primary key (tournament_id, character_id),
  unique (tournament_id, seed)
);

-- Votants (le nombre doit être impair au lancement)
create table public.tournament_participants (
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  joined_at      timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

-- Le créateur rejoint automatiquement son tournoi
create or replace function public.add_creator_as_participant()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into tournament_participants (tournament_id, user_id) values (new.id, new.creator_id);
  return new;
end $$;

create trigger on_tournament_created
  after insert on public.tournaments
  for each row execute function public.add_creator_as_participant();

-- ---------------------------------------------------------------------
-- 4. DUELS + VOTES
-- ---------------------------------------------------------------------
create table public.matches (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  round          int  not null,
  position       int  not null,
  character_a    uuid not null references public.characters(id),
  character_b    uuid not null references public.characters(id),
  winner_id      uuid references public.characters(id),
  status         text not null default 'open' check (status in ('open', 'closed')),
  unique (tournament_id, round, position)
);

create table public.votes (
  match_id      uuid not null references public.matches(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  character_id  uuid not null references public.characters(id),
  created_at    timestamptz not null default now(),
  primary key (match_id, user_id)          -- 1 vote par personne et par duel
);

-- ---------------------------------------------------------------------
-- 5. LOGIQUE DU TOURNOI
-- ---------------------------------------------------------------------

-- Lancer le tournoi : vérifie nb impair de votants + nb de persos en puissance de 2
create or replace function public.start_tournament(p_tournament uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  t        tournaments;
  n_voters int;
  n_chars  int;
  chars    uuid[];
begin
  select * into t from tournaments where id = p_tournament for update;
  if not found then raise exception 'Tournoi introuvable'; end if;
  if t.creator_id <> auth.uid() then raise exception 'Seul le créateur peut lancer le tournoi'; end if;
  if t.status <> 'lobby' then raise exception 'Le tournoi est déjà lancé'; end if;

  select count(*) into n_voters from tournament_participants where tournament_id = p_tournament;
  if n_voters < 3 or n_voters % 2 = 0 then
    raise exception 'Il faut un nombre impair de participants (3 minimum). Actuellement : %', n_voters;
  end if;

  select array_agg(character_id order by seed) into chars
  from tournament_characters where tournament_id = p_tournament;
  n_chars := coalesce(array_length(chars, 1), 0);
  if n_chars < 2 or n_chars > 64 or (n_chars & (n_chars - 1)) <> 0 then
    raise exception 'Il faut 2, 4, 8, 16, 32 ou 64 personnages. Actuellement : %', n_chars;
  end if;

  for i in 1 .. n_chars / 2 loop
    insert into matches (tournament_id, round, position, character_a, character_b)
    values (p_tournament, 1, i, chars[2 * i - 1], chars[2 * i]);
  end loop;

  update tournaments set status = 'running', current_round = 1 where id = p_tournament;
end $$;

-- Clôture un duel, et si le round est fini : crée le round suivant ou termine le tournoi
-- (fonction interne, pas appelable depuis le front)
create or replace function public.resolve_match(p_match uuid, p_winner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m          matches;
  remaining  int;
  winners    uuid[];
  n          int;
begin
  select * into m from matches where id = p_match;
  if not found then return; end if;

  -- Verrou sur le tournoi : évite que 2 derniers votes simultanés bloquent le passage de round
  perform 1 from tournaments where id = m.tournament_id for update;

  update matches set status = 'closed', winner_id = p_winner
  where id = p_match and status = 'open';
  if not found then return; end if;

  select count(*) into remaining
  from matches where tournament_id = m.tournament_id and round = m.round and status = 'open';
  if remaining > 0 then return; end if;

  select array_agg(winner_id order by position) into winners
  from matches where tournament_id = m.tournament_id and round = m.round;
  n := array_length(winners, 1);

  if n = 1 then
    update tournaments set status = 'finished', winner_id = winners[1] where id = m.tournament_id;
    return;
  end if;

  for i in 1 .. n / 2 loop
    insert into matches (tournament_id, round, position, character_a, character_b)
    values (m.tournament_id, m.round + 1, i, winners[2 * i - 1], winners[2 * i]);
  end loop;

  update tournaments set current_round = m.round + 1 where id = m.tournament_id;
end $$;

-- Après chaque vote : si tout le monde a voté et pas d'égalité -> on clôture
create or replace function public.on_vote()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m        matches;
  n_voters int;
  n_votes  int;
  votes_a  int;
  votes_b  int;
begin
  select * into m from matches where id = new.match_id;
  perform 1 from tournaments where id = m.tournament_id for update;

  select count(*) into n_voters from tournament_participants where tournament_id = m.tournament_id;

  select count(*),
         count(*) filter (where character_id = m.character_a),
         count(*) filter (where character_id = m.character_b)
    into n_votes, votes_a, votes_b
  from votes where match_id = m.id;

  if n_votes >= n_voters and votes_a <> votes_b then
    perform resolve_match(m.id, case when votes_a > votes_b then m.character_a else m.character_b end);
  end if;

  return new;
end $$;

create trigger on_vote_inserted
  after insert on public.votes
  for each row execute function public.on_vote();

-- Bouton "forcer la fin du duel" (créateur uniquement)
-- Majorité actuelle si possible ; en cas d'égalité, le créateur doit choisir p_winner
create or replace function public.force_close_match(p_match uuid, p_winner uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  m        matches;
  creator  uuid;
  votes_a  int;
  votes_b  int;
begin
  select * into m from matches where id = p_match;
  if not found then raise exception 'Duel introuvable'; end if;
  if m.status <> 'open' then raise exception 'Duel déjà terminé'; end if;

  select creator_id into creator from tournaments where id = m.tournament_id;
  if creator <> auth.uid() then raise exception 'Seul le créateur peut forcer la fin du duel'; end if;

  select count(*) filter (where character_id = m.character_a),
         count(*) filter (where character_id = m.character_b)
    into votes_a, votes_b
  from votes where match_id = m.id;

  if votes_a > votes_b then
    perform resolve_match(m.id, m.character_a);
  elsif votes_b > votes_a then
    perform resolve_match(m.id, m.character_b);
  else
    if p_winner is null or p_winner not in (m.character_a, m.character_b) then
      raise exception 'EGALITE: choisis le gagnant';
    end if;
    perform resolve_match(m.id, p_winner);
  end if;
end $$;

-- Rejoindre un tournoi (public ou privé via code)
create or replace function public.join_tournament(p_tournament uuid default null, p_code text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t tournaments;
begin
  if auth.uid() is null then raise exception 'Connexion requise'; end if;

  if p_code is not null then
    select * into t from tournaments where invite_code = p_code;
  else
    select * into t from tournaments where id = p_tournament and is_private = false;
  end if;

  if not found then raise exception 'Tournoi introuvable'; end if;
  if t.status <> 'lobby' then raise exception 'Le tournoi a déjà commencé'; end if;

  insert into tournament_participants (tournament_id, user_id)
  values (t.id, auth.uid())
  on conflict do nothing;

  return t.id;
end $$;

-- Les fonctions internes ne doivent pas être appelables depuis le front
revoke execute on function public.resolve_match(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. SÉCURITÉ (RLS)
-- ---------------------------------------------------------------------
alter table public.profiles                enable row level security;
alter table public.characters              enable row level security;
alter table public.character_images        enable row level security;
alter table public.tournaments             enable row level security;
alter table public.tournament_characters   enable row level security;
alter table public.tournament_participants enable row level security;
alter table public.matches                 enable row level security;
alter table public.votes                   enable row level security;

-- Profils
create policy "profiles_read"   on public.profiles for select using (true);
create policy "profiles_update" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Personnages
create policy "characters_read"   on public.characters for select using (true);
create policy "characters_insert" on public.characters for insert to authenticated
  with check (created_by = auth.uid());
create policy "characters_update" on public.characters for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());
create policy "characters_delete" on public.characters for delete to authenticated
  using (created_by = auth.uid());

-- Images de personnages
create policy "images_read"   on public.character_images for select using (true);
create policy "images_insert" on public.character_images for insert to authenticated
  with check (exists (select 1 from characters c where c.id = character_id and c.created_by = auth.uid()));
create policy "images_delete" on public.character_images for delete to authenticated
  using (exists (select 1 from characters c where c.id = character_id and c.created_by = auth.uid()));

-- Tournois : publics visibles par tous, privés seulement par créateur/participants
create policy "tournaments_read" on public.tournaments for select using (
  is_private = false
  or creator_id = auth.uid()
  or exists (select 1 from tournament_participants p where p.tournament_id = id and p.user_id = auth.uid())
);
create policy "tournaments_insert" on public.tournaments for insert to authenticated
  with check (creator_id = auth.uid());
create policy "tournaments_update" on public.tournaments for update to authenticated
  using (creator_id = auth.uid() and status = 'lobby');
create policy "tournaments_delete" on public.tournaments for delete to authenticated
  using (creator_id = auth.uid());

-- Le créateur ne peut modifier que le nom et la visibilité (statut/gagnant = fonctions uniquement)
revoke update on public.tournaments from anon, authenticated;
grant  update (name, is_private) on public.tournaments to authenticated;

-- Personnages du tournoi : modifiables par le créateur tant que le tournoi est en lobby
create policy "tchars_read"   on public.tournament_characters for select using (true);
create policy "tchars_insert" on public.tournament_characters for insert to authenticated
  with check (exists (select 1 from tournaments t
                      where t.id = tournament_id and t.creator_id = auth.uid() and t.status = 'lobby'));
create policy "tchars_delete" on public.tournament_characters for delete to authenticated
  using (exists (select 1 from tournaments t
                 where t.id = tournament_id and t.creator_id = auth.uid() and t.status = 'lobby'));

-- Participants : on rejoint via join_tournament() ; on peut partir, le créateur peut exclure
create policy "participants_read"   on public.tournament_participants for select using (true);
create policy "participants_delete" on public.tournament_participants for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from tournaments t where t.id = tournament_id and t.creator_id = auth.uid())
  );

-- Duels : lecture seule (écriture uniquement via les fonctions)
create policy "matches_read" on public.matches for select using (true);

-- Votes : un participant vote une fois, sur un duel ouvert, pour l'un des 2 persos
create policy "votes_read"   on public.votes for select using (true);
create policy "votes_insert" on public.votes for insert to authenticated with check (
  user_id = auth.uid()
  and exists (
    select 1
    from matches m
    join tournament_participants p
      on p.tournament_id = m.tournament_id and p.user_id = auth.uid()
    where m.id = match_id
      and m.status = 'open'
      and character_id in (m.character_a, m.character_b)
  )
);
-- Pas de policy update/delete sur votes : un vote est définitif

-- ---------------------------------------------------------------------
-- 7. TEMPS RÉEL
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table
  public.tournaments,
  public.tournament_participants,
  public.matches,
  public.votes;

-- ---------------------------------------------------------------------
-- 8. STOCKAGE DES IMAGES (bucket public "characters")
--    Chemin des fichiers : <user_id>/<nom_fichier>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('characters', 'characters', true)
on conflict (id) do nothing;

create policy "char_images_upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'characters' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "char_images_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'characters' and (storage.foldername(name))[1] = auth.uid()::text);
