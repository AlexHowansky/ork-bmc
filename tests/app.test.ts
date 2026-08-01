/**
 * The handlers in `public/app.js`.
 *
 * There is no browser or DOM library here and it is not worth a dependency for
 * one script, so the handlers are driven against the smallest stub that satisfies
 * what they actually touch: `closest`, `classList`, `querySelector` and
 * `dispatchEvent`. That keeps this honest about the wiring — which classes get
 * toggled, what reaches the file input, what is refused — without pretending to
 * test the browser's own drag machinery.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

type Handler = (event: unknown) => void;

const handlers: Record<string, Handler> = {};
const dispatched: string[] = [];
const message = { textContent: '' };

const fileInput = {
  files: null as { length: number } | null,
  getAttribute: (name: string) => (name === 'accept' ? 'image/png,image/jpeg,image/webp' : null),
  dispatchEvent: (event: { type: string }) => dispatched.push(event.type),
};

const classes = new Set<string>();

const zone = {
  classList: {
    add: (name: string) => classes.add(name),
    remove: (name: string) => classes.delete(name),
  },
  getAttribute: (name: string) =>
    name === 'data-dropzone-active' ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30' : null,
  querySelector: (selector: string) => (selector === 'input[type="file"]' ? fileInput : message),
  contains: () => false,
  closest: (selector: string) => (selector === '[data-dropzone]' ? zone : null),
};

/** A drag event carrying files, aimed at the drop zone unless told otherwise. */
function dragEvent(files: { name: string; type: string }[], target: unknown = zone) {
  return {
    target,
    relatedTarget: null,
    dataTransfer: { types: ['Files'], files, dropEffect: '' },
    prevented: false,
    preventDefault(this: { prevented: boolean }) {
      this.prevented = true;
    },
  };
}

const png = { name: 'sunken_temple.png', type: 'image/png' };

/** The checkbox that CSS uses to hold the full-size map view open. */
const lightbox = { checked: false };

/** A `<time data-local-time>` as the script sees it. */
function makeTimestamp(datetime: string | null, text: string) {
  return {
    textContent: text,
    title: '',
    getAttribute: (name: string) => (name === 'datetime' ? datetime : null),
  };
}

/**
 * Timestamps are restated when the script loads rather than on an event, so the
 * whole set has to be in place before the import below.
 */
const timestamps = [
  makeTimestamp('2026-07-31T14:23:05.000Z', '2026-07-31 14:23 UTC'),
  makeTimestamp('not a date at all', '2026-07-31 14:23 UTC'),
  makeTimestamp(null, 'no datetime attribute'),
];

beforeAll(async () => {
  const globals = globalThis as Record<string, unknown>;
  globals['document'] = {
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    querySelector: (selector: string) => {
      if (selector.indexOf('data-lightbox-toggle') !== -1) return lightbox.checked ? lightbox : null;
      // Otherwise: is there a drop zone on this page at all?
      return zone;
    },
    querySelectorAll: (selector: string) => (selector === '[data-local-time]' ? timestamps : []),
  };
  globals['Event'] = class {
    constructor(public type: string) {}
  };
  globals['DataTransfer'] = class {
    files: unknown[] = [];
    items = {
      add: (file: unknown) => {
        this.files.push(file);
      },
    };
  };

  await import('../public/app.js');
});

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  delete globals['document'];
  delete globals['Event'];
  delete globals['DataTransfer'];
});

function reset(): void {
  classes.clear();
  dispatched.length = 0;
  message.textContent = '';
  fileInput.files = null;
}

describe('the upload drop zone', () => {
  test('claims the drag and highlights with the classes the markup supplies', () => {
    reset();
    const event = dragEvent([]);
    handlers['dragover']!(event);

    // Without preventDefault the browser keeps the drop and opens the file.
    expect(event.prevented).toBe(true);
    expect(event.dataTransfer.dropEffect).toBe('copy');
    expect([...classes]).toEqual(['border-amber-500', 'bg-amber-50', 'dark:bg-amber-950/30']);

    handlers['dragleave']!(dragEvent([]));
    expect(classes.size).toBe(0);
  });

  test('hands a dropped image to the file input and wakes the name default', () => {
    reset();
    const event = dragEvent([png]);
    handlers['drop']!(event);

    expect(event.prevented).toBe(true);
    expect(fileInput.files).toHaveLength(1);
    // Assigning `files` fires nothing on its own, so the name-from-file handler
    // would never see the drop without this.
    expect(dispatched).toEqual(['change']);
    expect(message.textContent).toBe('');
    expect(classes.size).toBe(0);
  });

  test('refuses a file the form does not accept, and says which', () => {
    reset();
    handlers['drop']!(dragEvent([{ name: 'rules.pdf', type: 'application/pdf' }]));

    expect(fileInput.files).toBeNull();
    expect(dispatched).toEqual([]);
    expect(message.textContent).toContain('rules.pdf');
  });

  test('passes a file of unknown type on for the server to judge', () => {
    reset();
    handlers['drop']!(dragEvent([{ name: 'map', type: '' }]));

    expect(fileInput.files).toHaveLength(1);
  });

  test('takes the first of several files rather than dropping them silently', () => {
    reset();
    handlers['drop']!(dragEvent([png, { name: 'second.png', type: 'image/png' }]));

    expect(fileInput.files).toHaveLength(1);
    expect(message.textContent).toContain(png.name);
  });

  test('swallows a drop that misses the box, so the form is not navigated away', () => {
    reset();
    const event = dragEvent([png], { closest: () => null });
    handlers['drop']!(event);

    expect(event.prevented).toBe(true);
    expect(fileInput.files).toBeNull();
  });
});

