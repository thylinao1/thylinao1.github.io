# thylinao1.github.io

Source for my personal site at https://thylinao1.github.io. It is static HTML and CSS with no
build step: `index.html` is the landing page, and every HTML file under `projects/` is a
self-contained case study or essay.

## Local preview

Any static server works. From the repository root:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` straight from the filesystem also renders, but serving it over HTTP keeps
relative asset paths behaving the way they do in production.

## Deploy

GitHub Pages serves this repository as a user page, deploying from the root of the `main`
branch. Pushing to `main` publishes to https://thylinao1.github.io. There is no build or CI stage
in between.

## Repository layout

| Path | Contents |
| --- | --- |
| `index.html` | Landing page: bio, distinctions, competition results, internships, projects, blog, education, skills |
| `projects/` | One HTML file per case study or essay |
| `projects/assets/` | Figures, two paper PDFs, and a captioned video used by individual project pages |
| `assets/` | Institution logos, a certificate scan, two competition result images, and the social-card image for the masked-distress page |
| `cv-applied-ai-ds.pdf`, `cv-agentic-genai.pdf`, `cv-mlops-rl.pdf` | Three CV variants linked from the landing page |
| `photo.jpg` | Portrait used in the hero section |

## Pages under `projects/`

| File | What it covers |
| --- | --- |
| `abguardrail.html` | ab-guardrail, a command-line A/B-test guardrail: SRM detection, metric tests, BH-FDR, propensity matching |
| `barec.html` | BAREC 2026 Arabic sentence readability shared task, 2nd place in the Strict and Open tracks at 85.4 QWK |
| `bluedot-fold.html` | BlueDot Technical AI Safety Puzzle #1: a feature stored as a magnitude behind a ReLU absolute-value fold |
| `hidden-markov-models.html` | Essay: a geometric reading of hidden Markov models, EM, forward-backward, and Viterbi |
| `jpmc.html` | JPMorgan Chase and Forage quantitative research: credit-risk thresholding, FICO bucketing, gas-storage Q-learning |
| `masked-distress.html` | Apart Research Digital Minds Sprint: expressed distress falls under a suppression prompt while the probe reading does not |
| `medlongtrust.html` | MedLongTrust-EHR at the TCSAUC workshop, UbiComp/ISWC 2026: first place, final score 100.0 |
| `olist.html` | Hierarchical Bayesian difference-in-differences on a 97k-order Olist marketplace panel, in PyMC |
| `p-values.html` | Essay on the 0.05 significance threshold |
| `ponder-superheroes.html` | IBM Research Ponder This, July 2026: bottleneck assignment, answers 349 and 408 |
| `powerco.html` | BCG X and Forage PowerCo SME churn, with a cost-sensitive decision threshold |
| `skill-lift.html` | BenchFlow Agent Skill Lift entry: a static skill library and a skill generator for SkillsBench |
| `sovereign.html` | Sovereign-default prediction across five models, plus a from-scratch PPO allocation agent |

## How the pages are put together

Each page carries its own inline `<style>` and `<script>`. Nothing is shared between files, so a
page can be opened, copied, or moved on its own, at the cost of some duplicated CSS. Font handling
varies by page: the landing page and most project pages link Google Fonts (the landing page uses
Instrument Serif with IBM Plex Sans and IBM Plex Mono), `jpmc.html` embeds its faces as base64
data URIs, and a couple of pages fall back to system serifs.

Each file declares its palette as CSS custom properties at the top. The landing page and most
case studies share a cream `#f4efe6` background with `#15110b` ink; the accent varies per page,
and a couple of pages run a different ground entirely. Layout collapses to a single column below
roughly 760px.

Figures are drawn with plain canvas or inline SVG and no libraries, with one exception.
`olist.html` ships a base64-encoded bundle of React, ReactDOM, and Babel standalone that renders
the interactive version of that case study in the browser; the plain HTML in the file itself is
the summary shown when JavaScript is off. That is why it is by far the largest file here.

## Editing

To change the landing page, edit `index.html` and push. To add a case study, drop the HTML file
into `projects/` and link it from the relevant section of `index.html`.
