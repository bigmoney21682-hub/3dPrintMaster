/**
 * Local project library on IndexedDB.
 *
 * Everything — photos, masks, finished STLs — lives on the device. That is what
 * lets the whole app be a static site on GitHub Pages with no backend, and it
 * means your photos never leave your phone.
 */

import type { SegmentOptions } from './segment';
import type { CarveOptions } from './carve';
import type { HeightfieldOptions } from './heightfield';

const DB_NAME = '3dprintmaster';
const DB_VERSION = 1;

export type ProjectMode = 'scan' | 'relief';

export interface Project {
  id: string;
  name: string;
  notes: string;
  mode: ProjectMode;
  createdAt: number;
  updatedAt: number;
  sweepDeg: number;
  carve: Partial<CarveOptions>;
  heightfield: Partial<HeightfieldOptions>;
  segment: Partial<SegmentOptions>;
  targetSizeMm: number;
}

export interface Photo {
  id: string;
  projectId: string;
  order: number;
  angleDeg: number;
  blob: Blob;
  thumb: Blob;
  width: number;
  height: number;
  createdAt: number;
  /** Per-photo tweaks layered on top of the project defaults. */
  segment?: Partial<SegmentOptions>;
  /** Painted overrides at the working resolution: 0 none, 1 keep, 2 remove. */
  paint?: { width: number; height: number; data: Uint8Array };
  excluded?: boolean;
}

export interface ModelRecord {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  stl: Blob;
  triangles: number;
  sizeMm: [number, number, number];
  method: string;
  photoCount: number;
  preview?: Blob;
  params: Record<string, unknown>;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('models')) {
        const store = db.createObjectStore('models', { keyPath: 'id' });
        store.createIndex('projectId', 'projectId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

function allFromIndex<T>(store: string, index: string, key: IDBValidKey): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const t = db.transaction(store, 'readonly');
        const req = t.objectStore(store).index(index).getAll(key);
        req.onsuccess = () => resolve(req.result as T[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function listProjects(): Promise<Project[]> {
  const all = await tx<Project[]>('projects', 'readonly', (s) => s.getAll());
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getProject(id: string): Promise<Project | undefined> {
  return tx<Project | undefined>('projects', 'readonly', (s) => s.get(id));
}

export async function saveProject(project: Project): Promise<Project> {
  const next = { ...project, updatedAt: Date.now() };
  await tx('projects', 'readwrite', (s) => s.put(next));
  return next;
}

export async function deleteProject(id: string): Promise<void> {
  const [photos, models] = await Promise.all([listPhotos(id), listModels(id)]);
  await Promise.all(photos.map((p) => deletePhoto(p.id)));
  await Promise.all(models.map((m) => deleteModel(m.id)));
  await tx('projects', 'readwrite', (s) => s.delete(id));
}

export async function listPhotos(projectId: string): Promise<Photo[]> {
  const photos = await allFromIndex<Photo>('photos', 'projectId', projectId);
  return photos.sort((a, b) => a.order - b.order);
}

export async function savePhoto(photo: Photo): Promise<void> {
  await tx('photos', 'readwrite', (s) => s.put(photo));
}

export async function deletePhoto(id: string): Promise<void> {
  await tx('photos', 'readwrite', (s) => s.delete(id));
}

export async function listModels(projectId: string): Promise<ModelRecord[]> {
  const models = await allFromIndex<ModelRecord>('models', 'projectId', projectId);
  return models.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveModel(model: ModelRecord): Promise<void> {
  await tx('models', 'readwrite', (s) => s.put(model));
}

export async function deleteModel(id: string): Promise<void> {
  await tx('models', 'readwrite', (s) => s.delete(id));
}

export function createProject(name: string, mode: ProjectMode): Project {
  const now = Date.now();
  return {
    id: newId('prj'),
    name: name.trim() || 'Untitled project',
    notes: '',
    mode,
    createdAt: now,
    updatedAt: now,
    sweepDeg: 360,
    carve: {},
    heightfield: {},
    segment: {},
    targetSizeMm: 60,
  };
}

/** Ask the browser not to evict the library when storage gets tight. */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
