export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Échappement HTML : TOUT contenu utilisateur passe par là (anti-XSS)
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function errMsg(e) {
  const m = e?.message || String(e);
  if (/duplicate key.*votes/i.test(m)) return 'Tu as déjà voté pour ce duel.';
  if (/row-level security/i.test(m)) return "Action non autorisée.";
  if (/Invalid login credentials/i.test(m)) return 'Email ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(m)) return "Confirme ton email avant de te connecter (regarde tes mails).";
  if (/User already registered/i.test(m)) return 'Un compte existe déjà avec cet email.';
  return m;
}

export function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3800);
}

export const TIKTOK_RE = /^https:\/\/([a-z0-9-]+\.)?tiktok\.com\//i;

export function tiktokId(url) {
  const m = String(url || '').match(/tiktok\.com\/(?:@[\w.-]+\/video|v|embed(?:\/v2)?)\/(\d+)/);
  return m ? m[1] : null;
}

export function sortedImages(c) {
  return [...(c?.character_images || [])].sort((a, b) => a.position - b.position);
}

export function thumb(c) {
  const img = sortedImages(c)[0];
  return img ? `<img src="${esc(img.url)}" alt="" loading="lazy">` : '<span>?</span>';
}

// Carrousel : images + vidéo TikTok (si lien) — swipe natif sur téléphone
export function carousel(c, key) {
  const slides = sortedImages(c).map(i =>
    `<div class="slide"><img src="${esc(i.url)}" alt="${esc(c.name)}" loading="lazy" draggable="false"></div>`);

  const tid = tiktokId(c.tiktok_url);
  if (tid) {
    // Lecteur TikTok épuré : juste la vidéo, sans la page autour
    const params = 'autoplay=0&loop=1&music_info=0&description=0&rel=0&native_context_menu=0&closed_caption=0&controls=1&progress_bar=1&play_button=1&volume_control=1&fullscreen_button=1&timestamp=0';
    slides.push(`<div class="slide slide-video"><iframe src="https://www.tiktok.com/player/v1/${tid}?${params}" loading="lazy"
      allow="encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="Edit TikTok ${esc(c.name)}"></iframe></div>`);
  } else if (c.tiktok_url) {
    // Lien court (vm.tiktok.com) : pas intégrable, on met un bouton
    slides.push(`<div class="slide slide-link"><a href="${esc(c.tiktok_url)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">▶ Voir l'edit TikTok</a></div>`);
  }
  if (!slides.length) slides.push('<div class="slide slide-empty">?</div>');

  const multi = slides.length > 1;
  return `
    <div class="carousel" data-key="${esc(key)}">
      <div class="track">${slides.join('')}</div>
      ${multi ? '<button class="car-btn prev" aria-label="Précédent">‹</button><button class="car-btn next" aria-label="Suivant">›</button>' : ''}
      ${multi ? `<div class="dots">${slides.map((_, i) => `<span class="${i === 0 ? 'on' : ''}"></span>`).join('')}</div>` : ''}
      ${c.tiktok_url ? '<span class="badge-video">▶ EDIT</span>' : ''}
    </div>`;
}

// Limites du cadre : de très haut (0.6 = portrait) à large (16:9 = paysage)
const MIN_RATIO = 0.6;
const MAX_RATIO = 16 / 9;

export function bindCarousels(root = document) {
  $$('.carousel', root).forEach(c => {
    if (c.dataset.bound) return;
    c.dataset.bound = '1';
    const track = $('.track', c);
    const dots = $$('.dots span', c);
    const go = d => track.scrollBy({ left: d * track.clientWidth, behavior: 'smooth' });
    $('.prev', c)?.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); go(-1); });
    $('.next', c)?.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); go(1); });
    const prev = $('.prev', c);
    const next = $('.next', c);
    const update = () => {
      const i = Math.round(track.scrollLeft / track.clientWidth);
      const last = track.children.length - 1;
      dots.forEach((d, j) => d.classList.toggle('on', i === j));
      if (prev) prev.disabled = i <= 0;
      if (next) next.disabled = i >= last;
    };
    track.addEventListener('scroll', update, { passive: true });
    update();

    // Le cadre prend la forme de l'image affichée (portrait, carré, paysage…)
    let current = -1;
    const fit = () => {
      const i = Math.round(track.scrollLeft / (track.clientWidth || 1));
      if (i === current) return;
      current = i;
      const slide = track.children[i];
      if (!slide) return;
      if (slide.classList.contains('slide-video')) { c.style.aspectRatio = '9 / 16'; return; }
      const img = slide.querySelector('img');
      if (!img) return;
      const apply = () => {
        if (!img.naturalWidth) return;
        const r = Math.min(MAX_RATIO, Math.max(MIN_RATIO, img.naturalWidth / img.naturalHeight));
        c.style.aspectRatio = String(r);
      };
      if (img.complete) apply();
      else img.addEventListener('load', apply, { once: true });
    };
    // On charge tout de suite la 1re image pour éviter un saut
    const first = track.querySelector('img');
    if (first) first.loading = 'eager';
    track.addEventListener('scroll', () => { clearTimeout(c._fitT); c._fitT = setTimeout(() => { current = -1; fit(); }, 80); }, { passive: true });
    fit();
  });
}

// Garde la position des carrousels quand on re-dessine la page (temps réel)
export function saveCarousels(root) {
  const pos = {};
  $$('.carousel', root).forEach(c => { pos[c.dataset.key] = $('.track', c).scrollLeft; });
  return pos;
}
export function restoreCarousels(root, pos) {
  $$('.carousel', root).forEach(c => {
    const v = pos[c.dataset.key];
    if (v) { const t = $('.track', c); t.style.scrollBehavior = 'auto'; t.scrollLeft = v; t.style.scrollBehavior = ''; t.dispatchEvent(new Event('scroll')); }
  });
}

export function timeAgo(d) {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}