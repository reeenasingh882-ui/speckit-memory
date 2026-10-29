// Type definitions for speckit-memory (generated from the JSDoc surface).
// The package is CommonJS; these declarations cover the programmatic API.

export type MemoryType = 'law' | 'history' | 'feature';
export type HistoryCategory = 'decisions' | 'worklogs' | 'bug-preventions';
export type FeatureKind = 'watchpoint' | 'open-question';

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  category: string | null;
  feature: string | null;
  title: string;
  filePath: string;
  created: string | null;
  updated: string | null;
  tags: string[];
  content: string;
  status: 'open' | 'resolved' | null;
  hash: string;
  wordCount: number;
}

export interface ListFilter {
  type?: MemoryType | null;
  category?: string | null;
  feature?: string | null;
  tag?: string | null;
  status?: string | null;
}

export interface AddInput {
  type: MemoryType;
  content?: string;
  contentFile?: string;
  title?: string;
  category?: string;
  feature?: string;
  kind?: FeatureKind | string;
  tags?: string[];
  id?: string;
  mcpType?: string;
  metadata?: Record<string, unknown>;
}

export declare class MemoryError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export declare class ImmutableLawError extends Error {
  id: string;
  constructor(id: string);
}

export declare class MemoryStore {
  constructor(rootDir: string);
  static open(rootDir?: string): MemoryStore;
  readonly rootDir: string;
  isInitialized(): boolean;
  init(): { created: string[] };
  add(input: AddInput): MemoryEntry;
  list(filter?: ListFilter): MemoryEntry[];
  get(id: string): MemoryEntry | null;
  update(id: string, patch?: { title?: string; content?: string; tags?: string[]; status?: string }): MemoryEntry;
  resolve(id: string): MemoryEntry;
  remove(id: string): MemoryEntry;
  scan(): MemoryEntry[];
  writeSynthesis(feature: string, body: string, meta?: Record<string, unknown>): string;
  close(): void;
}

export declare class MemoryCache {
  constructor(cacheDir: string);
  readonly kind: 'sqlite' | 'json';
  replaceAll(entries: Array<Record<string, unknown>>): void;
  query(filter?: Record<string, unknown>): Array<Record<string, unknown>>;
  count(): number;
  close(): void;
}

export interface SynthesisResult {
  feature: string;
  wordCount: number;
  targetWords: number;
  tolerance: number;
  body: string;
  filePath?: string;
}

export declare function synthesize(
  store: MemoryStore,
  feature: string,
  options?: { targetWords?: number; tolerance?: number; write?: boolean; heading?: string }
): SynthesisResult;

export declare const DEFAULT_TARGET_WORDS: number;
export declare const DEFAULT_TOLERANCE: number;
export declare const TYPES: MemoryType[];
export declare const HISTORY_CATEGORIES: Record<string, { idPrefix: string }>;
export declare const FEATURE_KINDS: Record<string, { idPrefix: string; file: string; label: string }>;
export declare const CACHE_SCHEMA_VERSION: number;

export declare const fsUtils: Record<string, (...args: any[]) => any>;
export declare const cli: { main(argv: string[]): number | null; USAGE: string };
