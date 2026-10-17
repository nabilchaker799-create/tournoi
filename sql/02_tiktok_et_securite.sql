-- 1. Lien TikTok (edit) par personnage
alter table public.characters
  add column if not exists tiktok_url text;

alter table public.characters drop constraint if exists characters_tiktok_url_check;
alter table public.characters
  add constraint characters_tiktok_url_check
  check (tiktok_url is null or tiktok_url ~ '^https://([a-z0-9-]+\.)?tiktok\.com/');

-- 2. Temps réel : reçoit aussi les suppressions
alter table public.tournament_participants replica identity full;
alter table public.tournaments replica identity full;

-- 3. Images : 5 Mo max, formats image uniquement
update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
where id = 'characters';