/** A stand-in for one text input on the upload form. */
function makeField(value = '') {
  return {
    value,
    attrs: {} as Record<string, string>,
    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    },
    setAttribute(name: string, next: string) {
      this.attrs[name] = next;
    },
  };
}

describe('choosing a file', () => {
  type Field = ReturnType<typeof makeField>;
  let fields: Record<string, Field>;

  /** Fires the file input's change event with a chosen filename. */
  function choose(filename: string, typed: Partial<Record<string, string>> = {}): void {
    fields = {
      name: makeField(typed['name'] ?? ''),
      gridSize: makeField(typed['gridSize'] ?? ''),
      gridWidth: makeField(typed['gridWidth'] ?? ''),
      gridHeight: makeField(typed['gridHeight'] ?? ''),
    };

    const form = {
      querySelector: (selector: string) => {
        const match = /input\[name="(\w+)"\]/.exec(selector);
        return match ? (fields[match[1]!] ?? null) : null;
      },
    };

    handlers['change']!({
      target: {
        hasAttribute: (name: string) => name === 'data-name-from-file',
        form,
        files: [{ name: filename }],
      },
    });
  }

  test('names the map after the file', () => {
    choose('sunken_temple.png');
    expect(fields['name']!.value).toBe('Sunken Temple');
  });

  test('takes square counts out of the file name, and leaves them out of it', () => {
    choose('Forest Road 40x30.png');

    expect(fields['name']!.value).toBe('Forest Road');
    expect(fields['gridWidth']!.value).toBe('40');
    expect(fields['gridHeight']!.value).toBe('30');
    // Derived, not measured: the size is still for the admin or the image to say.
    expect(fields['gridSize']!.value).toBe('');
  });

  test('reads a resolution as part of the name, not as a grid', () => {
    choose('Riverbank 1920x1080.png');

    expect(fields['name']!.value).toBe('Riverbank 1920x1080');
    expect(fields['gridWidth']!.value).toBe('');
  });

  test('leaves the grid alone once anything has been typed into it', () => {
    choose('Forest Road 40x30.png', { gridSize: '70' });

    expect(fields['gridWidth']!.value).toBe('');
    expect(fields['gridHeight']!.value).toBe('');
    // The name is a separate field and still fills in.
    expect(fields['name']!.value).toBe('Forest Road');
  });

  test('never clobbers a name the admin typed', () => {
    choose('Forest Road 40x30.png', { name: 'Mine, thanks' });

    expect(fields['name']!.value).toBe('Mine, thanks');
    // The grid was still untouched, so it is still offered.
    expect(fields['gridWidth']!.value).toBe('40');
  });
});

describe('timestamps', () => {
  test('are restated in the reader’s own time zone, keeping UTC on the title', () => {
    const restated = timestamps[0]!;

    // Not the UTC text any more, and it is the same moment: the suite runs in
    // whatever zone the machine is set to, so assert the instant, not a string.
    expect(restated.textContent).not.toBe('2026-07-31 14:23 UTC');
    expect(restated.title).toBe('2026-07-31 14:23 UTC');
    expect(new Date('2026-07-31T14:23:05.000Z').toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })).toBe(restated.textContent);
  });

  test('are left alone when the attribute is unusable', () => {
    // A bad value, and a missing one — `new Date(null)` is 1970, not an error,
    // so restating that would quietly invent a date.
    expect(timestamps[1]!.textContent).toBe('2026-07-31 14:23 UTC');
    expect(timestamps[2]!.textContent).toBe('no datetime attribute');
    expect(timestamps[2]!.title).toBe('');
  });
});

describe('the full-size map view', () => {
  test('closes on Escape', () => {
    lightbox.checked = true;
    handlers['keydown']!({ key: 'Escape' });

    expect(lightbox.checked).toBe(false);
  });

  test('ignores any other key', () => {
    lightbox.checked = true;
    handlers['keydown']!({ key: 'Enter' });

    expect(lightbox.checked).toBe(true);
    lightbox.checked = false;
  });

  test('does not mind Escape when nothing is open', () => {
    expect(() => handlers['keydown']!({ key: 'Escape' })).not.toThrow();
  });
});
