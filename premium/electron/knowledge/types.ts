export const DocType = {
  RESUME: 'resume',
  JD: 'jd',
} as const;

export type DocType = typeof DocType[keyof typeof DocType];

export interface KnowledgeDocument<T = Record<string, unknown>> {
  id?: number;
  owner_scope: string;
  type: DocType;
  source_uri: string;
  structured_data: T | null;
  extraction_mode?: string | null;
  schema_version?: number;
  source_hash?: string | null;
  user_edited?: boolean;
  revision?: string;
  created_at?: string;
  updated_at?: string;
}

export interface KnowledgeNode {
  id?: number;
  owner_scope?: string;
  source_type: DocType;
  category: string;
  title: string;
  text_content: string;
  source_path?: string;
  trust_level?: 'user_approved' | 'parsed' | 'heuristic';
  embedding?: number[] | null;
  embedding_space?: string | null;
}
