/* views-keys.js (2026-11-10) — switch simpleStem views from any page:
   ⌥1 Performer · ⌥2 Librarian · ⌥3 MIDI · ⌥4 Desktop. Uses e.code so it
   works even though ⌥+digit types a symbol on a Mac keyboard. Also adds
   the shortcut to each view button's tooltip. */
(function () {
  const VIEWS = [['Digit1', '/', 'pb-performer'], ['Digit2', '/librarian', 'pb-librarian'],
                 ['Digit3', '/midi-console.html', 'pb-midi'], ['Digit4', '/desktop-proto.html', 'pb-desk']];
  const here = (url) => {
    const p = location.pathname.replace(/\.html$/, '');
    return url === '/' ? (p === '/' || p === '/index') : p === url.replace(/\.html$/, '');
  };
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const v = VIEWS.find(x => x[0] === e.code);
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    if (!here(v[1])) location.href = v[1];
  }, true);
  const tip = () => VIEWS.forEach(([code, , cls], n) => {
    document.querySelectorAll('#portals a.' + cls).forEach(a => {
      if (!/⌥\d/.test(a.title || '')) a.title = (a.title || a.textContent.trim()) + ' (⌥' + (n + 1) + ')';
    });
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tip); else tip();
})();
