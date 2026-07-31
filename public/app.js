/**
 * Progressive enhancement. Everything here is optional: with JavaScript
 * disabled the app is fully usable, and the server has already rendered the
 * correct theme, so there is never a flash of the wrong one.
 *
 *   - Theme toggle switches in-page instead of round-tripping.
 *   - Delete buttons ask for confirmation first.
 *   - Choosing a file names the map after it. The server derives the same name
 *     from a blank field, so this only makes it visible sooner.
 *
 * Loaded from same-origin so the strict `script-src 'self'` CSP allows it.
 */
(function () {
  'use strict';

  var ORDER = ['system', 'light', 'dark'];
  var LABELS = { system: 'System theme', light: 'Light theme', dark: 'Dark theme' };
  var ICONS = { system: '🖥️', light: '☀️', dark: '🌙' };

  function currentTheme() {
    var match = /(?:^|;\s*)bm_theme=(light|dark)(?:;|$)/.exec(document.cookie);
    return match ? match[1] : 'system';
  }

  function persist(theme) {
    var base = ';path=/;max-age=31536000;samesite=lax' + (location.protocol === 'https:' ? ';secure' : '');
    if (theme === 'system') {
      document.cookie = 'bm_theme=;path=/;max-age=0';
    } else {
      document.cookie = 'bm_theme=' + theme + base;
    }
  }

  function apply(theme) {
    var root = document.documentElement;
    root.classList.remove('light', 'dark');
    if (theme !== 'system') root.classList.add(theme);
  }

  // Mirrors `nameFromFilename` in src/models/maps.ts, which is the authority:
  // the server applies the same rule to a name left blank. Keep the two in step.
  function nameFromFilename(filename) {
    var base = filename.split(/[\\/]/).pop() || '';
    var stem = base.replace(/\.[^.]+$/, '') || base;
    return stem
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\s+|\s+$/g, '')
      .replace(/(^|\s)(\S)/g, function (match, lead, first) {
        return lead + first.toUpperCase();
      })
      .slice(0, 200)
      .replace(/^\s+|\s+$/g, '');
  }

  document.addEventListener('change', function (event) {
    var input = event.target;
    if (!input || !input.hasAttribute || !input.hasAttribute('data-name-from-file')) return;

    var field = input.form && input.form.querySelector('input[name="name"]');
    var file = input.files && input.files[0];
    if (!field || !file) return;

    // Only fill a field that is empty or still holds what this handler last
    // wrote — a name the admin typed is theirs, and picking a second file
    // should still follow the file.
    if (field.value !== '' && field.value !== field.getAttribute('data-autofilled')) return;

    field.value = nameFromFilename(file.name);
    field.setAttribute('data-autofilled', field.value);
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.hasAttribute) return;

    // Deleting a map is irreversible and the button sits next to Edit, so make
    // it deliberate. The server does not rely on this — it is a courtesy.
    if (form.hasAttribute('data-confirm-delete')) {
      if (!window.confirm('Delete this map permanently? This cannot be undone.')) {
        event.preventDefault();
      }
      return;
    }

    if (!form.hasAttribute('data-theme-toggle')) return;

    event.preventDefault();

    var next = ORDER[(ORDER.indexOf(currentTheme()) + 1) % ORDER.length];
    persist(next);
    apply(next);

    // Keep the button's label, icon and next-value in step with the new state.
    var following = ORDER[(ORDER.indexOf(next) + 1) % ORDER.length];
    var hidden = form.querySelector('input[name="theme"]');
    if (hidden) hidden.value = following;

    var button = form.querySelector('button');
    if (button) {
      button.title = 'Switch to ' + LABELS[following].toLowerCase();
      button.setAttribute(
        'aria-label',
        'Current: ' + LABELS[next].toLowerCase() + '. Switch to ' + LABELS[following].toLowerCase() + '.',
      );
      var icon = button.querySelector('span[aria-hidden="true"]');
      if (icon) icon.textContent = ICONS[next];
      var text = button.querySelector('span:not([aria-hidden])');
      if (text) text.textContent = LABELS[next];
    }
  });
})();
