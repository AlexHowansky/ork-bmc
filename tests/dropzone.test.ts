/**
 * The drag-and-drop half of `public/app.js`.
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

beforeAll(async () => {
  const globals = globalThis as Record<string, unknown>;
  globals['document'] = {
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    // Only consulted to decide whether a stray drop should be swallowed.
    querySelector: () => zone,
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
