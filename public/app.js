/**
 * Progressive enhancement. Everything here is optional: with JavaScript
 * disabled the app is fully usable, and the server has already rendered the
 * correct theme, so there is never a flash of the wrong one.
 *
 *   - Theme toggle switches in-page instead of round-tripping.
 *   - Delete buttons ask for confirmation first.
 *   - Choosing a file names the map after it, and fills in square counts written
 *     into the file name. The server derives both from the file it receives, so
 *     this only makes them visible sooner.
 *   - The upload box accepts a dragged file, handing it to the ordinary file
 *     input so the form still posts in exactly the same way.
 *   - Escape closes the full-size map view, which otherwise opens and closes
 *     entirely in CSS.
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

  // Mirrors `gridFromFilename` in src/images/grid.ts — including the bounds,
  // which are what stop "Riverbank 1920x1080.png" being read as a grid.
  var GRID_PATTERN = /(?<![\d.])(\d{1,4})\s*[xX\u00d7]\s*(\d{1,4})(?![\d.])/;
  var MIN_SQUARES = 3;
  var MAX_SQUARES = 200;

  function gridFromFilename(filename) {
    var base = filename.split(/[\\/]/).pop() || '';
    var stem = base.replace(/\.[^.]+$/, '') || base;
    var match = GRID_PATTERN.exec(stem);
    if (!match) return null;

    var width = Number(match[1]);
    var height = Number(match[2]);
    var plausible = function (count) {
      return count >= MIN_SQUARES && count <= MAX_SQUARES;
    };
    return plausible(width) && plausible(height) ? { width: width, height: height } : null;
  }

  // Mirrors `nameFromFilename` in src/models/maps.ts, which is the authority:
  // the server applies the same rule to a name left blank. Keep the two in step.
  function nameFromFilename(filename) {
    var base = filename.split(/[\\/]/).pop() || '';
    var stem = base.replace(/\.[^.]+$/, '') || base;

    // Square counts belong to the grid fields, so they are not repeated in the
    // name — unless they were the whole of it.
    if (gridFromFilename(stem)) {
      var stripped = stem.replace(GRID_PATTERN, ' ').replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ');
      if (stripped.replace(/^\s+|\s+$/g, '') !== '') stem = stripped;
    }

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

    var file = input.files && input.files[0];
    if (!input.form || !file) return;

    // The name and the grid are filled in independently, exactly as the server
    // does it: typing a name of your own is no reason to be denied the grid.
    fillName(input.form, file.name);
    fillGrid(input.form, file.name);
  });

  /**
   * True for a field that is empty, or still holds what this script last wrote.
   * Anything the admin typed is theirs and is never overwritten; picking a
   * second file does still follow the new file.
   */
  function untouched(field) {
    return field.value === '' || field.value === field.getAttribute('data-autofilled');
  }

  function fillName(form, filename) {
    var field = form.querySelector('input[name="name"]');
    if (!field || !untouched(field)) return;

    field.value = nameFromFilename(filename);
    field.setAttribute('data-autofilled', field.value);
  }

  /**
   * Offers the square counts from the file name, but only when the whole grid
   * section is untouched — the same rule the server applies, so what is shown
   * here is what would have happened anyway.
   */
  function fillGrid(form, filename) {
    var size = form.querySelector('input[name="gridSize"]');
    var width = form.querySelector('input[name="gridWidth"]');
    var height = form.querySelector('input[name="gridHeight"]');
    if (!size || !width || !height) return;

    if (!untouched(size) || !untouched(width) || !untouched(height)) return;

    var grid = gridFromFilename(filename);
    if (!grid) return;

    width.value = String(grid.width);
    width.setAttribute('data-autofilled', width.value);
    height.value = String(grid.height);
    height.setAttribute('data-autofilled', height.value);
  }

  // The full-size map view is a checkbox and a label, so clicking closes it and
  // so does Space on the focused control. Escape is the one thing CSS cannot
  // offer, and it is what people reach for over a full-screen overlay.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;

    var open = document.querySelector('[data-lightbox-toggle]:checked');
    if (open) open.checked = false;
  });

  // -------------------------------------------------------------------------
  // Drag and drop onto the upload box
  // -------------------------------------------------------------------------

  function dropZoneOf(target) {
    return target && target.closest ? target.closest('[data-dropzone]') : null;
  }

  /** Whether the drag carries files, as opposed to selected text or a link. */
  function carriesFiles(transfer) {
    if (!transfer) return false;
    var types = transfer.types || [];
    for (var i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  // The active class names live in src/views/ui.ts and ride along in a data
  // attribute, so this file never spells out a Tailwind class of its own.
  function highlight(zone, on) {
    var names = (zone.getAttribute('data-dropzone-active') || '').split(/\s+/);
    for (var i = 0; i < names.length; i++) {
      if (!names[i]) continue;
      if (on) zone.classList.add(names[i]);
      else zone.classList.remove(names[i]);
    }
  }

  function say(zone, message) {
    var element = zone.querySelector('[data-dropzone-message]');
    if (element) element.textContent = message;
  }

  document.addEventListener('dragover', function (event) {
    if (!carriesFiles(event.dataTransfer)) return;

    var zone = dropZoneOf(event.target);
    // Missing the box would otherwise navigate away to the dropped file and
    // take the half-filled form with it, so swallow those drags too.
    if (!zone) {
      if (document.querySelector('[data-dropzone]')) event.preventDefault();
      return;
    }

    // Without this the browser keeps the drop for itself.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    highlight(zone, true);
  });

  document.addEventListener('dragleave', function (event) {
    var zone = dropZoneOf(event.target);
    // Crossing between the box's own children fires dragleave as well, so only
    // react when the pointer has actually left the box.
    if (!zone || (event.relatedTarget && zone.contains(event.relatedTarget))) return;
    highlight(zone, false);
  });

  document.addEventListener('drop', function (event) {
    if (!carriesFiles(event.dataTransfer)) return;

    var zone = dropZoneOf(event.target);
    if (!zone) {
      if (document.querySelector('[data-dropzone]')) event.preventDefault();
      return;
    }

    event.preventDefault();
    highlight(zone, false);

    var input = zone.querySelector('input[type="file"]');
    var file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (!input || !file) return;

    // One map per upload; a second file would silently be ignored otherwise.
    if (event.dataTransfer.files.length > 1) {
      say(zone, 'Only one file at a time — using “' + file.name + '”.');
    } else {
      say(zone, '');
    }

    // An empty type means the browser could not tell; let the server decide
    // rather than refuse a file it would have accepted.
    var accepted = (input.getAttribute('accept') || '').replace(/\s+/g, '').split(',');
    if (file.type !== '' && accepted.indexOf(file.type) === -1) {
      say(zone, '“' + file.name + '” is not a PNG, JPG or WEBP image.');
      return;
    }

    try {
      var transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
    } catch (error) {
      say(zone, 'This browser will not accept a dropped file — please use the button instead.');
      return;
    }

    // Assigning `files` fires nothing, and the name-from-file handler above is
    // listening for a change.
    input.dispatchEvent(new Event('change', { bubbles: true }));
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
