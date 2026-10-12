// Light/dark toggle that remembers the choice per browser.
const KEY = 'pc-theme';
const get = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const set = (v) => { try { localStorage.setItem(KEY, v); } catch { /* ignore */ } };

const saved = get();
if (saved) document.documentElement.dataset.theme = saved;

export function bindThemeToggle(btn) {
  if (!btn) return;
  btn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    set(next);
  });
}
