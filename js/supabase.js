import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// État global partagé
export const state = {
  session: null,
  profile: null,
  get uid() { return this.session?.user?.id ?? null; },
};

export async function loadProfile() {
  if (!state.uid) { state.profile = null; return; }
  const { data } = await sb.from('profiles').select('id, username').eq('id', state.uid).maybeSingle();
  state.profile = data;
}

// Redirige vers la connexion en mémorisant où revenir
export function requireLogin() {
  sessionStorage.setItem('k40_after_login', location.hash || '#/');
  location.hash = '#/login';
}
