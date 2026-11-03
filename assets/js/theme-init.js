// Apply the saved or system theme before first paint to avoid a light/dark flash.
(function () {
  var t = null;
  try { t = localStorage.getItem('cms-theme'); } catch (e) {}
  if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
})();
