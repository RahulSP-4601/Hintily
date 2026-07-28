import { SKILL_CATEGORIES, type CategorizedSkills } from './DocumentChunker';

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
export const classifySkill = (skill: unknown): keyof CategorizedSkills => {
  const value = clean(skill).toLowerCase();
  if (/^(r|go|sql)$|typescript|javascript|python|java\b|golang|c\+\+|c#|ruby|rust|swift|kotlin|php/.test(value)) return 'languages';
  if (/react|next\.?js|node\.?js|fastapi|django|spring|angular|vue|express|rails|laravel/.test(value)) return 'frameworks';
  if (/\baws\b|\bgcp\b|azure|vercel|cloudflare|heroku|firebase/.test(value)) return 'cloud';
  if (/postgres|mysql|redis|mongo|sqlite|snowflake|bigquery|pgvector|dynamodb/.test(value)) return 'databases';
  if (/pytorch|tensorflow|langchain|hugging face|pandas|\brag\b|\bllm\b|machine learning|ai\/ml/.test(value)) return 'ml';
  if (/docker|kubernetes|terraform|jenkins|github actions|ci\/cd|ansible|kafka|datadog/.test(value)) return 'devops';
  return 'tools';
};

const empty = (): CategorizedSkills => Object.fromEntries(
  SKILL_CATEGORIES.map((key): [keyof CategorizedSkills, string[]] => [key, []]),
) as CategorizedSkills;
const add = (result: CategorizedSkills, bucket: keyof CategorizedSkills, value: unknown) => {
  const skill = clean(value);
  if (skill && !result[bucket].some(existing => existing.toLowerCase() === skill.toLowerCase())) result[bucket].push(skill);
};

export const categorizeFlatSkills = (value: unknown): CategorizedSkills => {
  const result = empty();
  for (const skill of Array.isArray(value) ? value : []) add(result, classifySkill(skill), skill);
  return result;
};

export const coerceSkills = (value: unknown): CategorizedSkills => {
  if (Array.isArray(value)) return categorizeFlatSkills(value);
  const result = empty();
  if (!value || typeof value !== 'object') return result;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    for (const skill of Array.isArray(raw) ? raw : []) {
      add(result, (SKILL_CATEGORIES as readonly string[]).includes(key) ? key as keyof CategorizedSkills : 'tools', skill);
    }
  }
  return result;
};

export const flattenSkills = (value: unknown): string[] =>
  SKILL_CATEGORIES.flatMap(key => coerceSkills(value)[key]);
export const isLegacyFlatSkills = (value: unknown): boolean => Array.isArray(value);

export const detectSkillCategories = (question: unknown): Array<keyof CategorizedSkills> => {
  const value = clean(question).toLowerCase();
  const result: Array<keyof CategorizedSkills> = [];
  if (/programming language|\blanguages?\b/.test(value)) result.push('languages');
  if (/framework/.test(value)) result.push('frameworks');
  if (/cloud/.test(value)) result.push('cloud');
  if (/database/.test(value)) result.push('databases');
  if (/\bai\b|machine learning|\bml\b/.test(value)) result.push('ml');
  if (/devops|infrastructure|deployment/.test(value)) result.push('devops');
  return result;
};
