import { heuristicResumeExtract, isDegenerateStructuredResume } from './HeuristicExtractor';
import {
  flattenSkills,
  SKILL_CATEGORIES,
  toCategorizedSkills,
  type CategorizedSkills,
} from './DocumentChunker';

type GenerateFn = (contents: Array<{ text: string }>) => Promise<any>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const MAX_RESUME_EXTRACTION_CHARS = 28_000;
const MAX_RESUME_EXTRACTION_CHUNKS = 4;
const MAX_RESUME_SOURCE_CHARS = MAX_RESUME_EXTRACTION_CHARS * MAX_RESUME_EXTRACTION_CHUNKS;
const RESUME_EXTRACTION_CONCURRENCY = 2;
const MAX_REPAIR_CONTEXT_CHARS = 24_000;

/**
 * Splits without deleting or duplicating a character. Prefer page/paragraph
 * boundaries, but always make progress when a document has one very long line.
 */
export const splitResumeSourceForExtraction = (
  source: string,
  maxChars = MAX_RESUME_EXTRACTION_CHARS,
): string[] => {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('resume chunk size must be positive');
  if (!source) return [''];
  const chunks: string[] = [];
  const maximumChunkCount = Math.ceil(source.length / maxChars);
  let offset = 0;
  while (offset < source.length) {
    const hardEnd = Math.min(source.length, offset + maxChars);
    let end = hardEnd;
    if (hardEnd < source.length) {
      const minimumUsefulBoundary = offset + Math.floor(maxChars * 0.6);
      const remainingChunkSlots = maximumChunkCount - chunks.length - 1;
      const boundaries = [
        source.lastIndexOf('\n[Page ', hardEnd),
        source.lastIndexOf('\n\n', hardEnd),
        source.lastIndexOf('\n', hardEnd),
      ].filter((candidate) =>
        candidate >= minimumUsefulBoundary
        && source.length - (candidate + 1) <= remainingChunkSlots * maxChars);
      if (boundaries.length) end = Math.max(...boundaries) + 1;
    }
    chunks.push(source.slice(offset, end));
    offset = end;
  }
  return chunks;
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const next = async (): Promise<void> => {
    const index = cursor;
    cursor += 1;
    if (index >= items.length) return;
    results[index] = await mapper(items[index], index);
    await next();
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => next()),
  );
  return results;
};

const stringifyBoundedRepairContext = (value: any): string => {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized.length <= MAX_REPAIR_CONTEXT_CHARS) return serialized;
  // Source chunks remain complete. This context is only a hint, so retain the
  // identity/skills needed to avoid contradictory repairs instead of allowing
  // an oversized prior extraction to overflow the provider context window.
  return JSON.stringify({
    identity: {
      name: value?.identity?.name || '',
      email: value?.identity?.email || '',
      phone: value?.identity?.phone || '',
      linkedin: value?.identity?.linkedin || '',
      github: value?.identity?.github || '',
      website: value?.identity?.website || '',
      location: value?.identity?.location || '',
    },
    skills: Object.fromEntries(
      SKILL_CATEGORIES.map((category) => [
        category,
        normalizeArray(value?.skills?.[category]).slice(0, 100),
      ]),
    ),
    note: 'Prior structured context was too large; reconstruct remaining fields from this source chunk.',
  }, null, 2);
};

const normalizeLine = (value: unknown): string =>
  String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

const normalizeParagraph = (value: unknown): string =>
  String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const unique = (items: string[]): string[] => Array.from(new Set(items.map((item) => normalizeLine(item)).filter(Boolean)));
const MONTH_LOOKUP: Record<string, string> = {
  jan: '01',
  january: '01',
  feb: '02',
  february: '02',
  mar: '03',
  march: '03',
  apr: '04',
  april: '04',
  may: '05',
  jun: '06',
  june: '06',
  jul: '07',
  july: '07',
  aug: '08',
  august: '08',
  sep: '09',
  sept: '09',
  september: '09',
  oct: '10',
  october: '10',
  nov: '11',
  november: '11',
  dec: '12',
  december: '12',
};

const normalizeArray = <T>(value: T | T[] | null | undefined): T[] => (Array.isArray(value) ? value : value == null ? [] : [value]);

const cleanUrl = (value: unknown): string => {
  const text = normalizeLine(value).replace(/[),.;]+$/g, '');
  return /^(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?$/i.test(text) ? text : '';
};

const splitLooseList = (value: string): string[] =>
  value
    .split(/\r?\n|[|•▪●◦]+|,(?![^()]*\))/)
    .map((item) => normalizeLine(item.replace(/^[-*]\s*/, '')))
    .filter(Boolean);

const splitBulletLines = (value: string): string[] =>
  value
    .split(/\r?\n|[•▪●◦]+/)
    .map((item) => normalizeLine(item.replace(/^[-*]\s*/, '')))
    .filter(Boolean);

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') out.push(...splitLooseList(item));
      else if (item && typeof item === 'object') {
        const candidate = normalizeLine((item as any).name ?? (item as any).skill ?? (item as any).value ?? '');
        if (candidate) out.push(candidate);
      } else if (item != null) out.push(normalizeLine(item));
    }
    return unique(out);
  }
  if (typeof value === 'string') return unique(splitLooseList(value));
  if (value == null) return [];
  return unique([normalizeLine(value)]);
};

const toBulletArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') out.push(...splitBulletLines(item));
      else if (item != null) out.push(normalizeLine(item));
    }
    return unique(out);
  }
  if (typeof value === 'string') return unique(splitBulletLines(value));
  if (value == null) return [];
  return unique([normalizeLine(value)]);
};

// Narrative fields commonly contain commas inside a single fact. Treating a
// comma as a list separator corrupts achievements such as
// "Reduced latency by 40%, serving 2M requests". Only real line/bullet
// boundaries split these fields.
const toNarrativeArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return unique(value.flatMap((item) => toNarrativeArray(item)));
  }
  if (typeof value === 'string') return unique(splitBulletLines(value));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const heading = normalizeLine(
      record.title ?? record.name ?? record.achievement ?? record.award ?? '',
    );
    const detail = normalizeParagraph(
      record.description ?? record.detail ?? record.text ?? record.value ?? '',
    );
    const date = normalizeLine(record.date ?? record.year ?? '');
    const narrative = unique([
      heading && detail && heading.toLowerCase() !== detail.toLowerCase()
        ? `${heading}: ${detail}`
        : heading || detail,
      date,
    ]).join(' ');
    return narrative ? [narrative] : [];
  }
  return value == null ? [] : unique([normalizeLine(value)]);
};

