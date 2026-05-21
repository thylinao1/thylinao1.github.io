# Maksim Silchenko · Personal Portfolio

Source for [thylinao1.github.io](https://thylinao1.github.io) — a static, single-page
portfolio built to match the visual language of the case-study HTMLs in `projects/`.

## Layout

```
.
├── index.html             # Landing page (hero, experience, skills, awards, education)
├── projects/
│   ├── abguardrail.html   # A/B-Test Experimentation Guardrail case study
│   ├── jpmc.html          # J.P. Morgan Quantitative Research case study
│   ├── olist.html         # Olist Hierarchical Bayesian A/B Testing case study
│   ├── powerco.html       # PowerCo / BCG X Cost-Sensitive Churn case study
│   └── sovereign.html     # Sovereign Default Prediction & RL Portfolio case study
├── cv-applied-ai-ds.pdf   # CV variant — Applied AI & Data Science
├── cv-agentic-genai.pdf   # CV variant — Agentic AI & GenAI Systems
├── cv-mlops-rl.pdf        # CV variant — MLOps & Production Engineering
└── README.md
```

Project HTMLs are loaded **as-is** from your original files — no changes were made.

## Local preview

Open `index.html` in any browser, or run a tiny local server so paths resolve cleanly:

```bash
cd "Personal portfolio website creation"
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy to GitHub Pages

This site is configured for a **user-page repo** (`thylinao1.github.io`). It will
serve at `https://thylinao1.github.io` with **no `/portfolio` suffix** — clean for
your CV.

**One-time setup:**

1. On GitHub, create a new public repository **named exactly** `thylinao1.github.io`.
   - Do **not** add a README, .gitignore, or license when creating it.
2. From this folder, push the contents:

   ```bash
   cd "Personal portfolio website creation"
   git init
   git add .
   git commit -m "Initial portfolio"
   git branch -M main
   git remote add origin https://github.com/thylinao1/thylinao1.github.io.git
   git push -u origin main
   ```

3. On GitHub, go to **Settings → Pages**:
   - **Source:** *Deploy from a branch*
   - **Branch:** `main` / `/ (root)`
   - Save.

4. Wait ~30–60 seconds. The site goes live at **https://thylinao1.github.io**.

## Future edits

To change the landing page, edit `index.html` and push:

```bash
git add index.html
git commit -m "Update landing page"
git push
```

GitHub Pages rebuilds automatically on every push to `main`.

To add a new case study, drop the HTML into `projects/` and link to it from a
new `<article class="exp">` block in `index.html`.

## Tech notes

- **No build step** — plain HTML + CSS, served as static files.
- **Fonts** — Instrument Serif, IBM Plex Sans, IBM Plex Mono via Google Fonts.
- **Colour system** — `#f4efe6` cream background, `#15110b` warm-dark ink,
  `#c8421f` red-orange accent — matches the four case-study pages.
- **Mobile-friendly** — single-column layout below ~760px.
