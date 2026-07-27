import { DocType, type DocType as DocTypeValue, type KnowledgeNode } from './types';

export const SKILL_CATEGORIES = [
  'languages', 'frameworks', 'cloud', 'databases', 'ml', 'devops', 'tools',
] as const;

export type CategorizedSkills = Record<typeof SKILL_CATEGORIES[number], string[]>;

const clean = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
const unique = (values: unknown[]): string[] => Array.from(new Set(
  values.flatMap(value => Array.isArray(value) ? value : [value]).map(clean).filter(Boolean),
));

const bucketForSkill = (skill: string): keyof CategorizedSkills => {
  const value = skill.toLowerCase();
  if (/typescript|javascript|python|java\b|golang|\bgo\b|c\+\+|c#|\bsql\b|ruby|rust|swift|kotlin|php/.test(value)) return 'languages';
  if (/react|next\.?js|node\.?js|fastapi|django|spring|angular|vue|express|rails|laravel/.test(value)) return 'frameworks';
  if (/\baws\b|\bgcp\b|azure|vercel|cloudflare|heroku/.test(value)) return 'cloud';
  if (/postgres|mysql|redis|mongo|sqlite|snowflake|bigquery|pgvector|dynamodb|database/.test(value)) return 'databases';
  if (/pytorch|tensorflow|langchain|\brag\b|\bllm\b|machine learning|artificial intelligence|ai\/ml/.test(value)) return 'ml';
  if (/docker|kubernetes|terraform|jenkins|github actions|ci\/cd|ansible|devops/.test(value)) return 'devops';
  return 'tools';
};

export const toCategorizedSkills = (value: unknown): CategorizedSkills => {
  const result = Object.fromEntries(SKILL_CATEGORIES.map(key => [key, []])) as CategorizedSkills;
  if (Array.isArray(value)) {
    for (const skill of unique(value)) result[bucketForSkill(skill)].push(skill);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  const source = value as Record<string, unknown>;
  for (const key of SKILL_CATEGORIES) {
    result[key] = unique(Array.isArray(source[key]) ? source[key] as unknown[] : []);
  }
  for (const skill of unique([
    ...(Array.isArray(source.technical) ? source.technical : []),
    ...(Array.isArray(source.skills_flat) ? source.skills_flat : []),
  ])) {
    const bucket = bucketForSkill(skill);
    if (!result[bucket].includes(skill)) result[bucket].push(skill);
  }
  return result;
};

export const flattenSkills = (value: unknown): string[] => {
  const categorized = toCategorizedSkills(value);
  return unique(SKILL_CATEGORIES.flatMap(key => categorized[key]));
};

const node = (
  sourceType: DocTypeValue,
  category: string,
  title: unknown,
  content: unknown,
  sourcePath: string,
): KnowledgeNode | null => {
  const text = clean(content);
  if (!text) return null;
  return {
    source_type: sourceType,
    category,
    title: clean(title) || category,
    text_content: text,
    source_path: sourcePath,
    trust_level: 'parsed',
  };
};

const serialize = (value: unknown): string => Array.isArray(value)
  ? value.map(clean).filter(Boolean).join('; ')
  : clean(value);

export const createDocumentNodes = (
  structured: Record<string, any> | null | undefined,
  docType: DocTypeValue,
): KnowledgeNode[] => {
  if (!structured || typeof structured !== 'object') return [];
  const nodes: Array<KnowledgeNode | null> = [];
  if (docType === DocType.RESUME) {
    const identity = structured.identity || {};
    nodes.push(node(docType, 'identity', identity.name || 'Candidate identity', [
      identity.name, identity.location, identity.summary,
    ].map(clean).filter(Boolean).join(' — '), 'identity'));
    for (const [category, skills] of Object.entries(toCategorizedSkills(structured.skills))) {
      nodes.push(node(docType, `skills_${category}`, `${category} skills`, serialize(skills), `skills.${category}`));
    }
    (Array.isArray(structured.experience) ? structured.experience : []).forEach((entry: any, index: number) => {
      nodes.push(node(docType, 'experience', entry.role || entry.company || `Experience ${index + 1}`, [
        entry.role, entry.company, entry.start_date && `${entry.start_date}–${entry.end_date || 'present'}`,
        serialize(entry.bullets), serialize(entry.technologies),
      ].map(clean).filter(Boolean).join(' | '), `experience.${index}`));
    });
    (Array.isArray(structured.projects) ? structured.projects : []).forEach((entry: any, index: number) => {
      nodes.push(node(docType, 'projects', entry.name || `Project ${index + 1}`, [
        entry.description, serialize(entry.highlights), serialize(entry.technologies),
      ].map(clean).filter(Boolean).join(' | '), `projects.${index}`));
    });
    for (const category of ['education', 'achievements', 'certifications', 'languages', 'leadership']) {
      (Array.isArray(structured[category]) ? structured[category] : []).forEach((entry: any, index: number) => {
        const isObjectEntry = entry && typeof entry === 'object' && !Array.isArray(entry);
        const content = isObjectEntry
          ? Object.values(entry).map(serialize).filter(Boolean).join(' | ')
          : serialize(entry);
        nodes.push(node(
          docType,
          category,
          (isObjectEntry && (entry.name || entry.title || entry.institution)) || content || `${category} ${index + 1}`,
          content,
          `${category}.${index}`,
        ));
      });
    }
  } else {
    nodes.push(node(docType, 'jd_summary', structured.title || 'Job description', [
      structured.title, structured.company, structured.seniority || structured.level,
      structured.employment_type, structured.location, structured.remote,
      structured.description_summary,
    ].map(clean).filter(Boolean).join(' | '), 'job'));
    for (const category of [
      'responsibilities', 'required_skills', 'preferred_skills', 'requirements',
      'nice_to_haves', 'technologies', 'education_requirements',
    ]) {
      nodes.push(node(docType, `jd_${category}`, category, serialize(structured[category]), category));
    }
    if (structured.compensation?.explicit || structured.compensation_hint) {
      nodes.push(node(docType, 'jd_compensation', 'Explicit compensation',
        structured.compensation?.text || structured.compensation_hint, 'compensation'));
    }
  }
  return nodes.filter((item): item is KnowledgeNode => Boolean(item));
};
