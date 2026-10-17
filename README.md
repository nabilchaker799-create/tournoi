# ⚡ K40 POWER

Tournois de personnages (anime, SF, jeux…) avec votes en temps réel.
Site 100 % statique (HTML/CSS/JS) + Supabase → hébergeable gratuitement sur GitHub Pages.

## 1. Supabase (une seule fois)

1. **SQL Editor** → colle et lance `sql/01_schema.sql`, puis `sql/02_tiktok_et_securite.sql`.
   (Si tu avais déjà lancé le schéma avant : lance seulement le `02`.)
2. **Project Settings → Data API** → copie la *Project URL* et colle-la dans `js/config.js` (`SUPABASE_URL`).
3. **Authentication → URL Configuration** → mets l'URL de ton site GitHub Pages
   (ex : `https://tonpseudo.github.io/k40-power/`) dans *Site URL* et *Redirect URLs*.
   Sinon le lien de confirmation par email renvoie vers localhost.
4. (Optionnel) **Authentication → Sign In / Providers → Email** : désactive *Confirm email* si tu veux
   que les potes puissent jouer direct sans confirmer leur mail.

> 🔐 Seule la clé **publishable** (`sb_publishable_…`) va dans le code. La clé **secret** ne doit jamais être sur GitHub.

## 2. Tester en local

Les modules JS ne marchent pas en ouvrant `index.html` en double-clic. Lance un petit serveur :

```bash
cd k40-power
python -m http.server 8000
# puis ouvre http://localhost:8000
```

## 3. Mettre en ligne sur GitHub Pages

```bash
cd k40-power
git init
git add .
git commit -m "K40 POWER"
git branch -M main
git remote add origin https://github.com/TON-PSEUDO/k40-power.git
git push -u origin main
```

Sur GitHub : **Settings → Pages → Source : Deploy from a branch → `main` / `/ (root)`** → Save.
Le site sera dispo sur `https://TON-PSEUDO.github.io/k40-power/` en 1-2 min.

## Fonctionnement

- **Créer** : titre, nombre de persos (2 à 32), pour chaque perso : nom, univers, images (carrousel) + lien TikTok edit optionnel.
- **Rejoindre** : bouton sur la page du tournoi, ou lien / code d'invitation (obligatoire pour les tournois privés).
- **Lancer** : le créateur lance quand il y a un nombre **impair** de votants (3 minimum).
- **Voter** : un vote par duel, définitif. Le duel se termine dès que tout le monde a voté. Le créateur peut forcer la fin si quelqu'un bloque.
- **Arbre** complet visible en direct, champion + confettis à la fin.
- Liens TikTok : format `https://www.tiktok.com/@compte/video/123…` → vidéo intégrée au carrousel. Les liens courts `vm.tiktok.com` s'affichent en bouton.

## Structure

```
index.html
css/style.css
js/config.js       ← URL + clé Supabase, titre/sous-titre
js/supabase.js     ← client + session
js/components.js   ← carrousel, toasts, helpers
js/app.js          ← routeur, header, accueil, connexion
js/create.js       ← création de tournoi
js/tournament.js   ← lobby, duels, votes temps réel, arbre
sql/               ← scripts Supabase
```
