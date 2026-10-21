// Shared by the home page, the room and the sign-up preview.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// First letter of a name, uppercased. [...s] keeps emoji in one piece.
export const firstLetter = (name) => ([...String(name || '').trim()][0] || '?').toUpperCase();

// What goes inside an avatar circle: the person's picture, or their first letter.
// The circle's background comes from the --c CSS variable (their color).
export function avatarContent(user) {
  return user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(firstLetter(user.displayName ?? user.name));
}
