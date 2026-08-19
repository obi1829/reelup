(function () {
  // Apply cached theme + palette before first paint (settings load later via IPC).
  try {
    var validPalettes = { midnight: 1, ember: 1, forest: 1, dusk: 1 };
    var ct = localStorage.getItem('reelup-theme');
    var cp = localStorage.getItem('reelup-palette');
    if (ct === 'light' || ct === 'dark') document.documentElement.setAttribute('data-theme', ct);
    if (cp && validPalettes[cp]) document.documentElement.setAttribute('data-palette', cp);
  } catch (e) { /* localStorage unavailable (private mode, quota); keep default theme */ }
})();
