import { sb, state, requireLogin } from './supabase.js';
import {
  $, $$, esc, errMsg, toast, carousel, bindCarousels, saveCarousels, restoreCarousels, thumb,
} from './components.js';

const STATUS = { lobby: 'En attente', running: 'En direct', finished: 'Terminé' };

function roundName(r, total) {
  const left = total - r;
  if (left === 0) return 'Finale';
  if (left === 1) return 'Demi-finales';
  if (left === 2) return 'Quarts de finale';
  if (left === 3) return 'Huitièmes de finale';
  if (left === 4) return 'Seizièmes de finale';
  if (left === 5) return '32es de finale';
  return `Round ${r}`;
}

export async function tournamentPage(app, id) {
  let D = null;                 // données du tournoi
  let confettiDone = false;
  let busy = false;

  /* ============================== DONNÉES ============================== */
  async function load() {
    const [t, tc, parts, matches] = await Promise.all([
      sb.from('tournaments').select('*, creator:profiles!tournaments_creator_id_fkey(username)').eq('id', id).maybeSingle(),
      sb.from('tournament_characters')
        .select('seed, character:characters(id, name, universe, tiktok_url, character_images(url, position))')
        .eq('tournament_id', id).order('seed'),
      sb.from('tournament_participants')
        .select('user_id, joined_at, profile:profiles(username)')
        .eq('tournament_id', id).order('joined_at'),
      sb.from('matches').select('*').eq('tournament_id', id).order('round').order('position'),
    ]);
    for (const r of [t, tc, parts, matches]) if (r.error) throw r.error;
    if (!t.data) throw new Error('Tournoi introuvable (supprimé ou privé).');

    const chars = new Map(tc.data.map(x => [x.character.id, { ...x.character, seed: x.seed }]));
    D = {
      t: t.data,
      seeds: tc.data.map(x => x.character),
      chars,
      parts: parts.data,
      matches: matches.data,
      votes: [],
    };
    await loadVotes();
  }

  async function loadVotes() {
    const ids = D.matches.map(m => m.id);
    if (!ids.length) { D.votes = []; return; }
    const { data, error } = await sb.from('votes').select('match_id, user_id, character_id').in('match_id', ids);
    if (error) throw error;
    D.votes = data;
  }

  /* ============================== CALCULS ============================== */
  const isCreator = () => state.uid && D.t.creator_id === state.uid;
  const isParticipant = () => state.uid && D.parts.some(p => p.user_id === state.uid);
  const totalRounds = () => Math.log2(Math.max(D.seeds.length, 2));

  function voteStats(m) {
    const v = D.votes.filter(x => x.match_id === m.id);
    const a = v.filter(x => x.character_id === m.character_a).length;
    const b = v.filter(x => x.character_id === m.character_b).length;
    const mine = state.uid ? v.find(x => x.user_id === state.uid)?.character_id : null;
    return { total: v.length, a, b, mine };
  }

  /* ============================== RENDU ============================== */
  function render() {
    const pos = saveCarousels(app);
    const t = D.t;

    app.innerHTML = `
      <section class="t-head fade-up">
        <a href="#/" class="back">← Tournois</a>
        <div class="t-head-row">
          <span class="status status-${t.status}">${STATUS[t.status]}</span>
          ${t.is_private ? '<span class="pill">🔒 Privé</span>' : ''}
          ${t.status === 'running' ? `<span class="pill">${roundName(t.current_round, totalRounds())}</span>` : ''}
        </div>
        <h1 class="t-title">${esc(t.name)}</h1>
        <p class="muted">Créé par <b>${esc(t.creator?.username || '?')}</b> · ${D.seeds.length} persos · ${D.parts.length} votants</p>
        ${shareBox()}
      </section>

      ${t.status === 'finished' ? winnerHTML() : ''}
      ${t.status === 'lobby' ? lobbyHTML() : ''}
      ${t.status === 'running' ? runningHTML() : ''}

      ${t.status === 'finished' ? `
        <section class="block fade-up">
          <h2 class="section-title">🌳 Arbre du tournoi</h2>
          ${bracketHTML()}
        </section>` : `
        <section class="block locked-tree fade-up">
          <span class="lock-ico">🔒</span>
          <div>
            <b>Arbre du tournoi caché</b>
            <p class="muted small">Il sera révélé à la fin, avec le champion.</p>
          </div>
        </section>`}

      ${t.status === 'lobby' ? charsGridHTML() : ''}

      ${isCreator() ? `
        <section class="block danger-zone">
          <button class="btn btn-danger btn-sm" data-action="delete">🗑 Supprimer le tournoi</button>
        </section>` : ''}
    `;

    bindCarousels(app);
    restoreCarousels(app, pos);

    if (t.status === 'finished' && !confettiDone) {
      confettiDone = true;
      fireConfetti();
    }
  }

  function shareBox() {
    const t = D.t;
    const base = location.origin + location.pathname;
    const showCode = t.status === 'lobby' && (isCreator() || isParticipant() || !t.is_private);
    if (!showCode) return '';
    const link = `${base}#/join/${t.invite_code}`;
    return `
      <div class="share">
        <div>
          <span class="muted small">Code d'invitation</span>
          <div class="code">${esc(t.invite_code)}</div>
        </div>
        <button class="btn btn-sm btn-ghost" data-action="copy" data-link="${esc(link)}">📋 Copier le lien</button>
      </div>`;
  }

  /* ---------- LOBBY ---------- */
  function lobbyHTML() {
    const n = D.parts.length;
    const odd = n >= 3 && n % 2 === 1;
    const nChars = D.seeds.length;
    const pow2 = nChars >= 2 && (nChars & (nChars - 1)) === 0;
    const canStart = odd && pow2;

    let joinBtn = '';
    if (!state.session) joinBtn = '<button class="btn btn-lg btn-block" data-action="login">Se connecter pour participer</button>';
    else if (!isParticipant()) joinBtn = '<button class="btn btn-lg btn-block pulse" data-action="join">🙋 Rejoindre le tournoi</button>';
    else if (!isCreator()) joinBtn = '<button class="btn btn-ghost btn-block" data-action="leave">Quitter le tournoi</button>';

    return `
      <section class="block fade-up">
        <div class="section-row">
          <h2 class="section-title">🗳️ Votants (${n})</h2>
          <span class="chip ${odd ? 'chip-ok' : 'chip-warn'}">
            ${odd ? '✔ Nombre impair' : n < 3 ? '⚠ 3 minimum' : '⚠ Il faut un nombre impair'}
          </span>
        </div>
        <ul class="parts">
          ${D.parts.map((p, i) => `
            <li class="fade-up" style="animation-delay:${i * 30}ms">
              <span class="avatar">${esc((p.profile?.username || '?')[0].toUpperCase())}</span>
              <span>${esc(p.profile?.username || '?')}</span>
              ${p.user_id === D.t.creator_id ? '<span class="pill pill-xs">👑 créateur</span>' : ''}
              ${p.user_id === state.uid ? '<span class="pill pill-xs">toi</span>' : ''}
              ${isCreator() && p.user_id !== state.uid
                ? `<button class="kick" data-action="kick" data-user="${p.user_id}" title="Exclure">×</button>` : ''}
            </li>`).join('')}
        </ul>
        ${joinBtn}
        ${isCreator() ? `
          <button class="btn btn-lg btn-block ${canStart ? 'pulse' : ''}" data-action="start" ${canStart ? '' : 'disabled'}>
            🚀 Lancer le tournoi
          </button>
          ${!canStart ? `<p class="muted small center">${!pow2
            ? `Il faut 2, 4, 8, 16, 32 ou 64 persos (actuellement ${nChars}).`
            : 'Le tournoi se lance avec un nombre impair de votants (3, 5, 7…).'}</p>` : ''}
        ` : '<p class="muted small center">En attente du lancement par le créateur…</p>'}
      </section>`;
  }

  function charsGridHTML() {
    return `
      <section class="block fade-up">
        <h2 class="section-title">🥊 Les combattants</h2>
        <div class="chars-grid">
          ${D.seeds.map((c, i) => `
            <div class="char-card fade-up" style="animation-delay:${Math.min(i, 12) * 35}ms">
              ${carousel(c, `grid-${c.id}`)}
              <div class="char-info"><b>${esc(c.name)}</b><span>${esc(c.universe)}</span></div>
            </div>`).join('')}
        </div>
      </section>`;
  }

  /* ---------- EN COURS ---------- */
  function runningHTML() {
    const r = D.t.current_round;
    const ms = D.matches.filter(m => m.round === r);
    const open = ms.filter(m => m.status === 'open').length;
    return `
      <section class="block">
        <div class="section-row">
          <h2 class="section-title">⚔️ ${roundName(r, totalRounds())}</h2>
          <span class="chip">${ms.length - open}/${ms.length} duels terminés</span>
        </div>
        ${!isParticipant() ? `<p class="muted small">${state.session
          ? 'Tu es spectateur : les inscriptions sont fermées pour ce tournoi.'
          : '<a href="#/login" data-action="login">Connecte-toi</a> — tu regardes en spectateur.'}</p>` : ''}
        <div class="matches">${ms.map(matchHTML).join('')}</div>
      </section>`;
  }

  // Bouton / étiquette sous chaque perso
  function ctaHTML(m, cid) {
    const s = voteStats(m);
    if (m.status === 'closed') {
      return m.winner_id === cid
        ? '<span class="tag tag-win">👑 Qualifié</span>'
        : '<span class="tag tag-out">Éliminé</span>';
    }
    if (s.mine === cid) return '<span class="tag tag-mine">✔ Ton vote</span>';
    if (s.mine) return '';
    if (isParticipant()) {
      return `<button class="btn btn-vote" data-action="vote" data-match="${m.id}" data-char="${cid}">Voter</button>`;
    }
    return '<span class="tag tag-out">Spectateur</span>';
  }

  function sideClass(m, cid) {
    const s = voteStats(m);
    return [
      'side',
      m.winner_id === cid ? 'win' : '',
      m.winner_id && m.winner_id !== cid ? 'lose' : '',
      s.mine === cid ? 'picked' : '',
    ].join(' ');
  }

  function sideHTML(m, cid, key) {
    const c = D.chars.get(cid);
    return `
      <div class="${sideClass(m, cid)}" data-side="${m.id}:${cid}">
        <div class="side-media">
          ${carousel(c, `${key}-${cid}`)}
          ${m.winner_id === cid ? '<span class="crown">👑</span>' : ''}
        </div>
        <div class="side-body">
          <div class="side-name" title="${esc(c?.name)}">${esc(c?.name)}</div>
          <div class="side-uni">${esc(c?.universe)}</div>
          <div class="side-cta" data-cta="${m.id}:${cid}">${ctaHTML(m, cid)}</div>
        </div>
      </div>`;
  }

  function matchHTML(m, i) {
    return `
      <article class="match fade-up ${m.status}" style="animation-delay:${i * 60}ms" data-match="${m.id}">
        <div class="match-head">
          <span class="match-num">Duel ${m.position}</span>
          ${m.status === 'open' ? '<span class="live-dot">EN COURS</span>' : '<span class="done-dot">TERMINÉ</span>'}
        </div>
        <div class="duel">
          ${sideHTML(m, m.character_a, `m${m.round}-${m.position}`)}
          ${sideHTML(m, m.character_b, `m${m.round}-${m.position}`)}
          <div class="vs"><span>VS</span></div>
        </div>
        <div class="match-foot" data-foot="${m.id}">${footHTML(m)}</div>
      </article>`;
  }

  function footHTML(m) {
    const s = voteStats(m);
    const n = D.parts.length;
    const a = D.chars.get(m.character_a);
    const b = D.chars.get(m.character_b);
    const reveal = !!s.mine || m.status === 'closed' || !isParticipant();
    const pa = s.total ? Math.round((s.a / s.total) * 100) : 50;

    let html = '';

    if (reveal) {
      html += `
        <div class="bar-wrap">
          <div class="bar-labels"><span>${s.total ? pa : 0}%</span><span>${s.total ? 100 - pa : 0}%</span></div>
          <div class="bar">
            <div class="bar-a" style="width:${pa}%"></div>
            <div class="bar-b" style="width:${100 - pa}%"></div>
          </div>
        </div>`;
    }

    if (m.status === 'open') {
      const pct = n ? Math.round((s.total / n) * 100) : 0;
      html += `
        <div class="progress-votes">
          <div class="pv-track"><div style="width:${pct}%"></div></div>
          <span>${s.total}/${n} ont voté</span>
        </div>`;
      if (isCreator()) {
        const tie = s.a === s.b;
        html += `
          <details class="creator-tools">
            <summary>⚙️ Options créateur</summary>
            <div class="force">
              ${tie
                ? `<span class="muted small">Égalité ou duel bloqué : choisis le gagnant</span>
                   <div class="force-btns">
                     <button class="btn btn-sm btn-ghost" data-action="force" data-match="${m.id}" data-char="${m.character_a}">${esc(a?.name)}</button>
                     <button class="btn btn-sm btn-ghost" data-action="force" data-match="${m.id}" data-char="${m.character_b}">${esc(b?.name)}</button>
                   </div>`
                : `<button class="btn btn-sm btn-ghost" data-action="force" data-match="${m.id}">⏭ Terminer le duel maintenant</button>`}
            </div>
          </details>`;
      }
    }
    return html;
  }

  /* ---------- VAINQUEUR ---------- */
  function winnerHTML() {
    const w = D.chars.get(D.t.winner_id);
    if (!w) return '';
    return `
      <section class="winner pop-in">
        <div class="winner-crown">🏆</div>
        <h2>CHAMPION</h2>
        <div class="winner-card">${carousel(w, 'winner')}</div>
        <h3>${esc(w.name)}</h3>
        <p class="muted">${esc(w.universe)}</p>
      </section>`;
  }

  /* ---------- ARBRE ---------- */
  function bracketHTML() {
    const n = D.seeds.length;
    if (n < 2) return '<p class="muted">Pas assez de persos.</p>';
    const R = totalRounds();
    const cols = [];

    for (let r = 1; r <= R; r++) {
      const count = n / 2 ** r;
      const cells = [];
      for (let p = 1; p <= count; p++) {
        const m = D.matches.find(x => x.round === r && x.position === p);
        let a = null, b = null;
        if (m) { a = m.character_a; b = m.character_b; }
        else if (r === 1) { a = D.seeds[2 * p - 2]?.id; b = D.seeds[2 * p - 1]?.id; }
        const s = m ? voteStats(m) : null;
        const live = m && m.status === 'open';
        cells.push(`
          <div class="bm ${live ? 'live' : ''}">
            ${bSlot(a, m, s?.a)}
            ${bSlot(b, m, s?.b)}
          </div>`);
      }
      cols.push(`
        <div class="round">
          <div class="round-name">${roundName(r, R)}</div>
          <div class="round-cells">${cells.join('')}</div>
        </div>`);
    }

    const champ = D.chars.get(D.t.winner_id);
    cols.push(`
      <div class="round round-champ">
        <div class="round-name">Champion</div>
        <div class="round-cells">
          <div class="bm champ ${champ ? 'has' : ''}">
            <div class="slot">${champ ? `<span class="th">${thumb(champ)}</span><span class="nm">${esc(champ.name)}</span>` : '<span class="nm muted">🏆 ?</span>'}</div>
          </div>
        </div>
      </div>`);

    return `<div class="bracket-wrap"><div class="bracket">${cols.join('')}</div></div>`;
  }

  function bSlot(cid, m, votes) {
    if (!cid) return '<div class="slot empty"><span class="th"><span>?</span></span><span class="nm muted">À venir</span></div>';
    const c = D.chars.get(cid);
    const cls = m?.winner_id ? (m.winner_id === cid ? 'w' : 'l') : '';
    const showVotes = m && (m.status === 'closed' || !isParticipant() || voteStats(m).mine);
    return `
      <div class="slot ${cls}">
        <span class="th">${thumb(c)}</span>
        <span class="nm">${esc(c?.name)}</span>
        ${showVotes && votes != null ? `<span class="vc">${votes}</span>` : ''}
      </div>`;
  }

  /* ---------- Mise à jour légère des votes (sans recharger les carrousels) ---------- */
  function updateVotesUI() {
    for (const m of D.matches) {
      const foot = $(`[data-foot="${m.id}"]`, app);
      if (foot) {
        const wasOpen = $('details', foot)?.open;
        foot.innerHTML = footHTML(m);
        if (wasOpen && $('details', foot)) $('details', foot).open = true;
      }
      for (const cid of [m.character_a, m.character_b]) {
        const side = $(`[data-side="${m.id}:${cid}"]`, app);
        if (side) side.className = sideClass(m, cid);
        const cta = $(`[data-cta="${m.id}:${cid}"]`, app);
        if (cta) cta.innerHTML = ctaHTML(m, cid);
      }
    }
    const br = $('.bracket-wrap', app);
    if (br) {
      const sl = br.scrollLeft;
      br.outerHTML = bracketHTML();
      $('.bracket-wrap', app).scrollLeft = sl;
    }
  }

  function fireConfetti() {
    const go = () => {
      if (typeof window.confetti !== 'function') return;
      const end = Date.now() + 1800;
      (function frame() {
        window.confetti({ particleCount: 6, angle: 60, spread: 60, origin: { x: 0 }, colors: ['#ff2e4d', '#ffc93c', '#ffffff'] });
        window.confetti({ particleCount: 6, angle: 120, spread: 60, origin: { x: 1 }, colors: ['#ff2e4d', '#ffc93c', '#ffffff'] });
        if (Date.now() < end) requestAnimationFrame(frame);
      })();
    };
    if (window.confetti) go(); else setTimeout(go, 800);
  }

  /* ============================== ACTIONS ============================== */
  async function act(fn, okMsg) {
    if (busy) return;
    busy = true;
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      busy = false;
    }
  }

  async function onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el || !app.contains(el)) return;
    const a = el.dataset.action;

    if (a === 'login') { e.preventDefault(); requireLogin(); return; }

    if (a === 'copy') {
      try { await navigator.clipboard.writeText(el.dataset.link); toast('Lien copié 📋', 'success'); }
      catch { prompt('Copie ce lien :', el.dataset.link); }
      return;
    }

    if (a === 'join') {
      return act(async () => {
        const { error } = await sb.rpc('join_tournament', { p_tournament: id });
        if (error) throw error;
        await reload();
      }, 'Tu es dans le tournoi 🔥');
    }

    if (a === 'leave') {
      if (!confirm('Quitter ce tournoi ?')) return;
      return act(async () => {
        const { error } = await sb.from('tournament_participants').delete().eq('tournament_id', id).eq('user_id', state.uid);
        if (error) throw error;
        await reload();
      }, 'Tu as quitté le tournoi');
    }

    if (a === 'kick') {
      if (!confirm('Exclure ce joueur ?')) return;
      return act(async () => {
        const { error } = await sb.from('tournament_participants').delete().eq('tournament_id', id).eq('user_id', el.dataset.user);
        if (error) throw error;
        await reload();
      });
    }

    if (a === 'start') {
      return act(async () => {
        const { error } = await sb.rpc('start_tournament', { p_tournament: id });
        if (error) throw error;
        await reload();
      }, "C'est parti ! 🚀");
    }

    if (a === 'vote') {
      $$(`[data-action="vote"][data-match="${el.dataset.match}"]`, app).forEach(b => { b.disabled = true; });
      el.classList.add('voting');
      return act(async () => {
        const { error } = await sb.from('votes').insert({
          match_id: el.dataset.match, user_id: state.uid, character_id: el.dataset.char,
        });
        if (error) {
          $$(`[data-action="vote"][data-match="${el.dataset.match}"]`, app).forEach(b => { b.disabled = false; });
          throw error;
        }
        // Le temps réel met à jour, mais on recharge direct pour la réactivité
        await reload();
      }, 'Vote enregistré ✔');
    }

    if (a === 'force') {
      if (!confirm('Terminer ce duel maintenant ?')) return;
      return act(async () => {
        const params = { p_match: el.dataset.match };
        if (el.dataset.char) params.p_winner = el.dataset.char;
        const { error } = await sb.rpc('force_close_match', params);
        if (error) throw error;
        await reload();
      }, 'Duel terminé');
    }

    if (a === 'delete') {
      if (!confirm('Supprimer définitivement ce tournoi ?')) return;
      return act(async () => {
        const { error } = await sb.from('tournaments').delete().eq('id', id);
        if (error) throw error;
        location.hash = '#/';
      }, 'Tournoi supprimé');
    }
  }

  /* ============================== TEMPS RÉEL ============================== */
  async function reload() {
    try {
      await load();
      render();
    } catch (e) {
      app.innerHTML = `<section class="empty"><h2>😶</h2><p>${esc(errMsg(e))}</p><a class="btn" href="#/">Accueil</a></section>`;
    }
  }

  let timer = null;
  let pending = null;
  function schedule(kind) {
    pending = pending === 'full' || kind === 'full' ? 'full' : 'votes';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const k = pending; pending = null;
      try {
        if (k === 'full') await reload();
        else { await loadVotes(); updateVotesUI(); }
      } catch (e) { console.error(e); }
    }, 250);
  }

  // Premier chargement
  await load();
  render();
  app.addEventListener('click', onClick);

  const f = `tournament_id=eq.${id}`;
  const channel = sb.channel(`t-${id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${id}` }, () => schedule('full'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: f }, () => schedule('full'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tournament_participants', filter: f }, () => schedule('full'))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'votes' }, p => {
      if (D?.matches.some(m => m.id === p.new?.match_id)) schedule('votes');
    })
    .subscribe();

  // Filet de sécurité si le temps réel décroche (onglet en veille sur téléphone…)
  const onVisible = () => { if (document.visibilityState === 'visible') schedule('full'); };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    clearTimeout(timer);
    app.removeEventListener('click', onClick);
    document.removeEventListener('visibilitychange', onVisible);
    sb.removeChannel(channel);
  };
}