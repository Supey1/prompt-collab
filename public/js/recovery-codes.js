import { copyText } from './clipboard.js';

// Shows freshly made recovery codes with Copy all / Download buttons.
// Used after sign-up and on the account page. Codes are only ever shown once.
export function showRecoveryCodes(container, codes, username) {
  const text = `PromptCollab recovery codes for @${username}\n` +
    'Each code works once. Use one on the sign-in page ("Forgot password?") to set a new password.\n\n' +
    codes.join('\n') + '\n';
  container.innerHTML = `
    <ol class="codes" aria-label="Recovery codes">${codes.map((c) => `<li><code>${c}</code></li>`).join('')}</ol>
    <div class="key-actions">
      <button class="btn ghost small" type="button" data-codes-copy>Copy all</button>
      <button class="btn ghost small" type="button" data-codes-download>Download as .txt</button>
    </div>`;
  container.querySelector('[data-codes-copy]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.textContent = (await copyText(text)) ? 'Copied!' : 'Copy failed: download instead';
    setTimeout(() => { btn.textContent = 'Copy all'; }, 1800);
  });
  container.querySelector('[data-codes-download]').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `promptcollab-recovery-codes-${username}.txt` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
