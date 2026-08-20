/**
 * The receiving half of the channel-launch banner.
 *
 * The menu grows a full-screen banner over itself, stores its look in
 * sessionStorage, and navigates. The game page calls this first thing: it
 * re-creates the identical banner instantly (before the game has even built
 * its scene), holds a beat, and fades it out — so the launch reads as one
 * continuous motion across the page navigation, with no flash between.
 */
/**
 * Leave a game for the menu, the console way: the game fades to the menu's
 * silver, and the menu (see menu.js) fades in from the same silver with the
 * HOME chime and the theme starting together. The chime deliberately rings
 * on the MENU side: a game page's audio context is usually still suspended
 * (no local gesture ever happened there), so playing here was silently
 * dropped — and navigation would cut it off anyway.
 */
export function goHome() {
  if (goHome.leaving) return;
  goHome.leaving = true;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:#e4eaf1;opacity:0;'
    + 'transition:opacity .5s ease;z-index:999;pointer-events:none;';
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.opacity = '1'; });
  try { sessionStorage.setItem('openwii.home', String(Date.now())); } catch { /* fine */ }
  setTimeout(() => { window.location.href = '/'; }, 800);
}

export function consumeLaunchSplash() {
  let data;
  try {
    const raw = sessionStorage.getItem('openwii.launch');
    if (!raw) return;
    sessionStorage.removeItem('openwii.launch');
    data = JSON.parse(raw);
  } catch {
    return;
  }
  // Stale or for a different channel (back button, manual URL): skip.
  if (!data || Date.now() - (data.t || 0) > 4000) return;
  if (!window.location.pathname.includes(`/games/${data.slug}/`)) return;

  const el = document.createElement('div');
  el.innerHTML = `<div style="font-size:17vmin;filter:drop-shadow(0 1.2vmin 2.5vmin rgba(0,0,0,.3))">${data.emoji}</div>`
    + `<div style="font-size:5vmin;font-weight:700;color:#fff;text-shadow:0 .3vmin 1.2vmin rgba(0,0,0,.45)">${data.title}</div>`;
  el.style.cssText = 'position:fixed;inset:0;z-index:99;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:2vmin;'
    + `background:linear-gradient(180deg, ${data.c0}, ${data.c1});`
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
    + 'transition:opacity .35s ease;pointer-events:none;';
  document.body.appendChild(el);

  // Hold just long enough for the game underneath to render its first frame.
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 450);
  }, 300);
}
