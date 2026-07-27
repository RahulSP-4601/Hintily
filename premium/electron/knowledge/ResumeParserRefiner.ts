import { heuristicResumeExtract, isDegenerateStructuredResume } from './HeuristicExtractor';
import { flattenSkills, toCategorizedSkills } from './DocumentChunker';

type GenerateFn = (contents: Array<{ text: string }>) => Promise<any>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

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

const stripSummaryNoise = (value: unknown): string =>
  normalizeParagraph(value)
    .replace(/\b(?:skills|experience|projects|education|certifications|leadership)\b\s*:?\s*$/i, '')
    .trim();

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
  let startDate = parseMaybeDate(raw.start_date ?? raw.startDate ?? raw.from ?? raw.date_from ?? '');
  let endDate = parseMaybeDate(raw.end_date ?? raw.endDate ?? raw.to ?? raw.date_to ?? '');
  const locationCandidate = rawCompanyText && rawCompanyText !== company ? rawCompanyText : company;
  if (locationCandidate && !location && /\b[A-Z][A-Za-z]+,\s*[A-Z][A-Za-z]+/.test(locationCandidate) && !/\b(inc|llc|labs|systems|group|company|technologies)\b/i.test(locationCandidate)) {
    const parsed = parseLocationDateBlob(locationCandidate);
    if (parsed.location) {
      location = parsed.location;
      if (locationCandidate === company) company = '';
      if (!startDate && parsed.start_date) startDate = parsed.start_date;
      if (endDate === null || endDate) {
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
    if (endDate === null || endDate) {
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
  const combinedSkills = unique([
    ...(rawSkills && typeof rawSkills === 'object' && !Array.isArray(rawSkills)
      ? flattenSkills(toCategorizedSkills(rawSkills))
      : toStringArray(rawSkills)),
    ...toStringArray(raw?.technologies ?? []),
    ...toStringArray(heuristicProfile?.skillsFlat ?? heuristicProfile?.skills_flat ?? []),
  ]).filter((item) => !/^\[object object\]$/i.test(item));
  const skills = toCategorizedSkills(combinedSkills);
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
    ...toStringArray(raw?.achievements ?? []),
    ...toStringArray(raw?.awards ?? []),
  ]);
  const certifications = unique([
    ...toStringArray(raw?.certifications ?? []),
    ...toStringArray(raw?.licenses ?? []),
  ]);
  const leadership = unique([
    ...toStringArray(raw?.leadership ?? []),
    ...toStringArray(raw?.activities ?? []),
  ]);
  const next = {
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
  const skills = toCategorizedSkills(usable.flatMap((item) => flattenSkills(toCategorizedSkills(item?.skills))));
  const merged = {
    identity,
    skills,
    skillsFlat: flattenSkills(skills),
    skills_flat: flattenSkills(skills),
    experience: pickBestArray(usable.map((item) => item.experience || []), scoreExperience),
    projects: pickBestArray(usable.map((item) => item.projects || []), scoreProjects),
    education: pickBestArray(usable.map((item) => item.education || []), scoreEducation),
    achievements: unique(usable.flatMap((item) => toStringArray(item?.achievements))),
    certifications: unique(usable.flatMap((item) => toStringArray(item?.certifications))),
    leadership: unique(usable.flatMap((item) => toStringArray(item?.leadership))),
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

const buildRepairPrompt = (rawText: string, currentResume: any, heuristicResume: any, errors?: string[]): string => {
  const guidance = errors?.length ? `Previous attempt issues:\n${errors.map((item) => `- ${item}`).join('\n')}\n\n` : '';
  return `Repair and normalize this extracted resume JSON.

Rules:
- Use ONLY the resume text below.
- Do NOT invent employers, dates, links, degrees, projects, or skills.
- If a field is unknown, return an empty string or empty array.
- Prefer cleaner structure over verbosity.
- Experience, project, and education arrays must contain objects, not free-form paragraphs.
- "meeting_profile" must be grounded in the resume facts and help the assistant in meetings.
- Output ONLY one valid JSON object matching the required shape.

${guidance}Required JSON shape:
${resumeRepairShape}

CURRENT EXTRACTED JSON:
${JSON.stringify(currentResume, null, 2)}

HEURISTIC FALLBACK JSON:
${JSON.stringify(heuristicResume, null, 2)}

RESUME TEXT:
${rawText.slice(0, 18000)}`;
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
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prompt = buildRepairPrompt(rawText, currentResume, heuristicResume, errors);
    const response = await generateContentFn([{ text: prompt }]);
    const responseText = typeof response === 'string' ? response : JSON.stringify(response ?? {});
    const parsed = typeof response === 'object' && response !== null ? response : extractJsonObject(responseText);
    const validated = validateResumeRepair(parsed);
    if (validated.ok) return validated.data;
    errors = validated.errors.length ? validated.errors : ['invalid or missing JSON'];
  }
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
  const heuristic = heuristicResumeExtract(rawText);
  if (!generateContentFn) {
    throw new Error('resume parser not configured');
  }

  let primaryRaw: any = null;
  let primaryMode = 'llm';
  try {
    const response = await generateContentFn([{ text: `RESUME TEXT\n\n${rawText}` }]);
    const text = typeof response === 'string' ? response : JSON.stringify(response ?? {});
    primaryRaw = typeof response === 'object' && response !== null ? response : extractJsonObject(text);
    primaryMode = normalizeLine(primaryRaw?._extraction_mode || 'llm') || 'llm';
  } catch (error) {
    if (!heuristicsAllowed) throw error;
  }

  const mergedPrimary = mergeResumeCandidates([primaryRaw, heuristic]);
  const repairEnabled = process.env.PI_RESUME_JSON_REPAIR !== 'off'
    && (!primaryRaw || isDegenerateStructuredResume(primaryRaw));
  let repaired = null;
  if (repairEnabled) {
    try {
      repaired = await runRepairPass(rawText, mergedPrimary, heuristic, generateContentFn);
    } catch {
      repaired = null;
    }
  }

  const finalResume = mergeResumeCandidates([repaired, mergedPrimary, heuristic]);
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
  };
  return { data: finalResume, extractionMode: finalResume._extraction_mode };
};
