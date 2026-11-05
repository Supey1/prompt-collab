// Scroll effects for the home page. Everything here is decoration: the page
// reads the same without it, and none of it runs for people who've asked their
// system for less motion (except the "How it works" preview, which then just
// switches scenes without animating).
const root = document.documentElement;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function initHomeMotion() {
  if (!reduce) {
    root.classList.add('motion');
    splitWords(document.querySelector('.hero h1'));
    bindSpotlight();
  }
  staggerIndexes();
  const steps = [...document.querySelectorAll('.story-step')];
  const scenes = [...document.querySelectorAll('.scene')];
  const hero = document.querySelector('.hero');
  const bar = Object.assign(document.createElement('div'), { className: 'scroll-progress' });
  document.querySelector('.site-header')?.append(bar);

  let active = 0;
  let queued = false;
  const update = () => {
    queued = false;
    const y = scrollY;
    const max = root.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
    if (!reduce && hero) {
      // 0 at the top, 1 once the hero has scrolled out of view.
      root.style.setProperty('--hero-p', Math.min(1, Math.max(0, y / hero.offsetHeight)).toFixed(3));
    }
    // The step nearest the middle of the screen (or of the space under the
    // pinned preview on phones) drives the preview.
    if (steps.length) {
      const stage = document.querySelector('.story-stage');
      const narrow = innerWidth <= 860;
      const top = narrow && stage ? stage.getBoundingClientRect().bottom : 0;
      const focus = top + (innerHeight - top) * (narrow ? 0.45 : 0.5);
      let best = 0;
      let bestDist = Infinity;
      steps.forEach((s, i) => {
        const r = s.getBoundingClientRect();
        const d = Math.abs(r.top + r.height / 2 - focus);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      if (best !== active) {
        active = best;
        steps.forEach((s, i) => s.classList.toggle('active', i === active));
        scenes.forEach((s, i) => s.classList.toggle('active', i === active));
      }
    }
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  update();
}

// Each word of the headline rises in, one after another.
function splitWords(el) {
  if (!el) return;
  const words = el.textContent.trim().split(/\s+/);
  el.setAttribute('aria-label', el.textContent.trim());
  el.innerHTML = words.map((w, i) => `<span class="w" aria-hidden="true" style="--i:${i}">${w.replace(/[&<>]/g, '')}</span>`).join(' ');
}

// Cards and questions in a group appear one after another.
function staggerIndexes() {
  // Feature cards go left to right along each row of three; questions go top to bottom.
  document.querySelectorAll('.feature-grid > *').forEach((el, i) => el.style.setProperty('--i', i % 3));
  document.querySelectorAll('.faq-list > *').forEach((el, i) => el.style.setProperty('--i', i));
}

// A soft glow follows the pointer across the feature cards.
function bindSpotlight() {
  for (const card of document.querySelectorAll('.feature')) {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }
}
