import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { DocType, KnowledgeDocument, KnowledgeNode } from './types';

type Sqlite = Database.Database;
type StoredNode = KnowledgeNode & {
  id: number;
  owner_scope: string;
  embedding?: number[] | null;
  embedding_space?: string | null;
};

export type CompanyDossierRecord = {
  owner_scope: string;
  company_key: string;
  company_name: string;
  dossier: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

export class KnowledgeDatabaseManager {
  constructor(private readonly db: Sqlite) {
    try { this.db.pragma('foreign_keys = ON'); } catch { /* in-memory test doubles */ }
  }

  initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_scope TEXT NOT NULL DEFAULT 'local_default',
        type TEXT NOT NULL CHECK(type IN ('resume','jd')),
        source_uri TEXT NOT NULL,
        structured_data TEXT,
        extraction_mode TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        source_hash TEXT,
        user_edited INTEGER NOT NULL DEFAULT 0,
        revision TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_scope TEXT NOT NULL DEFAULT 'local_default',
        source_type TEXT NOT NULL CHECK(source_type IN ('resume','jd')),
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        text_content TEXT NOT NULL,
        source_path TEXT,
        trust_level TEXT NOT NULL DEFAULT 'parsed',
        embedding TEXT,
        embedding_space TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS company_dossiers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_scope TEXT NOT NULL DEFAULT 'local_default',
        company_key TEXT NOT NULL,
        company_name TEXT NOT NULL,
        dossier TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.ensureColumn('knowledge_documents', 'owner_scope', "TEXT NOT NULL DEFAULT 'local_default'");
    this.ensureColumn('knowledge_documents', 'extraction_mode', 'TEXT');
    this.ensureColumn('knowledge_documents', 'schema_version', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('knowledge_documents', 'source_hash', 'TEXT');
    this.ensureColumn('knowledge_documents', 'user_edited', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('knowledge_documents', 'revision', "TEXT NOT NULL DEFAULT ''");
    this.db.prepare(`
      UPDATE knowledge_documents
      SET revision = lower(hex(randomblob(16)))
      WHERE revision IS NULL OR revision = ''
    `).run();
    this.ensureColumn('knowledge_nodes', 'owner_scope', "TEXT NOT NULL DEFAULT 'local_default'");
    this.ensureColumn('knowledge_nodes', 'source_path', 'TEXT');
    this.ensureColumn('knowledge_nodes', 'trust_level', "TEXT NOT NULL DEFAULT 'parsed'");
    this.ensureColumn('knowledge_nodes', 'embedding_space', 'TEXT');
    this.ensureColumn('company_dossiers', 'owner_scope', "TEXT NOT NULL DEFAULT 'local_default'");
    this.ensureColumn('company_dossiers', 'company_key', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('company_dossiers', 'company_name', "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn('company_dossiers', 'dossier', "TEXT NOT NULL DEFAULT '{}'");
    this.ensureColumn('company_dossiers', 'created_at', 'TEXT');
    this.ensureColumn('company_dossiers', 'updated_at', 'TEXT');
    this.db.exec(`
      UPDATE company_dossiers
      SET company_key=lower(trim(company_name))
      WHERE company_key IS NULL OR company_key='';
      DELETE FROM company_dossiers
      WHERE rowid NOT IN (
        SELECT MAX(rowid)
        FROM company_dossiers
        GROUP BY owner_scope, company_key
      );
    `);
    // Pre-owner-scope builds could retain several historical rows for the same
    // document type. Keep the newest inserted row deterministically before the
    // owner/type uniqueness invariant is installed.
    this.db.transaction(() => {
      // Legacy nodes do not carry a document id, so once duplicate documents
      // exist there is no safe way to distinguish nodes from the retained row
      // from nodes belonging to a discarded row. Fail closed by clearing the
      // affected owner/type index before retaining the newest document.
      this.db.exec(`
        DELETE FROM knowledge_nodes
        WHERE EXISTS (
          SELECT 1
          FROM knowledge_documents
          WHERE owner_scope=knowledge_nodes.owner_scope
            AND type=knowledge_nodes.source_type
          GROUP BY owner_scope, type
          HAVING COUNT(*) > 1
        );
        DELETE FROM knowledge_documents
        WHERE id NOT IN (
          SELECT MAX(id)
          FROM knowledge_documents
          GROUP BY owner_scope, type
        );
      `);
    })();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_owner_type
        ON knowledge_documents(owner_scope, type);
      CREATE INDEX IF NOT EXISTS knowledge_nodes_owner_source
        ON knowledge_nodes(owner_scope, source_type);
      CREATE UNIQUE INDEX IF NOT EXISTS company_dossiers_owner_company
        ON company_dossiers(owner_scope, company_key);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some(row => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  saveDocument(input: Partial<KnowledgeDocument> & { type: DocType; source_uri: string; structured_data: unknown }): number {
    const owner = input.owner_scope || 'local_default';
    const updatedAt = input.updated_at || new Date().toISOString();
    const revision = input.revision || randomUUID();
    const statement = this.db.prepare(`
      INSERT INTO knowledge_documents(
        owner_scope,type,source_uri,structured_data,extraction_mode,schema_version,
        source_hash,user_edited,revision,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(owner_scope,type) DO UPDATE SET
        source_uri=excluded.source_uri,
        structured_data=excluded.structured_data,
        extraction_mode=excluded.extraction_mode,
        schema_version=excluded.schema_version,
        source_hash=excluded.source_hash,
        user_edited=excluded.user_edited,
        revision=excluded.revision,
        updated_at=excluded.updated_at
      RETURNING id
    `);
    const row = statement.get(
      owner, input.type, input.source_uri, JSON.stringify(input.structured_data),
      input.extraction_mode || null, input.schema_version || 1, input.source_hash || null,
      input.user_edited ? 1 : 0, revision, updatedAt,
    ) as { id: number };
    return row.id;
  }

  getDocumentByType<T = Record<string, unknown>>(type: DocType, ownerScope = 'local_default'): KnowledgeDocument<T> | null {
    const row = this.db.prepare(
      'SELECT * FROM knowledge_documents WHERE owner_scope=? AND type=? LIMIT 1',
    ).get(ownerScope, type) as Record<string, any> | undefined;
    if (!row) return null;
    return {
      ...row,
      structured_data: parseJson<T | null>(row.structured_data, null),
      user_edited: Boolean(row.user_edited),
    } as KnowledgeDocument<T>;
  }

  updateDocumentStructuredData(
    type: DocType,
    data: unknown,
    ownerScope = 'local_default',
    userEdited = false,
  ): void {
    this.db.prepare(`
      UPDATE knowledge_documents SET structured_data=?, schema_version=?,
        user_edited=CASE WHEN ? THEN 1 ELSE user_edited END
      WHERE owner_scope=? AND type=?
    `).run(
      JSON.stringify(data),
      Number((data as any)?._schema_version) || 1,
      userEdited ? 1 : 0,
      ownerScope,
      type,
    );
  }

  replaceDocumentAndNodes(
    document: Partial<KnowledgeDocument> & { type: DocType; source_uri: string; structured_data: unknown },
    nodes: KnowledgeNode[],
  ): number {
    return this.db.transaction(() => {
      const id = this.saveDocument(document);
      this.replaceNodes(document.type, nodes, document.owner_scope || 'local_default');
      return id;
    })();
  }

  replaceDocumentAndNodesIfUnchanged(
    document: Partial<KnowledgeDocument> & { type: DocType; source_uri: string; structured_data: unknown },
    nodes: KnowledgeNode[],
    expectedRevision: string,
  ): number | null {
    return this.db.transaction(() => {
      const owner = document.owner_scope || 'local_default';
      if (!expectedRevision) return null;
      const row = this.db.prepare(
        'SELECT revision FROM knowledge_documents WHERE owner_scope=? AND type=? LIMIT 1',
      ).get(owner, document.type) as { revision?: string } | undefined;
      if (!row || row.revision !== expectedRevision) return null;
      const id = this.saveDocument(document);
      this.replaceNodes(document.type, nodes, owner);
      return id;
    })();
  }

  replaceNodes(type: DocType, nodes: KnowledgeNode[], ownerScope = 'local_default'): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_nodes WHERE owner_scope=? AND source_type=?').run(ownerScope, type);
      this.saveNodes(nodes.map(item => ({ ...item, owner_scope: ownerScope })));
    })();
  }

  saveNodes(nodes: Array<KnowledgeNode & { owner_scope?: string; embedding?: number[] | null; embedding_space?: string | null }>): void {
    const insert = this.db.prepare(`
      INSERT INTO knowledge_nodes(
        owner_scope,source_type,category,title,text_content,source_path,trust_level,
        embedding,embedding_space
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `);
    this.db.transaction(() => {
      for (const item of nodes) {
        insert.run(
          item.owner_scope || 'local_default', item.source_type, item.category,
          item.title, item.text_content, item.source_path || null, item.trust_level || 'parsed',
          item.embedding ? JSON.stringify(item.embedding) : null, item.embedding_space || null,
        );
      }
    })();
  }

  getAllNodes(ownerScope?: string): StoredNode[] {
    const rows = (ownerScope
      ? this.db.prepare('SELECT * FROM knowledge_nodes WHERE owner_scope=? ORDER BY id').all(ownerScope)
      : this.db.prepare('SELECT * FROM knowledge_nodes ORDER BY id').all()) as Array<Record<string, any>>;
    return rows.map(row => ({
      ...row,
      embedding: parseJson<number[] | null>(row.embedding, null),
    })) as StoredNode[];
  }

  getNodeCount(ownerScope = 'local_default'): number {
    return Number((this.db.prepare(
      'SELECT count(*) AS count FROM knowledge_nodes WHERE owner_scope=?',
    ).get(ownerScope) as { count: number }).count);
  }

  getNodesNeedingReembed(activeSpace: string, limit = 100, ownerScope?: string): StoredNode[] {
    const rows = (ownerScope ? this.db.prepare(`
      SELECT * FROM knowledge_nodes
      WHERE owner_scope=? AND (embedding IS NULL OR embedding_space IS NULL OR embedding_space <> ?)
      ORDER BY id LIMIT ?
    `).all(ownerScope, activeSpace, Math.max(1, Math.min(1000, limit))) : this.db.prepare(`
      SELECT * FROM knowledge_nodes
      WHERE embedding IS NULL OR embedding_space IS NULL OR embedding_space <> ?
      ORDER BY id LIMIT ?
    `).all(activeSpace, Math.max(1, Math.min(1000, limit)))) as Array<Record<string, any>>;
    return rows.map(row => ({ ...row, embedding: parseJson(row.embedding, null) })) as StoredNode[];
  }

  updateNodeEmbedding(id: number, embedding: number[], embeddingSpace?: string): void {
    this.db.prepare(
      'UPDATE knowledge_nodes SET embedding=?, embedding_space=? WHERE id=?',
    ).run(JSON.stringify(embedding), embeddingSpace || null, id);
  }

  getCompanyDossier(
    companyKey: string,
    ownerScope = 'local_default',
  ): CompanyDossierRecord | null {
    const row = this.db.prepare(`
      SELECT owner_scope, company_key, company_name, dossier, created_at, updated_at
      FROM company_dossiers
      WHERE owner_scope=? AND company_key=?
      LIMIT 1
    `).get(ownerScope, companyKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...row,
      dossier: parseJson<Record<string, unknown>>(row.dossier, {}),
    } as CompanyDossierRecord;
  }

  saveCompanyDossier(
    companyKey: string,
    companyName: string,
    dossier: Record<string, unknown>,
    ownerScope = 'local_default',
  ): void {
    this.db.prepare(`
      INSERT INTO company_dossiers(owner_scope, company_key, company_name, dossier, updated_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(owner_scope,company_key) DO UPDATE SET
        company_name=excluded.company_name,
        dossier=excluded.dossier,
        updated_at=excluded.updated_at
    `).run(ownerScope, companyKey, companyName, JSON.stringify(dossier), new Date().toISOString());
  }

  deleteDocumentsByType(type: DocType, ownerScope = 'local_default'): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_nodes WHERE owner_scope=? AND source_type=?').run(ownerScope, type);
      this.db.prepare('DELETE FROM knowledge_documents WHERE owner_scope=? AND type=?').run(ownerScope, type);
    })();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