const parseMaybeDate = (value: unknown): string | null => {
  const text = normalizeLine(value).replace(/[–—]/g, '-').replace(/[‘’']/g, "'");
  if (!text) return null;
  if (/present|current/i.test(text)) return 'present';
  const isoMonth = text.match(/^(\d{4})[-/](\d{2})$/);
  if (isoMonth) return `${isoMonth[1]}-${isoMonth[2]}`;
  const dottedMonth = text.match(/^(\d{4})\.(\d{2})$/);
  if (dottedMonth) return `${dottedMonth[1]}-${dottedMonth[2]}`;
  const monthYear = text.match(/\b([A-Za-z]{3,9})\s*'?(\d{2}|\d{4})\b/);
  if (monthYear) {
    const month = MONTH_LOOKUP[monthYear[1].toLowerCase().replace(/\./g, '')];
    if (month) {
      const rawYear = monthYear[2];
      const fullYear = rawYear.length === 2 ? `${Number(rawYear) >= 70 ? '19' : '20'}${rawYear}` : rawYear;
      return `${fullYear}-${month}`;
    }
  }
  const year = text.match(/\b(19|20)\d{2}\b/);
  return year ? year[0] : null;
};

const readOptionalDate = (
  raw: Record<string, unknown>,
  keys: string[],
): string | null | undefined => {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined) continue;
    if (raw[key] === null) return null;
    const text = normalizeLine(raw[key]);
    if (!text) return undefined;
    return parseMaybeDate(text) ?? undefined;
  }
  return undefined;
};

const stripSummaryNoise = (value: unknown): string =>
  normalizeParagraph(value)
    .replace(/\b(?:selected\s+)?(?:impact\s+)?highlights\b[\s\S]*$/i, '')
    .replace(/\b(?:skills|experience|projects|education|certifications|leadership)\b\s*:?\s*$/i, '')
    .trim();

const mergeCategorizedSkills = (...sources: unknown[]): CategorizedSkills => {
  const merged = Object.fromEntries(
    SKILL_CATEGORIES.map((category) => [category, [] as string[]]),
  ) as CategorizedSkills;
  const seen = new Set<string>();
  for (const source of sources) {
    const categorized = toCategorizedSkills(source);
    for (const category of SKILL_CATEGORIES) {
      for (const skill of categorized[category]) {
        const key = normalizeLine(skill).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged[category].push(skill);
      }
    }
  }
  for (const category of SKILL_CATEGORIES) merged[category] = unique(merged[category]);
  return merged;
};

const sanitizeIdentity = (raw: any, heuristic: any) => {
  const identity = raw?.identity && typeof raw.identity === 'object' ? raw.identity : {};
  const summary =
    stripSummaryNoise(
      identity.summary ??
        raw?.summary ??
        raw?.professional_summary ??
        raw?.profile_summary ??
        raw?.ai_summary ??
        heuristic?.identity?.summary ??
        '',
    ) || '';
  return {
    name: normalizeLine(identity.name ?? raw?.name ?? raw?.candidate_name ?? heuristic?.identity?.name ?? ''),
    email: normalizeLine(identity.email ?? raw?.email ?? heuristic?.identity?.email ?? ''),
    phone: normalizeLine(identity.phone ?? identity.mobile_number ?? raw?.phone ?? raw?.mobile_number ?? heuristic?.identity?.phone ?? ''),
    linkedin: cleanUrl(identity.linkedin ?? raw?.linkedin ?? heuristic?.identity?.linkedin ?? ''),
    github: cleanUrl(identity.github ?? raw?.github ?? heuristic?.identity?.github ?? ''),
    website: cleanUrl(identity.website ?? raw?.website ?? raw?.portfolio ?? ''),
    location: normalizeLine(identity.location ?? raw?.location ?? ''),
    summary,
  };
};

const sanitizeBullets = (value: unknown): string[] =>
  unique(
    toBulletArray(value)
      .map((item) => item.replace(/^[-*]\s*/, ''))
      .filter((item) => !/^\[Page\s+\d+\]$/i.test(item))
      .filter((item) => item.length <= 280),
  );

const splitRoleCompany = (role: string, company: string): { role: string; company: string } => {
  const normalizedRole = normalizeLine(role);
  const normalizedCompany = normalizeLine(company);
  if (normalizedRole && (!normalizedCompany || /\b[A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+/.test(normalizedCompany))) {
    const commaMatch = normalizedRole.match(/^(.+?),\s*([^,]+)$/);
    if (commaMatch) return { role: normalizeLine(commaMatch[1]), company: normalizeLine(commaMatch[2]) };
  }
  return { role: normalizedRole, company: normalizedCompany };
};

const parseLocationDateBlob = (value: string): { location: string; start_date?: string; end_date?: string | null } => {
  const text = normalizeLine(value).replace(/[–—]/g, '-');
  const rangeMatch = text.match(/^(.*?)(?:\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*\s*[’']?\d{2,4}.*))$/i);
  if (!rangeMatch) return { location: text };
  const location = normalizeLine(rangeMatch[1].replace(/[|·•]+/g, ' '));
  const rangeText = normalizeLine(rangeMatch[2]);
  const parts = rangeText.split(/\s*-\s*/).map(normalizeLine).filter(Boolean);
  const startDate = parseMaybeDate(parts[0] || rangeText);
  const endDate =
    /present|current/i.test(rangeText)
      ? null
      : parts[1]
        ? parseMaybeDate(parts[1])
        : undefined;
  return {
    location,
    ...(startDate ? { start_date: startDate } : {}),
    ...(endDate !== undefined ? { end_date: endDate } : {}),
  };
};

const mergeContinuationExperienceEntries = (items: any[]): any[] => {
  const merged: any[] = [];
  for (const item of items) {
    if (!item) continue;
    const hasIdentity = Boolean(normalizeLine(item.role) || normalizeLine(item.company));
    if (!hasIdentity && merged.length > 0) {
      const previous = merged[merged.length - 1];
      previous.bullets = unique([...(previous.bullets || []), ...(item.bullets || [])]);
      continue;
    }
    merged.push(item);
  }
  return merged;
};

const sanitizeExperienceEntry = (raw: any) => {
  if (!raw || typeof raw !== 'object') return null;
  const rawCompanyText = normalizeLine(raw.company ?? raw.organization ?? raw.employer ?? raw.org ?? '');
  const headerLine = normalizeLine(Array.isArray(raw.source_span) ? raw.source_span[0] || '' : '');
  const split = splitRoleCompany(
    raw.role ?? raw.title ?? raw.position ?? raw.designation ?? '',
    rawCompanyText,
  );
  let role = split.role;
  let company = split.company;
  let location = normalizeLine(raw.location ?? '');
  const bullets = sanitizeBullets(raw.bullets ?? raw.highlights ?? raw.responsibilities ?? raw.summary ?? raw.description ?? '');
  let startDate = readOptionalDate(raw, ['start_date', 'startDate', 'from', 'date_from']);
  let endDate = readOptionalDate(raw, ['end_date', 'endDate', 'to', 'date_to']);
  const locationCandidate = rawCompanyText && rawCompanyText !== company ? rawCompanyText : company;
  if (locationCandidate && !location && /\b[A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+/.test(locationCandidate) && !/\b(inc|llc|labs|systems|group|company|technologies)\b/i.test(locationCandidate)) {
    const parsed = parseLocationDateBlob(locationCandidate);
    if (parsed.location) {
      location = parsed.location;
      if (locationCandidate === company) company = '';
      if (!startDate && parsed.start_date) startDate = parsed.start_date;
      if (endDate !== undefined) {
        // keep explicit end date from source
      } else if (parsed.end_date !== undefined) {
        endDate = parsed.end_date;
      }
    }
  }
  if (headerLine && (!location || !startDate)) {
    const afterDash = headerLine.split(/\s+—\s+/).slice(1).join(' — ');
    const parsed = parseLocationDateBlob(afterDash || headerLine);
    if (!location && parsed.location) location = parsed.location;
    if (!startDate && parsed.start_date) startDate = parsed.start_date;
    if (endDate !== undefined) {
      // keep explicit end date from source
    } else if (parsed.end_date !== undefined) {
      endDate = parsed.end_date;
    }
  }
  if (!role && !company && bullets.length === 0) return null;
  return {
    role,
    company,
    ...(location ? { location } : {}),
    start_date: startDate && startDate !== 'present' ? startDate : undefined,
    ...((endDate === null || endDate === 'present') ? { end_date: null } : endDate ? { end_date: endDate } : {}),
    bullets,
  };
};

const sanitizeProjectEntry = (raw: any) => {
  if (!raw || typeof raw !== 'object') return null;
  const name = normalizeLine(raw.name ?? raw.title ?? raw.project ?? '');
  const description = normalizeParagraph(raw.description ?? raw.summary ?? '');
  const technologies = unique([
    ...toStringArray(raw.technologies ?? raw.tech_stack ?? raw.tools ?? []),
    ...toStringArray(raw.skills ?? []),
  ]);
  const highlights = sanitizeBullets(raw.highlights ?? raw.bullets ?? raw.description ?? '');
  const url = cleanUrl(raw.url ?? raw.link ?? raw.website ?? '');
  if (!name && !description && technologies.length === 0) return null;
  return { name, description, technologies, highlights, url };
};

const sanitizeEducationEntry = (raw: any) => {
  if (!raw || typeof raw !== 'object') return null;
  const institution = normalizeLine(raw.institution ?? raw.school ?? raw.university ?? raw.college ?? raw.college_name ?? '');
  const degree = normalizeLine(raw.degree ?? raw.program ?? raw.qualification ?? '');
  const field = normalizeLine(raw.field ?? raw.major ?? raw.specialization ?? '');
  const startDate = parseMaybeDate(raw.start_date ?? raw.startDate ?? raw.from ?? '');
  const endDate = parseMaybeDate(raw.end_date ?? raw.endDate ?? raw.to ?? '');
  const gpa = normalizeLine(raw.gpa ?? '');
  const thesis = normalizeParagraph(raw.thesis ?? '');
  if (!institution && !degree && !field) return null;
  return {
    institution,
    degree,
    field,
    start_date: startDate && startDate !== 'present' ? startDate : undefined,
    end_date: endDate === 'present' ? undefined : endDate || undefined,
    gpa,
    thesis,
  };
};

const scoreExperience = (items: any[]): number =>
  normalizeArray(items).reduce((score, item) => {
    if (!item || typeof item !== 'object') return score;
    return (
      score +
      (normalizeLine(item.role).length ? 2 : 0) +
      (normalizeLine(item.company).length ? 2 : 0) +
      ((Array.isArray(item.bullets) ? item.bullets.length : 0) > 0 ? 1 : 0) +
      (item.start_date || item.end_date === null || item.end_date ? 1 : 0)
    );
  }, 0);

const scoreProjects = (items: any[]): number =>
  normalizeArray(items).reduce((score, item) => {
    if (!item || typeof item !== 'object') return score;
    return (
      score +
      (normalizeLine(item.name).length ? 2 : 0) +
      (normalizeParagraph(item.description).length ? 2 : 0) +
      ((Array.isArray(item.technologies) ? item.technologies.length : 0) > 0 ? 1 : 0) +
      ((Array.isArray(item.highlights) ? item.highlights.length : 0) > 0 ? 1 : 0)
    );
  }, 0);

const scoreEducation = (items: any[]): number =>
  normalizeArray(items).reduce((score, item) => {
    if (!item || typeof item !== 'object') return score;
    return (
      score +
      (normalizeLine(item.institution).length ? 2 : 0) +
      (normalizeLine(item.degree).length ? 2 : 0) +
      (normalizeLine(item.field).length ? 1 : 0) +
      (item.start_date || item.end_date ? 1 : 0)
    );
  }, 0);

const pickBestArray = (arrays: any[][], scorer: (items: any[]) => number): any[] => {
  let best: any[] = [];
  let bestScore = -1;
  for (const candidate of arrays) {
    const next = Array.isArray(candidate) ? candidate : [];
    const score = scorer(next);
    if (score > bestScore || (score === bestScore && next.length > best.length)) {
      best = next;
      bestScore = score;
    }
  }
  return best;
};

const buildLegacyExperience = (raw: any): any[] => {
  const companies = toStringArray(raw?.company_names ?? raw?.companies ?? []);
  const roles = toStringArray(raw?.designation ?? raw?.designations ?? raw?.roles ?? []);
  const count = Math.max(companies.length, roles.length);
  const items: any[] = [];
  for (let index = 0; index < count; index += 1) {
    const role = roles[index] || '';
    const company = companies[index] || '';
    if (role || company) items.push({ role, company, bullets: [] });
  }
  return items;
};

const buildLegacyEducation = (raw: any): any[] => {
  const institutions = toStringArray(raw?.college_name ?? raw?.college_names ?? raw?.schools ?? []);
  const degrees = toStringArray(raw?.degree ?? raw?.degrees ?? []);
  const count = Math.max(institutions.length, degrees.length);
  const items: any[] = [];
  for (let index = 0; index < count; index += 1) {
    const institution = institutions[index] || '';
    const degree = degrees[index] || '';
    if (institution || degree) items.push({ institution, degree, field: '' });
  }
  return items;
};

const buildDeterministicMeetingProfile = (resume: any) => {
  const experience = Array.isArray(resume?.experience) ? resume.experience : [];
  const latest = experience[0] || {};
  const skills = flattenSkills(toCategorizedSkills(resume?.skills));
  const summary = stripSummaryNoise(resume?.identity?.summary || '');
  const years =
    experience
      .map((item: any) => String(item?.start_date || '').match(/^(\d{4})/)?.[1])
      .filter(Boolean)
      .map(Number)
      .reduce((min: number | null, year: number) => (min == null ? year : Math.min(min, year)), null) || null;
  const totalYears = years ? Math.max(0, new Date().getFullYear() - years) : null;
  const headline =
    normalizeLine(
      summary ||
        [latest?.role, latest?.company ? `at ${latest.company}` : '']
          .filter(Boolean)
          .join(' ') ||
        skills.slice(0, 3).join(', '),
    ) || '';
  const strengths = unique([
    ...toStringArray(resume?.meeting_profile?.core_strengths ?? []),
    ...toStringArray(resume?.ai_strengths ?? []),
    ...(skills.length >= 3 ? [`Strong hands-on coverage across ${skills.slice(0, 3).join(', ')}`] : []),
    ...(latest?.company && latest?.role ? [`Most recent role: ${latest.role} at ${latest.company}`] : []),
    ...(summary ? [summary] : []),
  ]).slice(0, 4);
  const suggestedIntro =
    normalizeParagraph(
      resume?.meeting_profile?.suggested_intro ||
        [
          resume?.identity?.name ? `I'm ${resume.identity.name}.` : '',
          totalYears ? `I bring about ${totalYears}+ years of experience.` : '',
          latest?.role ? `Most recently I worked as ${latest.role}${latest.company ? ` at ${latest.company}` : ''}.` : '',
          skills.length ? `My core stack includes ${skills.slice(0, 5).join(', ')}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
    ) || '';
  return {
    professional_headline: headline,
    suggested_intro: suggestedIntro,
    core_strengths: strengths,
    top_skills: skills.slice(0, 8),
  };
};

const sanitizeResumeCandidate = (raw: any, heuristic?: any): any => {
  const heuristicProfile = heuristic && typeof heuristic === 'object' ? heuristic : heuristicResumeExtract('');
  const sanitizedIdentity = sanitizeIdentity(raw, heuristicProfile);
  const rawSkills = raw?.skills ?? raw?.skillsFlat ?? raw?.skills_flat ?? [];
  const explicitSkills = rawSkills && typeof rawSkills === 'object' && !Array.isArray(rawSkills)
    ? toCategorizedSkills(rawSkills)
    : toCategorizedSkills(toStringArray(rawSkills));
  // Keep categories supplied by a structured extractor. Flattening and then
  // re-classifying them discarded useful distinctions (for example Firebase
  // being explicitly identified as a database).
  const skills = mergeCategorizedSkills(
    explicitSkills,
    toStringArray(raw?.technologies ?? []),
    heuristicProfile?.skills ?? heuristicProfile?.skillsFlat ?? heuristicProfile?.skills_flat ?? [],
  );
  const experience = pickBestArray(
    [
      normalizeArray(raw?.experience).map(sanitizeExperienceEntry).filter(Boolean),
      buildLegacyExperience(raw).map(sanitizeExperienceEntry).filter(Boolean),
      Array.isArray(heuristicProfile?.experience) ? heuristicProfile.experience : [],
    ],
    scoreExperience,
  );
  const projects = pickBestArray(
    [
      normalizeArray(raw?.projects).map(sanitizeProjectEntry).filter(Boolean),
      Array.isArray(heuristicProfile?.projects) ? heuristicProfile.projects : [],
    ],
    scoreProjects,
  );
  const education = pickBestArray(
    [
      normalizeArray(raw?.education).map(sanitizeEducationEntry).filter(Boolean),
      buildLegacyEducation(raw).map(sanitizeEducationEntry).filter(Boolean),
      Array.isArray(heuristicProfile?.education) ? heuristicProfile.education : [],
    ],
    scoreEducation,
  );
  const achievements = unique([
    ...toNarrativeArray(raw?.achievements ?? []),
    ...toNarrativeArray(raw?.awards ?? []),
  ]);
  const certifications = unique([
    ...toNarrativeArray(raw?.certifications ?? []),
    ...toNarrativeArray(raw?.licenses ?? []),
  ]);
  const leadership = unique([
    ...toNarrativeArray(raw?.leadership ?? []),
    ...toNarrativeArray(raw?.activities ?? []),
  ]);
  const next: any = {
    identity: sanitizedIdentity,
    skills,
    skillsFlat: flattenSkills(skills),
    skills_flat: flattenSkills(skills),
    experience: mergeContinuationExperienceEntries(experience),
    projects,
    education,
    achievements,
    certifications,
    leadership,
    meeting_profile: buildDeterministicMeetingProfile({
      identity: sanitizedIdentity,
      skills,
      experience,
      projects,
      education,
      achievements,
      certifications,
      leadership,
      meeting_profile: raw?.meeting_profile,
      ai_strengths: raw?.ai_strengths,
    }),
    _schema_version: 2,
  };
  next._parser_metadata = {
    ...(raw?._parser_metadata && typeof raw._parser_metadata === 'object' ? raw._parser_metadata : {}),
    parser_version: raw?._parser_metadata?.parser_version || 'resume_refiner_v1',
    source_shape: raw?.company_names || raw?.college_name || raw?.designation ? 'legacy_flat' : 'structured',
  };
  return next;
};

const mergeResumeCandidates = (candidates: Array<any | null | undefined>): any => {
  const usable = candidates.filter((candidate) => candidate && typeof candidate === 'object').map((candidate) => sanitizeResumeCandidate(candidate));
  if (!usable.length) return sanitizeResumeCandidate({});
  const identity = {
    name: usable.map((item) => normalizeLine(item?.identity?.name)).find(Boolean) || '',
    email: usable.map((item) => normalizeLine(item?.identity?.email)).find(Boolean) || '',
    phone: usable.map((item) => normalizeLine(item?.identity?.phone)).find(Boolean) || '',
    linkedin: usable.map((item) => cleanUrl(item?.identity?.linkedin)).find(Boolean) || '',
    github: usable.map((item) => cleanUrl(item?.identity?.github)).find(Boolean) || '',
    website: usable.map((item) => cleanUrl(item?.identity?.website)).find(Boolean) || '',
    location: usable.map((item) => normalizeLine(item?.identity?.location)).find(Boolean) || '',
    summary: usable
      .map((item) => stripSummaryNoise(item?.identity?.summary))
      .filter((value) => value && value.length >= 24)
      .sort((a, b) => b.length - a.length)[0] || '',
  };
  const skills = mergeCategorizedSkills(...usable.map((item) => item?.skills));
  const merged = {
    identity,
    skills,
    skillsFlat: flattenSkills(skills),
    skills_flat: flattenSkills(skills),
    experience: pickBestArray(usable.map((item) => item.experience || []), scoreExperience),
    projects: pickBestArray(usable.map((item) => item.projects || []), scoreProjects),
    education: pickBestArray(usable.map((item) => item.education || []), scoreEducation),
    achievements: unique(usable.flatMap((item) => toNarrativeArray(item?.achievements))),
    certifications: unique(usable.flatMap((item) => toNarrativeArray(item?.certifications))),
    leadership: unique(usable.flatMap((item) => toNarrativeArray(item?.leadership))),
    _schema_version: 2,
  };
  return {
    ...merged,
    meeting_profile: buildDeterministicMeetingProfile(merged),
    _parser_metadata: {
      parser_version: 'resume_refiner_v1',
      source_shape: usable.some((item) => item?._parser_metadata?.source_shape === 'legacy_flat') ? 'legacy_flat' : 'structured',
    },
  };
};

const mergeAllChunkEntries = (candidates: Array<any | null | undefined>): any => {
  const usable = candidates
    .filter((candidate) => candidate && typeof candidate === 'object')
    .map((candidate) => sanitizeResumeCandidate(candidate));
  if (!usable.length) return sanitizeResumeCandidate({});
  const base = mergeResumeCandidates(usable);
  const uniqueObjects = (items: any[]): any[] => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const datesAreCompatible = (left: any, right: any): boolean => {
    const valuesMatch = (leftValue: unknown, rightValue: unknown): boolean =>
      leftValue === undefined || rightValue === undefined || leftValue === rightValue;
    return valuesMatch(left?.start_date, right?.start_date)
      && valuesMatch(left?.end_date, right?.end_date);
  };
  const mergeExperienceEntries = (items: any[]): any[] => {
    const merged: any[] = [];
    for (const item of mergeContinuationExperienceEntries(uniqueObjects(items))) {
      const role = normalizeLine(item?.role).toLowerCase();
      const company = normalizeLine(item?.company).toLowerCase();
      const existing = role && company
        ? merged.find((candidate) =>
          normalizeLine(candidate?.role).toLowerCase() === role
          && normalizeLine(candidate?.company).toLowerCase() === company
          && datesAreCompatible(candidate, item))
        : undefined;
      if (!existing) {
        merged.push(item);
        continue;
      }
      existing.location ||= item.location;
      existing.start_date ??= item.start_date;
      if (existing.end_date === undefined && item.end_date !== undefined) {
        existing.end_date = item.end_date;
      }
      existing.bullets = unique([
        ...toBulletArray(existing.bullets),
        ...toBulletArray(item.bullets),
      ]);
    }
    return merged;
  };
  const mergeProjectEntries = (items: any[]): any[] => {
    const merged: any[] = [];
    for (const item of uniqueObjects(items)) {
      const name = normalizeLine(item?.name).toLowerCase();
      const existing = name
        ? merged.find((candidate) => {
          if (normalizeLine(candidate?.name).toLowerCase() !== name) return false;
          const candidateUrl = cleanUrl(candidate?.url).toLowerCase();
          const itemUrl = cleanUrl(item?.url).toLowerCase();
          return !candidateUrl || !itemUrl || candidateUrl === itemUrl;
        })
        : undefined;
      if (!existing) {
        merged.push(item);
        continue;
      }
      if (normalizeParagraph(item.description).length > normalizeParagraph(existing.description).length) {
        existing.description = item.description;
      }
      existing.url ||= item.url;
      existing.technologies = unique([
        ...normalizeArray(existing.technologies),
        ...normalizeArray(item.technologies),
      ]);
      existing.highlights = unique([
        ...toBulletArray(existing.highlights),
        ...toBulletArray(item.highlights),
      ]);
    }
    return merged;
  };
  const merged = {
    ...base,
    skills: mergeCategorizedSkills(...usable.map((item) => item.skills)),
    experience: mergeExperienceEntries(usable.flatMap((item) => item.experience || [])),
    projects: mergeProjectEntries(usable.flatMap((item) => item.projects || [])),
    education: uniqueObjects(usable.flatMap((item) => item.education || [])),
    achievements: unique(usable.flatMap((item) => toNarrativeArray(item.achievements))),
    certifications: unique(usable.flatMap((item) => toNarrativeArray(item.certifications))),
    leadership: unique(usable.flatMap((item) => toNarrativeArray(item.leadership))),
  };
  merged.skillsFlat = flattenSkills(merged.skills);
  merged.skills_flat = merged.skillsFlat;
  merged.meeting_profile = buildDeterministicMeetingProfile(merged);
  return merged;
};

const extractJsonObject = (raw: string): unknown | null => {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = (fenced?.[1] || text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

const evidenceTokens = (value: string): string[] =>
  normalizeParagraph(value)
    .toLowerCase()
    .match(/[\p{L}\p{N}+#.]+/gu)
    ?.filter((token) => token.length > 2) || [];

type ResumeBulletSection = 'experience' | 'projects' | 'achievements' | 'leadership' | 'unknown';

interface SourceBulletAtom {
  text: string;
  section: ResumeBulletSection;
  context: string[];
}

const classifyResumeSection = (line: string, current: ResumeBulletSection): ResumeBulletSection => {
  const heading = normalizeLine(line).replace(/[:：]$/, '').toLowerCase();
  if (/^(?:professional |work )?experience$|^employment(?: history)?$/.test(heading)) return 'experience';
  if (/^(?:selected |personal |academic )?projects?$/.test(heading)) return 'projects';
  if (/^(?:(?:key|selected impact) )?(?:achievements?|highlights|awards?|honors?)$/.test(heading)) return 'achievements';
  if (/^(?:leadership|activities|volunteering|extracurriculars?)$/.test(heading)) return 'leadership';
  if (/^(?:education|skills?|summary|profile|certifications?|courses?|interests?)$/.test(heading)) return 'unknown';
  return current;
};

const extractSourceBulletAtoms = (rawText: string): SourceBulletAtom[] => {
  const lines = String(rawText || '').replace(/\r/g, '').split('\n');
  const atoms: SourceBulletAtom[] = [];
  const recentContext: string[] = [];
  let section: ResumeBulletSection = 'unknown';
  let current = '';
  let currentSection: ResumeBulletSection = 'unknown';
  let currentContext: string[] = [];
  const flush = () => {
    const text = normalizeParagraph(current);
    if (text.length >= 24 && evidenceTokens(text).length >= 5) {
      atoms.push({ text, section: currentSection, context: [...currentContext] });
    }
    current = '';
    currentContext = [];
  };

  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    const nextSection = classifyResumeSection(line, section);
    if (nextSection !== section || /^(?:education|skills?|summary|profile|certifications?|courses?|interests?)[:：]?$/i.test(line)) {
      flush();
      section = nextSection;
      recentContext.length = 0;
      continue;
    }
    const bullet = line.match(/^(?:[-*•▪●◦‣]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      flush();
      if (/^\d+[.)]\s+[A-Za-z][A-Za-z &/+.-]{1,30}:/.test(line)) continue;
      current = bullet[1];
      currentSection = section;
      currentContext = recentContext.slice(-3);
      continue;
    }
    if (current) {
      if (
        !line
        || /^\[Page\s+\d+\]$/i.test(line)
        || /^[A-Z][A-Z &/+-]{2,}$/.test(line)
        || /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*\s*[‘’']?\d{2,4}\s*[-–—]\s*(?:present|current|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*\s*[‘’']?\d{2,4})\b/i.test(line)
        || /\b(?:19|20)\d{2}\b.*(?:present|current|(?:19|20)\d{2})/i.test(line)
      ) {
        flush();
      } else {
        current += ` ${line}`;
        continue;
      }
    }
    if (line && !/^\[Page\s+\d+\]$/i.test(line)) {
      recentContext.push(line);
      if (recentContext.length > 3) recentContext.shift();
    }
  }
  flush();
  return atoms;
};

const extractSourceBullets = (rawText: string): string[] => {
  return unique(extractSourceBulletAtoms(rawText).map((atom) => atom.text));
};

const candidateEvidence = (resume: any): string[] => unique([
  ...normalizeArray(resume?.experience).flatMap((item: any) => toBulletArray(item?.bullets)),
  ...normalizeArray(resume?.projects).flatMap((item: any) => [
    normalizeParagraph(item?.description),
    ...toBulletArray(item?.highlights),
  ]),
  ...toNarrativeArray(resume?.achievements),
  ...toNarrativeArray(resume?.certifications),
  ...toNarrativeArray(resume?.leadership),
]);

const evidenceIsRepresented = (source: string, candidates: string[]): boolean => {
  const sourceTokens = new Set(evidenceTokens(source));
  if (sourceTokens.size === 0) return true;
  return candidates.some((candidate) => {
    const normalizedCandidate = normalizeParagraph(candidate).toLowerCase();
    const normalizedSource = normalizeParagraph(source).toLowerCase();
    if (normalizedCandidate.includes(normalizedSource) || normalizedSource.includes(normalizedCandidate)) return true;
    const candidateTokens = new Set(evidenceTokens(candidate));
    let overlap = 0;
    for (const token of sourceTokens) if (candidateTokens.has(token)) overlap += 1;
    return overlap / sourceTokens.size >= 0.72;
  });
};

const contextMatchScore = (context: string[], candidate: any, section: ResumeBulletSection): number => {
  const sourceTokens = new Set(evidenceTokens(context.join(' ')));
  const candidateText = section === 'projects'
    ? `${candidate?.name || ''} ${candidate?.technologies || ''}`
    : `${candidate?.role || ''} ${candidate?.company || ''} ${candidate?.location || ''}`;
  const targetTokens = new Set(evidenceTokens(candidateText));
  if (!sourceTokens.size || !targetTokens.size) return 0;
  let overlap = 0;
  for (const token of targetTokens) if (sourceTokens.has(token)) overlap += 1;
  return overlap / targetTokens.size;
};

const reconcileSourceBullets = (rawText: string, resume: any): {
  data: any;
  recovered: number;
  unresolved: SourceBulletAtom[];
} => {
  const data = clone(resume);
  let represented = candidateEvidence(data);
  let recovered = 0;
  const unresolved: SourceBulletAtom[] = [];

  for (const atom of extractSourceBulletAtoms(rawText)) {
    if (evidenceIsRepresented(atom.text, represented)) continue;
    if (atom.section === 'achievements' || atom.section === 'leadership') {
      const field = atom.section;
      data[field] = unique([...toNarrativeArray(data[field]), atom.text]);
      represented.push(atom.text);
      recovered += 1;
      continue;
    }
    if (atom.section !== 'experience' && atom.section !== 'projects') {
      unresolved.push(atom);
      continue;
    }

    const entries = normalizeArray(data[atom.section]);
    if (!entries.length) {
      unresolved.push(atom);
      continue;
    }
    const ranked = entries
      .map((entry: any, index: number) => ({
        index,
        score: contextMatchScore(atom.context, entry, atom.section),
      }))
      .sort((left, right) => right.score - left.score);
    const best = ranked[0];
    const runnerUp = ranked[1];
    const unambiguousSingleEntry = entries.length === 1;
    const confidentMatch = best.score >= 0.45 && (!runnerUp || best.score - runnerUp.score >= 0.15);
    if (!unambiguousSingleEntry && !confidentMatch) {
      unresolved.push(atom);
      continue;
    }
    const destination = entries[best.index] as any;
    const field = atom.section === 'projects' ? 'highlights' : 'bullets';
    destination[field] = unique([...toBulletArray(destination[field]), atom.text]);
    represented.push(atom.text);
    recovered += 1;
  }
  return { data, recovered, unresolved };
};

const auditResumeCompleteness = (rawText: string, resume: any): string[] => {
  const errors: string[] = [];
  const representedEvidence = candidateEvidence(resume);
  for (const sourceBullet of extractSourceBullets(rawText)) {
    if (!evidenceIsRepresented(sourceBullet, representedEvidence)) {
      errors.push(`Missing source bullet; preserve it verbatim in the correct section: "${sourceBullet}"`);
    }
  }

  const contactHyperlinkSection = String(rawText || '').match(
    /(?:^|\n)\[Document contact hyperlinks\]\s*\n([\s\S]*?)(?=\n\[[^\n]+\]\s*(?:\n|$)|$)/i,
  )?.[1] || '';
  const requiredContactUrls = unique(
    contactHyperlinkSection
      .split(/\r?\n/)
      .map((line) => line.match(/^(?:LinkedIn|GitHub|Website|Portfolio)\s*:\s*(https?:\/\/\S+)/i)?.[1] || '')
      .filter(Boolean),
  );
  const structuredUrls = [
    resume?.identity?.linkedin,
    resume?.identity?.github,
    resume?.identity?.website,
  ].map((value) => cleanUrl(value)).filter(Boolean);
  for (const sourceUrl of requiredContactUrls) {
    if (!structuredUrls.some((value) => value.toLowerCase() === cleanUrl(sourceUrl).toLowerCase())) {
      errors.push(`Missing document hyperlink; place it in the matching identity or project URL field: "${sourceUrl}"`);
    }
  }

  const experienceLocations = normalizeArray(resume?.experience)
    .map((item: any) => normalizeLine(item?.location).toLowerCase())
    .filter(Boolean);
  for (const line of String(rawText || '').split(/\r?\n/).map(normalizeLine)) {
    const locationMatch = line.match(
      /—\s*(.+?)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*\s*[‘’']?\d{2,4}\s*[-–—]\s*(?:present|current|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*\s*[‘’']?\d{2,4})\b/i,
    );
    if (!locationMatch) continue;
    const sourceLocation = normalizeLine(locationMatch[1]);
    if (!experienceLocations.some((location) =>
      location === sourceLocation.toLowerCase() ||
      location.includes(sourceLocation.toLowerCase()) ||
      sourceLocation.toLowerCase().includes(location))) {
      errors.push(`Missing experience location; extract it from this exact experience header: "${line}"`);
    }
  }
  return errors.slice(0, 24);
};

const resumeRepairShape = `{
  "identity": {
    "name": "",
    "email": "",
    "phone": "",
    "linkedin": "",
    "github": "",
    "website": "",
    "location": "",
    "summary": ""
  },
  "skills": {
    "languages": [],
    "frameworks": [],
    "cloud": [],
    "databases": [],
    "ml": [],
    "devops": [],
    "tools": []
  },
  "experience": [
    {
      "role": "",
      "company": "",
      "location": "",
      "start_date": "",
      "end_date": "",
      "bullets": []
    }
  ],
  "projects": [
    {
      "name": "",
      "description": "",
      "technologies": [],
      "highlights": [],
      "url": ""
    }
  ],
  "education": [
    {
      "institution": "",
      "degree": "",
      "field": "",
      "start_date": "",
      "end_date": "",
      "gpa": "",
      "thesis": ""
    }
  ],
  "achievements": [],
  "certifications": [],
  "leadership": [],
  "meeting_profile": {
    "professional_headline": "",
    "suggested_intro": "",
    "core_strengths": [],
    "top_skills": []
  }
}`;

const buildPrimaryExtractionPrompt = (rawText: string, chunkIndex: number, chunkCount: number): string => `Extract this resume source chunk into the required JSON shape.

This is source chunk ${chunkIndex + 1} of ${chunkCount}. Extract every fact present in this chunk.
It is valid for fields or arrays belonging to other chunks to be empty.

Accuracy rules:
- Use ONLY facts explicitly present in the resume text.
- Preserve every distinct experience, project, education, achievement, certification, and leadership entry.
- Preserve every meaningful accomplishment bullet. Do not summarize multiple bullets into one.
- Keep role, company, location, and dates in their correct fields. A bullet is never a location.
- Preserve dates as written when their exact normalized value is uncertain. Never move a date into company or role.
- Remove numbering and category labels from individual skills (for example, "1. Languages: Python" becomes "Python").
- Copy contact values completely. Do not return a partial phone number or truncated URL.
- Do not infer employers, dates, skills, degrees, metrics, or links.
- Use an empty string or empty array when a value is absent.
- "meeting_profile" may reorganize resume facts for assistance, but must not introduce new facts.
- Output ONLY one valid JSON object. Do not use Markdown or explanatory text.

Required JSON shape:
${resumeRepairShape}

RESUME TEXT:
${rawText}`;

const buildRepairPrompt = (
  rawText: string,
  currentResume: any,
  heuristicResume: any,
  errors: string[] | undefined,
  chunkIndex: number,
  chunkCount: number,
): string => {
  const guidance = errors?.length
    ? `Previous attempt issues:\n${errors
      .slice(0, 24)
      .map((item) => `- ${normalizeParagraph(item).slice(0, 500)}`)
      .join('\n')}\n\n`
    : '';
  return `Repair and normalize this extracted resume JSON using source chunk ${chunkIndex + 1} of ${chunkCount}.

Rules:
- Use ONLY the resume text below.
- Do NOT invent employers, dates, links, degrees, projects, or skills.
- If a field is unknown, return an empty string or empty array.
- Prefer cleaner structure over verbosity.
- Experience, project, and education arrays must contain objects, not free-form paragraphs.
- "meeting_profile" must be grounded in the resume facts and help the assistant in meetings.
- Preserve all correct values already present in CURRENT EXTRACTED JSON.
- Resolve every item under Previous attempt issues using the source text.
- Never combine or summarize distinct source bullets.
- Output ONLY one valid JSON object matching the required shape.

${guidance}Required JSON shape:
${resumeRepairShape}

CURRENT EXTRACTED JSON:
${stringifyBoundedRepairContext(currentResume)}

HEURISTIC FALLBACK JSON:
${stringifyBoundedRepairContext(heuristicResume)}

RESUME TEXT:
${rawText}`;
};

const validateResumeRepair = (candidate: any): { ok: boolean; data: any; errors: string[] } => {
  const normalized = sanitizeResumeCandidate(candidate);
  const errors: string[] = [];
  if (!normalized.identity?.name) errors.push('missing candidate name');
  if (!Array.isArray(normalized.experience)) errors.push('experience must be an array');
  if (!Array.isArray(normalized.projects)) errors.push('projects must be an array');
  if (!Array.isArray(normalized.education)) errors.push('education must be an array');
  return { ok: errors.length === 0 || !isDegenerateStructuredResume(normalized), data: normalized, errors };
};

const runRepairPass = async (rawText: string, currentResume: any, heuristicResume: any, generateContentFn: GenerateFn): Promise<any | null> => {
  const chunks = splitResumeSourceForExtraction(rawText);
  let errors: string[] = auditResumeCompleteness(rawText, currentResume);
  const repairedByChunk = new Map<number, any>();
  let pendingChunkIndexes = chunks.map((_, index) => index);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const repairResults = await mapWithConcurrency(
      pendingChunkIndexes,
      RESUME_EXTRACTION_CONCURRENCY,
      async (chunkIndex) => {
        try {
          const prompt = buildRepairPrompt(
            chunks[chunkIndex],
            currentResume,
            heuristicResume,
            errors,
            chunkIndex,
            chunks.length,
          );
          const response = await generateContentFn([{ text: prompt }]);
          const responseText = typeof response === 'string' ? response : JSON.stringify(response ?? {});
          const candidate = typeof response === 'object' && response !== null
            ? response
            : extractJsonObject(responseText);
          return { chunkIndex, candidate, error: '' };
        } catch (error) {
          return {
            chunkIndex,
            candidate: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    const nextPendingChunkIndexes: number[] = [];
    const repairFailures: string[] = [];
    for (const result of repairResults) {
      if (result.candidate && typeof result.candidate === 'object') {
        repairedByChunk.set(result.chunkIndex, result.candidate);
      } else {
        nextPendingChunkIndexes.push(result.chunkIndex);
        repairFailures.push(`repair chunk ${result.chunkIndex + 1} failed: ${result.error || 'invalid JSON'}`);
      }
    }
    const repairedChunks = [...repairedByChunk.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, candidate]) => candidate);
    const validated = validateResumeRepair(mergeAllChunkEntries(repairedChunks));
    const completenessErrors = validated.ok ? auditResumeCompleteness(rawText, validated.data) : [];
    if (validated.ok && completenessErrors.length === 0 && nextPendingChunkIndexes.length === 0) {
      return validated.data;
    }
    errors = [...validated.errors, ...completenessErrors, ...repairFailures];
    if (!errors.length) errors = ['invalid or missing JSON'];
    // Transport/JSON failures only need their failed chunks retried. When all
    // chunks returned but the merged result is semantically incomplete, retry
    // every chunk so the second prompt can apply the completeness feedback.
    pendingChunkIndexes = nextPendingChunkIndexes.length > 0
      ? nextPendingChunkIndexes
      : chunks.map((_, index) => index);
  }
  // Never let a partial or semantically incomplete repair outrank the complete
  // primary and heuristic candidates retained by the caller.
  return null;
};

export const normalizeResumeDocument = (resume: any): { data: any; changed: boolean } => {
  if (!resume || typeof resume !== 'object') return { data: resume, changed: false };
  const next = sanitizeResumeCandidate(clone(resume));
  next._extraction_mode = normalizeLine(resume._extraction_mode || '') || undefined;
  if (!next._extraction_mode) delete next._extraction_mode;
  const changed = JSON.stringify(next) !== JSON.stringify(resume);
  return { data: next, changed };
};

export const extractResumeWithCleanup = async (
  rawText: string,
  generateContentFn: GenerateFn | null,
  heuristicsAllowed: boolean,
): Promise<{ data: any; extractionMode: string }> => {
  if (rawText.length > MAX_RESUME_SOURCE_CHARS) {
    throw new Error(`resume text exceeds the supported ${MAX_RESUME_SOURCE_CHARS.toLocaleString()} character limit`);
  }
  const heuristic = heuristicResumeExtract(rawText);
  if (!generateContentFn) {
    throw new Error('resume parser not configured');
  }

  let primaryRaw: any = null;
  let primaryMode = 'llm';
  let primaryFailure = '';
  let primaryFailedChunkCount = 0;
  try {
    const chunks = splitResumeSourceForExtraction(rawText);
    const primaryChunkResults = await mapWithConcurrency(
      chunks,
      RESUME_EXTRACTION_CONCURRENCY,
      async (chunk, chunkIndex) => {
        try {
          const response = await generateContentFn([
            { text: buildPrimaryExtractionPrompt(chunk, chunkIndex, chunks.length) },
          ]);
          const text = typeof response === 'string' ? response : JSON.stringify(response ?? {});
          const candidate = typeof response === 'object' && response !== null
            ? response
            : extractJsonObject(text);
          return {
            candidate,
            error: candidate && typeof candidate === 'object'
              ? ''
              : `primary extraction chunk ${chunkIndex + 1} returned invalid JSON`,
          };
        } catch (error) {
          return {
            candidate: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    );
    const validPrimaryChunks = primaryChunkResults.map(({ candidate }) => candidate).filter(
      (candidate) => candidate && typeof candidate === 'object',
    );
    const failedPrimaryChunks = primaryChunkResults
      .map(({ error }) => error)
      .filter(Boolean);
    primaryFailedChunkCount = failedPrimaryChunks.length;
    primaryRaw = validPrimaryChunks.length ? mergeAllChunkEntries(validPrimaryChunks) : null;
    if (failedPrimaryChunks.length) {
      primaryFailure = `${failedPrimaryChunks.length} of ${chunks.length} primary extraction chunks failed: ${failedPrimaryChunks.join('; ')}`;
    } else if (!primaryRaw) {
      primaryFailure = 'primary extractor returned incomplete or invalid JSON';
    }
    if (!primaryRaw && failedPrimaryChunks.length && !heuristicsAllowed) {
      throw new Error(primaryFailure);
    }
    primaryMode = normalizeLine(primaryRaw?._extraction_mode || 'llm') || 'llm';
  } catch (error) {
    primaryFailure = error instanceof Error ? error.message : String(error);
    if (!heuristicsAllowed) throw error;
  }

  const mergedPrimary = mergeResumeCandidates([primaryRaw, heuristic]);
  const completenessErrors = auditResumeCompleteness(rawText, mergedPrimary);
  const repairEnabled = process.env.PI_RESUME_JSON_REPAIR !== 'off'
    && (
      !primaryRaw
      || primaryFailedChunkCount > 0
      || isDegenerateStructuredResume(primaryRaw)
      || completenessErrors.length > 0
    );
  let repaired = null;
  if (repairEnabled) {
    try {
      repaired = await runRepairPass(rawText, mergedPrimary, heuristic, generateContentFn);
    } catch {
      repaired = null;
    }
  }

  const mergedFinal = mergeResumeCandidates([repaired, mergedPrimary, heuristic]);
  const reconciliation = reconcileSourceBullets(rawText, mergedFinal);
  const finalResume = reconciliation.data;
  if (isDegenerateStructuredResume(finalResume)) {
    if (!heuristicsAllowed) throw new Error('structured extraction returned degenerate data');
    return { data: sanitizeResumeCandidate(heuristic, heuristic), extractionMode: 'heuristic' };
  }

  const primaryWasDegenerate = !primaryRaw || isDegenerateStructuredResume(primaryRaw);
  finalResume._extraction_mode = primaryWasDegenerate ? 'heuristic' : repaired ? 'llm_repaired' : primaryMode;
  finalResume._parser_metadata = {
    ...(finalResume._parser_metadata || {}),
    parser_version: repaired ? 'resume_refiner_v1_repaired' : 'resume_refiner_v1',
    used_llm_repair: Boolean(repaired),
    fallback_used: !primaryRaw,
    primary_failure: primaryFailure || undefined,
    source_bullets_recovered: reconciliation.recovered,
    unresolved_source_items: reconciliation.unresolved.map((atom) => ({
      text: atom.text,
      section: atom.section,
      context: atom.context,
    })),
  };
  return { data: finalResume, extractionMode: finalResume._extraction_mode };
};
