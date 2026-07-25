// Where checkpoints live: a store is four functions over keys and strings, so
// a file tree, a database table, or a test's map all serve.
//
// A checkpoint is already a JSON string and a verdict is one word, so storage
// needs nothing richer than put/get/delete/has. Implementations follow the
// package's closure rule: a store's functions capture configuration (a
// directory, a table name) and call top-level functions by name.
//
// The database implementation lives with the database package — the pgvector
// package can back this with a table — so this file defines the contract and
// the two backends with no dependencies: files and memory.

export type CheckpointStore = {
  put: (key: string, value: string) => bool,
  get: (key: string) => string,
  del: (key: string) => bool,
  has: (key: string) => bool,
};

// --- files --------------------------------------------------------------------

function fileStorePath(dir: string, key: string): string {
  return dir + "/" + key;
}

function fileStorePut(dir: string, key: string, value: string): bool {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir); }
  fs.writeFileSync(fileStorePath(dir, key), value);
  return true;
}

function fileStoreGet(dir: string, key: string): string {
  let path = fileStorePath(dir, key);
  if (!fs.existsSync(path)) { return ""; }
  return fs.readFileSync(path);
}

function fileStoreDel(dir: string, key: string): bool {
  let path = fileStorePath(dir, key);
  if (!fs.existsSync(path)) { return false; }
  fs.unlinkSync(path);
  return true;
}

function fileStoreHas(dir: string, key: string): bool {
  return fs.existsSync(fileStorePath(dir, key));
}

// Checkpoints as files under a directory. Keys become file names, so they are
// restricted to names that cannot escape the directory: letters, digits,
// dashes, underscores and dots, and never a path separator.
export function fileCheckpointStore(dir: string): CheckpointStore {
  let store: CheckpointStore = {
    put: (key: string, value: string) => {
      if (!storeKeyOk(key)) { return false; }
      return fileStorePut(dir, key, value);
    },
    get: (key: string) => {
      if (!storeKeyOk(key)) { return ""; }
      return fileStoreGet(dir, key);
    },
    del: (key: string) => {
      if (!storeKeyOk(key)) { return false; }
      return fileStoreDel(dir, key);
    },
    has: (key: string) => {
      if (!storeKeyOk(key)) { return false; }
      return fileStoreHas(dir, key);
    },
  };
  return store;
}

// A key that is safe as a file name and as a database key alike.
export function storeKeyOk(key: string): bool {
  if (key.length == 0 || key.length > 200) { return false; }
  let i: int = 0;
  while (i < key.length) {
    let c = key.charCodeAt(i);
    let isLower = c >= 97 && c <= 122;
    let isUpper = c >= 65 && c <= 90;
    let isDigit = c >= 48 && c <= 57;
    let isSep = c == 45 || c == 95 || c == 46;
    if (!(isLower || isUpper || isDigit || isSep)) { return false; }
    i = i + 1;
  }
  if (key.startsWith(".")) { return false; }
  return true;
}

// --- memory --------------------------------------------------------------------

// A map-backed store for tests and single-process runs. The map is shared by
// the four functions through capture, which is read-only capture of a heap
// value — mutation through a Map is visible, as the language defines.
export function memoryCheckpointStore(): CheckpointStore {
  let entries = new Map<string, string>();
  let store: CheckpointStore = {
    put: (key: string, value: string) => {
      entries.set(key, value);
      return true;
    },
    get: (key: string) => {
      return entries.get(key) ?? "";
    },
    del: (key: string) => {
      if (!entries.has(key)) { return false; }
      entries.delete(key);
      return true;
    },
    has: (key: string) => {
      return entries.has(key);
    },
  };
  return store;
}
