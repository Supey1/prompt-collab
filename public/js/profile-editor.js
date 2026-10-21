import { firstLetter } from './avatar.js';

// The display name + color + letter-or-picture controls, shared by the
// sign-up page and the account page. Both use the same element ids.
const $ = (id) => document.getElementById(id);
const COLORS = ['#3d6bff', '#e8457c', '#13a57a', '#d98a00', '#8b5cf6', '#0e9fbf', '#e4572e', '#4a5468'];

// Show each message under its field (by data-for) and focus the first bad field.
export function setErrors(errors, scope = document) {
  scope.querySelectorAll('.field-error').forEach((el) => { el.textContent = errors[el.dataset.for] || ''; });
  scope.querySelectorAll('input[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  for (const field of Object.keys(errors)) $(field)?.setAttribute('aria-invalid', 'true');
  const first = Object.keys(errors).find((f) => $(f));
  if (first) $(first).focus();
}

// `initial` is the current profile on the account page; empty on sign-up.
// Returns a live object: { color, mode, picture } where picture is a new
// upload (data: URL) or the current picture's URL.
export function setupProfileEditor(initial = {}) {
  const state = {
    color: initial.color || COLORS[Math.floor(Math.random() * COLORS.length)],
    mode: initial.avatar ? 'picture' : 'letter',
    picture: initial.avatar || null,
    changedPicture: false,
  };
  if (initial.displayName) $('displayName').value = initial.displayName;
  document.querySelector(`input[name=avatarMode][value=${state.mode}]`).checked = true;

  // Color swatches, plus a rainbow one that opens the system color picker for any color.
  $('colorSwatches').innerHTML = COLORS.map((c) =>
    `<button type="button" class="swatch" role="radio" style="--c:${c}" data-c="${c}" aria-label="Color ${c}"></button>`
  ).join('') + `<label class="swatch custom" title="Any color"><input type="color" id="customColor" aria-label="Choose any color"></label>`;
  $('colorSwatches').addEventListener('click', (e) => {
    const b = e.target.closest('button.swatch');
    if (b) { state.color = b.dataset.c; render(); }
  });
  $('customColor').addEventListener('input', (e) => { state.color = e.target.value; render(); });

  document.querySelectorAll('input[name=avatarMode]').forEach((r) => r.addEventListener('change', () => {
    state.mode = document.querySelector('input[name=avatarMode]:checked').value;
    render();
  }));
  $('displayName').addEventListener('input', render);

  $('avatarFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      state.picture = await shrinkPicture(file);
      state.changedPicture = true;
      $('fileName').textContent = file.name;
      setErrors({}, $('avatarFile').closest('form'));
    } catch {
      setErrors({ avatar: "That file couldn't be read as a picture. Try a PNG or JPG." }, $('avatarFile').closest('form'));
    }
    render();
  });

  // Live preview of what teammates will see.
  function render() {
    $('pictureControls').hidden = state.mode !== 'picture';
    const preview = $('avatarPreview');
    preview.style.setProperty('--c', state.color);
    preview.classList.toggle('empty', state.mode === 'picture' && !state.picture);
    if (state.mode === 'picture') {
      preview.innerHTML = state.picture ? `<img src="${state.picture}" alt="">` : 'No picture';
    } else {
      preview.textContent = firstLetter($('displayName').value);
    }
    const custom = !COLORS.includes(state.color);
    document.querySelectorAll('#colorSwatches button.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.c === state.color)));
    const customSwatch = document.querySelector('.swatch.custom');
    customSwatch.setAttribute('aria-checked', String(custom));
    customSwatch.style.setProperty('--c', custom ? state.color : 'transparent');
    $('customColor').value = state.color;
  }
  render();
  return state;
}

// Crop a picture to a centered square and shrink it to 160×160, so uploads stay small.
async function shrinkPicture(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const size = 160;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // JPEG has no transparency
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.88);
  } finally {
    URL.revokeObjectURL(url);
  }
}
