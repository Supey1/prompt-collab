// When free messages reset, in the viewer's own time zone.
// resetsAt is an ISO time from the server (the next midnight UTC).

// "7:00 PM", or "Tue 7:00 PM" if it isn't today where you are.
export function resetClock(resetsAt) {
  const at = new Date(resetsAt);
  const sameDay = at.toDateString() === new Date().toDateString();
  return at.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// "6 h 12 min", "45 min", or "less than a minute".
export function resetCountdown(resetsAt) {
  const mins = Math.max(0, Math.ceil((new Date(resetsAt) - Date.now()) / 60000));
  if (mins < 1) return 'less than a minute';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

// "at 7:00 PM your time (in 6 h 12 min)"
export const resetPhrase = (resetsAt) => `at ${resetClock(resetsAt)} your time (in ${resetCountdown(resetsAt)})`;
