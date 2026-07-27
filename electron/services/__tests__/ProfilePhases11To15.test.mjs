import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = rel => import(pathToFileURL(path.resolve(here, '../../../dist-electron/premium/electron/knowledge/', rel)).href);
const { normalizeStructuredDocument, PROFILE_SCHEMA_VERSION } = await load('ProfileSchemas.js');
const { KnowledgeDatabaseManager } = await load('KnowledgeDatabaseManager.js');
const { KnowledgeOrchestrator } = await load('KnowledgeOrchestrator.js');
const { CompanyResearchEngine } = await load('CompanyResearchEngine.js');
const { createDocumentNodes } = await load('DocumentChunker.js');
const { DocType } = await load('types.js');

const resume = {
  identity: { name: 'Asha Rao', email: 'asha@example.com' },
  skills: ['Python', 'AWS'],
  experience: [{ company: 'Acme', role: 'Engineer', bullets: ['Built APIs'] }],
  projects: [], education: [], achievements: [], certifications: [], languages: [],
};

describe('Profile Intelligence phases 11-15', () => {
  test('resume normalization is versioned, categorized, bounded, and evidence-backed', () => {
    const normalized = normalizeStructuredDocument(DocType.RESUME, resume, 'Asha Rao\nEngineer at Acme\nPython AWS');
    assert.equal(normalized._schema_version, PROFILE_SCHEMA_VERSION);
    assert.ok(normalized.skills.languages.includes('Python'));
    assert.ok(normalized.skills.cloud.includes('AWS'));
    assert.ok(normalized.source_evidence.some(item => item.field === 'identity.name' && item.line_start === 1));
    assert.match(normalized.extraction_metadata.source_hash, /^[a-f0-9]{64}$/);
  });

  test('JD normalization fills every downstream collection without inventing facts', () => {
    const normalized = normalizeStructuredDocument(DocType.JD, { title: 'Backend Engineer' }, 'Backend Engineer');
    for (const field of ['requirements', 'responsibilities', 'nice_to_haves', 'technologies', 'keywords']) {
      assert.deepEqual(normalized[field], []);
    }
    assert.equal(normalized.company, '');
    assert.equal(normalized.level, '');
    assert.equal(normalized.employment_type, '');
  });

  test('legacy knowledge tables gain owner columns before owner-scoped indexes are created', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        structured_data TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE knowledge_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        text_content TEXT NOT NULL,
        embedding TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO knowledge_documents(type, source_uri, structured_data)
      VALUES
        ('resume', 'old-resume.pdf', '{"identity":{"name":"Old"}}'),
        ('resume', 'new-resume.pdf', '{"identity":{"name":"New"}}');
      INSERT INTO knowledge_nodes(source_type, category, title, text_content)
      VALUES ('resume', 'experience', 'Old role', 'Stale legacy profile fact');
    `);
    const db = new KnowledgeDatabaseManager(sqlite);
    assert.doesNotThrow(() => db.initializeSchema());
    assert.ok(sqlite.prepare('PRAGMA table_info(knowledge_documents)').all().some(row => row.name === 'owner_scope'));
    assert.ok(sqlite.prepare('PRAGMA table_info(knowledge_documents)').all().some(row => row.name === 'extraction_mode'));
    assert.ok(sqlite.prepare('PRAGMA table_info(knowledge_nodes)').all().some(row => row.name === 'owner_scope'));
    const migrated = sqlite.prepare(
      "SELECT source_uri FROM knowledge_documents WHERE owner_scope='local_default' AND type='resume'",
    ).all();
    assert.deepEqual(migrated, [{ source_uri: 'new-resume.pdf' }]);
    assert.equal(
      sqlite.prepare("SELECT count(*) AS count FROM knowledge_nodes WHERE source_type='resume'").get().count,
      0,
      'nodes from an ambiguous duplicate-document migration must be cleared',
    );
    assert.doesNotThrow(() => db.saveDocument({
      type: DocType.JD,
      owner_scope: 'local_default',
      source_uri: 'job.txt',
      structured_data: { title: 'Engineer' },
      extraction_mode: 'heuristic',
    }));
    db.close();
  });

  test('primitive resume sections are indexed as complete values', () => {
    const nodes = createDocumentNodes({
      ...resume,
      achievements: ['Winner of Hackathon'],
      certifications: ['AWS Certified'],
      languages: ['English'],
      leadership: ['Engineering Club President'],
    }, DocType.RESUME);
    assert.equal(nodes.find(node => node.source_path === 'languages.0').text_content, 'English');
    assert.equal(nodes.find(node => node.source_path === 'certifications.0').text_content, 'AWS Certified');
    assert.ok(!nodes.some(node => /\bE \| n \| g\b/.test(node.text_content)));
  });

  test('atomic user correction replaces nodes and marks trusted provenance', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'alice', source_uri: 'resume.pdf',
      structured_data: resume,
    }, createDocumentNodes(resume, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setOwnerScope('alice');
    const result = await orchestrator.updateStructuredDocument(DocType.RESUME, {
      ...resume, identity: { ...resume.identity, name: 'Asha R. Rao' },
    }, orchestrator.activeResume.revision);
    assert.equal(result.success, true);
    assert.equal(db.getDocumentByType(DocType.RESUME, 'alice').user_edited, true);
    assert.equal(db.getDocumentByType(DocType.RESUME, 'alice').structured_data.identity.name, 'Asha R. Rao');
    assert.equal(db.getAllNodes('alice').find(node => node.category === 'identity').trust_level, 'user_approved');
    assert.ok(db.getAllNodes('alice').some(node => node.trust_level === 'parsed'));
    db.close();
  });

  test('edit preserves unchanged evidence/hash and rejects a stale revision atomically', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const original = normalizeStructuredDocument(DocType.RESUME, resume, 'Asha Rao\nEngineer at Acme');
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'alice', source_uri: 'resume.pdf',
      structured_data: original, schema_version: PROFILE_SCHEMA_VERSION,
      source_hash: original.extraction_metadata.source_hash,
    }, createDocumentNodes(original, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setOwnerScope('alice');
    const revision = orchestrator.activeResume.revision;
    const first = await orchestrator.updateStructuredDocument(DocType.RESUME, {
      ...original, identity: { ...original.identity, name: 'Asha R. Rao' },
    }, revision);
    assert.equal(first.success, true);
    const stored = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.equal(stored.extraction_metadata.source_hash, original.extraction_metadata.source_hash);
    assert.ok(stored.source_evidence.some(item => item.field === 'experience.0.company' && item.source === 'resume'));
    assert.ok(stored.source_evidence.some(item => item.field === 'identity.name' && item.source === 'user'));
    const stale = await orchestrator.updateStructuredDocument(DocType.RESUME, {
      ...stored, identity: { ...stored.identity, name: 'Overwritten' },
    }, revision);
    assert.equal(stale.success, false);
    assert.equal(db.getDocumentByType(DocType.RESUME, 'alice').structured_data.identity.name, 'Asha R. Rao');
    assert.equal(db.getDocumentByType(DocType.RESUME, 'alice').schema_version, PROFILE_SCHEMA_VERSION);
    db.close();
  });

  test('editing one array entry elevates trust only for that entry', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const original = normalizeStructuredDocument(DocType.RESUME, {
      ...resume,
      experience: [
        { company: 'Acme', role: 'Engineer', bullets: ['Built APIs'] },
        { company: 'Beta', role: 'Developer', bullets: ['Maintained services'] },
      ],
    }, 'Engineer at Acme\nBuilt APIs\nDeveloper at Beta\nMaintained services');
    db.replaceDocumentAndNodes({
      type: DocType.RESUME,
      owner_scope: 'alice',
      source_uri: 'resume.pdf',
      structured_data: original,
      schema_version: PROFILE_SCHEMA_VERSION,
    }, createDocumentNodes(original, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setOwnerScope('alice');
    const edited = structuredClone(original);
    edited.experience[0].bullets = ['Built reliable APIs'];
    const result = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      edited,
      orchestrator.activeResume.revision,
    );
    assert.equal(result.success, true);
    const experienceNodes = db.getAllNodes('alice').filter(node => node.category === 'experience');
    assert.equal(experienceNodes.find(node => node.source_path === 'experience.0').trust_level, 'user_approved');
    assert.equal(experienceNodes.find(node => node.source_path === 'experience.1').trust_level, 'parsed');
    const stored = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.ok(stored.source_evidence.some(item =>
      item.field === 'experience.1.company' && item.source === 'resume'));

    const afterFirstEditRevision = orchestrator.activeResume.revision;
    const withoutFirstEntry = structuredClone(stored);
    withoutFirstEntry.experience = [withoutFirstEntry.experience[1]];
    const deletion = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      withoutFirstEntry,
      afterFirstEditRevision,
    );
    assert.equal(deletion.success, true);
    const shiftedNode = db.getAllNodes('alice').find(node => node.source_path === 'experience.0');
    assert.equal(shiftedNode.title, 'Developer');
    assert.equal(shiftedNode.trust_level, 'parsed');
    const afterDeletion = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.ok(afterDeletion.source_evidence.some(item =>
      item.field === 'experience.0.company' && item.source === 'resume'));
    assert.ok(!afterDeletion.source_evidence.some(item =>
      item.field.startsWith('experience.1.')));

    const beforeIdentityCorrectionRevision = orchestrator.activeResume.revision;
    const correctedIdentity = structuredClone(afterDeletion);
    correctedIdentity.experience[0].company = 'Beta Corp';
    const identityCorrection = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      correctedIdentity,
      beforeIdentityCorrectionRevision,
    );
    assert.equal(identityCorrection.success, true);
    const afterIdentityCorrection = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.ok(afterIdentityCorrection.source_evidence.some(item =>
      item.field === 'experience.0.role' && item.source === 'resume'));
    assert.ok(afterIdentityCorrection.source_evidence.some(item =>
      item.field === 'experience.0.company' && item.source === 'user'));

    const replacementRevision = orchestrator.activeResume.revision;
    const unrelatedReplacement = structuredClone(afterIdentityCorrection);
    unrelatedReplacement.experience[0] = {
      ...unrelatedReplacement.experience[0],
      company: 'Gamma',
      role: 'Manager',
      bullets: ['Maintained services'],
    };
    const replacement = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      unrelatedReplacement,
      replacementRevision,
    );
    assert.equal(replacement.success, true);
    const afterReplacement = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.ok(!afterReplacement.source_evidence.some(item =>
      item.field.startsWith('experience.0.') && item.source === 'resume'));
    assert.ok(afterReplacement.source_evidence.some(item =>
      item.field === 'experience.0' && item.source === 'user'));
    db.close();
  });

  test('edit requires a revision and preserves valid timestamps', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, createDocumentNodes(resume, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    const missing = await orchestrator.updateStructuredDocument(DocType.RESUME, resume, '');
    assert.equal(missing.success, false);
    const stored = db.getDocumentByType(DocType.RESUME);
    assert.ok(stored.revision);
    assert.equal(Number.isNaN(Date.parse(stored.updated_at)), false);
    db.close();
  });

  test('renaming a project preserves provenance for its unchanged facts', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const original = normalizeStructuredDocument(DocType.RESUME, {
      ...resume,
      projects: [{
        name: 'Atlas',
        description: 'Reporting platform',
        technologies: ['AWS'],
        highlights: ['Reduced reporting time'],
      }],
    }, 'Atlas\nReporting platform\nAWS\nReduced reporting time');
    original.source_evidence.push({
      field: 'projects.0.description',
      source: 'resume',
      text: 'Reporting platform',
      line_start: 2,
      line_end: 2,
    });
    db.replaceDocumentAndNodes({
      type: DocType.RESUME,
      owner_scope: 'alice',
      source_uri: 'resume.pdf',
      structured_data: original,
      schema_version: PROFILE_SCHEMA_VERSION,
    }, createDocumentNodes(original, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setOwnerScope('alice');
    const renamed = structuredClone(original);
    renamed.projects[0].name = 'Atlas Insights';
    const result = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      renamed,
      orchestrator.activeResume.revision,
    );
    assert.equal(result.success, true);
    const stored = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.ok(stored.source_evidence.some(item =>
      item.field === 'projects.0.description' && item.source === 'resume'));
    assert.ok(stored.source_evidence.some(item =>
      item.field === 'projects.0.name' && item.source === 'user'));
    db.close();
  });

  test('renaming and reordering a project preserves its unchanged provenance', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const original = normalizeStructuredDocument(DocType.RESUME, {
      ...resume,
      projects: [
        {
          name: 'Atlas',
          description: 'Reporting platform',
          technologies: ['AWS'],
          highlights: ['Reduced reporting time'],
        },
        {
          name: 'Beacon',
          description: 'Monitoring service',
          technologies: ['Python'],
          highlights: ['Improved alerting'],
        },
      ],
    }, 'Atlas\nReporting platform\nBeacon\nMonitoring service');
    original.source_evidence.push({
      field: 'projects.0.description',
      source: 'resume',
      text: 'Reporting platform',
      line_start: 2,
      line_end: 2,
    });
    db.replaceDocumentAndNodes({
      type: DocType.RESUME,
      owner_scope: 'alice',
      source_uri: 'resume.pdf',
      structured_data: original,
      schema_version: PROFILE_SCHEMA_VERSION,
    }, createDocumentNodes(original, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setOwnerScope('alice');
    const edited = structuredClone(original);
    edited.projects = [
      edited.projects[1],
      { ...edited.projects[0], name: 'Atlas Insights' },
    ];
    const result = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      edited,
      orchestrator.activeResume.revision,
    );
    assert.equal(result.success, true);
    const stored = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.ok(stored.source_evidence.some(item =>
      item.field === 'projects.1.description' && item.source === 'resume'));
    assert.ok(stored.source_evidence.some(item =>
      item.field === 'projects.1.name' && item.source === 'user'));
    db.close();
  });

  test('ambiguous renamed projects do not inherit arbitrary resume provenance', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const original = normalizeStructuredDocument(DocType.RESUME, {
      ...resume,
      projects: [
        {
          name: 'Atlas',
          description: 'Shared platform',
          technologies: ['AWS'],
          highlights: ['Shared result'],
        },
        {
          name: 'Beacon',
          description: 'Shared platform',
          technologies: ['AWS'],
          highlights: ['Shared result'],
        },
      ],
    }, 'Atlas\nBeacon\nShared platform');
    original.source_evidence.push({
      field: 'projects.0.description',
      source: 'resume',
      text: 'Shared platform',
      line_start: 3,
      line_end: 3,
    });
    db.replaceDocumentAndNodes({
      type: DocType.RESUME,
      owner_scope: 'alice',
      source_uri: 'resume.pdf',
      structured_data: original,
      schema_version: PROFILE_SCHEMA_VERSION,
    }, createDocumentNodes(original, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setOwnerScope('alice');
    const edited = structuredClone(original);
    edited.projects = [
      { ...edited.projects[1], name: 'Beacon Next' },
      { ...edited.projects[0], name: 'Atlas Next' },
    ];
    const result = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      edited,
      orchestrator.activeResume.revision,
    );
    assert.equal(result.success, true);
    const stored = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.ok(!stored.source_evidence.some(item =>
      item.field.startsWith('projects.') && item.source === 'resume'));
    assert.ok(stored.source_evidence.some(item =>
      item.field === 'projects.0' && item.source === 'user'));
    assert.ok(stored.source_evidence.some(item =>
      item.field === 'projects.1' && item.source === 'user'));
    db.close();
  });

  test('duplicate project identities are disambiguated by their full content', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const original = normalizeStructuredDocument(DocType.RESUME, {
      ...resume,
      projects: [
        {
          name: 'Internal Platform',
          description: 'Reporting platform',
          url: '',
          technologies: ['AWS'],
          highlights: ['Reduced reporting time'],
        },
        {
          name: 'Internal Platform',
          description: 'Monitoring service',
          url: '',
          technologies: ['Python'],
          highlights: ['Improved alerting'],
        },
      ],
    }, 'Internal Platform\nReporting platform\nMonitoring service');
    original.source_evidence.push({
      field: 'projects.0.description',
      source: 'resume',
      text: 'Reporting platform',
      line_start: 2,
      line_end: 2,
    });
    db.replaceDocumentAndNodes({
      type: DocType.RESUME,
      owner_scope: 'alice',
      source_uri: 'resume.pdf',
      structured_data: original,
      schema_version: PROFILE_SCHEMA_VERSION,
    }, createDocumentNodes(original, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setOwnerScope('alice');
    const edited = structuredClone(original);
    edited.projects = [edited.projects[1], edited.projects[0]];
    const result = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      edited,
      orchestrator.activeResume.revision,
    );
    assert.equal(result.success, true);
    const stored = db.getDocumentByType(DocType.RESUME, 'alice').structured_data;
    assert.ok(stored.source_evidence.some(item =>
      item.field === 'projects.1.description' && item.source === 'resume'));
    assert.ok(!stored.source_evidence.some(item =>
      item.field === 'projects.0.description' && item.source === 'resume'));
    db.close();
  });

  test('user correction embeds replacement nodes before they become active', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, createDocumentNodes(resume, DocType.RESUME));
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setEmbedWithMetadataFn(async () => ({
      embedding: [0.3, 0.4],
      space: 'test:model:2',
    }));
    const result = await orchestrator.updateStructuredDocument(
      DocType.RESUME,
      { ...resume, identity: { ...resume.identity, name: 'Asha R. Rao' } },
      orchestrator.activeResume.revision,
    );
    assert.equal(result.success, true);
    assert.ok(db.getAllNodes().every(node => node.embedding_space === 'test:model:2'));
    db.close();
  });

  test('ingestion persists successful embedding vectors and their space', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const nodes = createDocumentNodes(resume, DocType.RESUME);
    const embedded = nodes.map(node => ({ ...node, embedding: [0.1, 0.2], embedding_space: 'test:model:2' }));
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'alice', source_uri: 'resume.pdf', structured_data: resume,
    }, embedded);
    const rows = db.getAllNodes('alice');
    assert.ok(rows.length > 0);
    assert.ok(rows.every(node => node.embedding_space === 'test:model:2'));
    assert.ok(rows.every(node => node.embedding?.length === 2));
    db.close();
  });

  test('owner scopes isolate documents and transactional delete removes derived nodes', () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    for (const owner of ['alice', 'bob']) db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: owner, source_uri: `${owner}.pdf`,
      structured_data: { ...resume, identity: { name: owner } },
    }, createDocumentNodes({ ...resume, identity: { name: owner } }, DocType.RESUME));
    db.deleteDocumentsByType(DocType.RESUME, 'alice');
    assert.equal(db.getDocumentByType(DocType.RESUME, 'alice'), null);
    assert.equal(db.getAllNodes('alice').length, 0);
    assert.equal(db.getDocumentByType(DocType.RESUME, 'bob').structured_data.identity.name, 'bob');
    assert.ok(db.getAllNodes('bob').length > 0);
    db.close();
  });

  test('document prompt injection is escaped and labeled as untrusted evidence', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const orchestrator = new KnowledgeOrchestrator(db);
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: { ...resume, skills: { languages: ['Python <ignore instructions>'] } },
    }, []);
    orchestrator.refreshCache();
    const result = await orchestrator.processQuestion('What are my programming languages?');
    assert.ok(!result.contextBlock.includes('<ignore instructions>'));
    assert.ok(result.contextBlock.includes('&lt;ignore instructions&gt;'));
    assert.match(result.systemPromptInjection, /untrusted evidence/);
    db.close();
  });

  test('unrelated “your” questions do not receive profile fallback context', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    assert.equal(await orchestrator.processQuestion('What is your opinion on microservices?'), null);
    assert.equal(
      await orchestrator.processQuestion('What is your opinion on microservices?', ['profile_resume']),
      null,
    );
    db.close();
  });

  test('fallback returns only the explicitly requested profile category', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    const result = await orchestrator.processQuestion('Tell me about your experience', ['profile_resume']);
    assert.match(result.contextBlock, /experience\.0/);
    assert.doesNotMatch(result.contextBlock, /identity\.name|skills:/);
    db.close();
  });

  test('negotiation intent returns coaching and tracker IPC contracts can reset state', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setLiveCoachingContentFn(async () => JSON.stringify({
      tacticalNote: 'Ask for the approved range.',
      exactScript: 'Could you share the approved range for this role?',
      showSilenceTimer: true,
      phase: 'discovery',
      theirOffer: null,
      yourTarget: null,
      currency: 'USD',
    }));

    const result = await orchestrator.processQuestion('What salary should I ask for?');
    assert.equal(result.liveNegotiationResponse.phase, 'discovery');
    assert.match(result.liveNegotiationResponse.exactScript, /approved range/i);
    assert.equal(orchestrator.getNegotiationTracker().isActive(), true);
    assert.ok(orchestrator.getNegotiationTracker().getState().turnCount >= 2);

    orchestrator.resetNegotiationSession();
    assert.equal(orchestrator.getNegotiationTracker().isActive(), false);
    assert.equal(orchestrator.getNegotiationTracker().getState().turnCount, 0);
    db.close();
  });

  test('interviewer offer reaches coaching context and unknown fallback currency is not invented', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setConversationContextProvider(() => ({ recentInterviewerComp: true }));
    orchestrator.feedInterviewerUtterance('Our approved offer is ₹20 lakh.');
    let prompt = '';
    orchestrator.setLiveCoachingContentFn(async contents => {
      prompt = contents.map(item => item.text).join('\n');
      return 'not valid json';
    });

    const result = await orchestrator.processQuestion('Give me the number');
    assert.match(prompt, /interviewer: Our approved offer is ₹20 lakh/);
    assert.equal(result.liveNegotiationResponse.currency, '');
    assert.equal(orchestrator.getNegotiationTracker().getTurns()[0].role, 'interviewer');
    db.close();
  });

  test('ordinary uses of “number” do not activate negotiation coaching', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: {
        ...resume,
        projects: [{ name: 'Atlas', description: 'Reporting platform', technologies: ['AWS'] }],
      },
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    const result = await orchestrator.processQuestion('What number of my projects used AWS?');
    assert.equal(result?.liveNegotiationResponse, undefined);
    assert.match(result.contextBlock, /Atlas/);
    assert.equal(
      (await orchestrator.processQuestion('Explain a base class in Java'))?.liveNegotiationResponse,
      undefined,
    );
    assert.equal(
      (await orchestrator.processQuestion('How do I pay attention to memory usage?'))?.liveNegotiationResponse,
      undefined,
    );
    db.close();
  });

  test('negotiation metadata is derived from transcript evidence, not model claims', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.feedInterviewerUtterance('The approved offer is $120000.');
    orchestrator.setLiveCoachingContentFn(async () => JSON.stringify({
      tacticalNote: 'Discuss the documented offer.',
      exactScript: 'Thank you for the offer. Could we discuss the total package?',
      theirOffer: 999999,
      yourTarget: 888888,
      currency: 'EUR',
    }));
    const grounded = await orchestrator.processQuestion('How should I respond to the salary offer?');
    assert.equal(grounded.liveNegotiationResponse.theirOffer, 120000);
    assert.equal(grounded.liveNegotiationResponse.yourTarget, null);
    assert.equal(grounded.liveNegotiationResponse.currency, 'USD');

    orchestrator.resetNegotiationSession();
    orchestrator.setLiveCoachingContentFn(async () => JSON.stringify({
      tacticalNote: 'Demand $999999.',
      exactScript: 'I need $999999.',
      theirOffer: 999999,
      yourTarget: 999999,
      currency: 'USD',
    }));
    const rejected = await orchestrator.processQuestion('What salary should I ask for?');
    assert.equal(rejected.liveNegotiationResponse.theirOffer, null);
    assert.equal(rejected.liveNegotiationResponse.yourTarget, null);
    assert.doesNotMatch(rejected.liveNegotiationResponse.exactScript, /999999/);
    db.close();
  });

  test('compensation grounding normalizes units and recognizes user-reported offers', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const response = {
      tacticalNote: 'Discuss the recorded offer.',
      exactScript: 'Thank you. I would like to discuss the full package.',
      theirOffer: null, yourTarget: null, currency: '',
    };

    const abbreviated = new KnowledgeOrchestrator(db);
    abbreviated.feedInterviewerUtterance('The approved offer is $120k.');
    abbreviated.setLiveCoachingContentFn(async () => JSON.stringify(response));
    const abbreviatedResult = await abbreviated.processQuestion('How should I respond to this salary offer?');
    assert.equal(abbreviatedResult.liveNegotiationResponse.theirOffer, 120000);

    const reported = new KnowledgeOrchestrator(db);
    reported.setLiveCoachingContentFn(async () => JSON.stringify(response));
    const reportedResult = await reported.processQuestion('I received an offer of 20 LPA. How should I respond?');
    assert.equal(reportedResult.liveNegotiationResponse.theirOffer, 2000000);
    assert.equal(reportedResult.liveNegotiationResponse.yourTarget, null);
    assert.equal(reportedResult.liveNegotiationResponse.currency, 'INR');

    const grouped = new KnowledgeOrchestrator(db);
    grouped.setLiveCoachingContentFn(async () => JSON.stringify(response));
    const groupedResult = await grouped.processQuestion('They offered ₹20,00,000. What should I say?');
    assert.equal(groupedResult.liveNegotiationResponse.theirOffer, 2000000);
    db.close();
  });

  test('multiple compensation values in one turn preserve offer and target intent', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setLiveCoachingContentFn(async () => JSON.stringify({
      tacticalNote: 'Negotiate from the recorded figures.',
      exactScript: 'Thank you. I would like to discuss the full package.',
    }));
    const result = await orchestrator.processQuestion(
      'They offered $120k, but my target is $140k. How should I respond?',
    );
    assert.equal(result.liveNegotiationResponse.theirOffer, 120000);
    assert.equal(result.liveNegotiationResponse.yourTarget, 140000);
    assert.equal(result.liveNegotiationResponse.currency, 'USD');
    db.close();
  });

  test('coordinated compensation values use the nearest intent anchor', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    orchestrator.setLiveCoachingContentFn(async () => JSON.stringify({
      tacticalNote: 'Negotiate from the recorded figures.',
      exactScript: 'Thank you. I would like to discuss the full package.',
    }));
    const result = await orchestrator.processQuestion(
      'They offered $120k and my target is $140k. How should I respond?',
    );
    assert.equal(result.liveNegotiationResponse.theirOffer, 120000);
    assert.equal(result.liveNegotiationResponse.yourTarget, 140000);
    assert.equal(result.liveNegotiationResponse.currency, 'USD');
    db.close();
  });

  test('explicit offer, budget, CTC, LPA, bonus, and monetary ranges activate negotiation coaching', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const phrases = [
      'I received an offer of 20 LPA',
      'The budget is 100k USD',
      'How should I discuss my CTC?',
      'Can I negotiate the annual bonus?',
      'They offered ₹20 lakh',
    ];
    for (const phrase of phrases) {
      const orchestrator = new KnowledgeOrchestrator(db);
      const result = await orchestrator.processQuestion(phrase);
      assert.ok(result?.liveNegotiationResponse, `expected negotiation coaching for: ${phrase}`);
    }
    db.close();
  });

  test('company dossier generation is cached and isolated by profile owner', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    let owner = 'alice';
    let generationCount = 0;
    const engine = new CompanyResearchEngine(
      db,
      () => async () => {
        generationCount++;
        return JSON.stringify({
          culture_ratings: { overall: 4.2, source_indices: [1] },
          salary_estimates: [],
          hiring_strategy: 'Structured interviews',
          interview_focus: 'System design',
          interview_difficulty: 'hard',
          benefits: [],
          core_values: [],
          critics: [],
          recent_news: '',
          source_indices: {
            hiring_strategy: [1],
            interview_focus: [1],
            interview_difficulty: [1],
          },
        });
      },
      () => owner,
    );
    engine.setSearchProvider({
      async search() {
        return [{ title: 'Acme careers', url: 'https://example.com/acme', content: 'Structured system design interviews are hard.' }];
      },
    });
    const dossier = await engine.researchCompany('Acme', { title: 'Engineer' });
    assert.equal(dossier.company, 'Acme');
    assert.equal(
      engine.getCachedDossier('  ACME  ', { title: 'Engineer' }).hiring_strategy,
      'Structured interviews',
    );
    assert.equal(generationCount, 1);
    assert.equal(
      (await engine.researchCompany('Acme', { title: 'Engineer' })).hiring_strategy,
      'Structured interviews',
    );
    assert.equal(generationCount, 1);
    owner = 'bob';
    assert.equal(engine.getCachedDossier('Acme', { title: 'Engineer' }), null);
    db.close();
  });

  test('company dossier cache varies by JD context and rejects incomplete salary estimates', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    let generatedRole = '';
    const engine = new CompanyResearchEngine(
      db,
      () => async contents => {
        generatedRole = contents[0].text.includes('"title":"Product Manager"') ? 'Product Manager' : 'Engineer';
        return JSON.stringify({
          culture_ratings: { overall: null },
          salary_estimates: [
            { title: generatedRole, currency: '', min: null, max: '' },
            { title: generatedRole, currency: 'USD', min: 100000, max: 120000, source_indices: [1] },
          ],
          hiring_strategy: generatedRole,
          source_indices: { hiring_strategy: [1] },
        });
      },
      () => 'alice',
    );
    engine.setSearchProvider({
      async search() {
        return [{
          title: 'Acme jobs',
          url: 'https://example.com/jobs',
          content: [
            'Engineer salary range USD 100000 to 120000.',
            'Product Manager salary range USD 100000 to 120000.',
            'Engineer and Product Manager hiring strategy.',
          ].join('\n'),
        }];
      },
    });
    const engineering = await engine.researchCompany('Acme', { title: 'Engineer' });
    assert.equal(engineering.salary_estimates.length, 1);
    assert.equal(engineering.culture_ratings.overall, undefined);
    assert.equal(engineering.hiring_strategy, 'Engineer');
    assert.equal(engine.getCachedDossier('Acme', { title: 'Product Manager' }), null);
    const product = await engine.researchCompany('Acme', { title: 'Product Manager' });
    assert.equal(product.hiring_strategy, 'Product Manager');
    assert.equal(engine.getCachedDossier('Acme', { title: 'Engineer' }).hiring_strategy, 'Engineer');
    db.close();
  });

  test('LLM-only company research suppresses evidence-dependent claims', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify({
        culture_ratings: { overall: 4.9, source_indices: [1] },
        salary_estimates: [{
          title: 'Engineer', currency: 'USD', min: 200000, max: 300000, source_indices: [1],
        }],
        hiring_strategy: 'Invented claim',
        recent_news: 'Invented acquisition',
        source_indices: { hiring_strategy: [1], recent_news: [1] },
      }),
      () => 'alice',
    );
    const dossier = await engine.researchCompany('Acme', { title: 'Engineer' });
    assert.equal(dossier.culture_ratings.overall, undefined);
    assert.deepEqual(dossier.salary_estimates, []);
    assert.equal(dossier.hiring_strategy, '');
    assert.equal(dossier.recent_news, '');
    assert.deepEqual(dossier.sources, []);
    db.close();
  });

  test('irrelevant cited sources do not ground fabricated company facts', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify({
        culture_ratings: { overall: 4.9, source_indices: [1] },
        salary_estimates: [{
          title: 'Engineer', currency: 'USD', min: 200000, max: 300000, source_indices: [1],
        }],
        hiring_strategy: 'Uses a seven-round executive panel',
        recent_news: 'Acquired Moonshot Labs yesterday',
        source_indices: { hiring_strategy: [1], recent_news: [1] },
      }),
      () => 'alice',
    );
    engine.setSearchProvider({
      async search() {
        return [{
          title: 'Acme home',
          url: 'https://example.com',
          content: 'Acme sells warehouse inventory software to retailers.',
        }];
      },
    });
    const dossier = await engine.researchCompany('Acme', { title: 'Engineer' });
    assert.equal(dossier.culture_ratings.overall, undefined);
    assert.deepEqual(dossier.salary_estimates, []);
    assert.equal(dossier.hiring_strategy, '');
    assert.equal(dossier.recent_news, '');
    db.close();
  });

  test('company grounding validates salary currency and each rating category independently', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify({
        culture_ratings: {
          overall: 4.2,
          management: 4.2,
          source_indices: { overall: [1], management: [1] },
        },
        salary_estimates: [{
          title: 'Engineer', currency: 'USD', min: 100000, max: 120000, source_indices: [1],
        }],
      }),
      () => 'alice',
    );
    engine.setSearchProvider({
      async search() {
        return [{
          title: 'Acme reviews',
          url: 'https://example.com/reviews',
          content: 'Overall rating 4.2. Management rating 3.1. Salary range INR 100000 to 120000.',
        }];
      },
    });
    const dossier = await engine.researchCompany('Acme', { title: 'Engineer' });
    assert.equal(dossier.culture_ratings.overall, 4.2);
    assert.equal(dossier.culture_ratings.management, undefined);
    assert.deepEqual(dossier.salary_estimates, []);
    assert.deepEqual(dossier.culture_ratings.source_indices.overall, [1]);
    db.close();
  });

  test('company salary grounding rejects ambiguous dollar currency and mismatched dimensions', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    let generatedSalary = {
      title: 'Engineer',
      location: 'Toronto',
      currency: 'USD',
      min: 100000,
      max: 120000,
      source_indices: [1],
    };
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify({
        culture_ratings: {},
        salary_estimates: [generatedSalary],
      }),
      () => 'alice',
    );
    engine.setSearchProvider({
      async search() {
        return [{
          title: 'Acme salary data',
          url: 'https://example.com/salaries',
          content: 'Product Manager salary in Toronto: CAD $100000 to $120000.',
        }];
      },
    });

    const wrongCurrency = await engine.researchCompany('Acme', { title: 'Engineer' }, true);
    assert.deepEqual(wrongCurrency.salary_estimates, []);

    generatedSalary = { ...generatedSalary, currency: 'CAD' };
    const wrongTitle = await engine.researchCompany('Acme', { title: 'Engineer' }, true);
    assert.deepEqual(wrongTitle.salary_estimates, []);

    generatedSalary = { ...generatedSalary, title: 'Product Manager', location: 'London' };
    const wrongLocation = await engine.researchCompany('Acme', { title: 'Product Manager' }, true);
    assert.deepEqual(wrongLocation.salary_estimates, []);

    generatedSalary = { ...generatedSalary, location: 'Toronto' };
    const grounded = await engine.researchCompany('Acme', { title: 'Product Manager' }, true);
    assert.equal(grounded.salary_estimates.length, 1);
    assert.equal(grounded.salary_estimates[0].currency, 'CAD');
    db.close();
  });

  test('company salary grounding does not recombine dimensions from separate salary records', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify({
        culture_ratings: {},
        salary_estimates: [{
          title: 'Engineer',
          location: 'Toronto',
          currency: 'CAD',
          min: 100000,
          max: 120000,
          source_indices: [1],
        }],
      }),
      () => 'alice',
    );
    engine.setSearchProvider({
      async search() {
        return [{
          title: 'Acme salary data',
          url: 'https://example.com/salaries',
          content: [
            'Engineer salary in New York: USD 100000 to 120000.',
            'Manager salary in Toronto: CAD 80000 to 90000.',
          ].join('\n'),
        }];
      },
    });
    const dossier = await engine.researchCompany('Acme', { title: 'Engineer' }, true);
    assert.deepEqual(dossier.salary_estimates, []);
    db.close();
  });

  test('company salary grounding supports Markdown rows, result-title context, and short claims', async () => {
    const cases = [
      {
        salary: {
          title: 'Engineer', location: 'Toronto', currency: 'CAD',
          min: 100000, max: 120000, source_indices: [1],
        },
        source: {
          title: 'Acme salaries',
          content: '| Role | Location | Currency | Min | Max |\n| --- | --- | --- | --- | --- |\n| Engineer | Toronto | CAD | 100000 | 120000 |',
        },
      },
      {
        salary: {
          title: 'Software Engineer', location: 'Toronto', currency: 'CAD',
          min: 100000, max: 120000, source_indices: [1],
        },
        source: {
          title: 'Software Engineer salary in Toronto',
          content: 'Range CAD 100000 to 120000.',
        },
      },
      {
        salary: {
          title: 'SWE', location: 'NYC', currency: 'USD',
          min: 150000, max: 180000, source_indices: [1],
        },
        source: {
          title: 'SWE salary in NYC',
          content: 'USD 150000 to 180000.',
        },
      },
    ];

    for (const fixture of cases) {
      const db = new KnowledgeDatabaseManager(new Database(':memory:'));
      db.initializeSchema();
      const engine = new CompanyResearchEngine(
        db,
        () => async () => JSON.stringify({
          culture_ratings: {},
          salary_estimates: [fixture.salary],
        }),
        () => 'alice',
      );
      engine.setSearchProvider({
        async search() {
          return [{ ...fixture.source, url: 'https://example.com/salaries' }];
        },
      });
      const dossier = await engine.researchCompany('Acme', { title: fixture.salary.title }, true);
      assert.equal(dossier.salary_estimates.length, 1, `expected grounded salary for ${fixture.salary.title}`);
      db.close();
    }
  });

  test('company grounding rejects ambiguous title inheritance, crossed rating cells, and missing short qualifiers', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    let generated = {
      culture_ratings: {
        overall: 4.2,
        management: 4.2,
        source_indices: { overall: [1], management: [1] },
      },
      salary_estimates: [{
        title: 'VP Engineering',
        location: 'Toronto',
        currency: 'CAD',
        min: 100000,
        max: 120000,
        source_indices: [1],
      }],
    };
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify(generated),
      () => 'alice',
    );
    engine.setSearchProvider({
      async search() {
        return [{
          title: 'Engineer and Manager salaries in New York and Toronto',
          url: 'https://example.com/salaries',
          content: [
            '| Overall | 4.2 | Management | 3.1 |',
            '| Engineering Manager | New York | USD | 100000 | 120000 |',
            '| Manager | Toronto | CAD | 80000 | 90000 |',
          ].join('\n'),
        }];
      },
    });

    const dossier = await engine.researchCompany('Acme', { title: 'VP Engineering' }, true);
    assert.equal(dossier.culture_ratings.overall, 4.2);
    assert.equal(dossier.culture_ratings.management, undefined);
    assert.deepEqual(dossier.salary_estimates, []);

    generated = {
      culture_ratings: {},
      salary_estimates: [{
        title: 'VP Engineering',
        location: 'Toronto',
        currency: 'CAD',
        min: 100000,
        max: 120000,
        source_indices: [1],
      }],
    };
    const missingQualifier = await engine.researchCompany('Acme', { title: 'VP Engineering' }, true);
    assert.deepEqual(missingQualifier.salary_estimates, []);
    db.close();
  });

  test('company grounding accepts punctuated titles and rejects cross-source ratings and adjacent role names', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    let generated = {
      culture_ratings: {},
      salary_estimates: [{
        title: 'Software Engineer',
        location: 'Toronto',
        currency: 'CAD',
        min: 100000,
        max: 120000,
        source_indices: [1],
      }],
    };
    let sources = [{
      title: 'Software Engineer Salary, Toronto',
      url: 'https://example.com/salary',
      content: 'Range CAD 100000 to 120000.',
    }];
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify(generated),
      () => 'alice',
    );
    engine.setSearchProvider({ async search() { return sources; } });

    const punctuated = await engine.researchCompany('Acme', { title: 'Software Engineer' }, true);
    assert.equal(punctuated.salary_estimates.length, 1);

    generated = {
      culture_ratings: {
        overall: 4.2,
        source_indices: { overall: [1, 2] },
      },
      salary_estimates: [],
    };
    sources = [
      {
        title: 'Acme rating label',
        url: 'https://example.com/rating-label',
        content: 'Overall rating',
      },
      {
        title: 'Unrelated score',
        url: 'https://example.com/unrelated-score',
        content: 'A different metric scored 4.2.',
      },
    ];
    const crossSourceRating = await engine.researchCompany('Acme', {}, true);
    assert.equal(crossSourceRating.culture_ratings.overall, undefined);

    generated = {
      culture_ratings: {},
      salary_estimates: [{
        title: 'Senior Software Engineer',
        location: 'Toronto',
        currency: 'CAD',
        min: 100000,
        max: 120000,
        source_indices: [1],
      }],
    };
    sources = [{
      title: 'Acme salary data',
      url: 'https://example.com/wrong-role',
      content: 'Senior Software Manager in Toronto: CAD 100000 to 120000.',
    }];
    const wrongRole = await engine.researchCompany('Acme', { title: 'Senior Software Engineer' }, true);
    assert.deepEqual(wrongRole.salary_estimates, []);

    generated = {
      culture_ratings: {},
      salary_estimates: [{
        title: 'Software Engineer',
        location: 'Toronto',
        currency: 'CAD',
        min: 100000,
        max: 120000,
        source_indices: [1],
      }],
    };
    sources = [{
      title: 'Acme salary data',
      url: 'https://example.com/plural-role',
      content: 'Software Engineers in Toronto: CAD 100000 to 120000.',
    }];
    const pluralRole = await engine.researchCompany('Acme', { title: 'Software Engineer' }, true);
    assert.equal(pluralRole.salary_estimates.length, 1);
    db.close();
  });

  test('company grounding preserves company conjunctions and isolates repeated labels and generic claims', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    let generated = {
      culture_ratings: {},
      salary_estimates: [{
        title: 'Software Engineer',
        location: 'Toronto',
        currency: 'CAD',
        min: 100000,
        max: 120000,
        source_indices: [1],
      }],
    };
    let sources = [{
      title: 'Johnson and Johnson Software Engineer Salary Toronto',
      url: 'https://example.com/johnson-salary',
      content: 'CAD 100000 to 120000.',
    }];
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify(generated),
      () => 'alice',
    );
    engine.setSearchProvider({ async search() { return sources; } });

    const companyConjunction = await engine.researchCompany(
      'Johnson and Johnson',
      { title: 'Software Engineer' },
      true,
    );
    assert.equal(companyConjunction.salary_estimates.length, 1);

    generated = {
      culture_ratings: {
        overall: 4.2,
        source_indices: { overall: [1] },
      },
      salary_estimates: [],
    };
    sources = [{
      title: 'Employee ratings',
      url: 'https://example.com/repeated-rating-label',
      content: 'Overall rating methodology. Current overall rating 4.2.',
    }];
    const repeatedRatingLabel = await engine.researchCompany('Acme', {}, true);
    assert.equal(repeatedRatingLabel.culture_ratings.overall, 4.2);

    generated = {
      culture_ratings: {},
      salary_estimates: [],
      hiring_strategy: 'structured panel technical leadership behavioral interviews process',
      source_indices: { hiring_strategy: [1, 2] },
    };
    sources = [
      {
        title: 'Onboarding',
        url: 'https://example.com/structured-onboarding',
        content: 'The company uses a structured technical assessment.',
      },
      {
        title: 'Interviews',
        url: 'https://example.com/panel-interviews',
        content: 'Candidates complete leadership interviews.',
      },
    ];
    const crossSourceClaim = await engine.researchCompany('Acme', {}, true);
    assert.equal(crossSourceClaim.hiring_strategy, '');
    assert.deepEqual(crossSourceClaim.citations.hiring_strategy, []);
    db.close();
  });

  test('company grounding rejects contradictory salary rows and unrelated rating phrases', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    let generated = {
      culture_ratings: {},
      salary_estimates: [{
        title: 'Software Engineer',
        location: 'Toronto',
        currency: 'CAD',
        min: 100000,
        max: 120000,
        source_indices: [1],
      }],
    };
    let sources = [{
      title: 'Software Engineer salaries in Toronto',
      url: 'https://example.com/contradictory-salary',
      content: '| Product Manager | Vancouver | CAD | 100000 | 120000 |',
    }];
    const engine = new CompanyResearchEngine(
      db,
      () => async () => JSON.stringify(generated),
      () => 'alice',
    );
    engine.setSearchProvider({ async search() { return sources; } });

    const contradictorySalary = await engine.researchCompany(
      'Acme',
      { title: 'Software Engineer' },
      true,
    );
    assert.deepEqual(contradictorySalary.salary_estimates, []);

    sources = [{
      title: 'Software Engineer salary',
      url: 'https://example.com/split-salary-evidence',
      content: 'Toronto: CAD 100000 to 120000.',
    }];
    const splitSalaryEvidence = await engine.researchCompany(
      'Acme',
      { title: 'Software Engineer' },
      true,
    );
    assert.equal(splitSalaryEvidence.salary_estimates.length, 1);

    sources = [{
      title: 'Software Engineer salary in Toronto',
      url: 'https://example.com/mixed-currency',
      content: 'USD/CAD 100000 to 120000.',
    }];
    const mixedCurrency = await engine.researchCompany(
      'Acme',
      { title: 'Software Engineer' },
      true,
    );
    assert.deepEqual(mixedCurrency.salary_estimates, []);

    generated = {
      culture_ratings: {
        management: 4.2,
        source_indices: { management: [1] },
      },
      salary_estimates: [],
    };
    sources = [{
      title: 'Risk controls',
      url: 'https://example.com/risk-management',
      content: 'Risk management score 4.2.',
    }];
    const unrelatedRating = await engine.researchCompany('Acme', {}, true);
    assert.equal(unrelatedRating.culture_ratings.management, undefined);

    sources = [{
      title: 'Employee reviews',
      url: 'https://example.com/employee-management-rating',
      content: 'Employees rate management 4.2.',
    }];
    const conversationalRating = await engine.researchCompany('Acme', {}, true);
    assert.equal(conversationalRating.culture_ratings.management, 4.2);

    sources = [{
      title: 'Employee reviews with approval result',
      url: 'https://example.com/management-rating-and-approval',
      content: 'Management rating 4.2; 82% approve of leadership.',
    }];
    const ratingWithUnrelatedPercentage = await engine.researchCompany('Acme', {}, true);
    assert.equal(ratingWithUnrelatedPercentage.culture_ratings.management, 4.2);

    sources = [{
      title: 'Employee reviews on a ten-point scale',
      url: 'https://example.com/ten-point-rating',
      content: 'Management rating 4.2/10.',
    }];
    const wrongRatingScale = await engine.researchCompany('Acme', {}, true);
    assert.equal(wrongRatingScale.culture_ratings.management, undefined);

    for (const [slug, content] of [
      ['stars-out-of-ten', 'Management rating 4.2 stars out of 10.'],
      ['ten-point-scale', 'Management rating 4.2 on a 10-point scale.'],
      ['textual-percent', 'Management rating 4.2 percent.'],
      ['hyphenated-stars', 'Management rating 4.2-star rating out of 10.'],
      ['word-based-scale', 'Management rating 4.2 out of ten.'],
      ['short-of-scale', 'Management rating 4.2 of 10.'],
      ['from-scale', 'Management rating 4.2 from 10.'],
    ]) {
      sources = [{
        title: 'Invalid employee rating scale',
        url: `https://example.com/${slug}`,
        content,
      }];
      const invalidScale = await engine.researchCompany('Acme', {}, true);
      assert.equal(invalidScale.culture_ratings.management, undefined);
    }

    sources = [{
      title: 'Employee review sample',
      url: 'https://example.com/review-count',
      content: 'Management rating 4.2 from 10 reviews.',
    }];
    const ratingWithReviewCount = await engine.researchCompany('Acme', {}, true);
    assert.equal(ratingWithReviewCount.culture_ratings.management, 4.2);

    sources = [{
      title: 'Compliance program',
      url: 'https://example.com/compliance-management',
      content: 'Risk and compliance management score 4.2.',
    }];
    const compoundManagement = await engine.researchCompany('Acme', {}, true);
    assert.equal(compoundManagement.culture_ratings.management, undefined);

    generated = {
      culture_ratings: {
        overall: 4.2,
        source_indices: { overall: [1] },
      },
      salary_estimates: [],
    };
    sources = [{
      title: 'Revenue report',
      url: 'https://example.com/overall-revenue',
      content: 'Overall revenue score was 4.2.',
    }];
    const unrelatedOverall = await engine.researchCompany('Acme', {}, true);
    assert.equal(unrelatedOverall.culture_ratings.overall, undefined);

    sources = [{
      title: 'Product quality report',
      url: 'https://example.com/product-quality',
      content: 'Overall score for product quality was 4.2.',
    }];
    const productQualityScore = await engine.researchCompany('Acme', {}, true);
    assert.equal(productQualityScore.culture_ratings.overall, undefined);

    sources = [{
      title: 'Employee attrition report',
      url: 'https://example.com/employee-attrition',
      content: 'Overall employee attrition was 4.2%.',
    }];
    const employeeMetric = await engine.researchCompany('Acme', {}, true);
    assert.equal(employeeMetric.culture_ratings.overall, undefined);

    generated = {
      culture_ratings: {},
      salary_estimates: [{
        title: 'Research and Development Engineer',
        location: 'Trinidad and Tobago',
        currency: 'USD',
        min: 100000,
        max: 120000,
        source_indices: [1],
      }],
    };
    sources = [{
      title: 'Acme Research and Development Engineer salary in Trinidad and Tobago',
      url: 'https://example.com/conjunction-title',
      content: 'USD 100000 to 120000.',
    }];
    const legitimateConjunctions = await engine.researchCompany(
      'Acme',
      { title: 'Research and Development Engineer' },
      true,
    );
    assert.equal(legitimateConjunctions.salary_estimates.length, 1);

    generated.salary_estimates[0].location = 'Turks and Caicos Islands';
    sources = [{
      title: 'Acme Research and Development Engineer salary in Turks and Caicos Islands',
      url: 'https://example.com/compound-location',
      content: 'USD 100000 to 120000.',
    }];
    const generalCompoundLocation = await engine.researchCompany(
      'Acme',
      { title: 'Research and Development Engineer' },
      true,
    );
    assert.equal(generalCompoundLocation.salary_estimates.length, 1);
    db.close();
  });

  test('trial privacy wipe explicitly deletes profile knowledge nodes in both handlers', () => {
    const source = fs.readFileSync(path.resolve(here, '../../ipcHandlers.ts'), 'utf8');
    for (const marker of ["safeHandle('trial:end-byok'", "safeHandle('trial:wipe-profile-data'"]) {
      const start = source.indexOf(marker);
      assert.ok(start >= 0, `missing ${marker}`);
      const block = source.slice(start, start + 9000);
      assert.match(block, /DELETE FROM knowledge_documents;\s+DELETE FROM knowledge_nodes;/);
    }
  });

  test('in-flight ingestion is discarded after an account switch', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    const orchestrator = new KnowledgeOrchestrator(db);
    let releaseExtraction;
    orchestrator.setGenerateContentFn(() => new Promise(resolve => {
      releaseExtraction = resolve;
    }));
    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'owner-switch-resume.txt',
    );
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, 'Asha Rao\\nEngineer at Acme\\nPython AWS\\nBuilt APIs');
    const pending = orchestrator.ingestDocument(fixturePath, DocType.RESUME);
    while (!releaseExtraction) await new Promise(resolve => setImmediate(resolve));
    orchestrator.setOwnerScope('bob');
    releaseExtraction(JSON.stringify(resume));
    const result = await pending;
    assert.equal(result.success, false);
    assert.match(result.error, /Account changed/);
    assert.equal(db.getDocumentByType(DocType.RESUME, 'local_default'), null);
    assert.equal(db.getDocumentByType(DocType.RESUME, 'bob'), null);
    fs.unlinkSync(fixturePath);
    db.close();
  });

  test('in-flight structured edit is discarded after an account switch', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME,
      owner_scope: 'local_default',
      source_uri: 'resume.pdf',
      structured_data: normalizeStructuredDocument(
        DocType.RESUME,
        resume,
        'Asha Rao Engineer Acme Python AWS',
      ),
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    const original = orchestrator.activeResume;
    let releaseEmbedding;
    let markEmbeddingStarted;
    const embeddingStarted = new Promise(resolve => {
      markEmbeddingStarted = resolve;
    });
    const embeddingGate = new Promise(resolve => {
      releaseEmbedding = resolve;
    });
    let firstEmbedding = true;
    orchestrator.setEmbedWithMetadataFn(async () => {
      if (firstEmbedding) {
        firstEmbedding = false;
        markEmbeddingStarted();
        await embeddingGate;
      }
      return { embedding: [0.1, 0.2], space: 'test-space' };
    });
    const pending = orchestrator.updateStructuredDocument(
      DocType.RESUME,
      { ...original.structured_data, identity: { ...original.structured_data.identity, name: 'Changed' } },
      original.revision,
    );
    await embeddingStarted;
    orchestrator.setOwnerScope('bob');
    releaseEmbedding();
    const result = await pending;
    assert.equal(result.success, false);
    assert.match(result.error, /Account changed/);
    assert.equal(db.getDocumentByType(DocType.RESUME, 'local_default').structured_data.identity.name, 'Asha Rao');
    assert.equal(db.getDocumentByType(DocType.RESUME, 'bob'), null);
    db.close();
  });

  test('company research does not send an old account JD to the model after owner switch', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    let owner = 'alice';
    let generateCalls = 0;
    const engine = new CompanyResearchEngine(
      db,
      () => async () => {
        generateCalls++;
        return '{}';
      },
      () => owner,
    );
    engine.setSearchProvider({
      async search() {
        owner = 'bob';
        return [];
      },
    });
    assert.equal(await engine.researchCompany('Acme', { title: 'Private role' }, true), null);
    assert.equal(generateCalls, 0);
    db.close();
  });

  test('company dossier IPC synchronizes profile ownership and has no retired search-provider import', () => {
    const source = fs.readFileSync(path.resolve(here, '../../ipcHandlers.ts'), 'utf8');
    for (const channel of ['profile:get-company-dossier', 'profile:research-company']) {
      const start = source.indexOf(`safeHandle('${channel}'`);
      const end = source.indexOf('\n  });', start);
      const body = source.slice(start, end);
      assert.ok(start >= 0);
      assert.match(body, /await syncProfileOwner\(\)/);
    }
    assert.doesNotMatch(source, /NativelySearchProvider/);
    assert.match(source, /getAllNodes\(ownerScope\)/);
    assert.match(source, /getAllProfilePacks\(ownerScope\)/);
  });

  test('switching profile owner clears account-bound negotiation and generated content', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    await orchestrator.processQuestion('What salary should I ask for?');
    await orchestrator.generateNegotiationScriptOnDemand();
    await orchestrator.generateCoverLetterOnDemand();
    assert.equal(orchestrator.getNegotiationTracker().isActive(), true);
    assert.ok(orchestrator.getNegotiationScript());
    assert.ok(orchestrator.getCoverLetter());

    orchestrator.setOwnerScope('different-user');
    assert.equal(orchestrator.getNegotiationTracker().isActive(), false);
    assert.equal(orchestrator.getNegotiationScript(), null);
    assert.equal(orchestrator.getCoverLetter(), null);
    db.close();
  });

  test('negotiation coaching obeys profile source authorization', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    db.replaceDocumentAndNodes({
      type: DocType.JD, owner_scope: 'local_default', source_uri: 'jd.txt',
      structured_data: { title: 'Platform Engineer', company: 'Orbit', requirements: [] },
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    let prompt = '';
    orchestrator.setLiveCoachingContentFn(async contents => {
      prompt = contents.map(item => item.text).join('\n');
      return JSON.stringify({
        tacticalNote: 'Ask for the range.', exactScript: 'What range is approved?',
        showSilenceTimer: true, phase: 'discovery',
        theirOffer: null, yourTarget: null, currency: '',
      });
    });

    const result = await orchestrator.processQuestion('What salary should I ask for?', ['profile_jd']);
    assert.ok(result?.liveNegotiationResponse);
    assert.match(prompt, /Candidate skills: not authorized/);
    assert.doesNotMatch(prompt, /Python|AWS|Asha Rao/);
    assert.match(prompt, /Target role: Platform Engineer/);
    assert.equal(
      await orchestrator.processQuestion('What salary should I ask for?', []),
      null,
      'coaching must bypass when no profile source is authorized',
    );
    db.close();
  });

  test('in-flight coaching response is discarded after an account switch', async () => {
    const db = new KnowledgeDatabaseManager(new Database(':memory:'));
    db.initializeSchema();
    db.replaceDocumentAndNodes({
      type: DocType.RESUME, owner_scope: 'local_default', source_uri: 'resume.pdf',
      structured_data: resume,
    }, []);
    const orchestrator = new KnowledgeOrchestrator(db);
    let resolveResponse;
    orchestrator.setLiveCoachingContentFn(() => new Promise(resolve => {
      resolveResponse = resolve;
    }));

    const pending = orchestrator.processQuestion('What salary should I ask for?');
    orchestrator.setOwnerScope('different-user');
    resolveResponse(JSON.stringify({
      tacticalNote: 'Old account advice', exactScript: 'Old account script',
      showSilenceTimer: true, phase: 'counter',
      theirOffer: null, yourTarget: null, currency: '',
    }));
    assert.equal(await pending, null);
    assert.equal(orchestrator.getNegotiationTracker().isActive(), false);
    db.close();
  });

  test('meeting teardown resets negotiation state', () => {
    const mainSource = fs.readFileSync(path.resolve(here, '../../main.ts'), 'utf8');
    const endMeetingStart = mainSource.indexOf('public async endMeeting()');
    const endMeetingEnd = mainSource.indexOf('public async ', endMeetingStart + 1);
    const endMeetingBody = mainSource.slice(
      endMeetingStart,
      endMeetingEnd === -1 ? mainSource.length : endMeetingEnd,
    );
    assert.match(endMeetingBody, /knowledgeOrchestrator\?\.resetNegotiationSession\?\.\(\)/);
    assert.match(
      mainSource,
      /if \(this\.isMeetingActive && segment\.isFinal && speaker === 'interviewer'\)/,
      'draining STT finals must not refill negotiation memory after meeting reset',
    );
  });

  test('failed derived-pack regeneration invalidates stale owner-scoped evidence', () => {
    // Every Electron TS entry is bundled independently, so monkey-patching the
    // builder entry would not patch the copy bundled into the orchestrator.
    // Pin the fail-closed branch at its production source boundary instead.
    const source = fs.readFileSync(
      path.resolve(here, '../../../premium/electron/knowledge/KnowledgeOrchestrator.ts'),
      'utf8',
    );
    assert.match(source, /result\.status === 'failed' \|\| result\.status === 'skipped_empty'/);
    assert.match(source, /builder\.deleteProfilePack\(docType, this\.ownerScope\)/);
  });
});
