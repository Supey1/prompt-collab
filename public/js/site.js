import { bindThemeToggle } from './theme.js';
import { avatarContent } from './avatar.js';

// The header shared by the public pages (home, about, FAQ, privacy):
// dark mode, the phone menu, sign-in buttons or who's signed in, and a note
// when the site needs an access code. Resolves to the signed-in user, or null.
export async function initSite() {
  bindThemeToggle(document.getElementById('themeBtn'));
  bindMenu();
  revealOnScroll();
  // Remember the last page browsed, so the access code page can offer a way back.
  try { sessionStorage.setItem('pc-last-page', location.pathname); } catch { /* private mode */ }
  // The header gets a line under it once the page has scrolled.
  const header = document.querySelector('.site-header');
  const onScroll = () => header?.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  const config = await fetchJson('/api/config');
  const locked = !!config && !config.unlocked; // nobody can be signed in before entering the code
  const user = locked ? null : (await fetchJson('/api/me'))?.user || null;
  showAccount(user);
  if (locked) for (const el of document.querySelectorAll('[data-private-note]')) el.hidden = false;
  return user;
}

const fetchJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function showAccount(user) {
  const el = document.getElementById('account');
  if (!el) return;
  // On phones the header has no room for these, so the menu gets them too.
  const navAccount = document.getElementById('navAccount');
  if (navAccount) {
    navAccount.innerHTML = user
      ? '<a href="/account">Your account</a><a href="/keys">API keys</a><button type="button" class="nav-signout">Sign out</button>'
      : '<a href="/signin">Sign in</a><a href="/signup">Sign up</a>';
    navAccount.querySelector('.nav-signout')?.addEventListener('click', signOut);
  }
  if (!user) {
    el.innerHTML = '<a class="btn ghost small" href="/signin">Sign in</a><a class="btn small" href="/signup">Sign up</a>';
    return;
  }
  const badge = user.requests ? `<span class="badge" title="${user.requests} contact request${user.requests > 1 ? 's' : ''}">${user.requests}</span>` : '';
  el.innerHTML = `<a class="me" href="/account${user.requests ? '#contacts' : ''}" title="Your account (@${esc(user.username)})">
      <span class="avatar" style="--c:${esc(user.color)};margin:0">${avatarContent(user)}</span>${badge}
      <span class="name">${esc(user.displayName)}</span>
    </a>
    <a class="btn ghost small" href="/keys">API keys</a>
    <button class="btn ghost small" type="button" id="signOut">Sign out</button>`;
  document.getElementById('signOut').addEventListener('click', signOut);
}

async function signOut() {
  await fetch('/api/signout', { method: 'POST' }).catch(() => {});
  location.reload();
}

// On narrow screens the page links fold into a menu button.
function bindMenu() {
  const btn = document.getElementById('menuBtn');
  const nav = document.getElementById('siteNav');
  if (!btn || !nav) return;
  const set = (open) => { nav.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', () => set(!nav.classList.contains('open')));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('open')) { set(false); btn.focus(); } });
  document.addEventListener('click', (e) => { if (!e.target.closest('#siteNav, #menuBtn')) set(false); });
}

// Sections fade in as they scroll into view (skipped for people who prefer less motion).
function revealOnScroll() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length || !('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.documentElement.classList.add('will-reveal');
  const io = new IntersectionObserver((entries) => {
    // Also show anything already scrolled past (a jump to /#faq skips over sections).
    for (const e of entries) if (e.isIntersecting || e.boundingClientRect.top < 0) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  items.forEach((el) => io.observe(el));
}
