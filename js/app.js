import { sb, state, loadProfile, requireLogin } from './supabase.js';
import { SITE_TITLE, SITE_SUBTITLE } from './config.js';
import { $, $$, esc, errMsg, toast, timeAgo } from './components.js';
import { createPage } from './create.js';
import { tournamentPage } from './tournament.js';

/* ============================== HEADER ============================== */
function renderHeader() {
  const logged = !!state.session;
  $('#top').innerHTML = `
    <div class="hdr">
      <a href="#/" class="logo">K40<span> POWER</span></a>
      <nav>
        <a href="#/" class="nav-link">Tournois</a>
        <a href="#/create" class="btn btn-sm">+ Créer</a>
        ${logged
          ? `<button class="user-chip" id="logout" title="Se déconnecter">${esc(state.profile?.username || '…')} <span>⏻</span></button>`
          : '<a href="#/login" class="btn btn-sm btn-ghost">Connexion</a>'}
      </nav>
    </div>`;
  $('#logout')?.addEventListener('click', async () => {
    await sb.auth.signOut();
    toast('Déconnecté');
  });
}

/* ============================== ACCUEIL ============================== */
async function homePage(app) {
  let tab = sessionStorage.getItem('k40_tab') || 'running';

  app.innerHTML = `
    <section class="hero fade-up">
      <h1 class="hero-title">${esc(SITE_TITLE)}</h1>
      <p class="hero-sub">${esc(SITE_SUBTITLE)}</p>
      <div class="hero-actions">
        <a href="#/create" class="btn btn-lg">⚡ Créer un tournoi</a>
        <form class="join-code" id="joinForm">
          <input name="code" placeholder="Code d'invitation" maxlength="8" autocomplete="off" required>
          <button class="btn btn-ghost">Rejoindre</button>
        </form>
      </div>
    </section>

    <div class="tabs" role="tablist">
      <button data-tab="running">🔴 En direct</button>
      <button data-tab="lobby">⏳ En attente</button>
      <button data-tab="finished">🏆 Terminés</button>
    </div>
    <section id="list" class="grid-list"></section>`;

  $('#joinForm').addEventListener('submit', e => {
    e.preventDefault();
    const code = new FormData(e.target).get('code').trim().toLowerCase();
    if (code) location.hash = `#/join/${encodeURIComponent(code)}`;
  });

  async function loadList() {
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const list = $('#list');
    if (!list) return;
    const { data, error } = await sb.from('tournaments')
      .select('id, name, status, is_private, created_at, current_round, creator:profiles!tournaments_creator_id_fkey(username), tournament_characters(count), tournament_participants(count)')
      .eq('status', tab)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) { list.innerHTML = `<p class="empty">Erreur : ${esc(errMsg(error))}</p>`; return; }
    if (!data.length) {
      list.innerHTML = `<p class="empty">Aucun tournoi ici pour l'instant.<br><a href="#/create">Lance le premier 🔥</a></p>`;
      return;
    }
    list.innerHTML = data.map((t, i) => {
      const nc = t.tournament_characters?.[0]?.count ?? 0;
      const np = t.tournament_participants?.[0]?.count ?? 0;
      return `
        <a href="#/t/${t.id}" class="t-card fade-up" style="animation-delay:${Math.min(i, 10) * 40}ms">
          <div class="t-card-top">
            <span class="status status-${t.status}">${statusLabel(t.status)}</span>
            ${t.is_private ? '<span class="pill">🔒 Privé</span>' : ''}
          </div>
          <h3>${esc(t.name)}</h3>
          <div class="t-meta">
            <span>👤 ${esc(t.creator?.username || '?')}</span>
            <span>🥊 ${nc} persos</span>
            <span>🗳️ ${np} votants</span>
          </div>
          <div class="t-foot">${timeAgo(t.created_at)}</div>
        </a>`;
    }).join('');
  }

  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    sessionStorage.setItem('k40_tab', tab);
    loadList();
  }));

  await loadList();

  // Rafraîchit la liste en temps réel
  let t = null;
  const ch = sb.channel('home-list')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments' }, () => {
      clearTimeout(t); t = setTimeout(loadList, 400);
    })
    .subscribe();
  return () => sb.removeChannel(ch);
}

export function statusLabel(s) {
  return { lobby: 'En attente', running: 'En direct', finished: 'Terminé' }[s] || s;
}

