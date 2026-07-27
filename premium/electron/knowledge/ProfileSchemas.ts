import { createHash } from 'crypto';
import { SKILL_CATEGORIES, toCategorizedSkills } from './DocumentChunker';
import { DocType, type DocType as DocTypeValue } from './types';

export const PROFILE_SCHEMA_VERSION = 5;
const clean = (value: unknown, max = 4000): string =>
  String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (value: unknown, max = 100): string[] =>
  Array.from(new Set((Array.isArray(value) ? value : []).map(item => clean(item, 500)).filter(Boolean))).slice(0, max);
const objects = (value: unknown, max = 100): Record<string, any>[] =>
  (Array.isArray(value) ? value : []).filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(0, max);

export type SourceEvidence = {
  field: string;
  source: 'resume' | 'jd' | 'user';
  snippet: string;
  line_start: number | null;
  line_end: number | null;
  confidence: number;
};

const evidenceFor = (rawText: string, source: 'resume' | 'jd', facts: Array<[string, unknown]>): SourceEvidence[] => {
  const sourceLines = String(rawText || '').replace(/\r/g, '').split('\n');
  const evidence: SourceEvidence[] = [];
  for (const [field, rawValue] of facts) {
    const value = clean(rawValue, 300);
    if (!value) continue;
    const tokens = value.toLowerCase().split(/\W+/).filter(token => token.length > 2).slice(0, 4);
    const index = sourceLines.findIndex(line => tokens.length > 0 && tokens.every(token => line.toLowerCase().includes(token)));
    evidence.push({
      field, source,
      snippet: index >= 0 ? clean(sourceLines[index], 500) : '',
      line_start: index >= 0 ? index + 1 : null,
      line_end: index >= 0 ? index + 1 : null,
      confidence: index >= 0 ? 1 : 0.45,
    });
  }
  return evidence.slice(0, 300);
};

const normalizeEntries = (entries: unknown, fields: string[]) => objects(entries).map(entry => {
  const result: Record<string, any> = {};
  for (const field of fields) {
    result[field] = ['bullets', 'technologies', 'highlights'].includes(field)
      ? list(entry[field])
      : entry[field] == null ? (field.endsWith('_date') ? null : '') : clean(entry[field], 1000);
  }
  return result;
});

export const normalizeStructuredDocument = (
  docType: DocTypeValue,
  input: any,
  rawText = '',
  options: { mode?: string; userEdited?: boolean } = {},
): Record<string, any> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Structured document must be an object');
  if (JSON.stringify(input).length > 2_000_000) throw new Error('Structured document is too large');
  const mode = options.userEdited ? 'user_edited' : clean(options.mode || input._extraction_mode || 'unknown', 40);
  if (docType === DocType.RESUME) {
    const identity = input.identity && typeof input.identity === 'object' ? input.identity : {};
    const skills = toCategorizedSkills(input.skills ?? input.skills_flat ?? input.skillsFlat ?? []);
    const output: Record<string, any> = {
      _schema_version: PROFILE_SCHEMA_VERSION,
      _extraction_mode: mode,
      identity: {
        name: clean(identity.name, 200), email: clean(identity.email, 320), phone: clean(identity.phone, 100),
        location: clean(identity.location, 300), linkedin: clean(identity.linkedin, 500),
        github: clean(identity.github, 500), website: clean(identity.website, 500),
        summary: clean(identity.summary ?? input.summary, 5000),
      },
      summary: clean(input.summary ?? identity.summary, 5000),
      skills,
      skills_flat: SKILL_CATEGORIES.flatMap(key => skills[key]),
      experience: normalizeEntries(input.experience, ['company', 'role', 'location', 'start_date', 'end_date', 'bullets', 'technologies']),
      projects: normalizeEntries(input.projects, ['name', 'description', 'url', 'technologies', 'highlights']),
      education: normalizeEntries(input.education, ['institution', 'degree', 'field', 'location', 'start_date', 'end_date', 'gpa']),
      achievements: Array.isArray(input.achievements) ? input.achievements.slice(0, 100) : [],
      certifications: Array.isArray(input.certifications) ? input.certifications.slice(0, 100) : [],
      languages: list(input.languages),
      leadership: Array.isArray(input.leadership) ? input.leadership.slice(0, 100) : [],
      meeting_profile: input.meeting_profile && typeof input.meeting_profile === 'object' ? input.meeting_profile : null,
    };
    output.source_evidence = options.userEdited
      ? [{ field: '*', source: 'user', snippet: 'User-reviewed structured profile', line_start: null, line_end: null, confidence: 1 }]
      : evidenceFor(rawText, 'resume', [
        ['identity.name', output.identity.name],
        ...output.experience.flatMap((item: any, index: number) => [[`experience.${index}.company`, item.company], [`experience.${index}.role`, item.role]]),
        ...output.projects.map((item: any, index: number) => [`projects.${index}.name`, item.name]),
        ...output.education.map((item: any, index: number) => [`education.${index}.institution`, item.institution]),
        ...output.skills_flat.map((item: string, index: number) => [`skills_flat.${index}`, item]),
      ]);
    output.extraction_metadata = { parser_version: PROFILE_SCHEMA_VERSION, mode, source_hash: hashDocument(rawText) };
    return output;
  }
  const output: Record<string, any> = {
    _schema_version: PROFILE_SCHEMA_VERSION,
    _extraction_mode: mode,
    title: clean(input.title, 300),
    company: clean(input.company, 300),
    seniority: clean(input.seniority ?? input.level, 100),
    level: clean(input.level ?? input.seniority, 100),
    employment_type: clean(input.employment_type, 100),
    location: clean(input.location, 300),
    remote: input.remote == null ? null : clean(input.remote, 100),
    description_summary: clean(input.description_summary, 5000),
    responsibilities: list(input.responsibilities),
    requirements: list(input.requirements ?? input.required_skills),
    required_skills: list(input.required_skills ?? input.requirements),
    nice_to_haves: list(input.nice_to_haves ?? input.preferred_skills),
    preferred_skills: list(input.preferred_skills ?? input.nice_to_haves),
    min_years_experience: Number.isFinite(Number(input.min_years_experience)) ? Math.max(0, Math.min(80, Number(input.min_years_experience))) : null,
    technologies: list(input.technologies),
    education_requirements: list(input.education_requirements),
    compensation: input.compensation && typeof input.compensation === 'object'
      ? { explicit: Boolean(input.compensation.explicit), text: clean(input.compensation.text, 500) || null }
      : { explicit: Boolean(input.compensation_hint), text: clean(input.compensation_hint, 500) || null },
    compensation_hint: clean(input.compensation_hint ?? input.compensation?.text, 500),
    keywords: list(input.keywords),
  };
  output.source_evidence = options.userEdited
    ? [{ field: '*', source: 'user', snippet: 'User-reviewed structured job description', line_start: null, line_end: null, confidence: 1 }]
    : evidenceFor(rawText, 'jd', [
      ['title', output.title], ['company', output.company],
      ...output.requirements.map((item: string, index: number) => [`requirements.${index}`, item]),
      ...output.responsibilities.map((item: string, index: number) => [`responsibilities.${index}`, item]),
      ...output.technologies.map((item: string, index: number) => [`technologies.${index}`, item]),
    ]);
  output.extraction_metadata = { parser_version: PROFILE_SCHEMA_VERSION, mode, source_hash: hashDocument(rawText) };
  return output;
};

export const hashDocument = (rawText: string): string =>
  createHash('sha256').update(String(rawText || ''), 'utf8').digest('hex');
