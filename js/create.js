import { sb, state, requireLogin } from './supabase.js';
import { $, $$, esc, errMsg, toast, TIKTOK_RE } from './components.js';
import { loadDraft, saveDraft, clearDraft } from './draft.js';

const SIZES = [2, 4, 8, 16, 32, 64, 128];
const MAX_IMG = 5 * 1024 * 1024;          // 5 Mo
const MAX_IMGS_PER_CHAR = 8;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function createPage(app) {
  if (!state.session) { requireLogin(); return; }
  const uid = state.uid;

  let size = 8;
  let creating = false;
  // Données de chaque perso (gardées quand on change la taille)
  const chars = [];
  const blank = () => ({ name: '', universe: '', tiktok: '', files: [] });

  app.innerHTML = `
    <section class="fade-up">
      <div class="create-head">
        <h2 class="title">Créer un tournoi</h2>
        <div class="draft-bar">
          <span class="draft-status" id="draftStatus">💾 Sauvegarde auto activée</span>
          <button type="button" class="btn btn-sm btn-ghost" id="saveDraftBtn">💾 Sauvegarder</button>
          <button type="button" class="btn btn-sm btn-ghost" id="clearDraftBtn">🗑 Tout effacer</button>
        </div>
      </div>
      <form id="createForm" class="form" novalidate>
        <label>Titre du tournoi
          <input name="name" required minlength="3" maxlength="60" placeholder="ex: Le plus fort de l'anime">
        </label>

        <div class="field">
          <span class="field-label">Nombre de personnages</span>
          <div class="size-picker" id="sizePicker">
            ${SIZES.map(n => `<button type="button" data-size="${n}">${n}</button>`).join('')}
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
        <p class="muted small" style="margin-top:10px">Ne ferme pas la page. Ton brouillon reste sauvegardé en cas de souci.</p>
      </div>
    </div>`;

  const form = $('#createForm');

  /* ---------- Brouillon ---------- */
  const statusEl = $('#draftStatus');
  const setStatus = (txt, cls = '') => { statusEl.textContent = txt; statusEl.className = `draft-status ${cls}`; };
  const hhmm = d => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  function snapshot() {
    syncFromDom();
    return {
      name: form.elements.name.value,
      size,
      is_private: form.elements.is_private.checked,
      shuffle: form.elements.shuffle.checked,
      // On garde les fichiers tels quels : IndexedDB sait stocker des images
      chars: chars.map(c => ({
        name: c.name, universe: c.universe, tiktok: c.tiktok,
        files: c.files.map(f => ({ blob: f, name: f.name, type: f.type })),
      })),
    };
  }

  function isEmpty(d) {
    return !d.name.trim() && d.chars.every(c => !c.name.trim() && !c.universe.trim() && !c.tiktok.trim() && !c.files.length);
  }

  let saveTimer = null;
  let saving = Promise.resolve();
  let dirty = false;

  async function saveNow(manual = false) {
    clearTimeout(saveTimer);
    if (creating) return;
    const data = snapshot();
    dirty = false;
    saving = saving.then(async () => {
      try {
        if (isEmpty(data)) {
          await clearDraft(uid);
          setStatus('💾 Sauvegarde auto activée');
        } else {
          setStatus('⏳ Sauvegarde…', 'busy');
          await saveDraft(uid, data);
          setStatus(`✔ Brouillon sauvegardé à ${hhmm(Date.now())}`, 'ok');
          if (manual) toast('Brouillon sauvegardé 💾', 'success');
        }
      } catch (e) {
        console.error(e);
        dirty = true;
        setStatus('⚠ Sauvegarde impossible (navigation privée ou stockage plein ?)', 'err');
        if (manual) toast("Impossible de sauvegarder le brouillon sur ce navigateur", 'error');
      }
    });
    return saving;
  }

  function scheduleSave() {
    dirty = true;
    setStatus('✏️ Modifications en cours…', 'busy');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  async function restore() {
    const d = await loadDraft(uid);
    if (!d) return false;
    form.elements.name.value = d.name || '';
    form.elements.is_private.checked = !!d.is_private;
    form.elements.shuffle.checked = !!d.shuffle;
    size = SIZES.includes(d.size) ? d.size : 8;
    chars.length = 0;
    for (const c of d.chars || []) {
      chars.push({
        name: c.name || '', universe: c.universe || '', tiktok: c.tiktok || '',
        files: (c.files || []).filter(x => x?.blob).map(x => {
          const file = x.blob instanceof File ? x.blob : new File([x.blob], x.name || 'image', { type: x.type || x.blob.type });
          file._url = URL.createObjectURL(file);
          return file;
        }),
      });
    }
    setStatus(`✔ Brouillon restauré (sauvegardé à ${hhmm(d.savedAt)})`, 'ok');
    toast('Brouillon restauré ✔', 'success');
    return true;
  }

  /* ---------- Blocs personnages ---------- */
  function syncFromDom() {
    $$('.char-block', app).forEach(b => {
      const i = +b.dataset.i;
      if (!chars[i]) return;
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

  function renderSize() {
    $$('#sizePicker button').forEach(x => x.classList.toggle('active', +x.dataset.size === size));
  }

  function renderChars() {
    while (chars.length < size) chars.push(blank());
    $('#chars').innerHTML = chars.slice(0, size).map((c, i) => `
      <div class="char-block fade-up" style="animation-delay:${Math.min(i, 8) * 30}ms" data-i="${i}">
        <div class="char-head">
          <span class="num">#${i + 1}</span>
          ${c.name.trim() && c.universe.trim() && c.files.length ? '<span class="char-ok">✔</span>' : ''}
        </div>
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

  // Restaure le brouillon s'il existe, puis affiche
  await restore();
  renderSize();
  renderChars();

  $('#sizePicker').addEventListener('click', e => {
    const b = e.target.closest('[data-size]');
    if (!b) return;
    syncFromDom();
    size = +b.dataset.size;
    renderSize();
    renderChars();
    saveNow();
  });

  // Texte tapé : sauvegarde différée
  form.addEventListener('input', e => {
    if (e.target.matches('[type=file]')) return;
    scheduleSave();
  });
  form.addEventListener('change', e => {
    if (e.target.matches('[type=checkbox]')) saveNow();
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
    saveNow();
  });

  $('#chars').addEventListener('click', e => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    syncFromDom();
    const [i, j] = b.dataset.rm.split(':').map(Number);
    URL.revokeObjectURL(chars[i].files[j]._url);
    chars[i].files.splice(j, 1);
    renderChars();
    saveNow();
  });

  $('#saveDraftBtn').addEventListener('click', () => saveNow(true));

  $('#clearDraftBtn').addEventListener('click', async () => {
    if (!confirm('Effacer tout le formulaire et le brouillon sauvegardé ?')) return;
    clearTimeout(saveTimer);
    await clearDraft(uid);
    chars.forEach(c => c.files.forEach(x => URL.revokeObjectURL(x._url)));
    chars.length = 0;
    form.reset();
    size = 8;
    renderSize();
    renderChars();
    dirty = false;
    setStatus('💾 Sauvegarde auto activée');
    toast('Formulaire effacé');
  });

  // Sauvegarde immédiate si on quitte / change d'onglet / met le téléphone en veille
  const flush = () => { if (dirty) saveNow(); };
  const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
  const onBeforeUnload = e => {
    if (creating) { e.preventDefault(); e.returnValue = ''; return; }
    flush();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', onBeforeUnload);

  /* ---------- Envoi ---------- */
  form.addEventListener('submit', async e => {
    e.preventDefault();
    await saveNow();
    const f = new FormData(form);
    const name = f.get('name').trim();
    const list = chars.slice(0, size).map(c => ({ ...c, name: c.name.trim(), universe: c.universe.trim(), tiktok: c.tiktok.trim() }));

    // Validation
    if (name.length < 3) return toast('Le titre doit faire au moins 3 caractères', 'error');
    for (const [i, c] of list.entries()) {
      const where = () => $(`.char-block[data-i="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!c.name) { where(); return toast(`Perso #${i + 1} : nom manquant`, 'error'); }
      if (!c.universe) { where(); return toast(`Perso #${i + 1} : univers manquant`, 'error'); }
      if (!c.files.length) { where(); return toast(`Perso #${i + 1} : ajoute au moins une image`, 'error'); }
      if (c.tiktok && !TIKTOK_RE.test(c.tiktok)) { where(); return toast(`Perso #${i + 1} : le lien doit être un lien tiktok.com`, 'error'); }
    }

    if (f.get('shuffle')) list.sort(() => Math.random() - 0.5);

    const overlay = $('#progress');
    const setP = (txt, pct) => { $('#progressText').textContent = txt; $('#progressBar').style.width = `${pct}%`; };
    overlay.classList.remove('hidden');
    $('#submitBtn').disabled = true;
    creating = true;

    let tournamentId = null;
    try {
      setP('Création du tournoi…', 3);
      const { data: t, error: te } = await sb.from('tournaments')
        .insert({ name, creator_id: uid, is_private: !!f.get('is_private') })
        .select('id').single();
      if (te) throw te;
      tournamentId = t.id;

      for (const [i, c] of list.entries()) {
        setP(`Perso ${i + 1}/${list.length} : ${c.name}`, 5 + (i / list.length) * 92);

        const { data: ch, error: ce } = await sb.from('characters')
          .insert({ name: c.name, universe: c.universe, tiktok_url: c.tiktok || null, created_by: uid })
          .select('id').single();
        if (ce) throw ce;

        const urls = await Promise.all(c.files.map(async file => {
          const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
          const path = `${uid}/${crypto.randomUUID()}.${ext}`;
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
      creating = false;
      dirty = false;
      await clearDraft(uid);              // brouillon supprimé seulement quand tout a réussi
      chars.forEach(c => c.files.forEach(x => URL.revokeObjectURL(x._url)));
      toast('Tournoi créé ! Partage le lien pour que les autres rejoignent.', 'success');
      location.hash = `#/t/${tournamentId}`;
    } catch (err) {
      console.error(err);
      creating = false;
      toast(`${errMsg(err)} — ton brouillon est conservé, tu peux réessayer.`, 'error');
      if (tournamentId) await sb.from('tournaments').delete().eq('id', tournamentId);
      overlay.classList.add('hidden');
      $('#submitBtn').disabled = false;
    }
  });

  // Nettoyage quand on quitte la page "Créer"
  return () => {
    flush();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', flush);
    window.removeEventListener('beforeunload', onBeforeUnload);
  };
}