/* ============================== CONNEXION ============================== */
async function loginPage(app) {
  if (state.session) { location.hash = '#/'; return; }
  let mode = 'login';

  function render() {
    app.innerHTML = `
      <section class="auth fade-up">
        <h2 class="title">${mode === 'login' ? 'Connexion' : 'Créer un compte'}</h2>
        <p class="muted">Connecte-toi pour créer des tournois, les rejoindre et voter.</p>
        <div class="tabs tabs-sm">
          <button class="${mode === 'login' ? 'active' : ''}" data-mode="login">Connexion</button>
          <button class="${mode === 'signup' ? 'active' : ''}" data-mode="signup">Inscription</button>
        </div>
        <form id="authForm" class="form">
          ${mode === 'signup' ? `
            <label>Pseudo
              <input name="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_.\\-]{3,24}"
                     placeholder="ex: nabil_le_bg" autocomplete="username">
              <small>3 à 24 caractères : lettres, chiffres, _ . -</small>
            </label>` : ''}
          <label>Email
            <input name="email" type="email" required autocomplete="email" placeholder="toi@mail.com">
          </label>
          <label>Mot de passe
            <input name="password" type="password" required minlength="8"
                   autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" placeholder="8 caractères minimum">
          </label>
          <button class="btn btn-lg btn-block" type="submit">${mode === 'login' ? 'Se connecter' : "S'inscrire"}</button>
        </form>
      </section>`;

    $$('[data-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; render(); }));

    $('#authForm').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      const f = new FormData(e.target);
      const email = f.get('email').trim();
      const password = f.get('password');
      btn.disabled = true;
      try {
        if (mode === 'signup') {
          const username = f.get('username').trim();
          const { data: taken } = await sb.from('profiles').select('id').eq('username', username).maybeSingle();
          if (taken) throw new Error('Ce pseudo est déjà pris.');
          const { data, error } = await sb.auth.signUp({
            email, password,
            options: { data: { username }, emailRedirectTo: location.origin + location.pathname },
          });
          if (error) throw error;
          if (!data.session) {
            toast('Compte créé ! Confirme ton email puis connecte-toi.', 'success');
            mode = 'login'; render();
            return;
          }
          toast(`Bienvenue ${username} 🔥`, 'success');
        } else {
          const { error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
          toast('Connecté ✔', 'success');
        }
      } catch (err) {
        toast(errMsg(err), 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }
  render();
}

/* ============================== REJOINDRE PAR CODE ============================== */
async function joinPage(app, code) {
  if (!state.session) { requireLogin(); return; }
  app.innerHTML = '<div class="loader"></div><p class="center muted">On te fait rentrer…</p>';
  const { data, error } = await sb.rpc('join_tournament', { p_code: decodeURIComponent(code).toLowerCase() });
  if (error) {
    app.innerHTML = `<section class="empty"><h2>😬</h2><p>${esc(errMsg(error))}</p><a class="btn" href="#/">Retour</a></section>`;
    return;
  }
  toast('Tu as rejoint le tournoi !', 'success');
  location.replace(`#/t/${data}`);
}

/* ============================== ROUTEUR ============================== */
const routes = [
  [/^#?\/?$/, homePage],
  [/^#\/login$/, loginPage],
  [/^#\/create$/, createPage],
  [/^#\/t\/([0-9a-f-]{36})$/i, tournamentPage],
  [/^#\/join\/([\w%-]+)$/, joinPage],
];

let cleanup = null;
let navId = 0;

async function router() {
  const id = ++navId;
  try { cleanup?.(); } catch { /* rien */ }
  cleanup = null;

  const app = $('#app');
  const hash = location.hash || '#/';
  const route = routes.find(([re]) => re.test(hash));

  if (!route) {
    app.innerHTML = '<section class="empty"><h2>404</h2><p>Page introuvable.</p><a class="btn" href="#/">Accueil</a></section>';
    return;
  }

  app.innerHTML = '<div class="loader"></div>';
  window.scrollTo({ top: 0 });
  try {
    const args = hash.match(route[0]).slice(1);
    const c = await route[1](app, ...args);
    if (id !== navId) { c?.(); return; }   // l'utilisateur a changé de page entre-temps
    cleanup = c || null;
  } catch (e) {
    if (id !== navId) return;
    console.error(e);
    app.innerHTML = `<section class="empty"><h2>Oups</h2><p>${esc(errMsg(e))}</p><a class="btn" href="#/">Accueil</a></section>`;
  }
}

/* ============================== DÉMARRAGE ============================== */
async function init() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  await loadProfile();
  renderHeader();
  router();

  window.addEventListener('hashchange', router);

  sb.auth.onAuthStateChange((event, session) => {
    if (!['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED'].includes(event)) {
      state.session = session;
      return;
    }
    const wasLogged = !!state.session;
    state.session = session;
    // setTimeout : évite un blocage connu de supabase-js dans ce callback
    setTimeout(async () => {
      await loadProfile();
      renderHeader();
      if (event === 'SIGNED_IN' && !wasLogged) {
        const back = sessionStorage.getItem('k40_after_login');
        sessionStorage.removeItem('k40_after_login');
        if (back && back !== '#/login') location.hash = back;
        else if (location.hash === '#/login') location.hash = '#/';
        else router();
      } else if (event === 'SIGNED_OUT') {
        router();
      }
    }, 0);
  });
}

init();