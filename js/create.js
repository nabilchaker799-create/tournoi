import { sb, state, requireLogin } from './supabase.js';
import { $, $$, esc, errMsg, toast, TIKTOK_RE } from './components.js';

const SIZES = [2, 4, 8, 16, 32, 64];
const MAX_IMG = 5 * 1024 * 1024;          // 5 Mo
const MAX_IMGS_PER_CHAR = 8;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function createPage(app) {
  if (!state.session) { requireLogin(); return; }

  let size = 8;
  // Données de chaque perso (gardées quand on change la taille)
  const chars = [];
  const blank = () => ({ name: '', universe: '', tiktok: '', files: [] });

  app.innerHTML = `
    <section class="fade-up">
      <h2 class="title">Créer un tournoi</h2>
      <form id="createForm" class="form" novalidate>
        <label>Titre du tournoi
          <input name="name" required minlength="3" maxlength="60" placeholder="ex: Le plus fort de l'anime">
        </label>

        <div class="field">
          <span class="field-label">Nombre de personnages</span>
          <div class="size-picker" id="sizePicker">
            ${SIZES.map(n => `<button type="button" data-size="${n}" class="${n === size ? 'active' : ''}">${n}</button>`).join('')}
          </div>
        </div>

        <div class="row-opts">
          <label class="check"><input type="checkbox" name="is_private"> 🔒 Tournoi privé (accès par code)</label>
          <label class="check"><input type="checkbox" name="shuffle"> 🎲 Mélanger les duels</label>
        </div>

        <div id="chars" class="chars-form"></div>

        <button class="btn btn-lg btn-block" type="submit" id="submitBtn">⚡ Créer le tournoi</button>
      </form>
    </section>

    <div class="overlay hidden" id="progress">
      <div class="overlay-box">
        <div class="loader"></div>
        <p id="progressText">Création…</p>
        <div class="progress"><div id="progressBar"></div></div>
      </div>
    </div>`;

  /* ---------- Blocs personnages ---------- */
  function syncFromDom() {
    $$('.char-block').forEach((b, i) => {
      chars[i].name = $('[name=cname]', b).value;
      chars[i].universe = $('[name=cuniverse]', b).value;
      chars[i].tiktok = $('[name=ctiktok]', b).value;
    });
  }

  function previews(i) {
    return chars[i].files.map((f, j) => `
      <div class="pv">
        <img src="${f._url}" alt="">
        <button type="button" class="pv-x" data-rm="${i}:${j}" aria-label="Retirer">×</button>
      </div>`).join('');
  }

  function renderChars() {
    while (chars.length < size) chars.push(blank());
    $('#chars').innerHTML = chars.slice(0, size).map((c, i) => `
      <div class="char-block fade-up" style="animation-delay:${Math.min(i, 8) * 30}ms" data-i="${i}">
        <div class="char-head"><span class="num">#${i + 1}</span></div>
        <div class="char-grid">
          <label>Nom <input name="cname" maxlength="60" value="${esc(c.name)}" placeholder="ex: Goku"></label>
          <label>Univers <input name="cuniverse" maxlength="60" value="${esc(c.universe)}" placeholder="ex: Dragon Ball"></label>
        </div>
        <div class="field">
          <span class="field-label">Images (1 à ${MAX_IMGS_PER_CHAR}, 5 Mo max)</span>
          <div class="pv-grid" id="pv-${i}">
            ${previews(i)}
            <label class="pv-add">
              <input type="file" accept="${OK_TYPES.join(',')}" multiple data-files="${i}">
              <span>＋</span>
            </label>
          </div>
        </div>
        <label><span class="lbl-row">Lien TikTok edit <small>(optionnel)</small></span>
          <input name="ctiktok" type="url" value="${esc(c.tiktok)}" placeholder="https://www.tiktok.com/@compte/video/123…">
        </label>
      </div>`).join('');
  }

  renderChars();

  $('#sizePicker').addEventListener('click', e => {
    const b = e.target.closest('[data-size]');
    if (!b) return;
    syncFromDom();
    size = +b.dataset.size;
    $$('#sizePicker button').forEach(x => x.classList.toggle('active', x === b));
    renderChars();
  });

  $('#chars').addEventListener('change', e => {
    const input = e.target.closest('[data-files]');
    if (!input) return;
    syncFromDom();
    const i = +input.dataset.files;
    for (const f of input.files) {
      if (!OK_TYPES.includes(f.type)) { toast(`${f.name} : format non supporté`, 'error'); continue; }
      if (f.size > MAX_IMG) { toast(`${f.name} : trop lourde (5 Mo max)`, 'error'); continue; }
      if (chars[i].files.length >= MAX_IMGS_PER_CHAR) { toast(`${MAX_IMGS_PER_CHAR} images max par perso`, 'error'); break; }
      f._url = URL.createObjectURL(f);
      chars[i].files.push(f);
    }
    renderChars();
  });

  $('#chars').addEventListener('click', e => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    syncFromDom();
    const [i, j] = b.dataset.rm.split(':').map(Number);
    URL.revokeObjectURL(chars[i].files[j]._url);
    chars[i].files.splice(j, 1);
    renderChars();
  });

  /* ---------- Envoi ---------- */
  $('#createForm').addEventListener('submit', async e => {
    e.preventDefault();
    syncFromDom();
    const f = new FormData(e.target);
    const name = f.get('name').trim();
    const list = chars.slice(0, size).map(c => ({ ...c, name: c.name.trim(), universe: c.universe.trim(), tiktok: c.tiktok.trim() }));

    // Validation
    if (name.length < 3) return toast('Le titre doit faire au moins 3 caractères', 'error');
    for (const [i, c] of list.entries()) {
      if (!c.name) return toast(`Perso #${i + 1} : nom manquant`, 'error');
      if (!c.universe) return toast(`Perso #${i + 1} : univers manquant`, 'error');
      if (!c.files.length) return toast(`Perso #${i + 1} : ajoute au moins une image`, 'error');
      if (c.tiktok && !TIKTOK_RE.test(c.tiktok)) return toast(`Perso #${i + 1} : le lien doit être un lien tiktok.com`, 'error');
    }

    if (f.get('shuffle')) list.sort(() => Math.random() - 0.5);

    const overlay = $('#progress');
    const setP = (txt, pct) => { $('#progressText').textContent = txt; $('#progressBar').style.width = `${pct}%`; };
    overlay.classList.remove('hidden');
    $('#submitBtn').disabled = true;

    let tournamentId = null;
    try {
      setP('Création du tournoi…', 3);
      const { data: t, error: te } = await sb.from('tournaments')
        .insert({ name, creator_id: state.uid, is_private: !!f.get('is_private') })
        .select('id').single();
      if (te) throw te;
      tournamentId = t.id;

      for (const [i, c] of list.entries()) {
        setP(`Perso ${i + 1}/${list.length} : ${c.name}`, 5 + (i / list.length) * 92);

        const { data: ch, error: ce } = await sb.from('characters')
          .insert({ name: c.name, universe: c.universe, tiktok_url: c.tiktok || null, created_by: state.uid })
          .select('id').single();
        if (ce) throw ce;

        const urls = await Promise.all(c.files.map(async file => {
          const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
          const path = `${state.uid}/${crypto.randomUUID()}.${ext}`;
          const { error } = await sb.storage.from('characters').upload(path, file, { contentType: file.type, upsert: false });
          if (error) throw error;
          return sb.storage.from('characters').getPublicUrl(path).data.publicUrl;
        }));

        const { error: ie } = await sb.from('character_images')
          .insert(urls.map((url, position) => ({ character_id: ch.id, url, position })));
        if (ie) throw ie;

        const { error: tce } = await sb.from('tournament_characters')
          .insert({ tournament_id: tournamentId, character_id: ch.id, seed: i + 1 });
        if (tce) throw tce;
      }

      setP('Terminé ✔', 100);
      chars.forEach(c => c.files.forEach(x => URL.revokeObjectURL(x._url)));
      toast('Tournoi créé ! Partage le lien pour que les autres rejoignent.', 'success');
      location.hash = `#/t/${tournamentId}`;
    } catch (err) {
      console.error(err);
      toast(errMsg(err), 'error');
      if (tournamentId) await sb.from('tournaments').delete().eq('id', tournamentId);
      overlay.classList.add('hidden');
      $('#submitBtn').disabled = false;
    }
  });
}