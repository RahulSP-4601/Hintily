import { SKILL_CATEGORIES, type CategorizedSkills } from './DocumentChunker';

const clean = (value: unknown): string => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const lines = (text: string): string[] => String(text || '').replace(/\r/g, '').split('\n').map(clean);
const unique = (values: string[]): string[] => Array.from(new Set(values.map(clean).filter(Boolean)));
const emptySkills = (): CategorizedSkills => Object.fromEntries(
  SKILL_CATEGORIES.map((key): [keyof CategorizedSkills, string[]] => [key, []]),
) as CategorizedSkills;
const HEADER = /^(?:professional\s+)?(?:summary|profile|objective|(?:core\s+|technical\s+)?skills?|experience|work experience|professional experience|clinical experience|employment|projects?|education|achievements?|awards?|certifications?|languages?|leadership|responsibilities|requirements?|qualifications|what you bring|nice to have|preferred qualifications|about(?: the)? role)$/i;
const SECTION = /^(summary|profile|objective|(?:core\s+|technical\s+)?skills?|experience|work experience|professional experience|clinical experience|employment|projects?|education|achievements?|awards?|certifications?|languages?|leadership|responsibilities|requirements?|qualifications|what you bring|nice to have|preferred qualifications|about(?: the)? role)\s*:?\s*$/i;
const CONTACT_OR_URL = /@|https?:\/\/|(?:linkedin|github)\.com|www\.|\+?\d[\d\s().-]{7,}/i;

const sectionName = (line: string): string | null => {
  const match = line.match(SECTION);
  if (!match) return null;
  const value = match[1].toLowerCase();
  if (/experience|employment/.test(value)) return 'experience';
  if (/project/.test(value)) return 'projects';
  if (/education/.test(value)) return 'education';
  if (/skill/.test(value)) return 'skills';
  if (/responsibil/.test(value)) return 'responsibilities';
  if (/nice|preferred/.test(value)) return 'preferred';
  if (/require|qualification|what you bring/.test(value)) return 'requirements';
  return value.replace(/\s+/g, '_');
};

const splitSections = (text: string): { preamble: string[]; sections: Record<string, string[]> } => {
  const output: Record<string, string[]> = {};
  const preamble: string[] = [];
  let current: string | null = null;
  for (const line of lines(text)) {
    const section = sectionName(line);
    if (section) {
      current = section;
      output[current] ||= [];
      continue;
    }
    if (!line) continue;
    if (current) output[current].push(line);
    else preamble.push(line);
  }
  return { preamble, sections: output };
};

const looksLikeName = (line: string): boolean => {
  if (!line || HEADER.test(line) || CONTACT_OR_URL.test(line) || line.length > 80) return false;
  const words = line.replace(/,\s*(?:RN|BSN|CCRN|MBA|PMP|CPA|MD|PhD)(?:\s*,\s*(?:RN|BSN|CCRN|MBA|PMP|CPA|MD|PhD))*\s*$/i, '').replace(/["']/g, '').split(/\s+/);
  if (words.length < 2 || words.length > 6) return false;
  if (/engineer|developer|manager|analyst|designer|consultant|student|founder|director|specialist|nurse|intern/i.test(line)) return false;
  return words.every(word => /^[\p{L}][\p{L}.'-]*$/u.test(word));
};

const nameFromEmail = (email: string): string => email.split('@')[0]
  .split(/[._-]+/)
  .filter(part => part && !/^(email|mail|contact|resume|cv)$/i.test(part))
  .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
  .join(' ');

const splitList = (value: string): string[] => {
  const normalized = value
    .replace(/^[A-Za-z /&-]{1,24}(?::|\s{2,}|▪)\s*/, '')
    .replace(/[▪·]/g, ',');
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (const character of normalized) {
    if (character === '(') depth++;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,|;•]/.test(character)) {
      if (clean(current)) parts.push(clean(current));
      current = '';
    } else current += character;
  }
  if (clean(current)) parts.push(clean(current));
  return unique(parts.map(item => {
    const cleaned = item.replace(/^[-*]\s*/, '').trim();
    return cleaned.length >= 80 || (cleaned.match(/,/g)?.length || 0) > 2
      ? clean(cleaned.replace(/\s*\(.*$/, ''))
      : cleaned;
  }).filter(Boolean));
};

const skillBucket = (label: string, skill: string): keyof CategorizedSkills => {
  const source = `${label} ${skill}`.toLowerCase();
  if (/language|typescript|javascript|python|java\b|golang|\bgo\b|c\+\+|c#|\bsql\b|ruby|rust|swift|kotlin/.test(source)) return 'languages';
  if (/framework|react|next\.?js|node\.?js|fastapi|django|spring|angular|vue|express/.test(source)) return 'frameworks';
  if (/cloud|\baws\b|\bgcp\b|azure|vercel|cloudflare/.test(source)) return 'cloud';
  if (/database|postgres|mysql|redis|mongo|sqlite|snowflake|bigquery|pgvector/.test(source)) return 'databases';
  if (/ai\/?ml|machine learning|pytorch|tensorflow|langchain|\brag\b|llm/.test(source)) return 'ml';
  if (/devops|docker|kubernetes|terraform|jenkins|github actions|ci\/cd/.test(source)) return 'devops';
  return 'tools';
};

const parseSkills = (section: string[]): CategorizedSkills => {
  const result = emptySkills();
  for (const line of section) {
    const label = line.includes(':') ? line.slice(0, line.indexOf(':')) : '';
    for (const skill of splitList(line)) {
      const bucket = skillBucket(label, skill);
      if (!result[bucket].includes(skill)) result[bucket].push(skill);
    }
  }
  return result;
};

const parseDateRange = (value: string): { start_date: string | null; end_date: string | null } => {
  const token = /(?:\d{1,2}\/(?:19|20)\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:19|20)\d{2}|(?:19|20)\d{2}(?:[-/.]\d{1,2})?|present|current)/gi;
  const dates = value.match(token) || [];
  const normalize = (date?: string): string | null => {
    if (!date) return null;
    if (/present|current/i.test(date)) return null;
    const mmYear = date.match(/^(\d{1,2})\/(\d{4})$/);
    if (mmYear) return `${mmYear[2]}-${mmYear[1].padStart(2, '0')}`;
    const monthYear = date.match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (monthYear) {
      const months: Record<string, string> = { jan:'01', january:'01', feb:'02', february:'02', mar:'03', march:'03', apr:'04', april:'04', may:'05', jun:'06', june:'06', jul:'07', july:'07', aug:'08', august:'08', sep:'09', sept:'09', september:'09', oct:'10', october:'10', nov:'11', november:'11', dec:'12', december:'12' };
      return `${monthYear[2]}-${months[monthYear[1].toLowerCase()]}`;
    }
    const match = date.match(/^(\d{4})(?:[-/.](\d{1,2}))?/);
    return match ? `${match[1]}${match[2] ? `-${match[2].padStart(2, '0')}` : ''}` : null;
  };
  return { start_date: normalize(dates[0]), end_date: normalize(dates[1]) };
};

const parseExperience = (section: string[]): any[] => {
  const result: any[] = [];
  let current: any = null;
  const push = () => {
    if (current && (current.company || current.role || current.bullets.length)) result.push(current);
    current = null;
  };
  const roleLike = (value: string) => /\b(engineer|developer|manager|director|analyst|designer|consultant|specialist|nurse|intern|founder|president|vice president|vp|cto|ceo|cfo|head of|coordinator|architect|lead|officer)\b/i.test(value);
  const locationLike = (value: string) => /^(?:[A-Za-z .'-]+,\s*[A-Z]{2}|remote|hybrid)$/i.test(value);
  const divider = (value: string) => /^[\s─—=_-]{3,}$/.test(value);
  const make = (): {
    company: string;
    role: string;
    start_date: string | null;
    end_date: string | null;
    bullets: string[];
    technologies: string[];
  } => ({
    company: '',
    role: '',
    start_date: null,
    end_date: null,
    bullets: [],
    technologies: [],
  });
  for (let index = 0; index < section.length; index++) {
    const line = section[index];
    if (divider(line)) continue;
    const bullet = /^[-*•]\s*/.test(line);
    if (bullet && current) {
      current.bullets.push(line.replace(/^[-*•]\s*/, ''));
      continue;
    }
    const at = line.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s*\((.*)\))?$/i);
    const dash = line.split(/\s+—\s+/).filter(Boolean);
    const hasDate = /(?:19|20)\d{2}|present|current/i.test(line);
    if (at) {
      push(); current = { ...make(), role: clean(at[1]), company: clean(at[2].replace(/\(.*$/, '')), ...parseDateRange(line) }; continue;
    }
    if (dash.length === 2 && !hasDate) {
      const leftRole = roleLike(dash[0]);
      const rightRole = roleLike(dash[1]);
      if (current && !current.company && !leftRole && locationLike(dash[1])) { current.company = dash[0]; continue; }
      push();
      current = make();
      if (rightRole) { current.company = dash[0]; current.role = dash[1]; }
      else if (leftRole) { current.role = dash[0]; current.company = dash[1]; }
      else current.company = dash[0];
      continue;
    }
    if (hasDate) {
      if (!current) current = make();
      const dates = parseDateRange(line);
      current.start_date = dates.start_date;
      current.end_date = dates.end_date;
      const beforeDate = clean(line.replace(tokenDateRegex, '').replace(/[|—–-]+\s*$/, ''));
      if (beforeDate && !locationLike(beforeDate)) {
        if (roleLike(beforeDate)) current.role ||= beforeDate;
        else current.company ||= beforeDate;
      }
      continue;
    }
    if (!current) current = make();
    if (locationLike(line)) continue;
    if (current) {
      if (/^technolog(?:y|ies):/i.test(line)) current.technologies = splitList(line);
      else if (!current.role && roleLike(line)) current.role = line;
      else if (!current.company) current.company = line;
      else if (!current.role) current.role = line;
      else current.bullets.push(line.replace(/^[-*•]\s*/, ''));
    }
  }
  push();
  return result;
};

const tokenDateRegex = /(?:\d{1,2}\/(?:19|20)\d{2}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:19|20)\d{2}|(?:19|20)\d{2}(?:[-/.]\d{1,2})?|present|current).*$/i;

const parseProjects = (section: string[]): any[] => {
  const result: any[] = [];
  for (const raw of section) {
    const line = raw.replace(/^[-*•]\s*/, '');
    if (/^[\s─—=_-]{3,}$/.test(line)) continue;
    if (/^(?:https?:\/\/)?(?:www\.)?(?:github\.com|gitlab\.com)\//i.test(line)) {
      if (result.length) result[result.length - 1].url = line.split(/\s*[|]\s*/)[0];
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = clean(line.slice(0, colon));
      const description = clean(line.slice(colon + 1));
      result.push({ name, description, technologies: splitList(description).filter(skill => /react|node|python|java|sql|aws|docker|fastapi|typescript|postgres|redis/i.test(skill)), highlights: [], url: '' });
      continue;
    }
    if (!result.length || /\s{3,}/.test(raw)) {
      const name = clean(raw.split(/\s{3,}/)[0].replace(/\s+(?:Open source|Personal|Academic)\s*[·|].*$/i, ''));
      if (name) result.push({ name, description: '', technologies: [], highlights: [], url: '' });
    } else if (!result[result.length - 1].description) result[result.length - 1].description = line;
  }
  return result;
};

const parseEducation = (section: string[]): any[] => {
  const groups: string[][] = [];
  let current: string[] = [];
  const isInstitution = (line: string) => /university|college|school|institute|academy/i.test(line);
  for (const line of section) {
    if (isInstitution(line) && current.some(isInstitution)) {
      groups.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length) groups.push(current);
  return groups.filter(group => group.some(line => isInstitution(line) || /degree|bachelor|master|b\.?s|m\.?s|b\.?tech|associate|phd/i.test(line)))
    .map(group => {
      const institution = group.find(isInstitution) || '';
      const degreeLine = group.find(line => /bachelor|master|b\.?\s?s|m\.?\s?s|b\.?\s?tech|associate|phd|degree/i.test(line)) || '';
      const field = degreeLine.match(/(?:in|of)\s+([^,(]+?)(?:\s*\(|,|$)/i)?.[1] || '';
      const gpa = group.find(line => /gpa/i.test(line))?.match(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?/)?.[0] || '';
      return { institution: clean(institution.split(',')[0]), degree: clean(degreeLine.replace(/\(.*?\)/g, '').replace(/\d{4}.*$/, '')), field: clean(field), gpa, ...parseDateRange(group.join(' ')) };
    });
};

export const heuristicResumeExtract = (rawText: string): any => {
  const { preamble, sections } = splitSections(rawText);
  const email = String(rawText || '').match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] || '';
  const name = (preamble.find(looksLikeName) || (email ? nameFromEmail(email) : ''))
    .replace(/,\s*(?:RN|BSN|CCRN|MBA|PMP|CPA|MD|PhD)(?:\s*,\s*(?:RN|BSN|CCRN|MBA|PMP|CPA|MD|PhD))*\s*$/i, '');
  const summaryLines = sections.summary || sections.profile || sections.objective || [];
  const result: any = {
    _schema_version: 1,
    _extraction_mode: 'heuristic',
    identity: {
      name,
      email,
      phone: String(rawText || '').match(/(?:\+\d{1,3}\s*)?(?:\(?\d{3}\)?[\s.-]*)?\d{3}[\s.-]*\d{4}/)?.[0] || '',
      location: '',
      linkedin: String(rawText || '').match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/\S+/i)?.[0] || '',
      github: String(rawText || '').match(/(?:https?:\/\/)?(?:www\.)?github\.com\/\S+/i)?.[0] || '',
      website: '',
      summary: clean(summaryLines.join(' ')),
    },
    contact: {},
    summary: clean(summaryLines.join(' ')),
    skills: parseSkills(sections.skills || []),
    skills_flat: [] as string[],
    experience: parseExperience(sections.experience || []),
    projects: parseProjects(sections.projects || []),
    education: parseEducation(sections.education || []),
    achievements: (sections.achievements || sections.awards || []).map(title => ({ title: title.replace(/^[-*•]\s*/, ''), description: '' })),
    certifications: (sections.certifications || []).map(nameValue => ({ name: nameValue.replace(/^[-*•]\s*/, '') })),
    languages: (sections.languages || []).flatMap(splitList),
    leadership: (sections.leadership || []).map(title => ({ title })),
    source_evidence: [] as any[],
    extraction_metadata: { parser_version: 1, mode: 'heuristic' },
  };
  result.skills_flat = unique(Object.values(result.skills as CategorizedSkills).flat());
  return result;
};

export const heuristicJDExtract = (rawText: string): any => {
  const { preamble, sections } = splitSections(rawText);
  const cleanMd = (value: string) => clean(value.replace(/\*\*/g, ''));
  const labeledCompany = preamble.find(line => /^\**company\**\s*:/i.test(line));
  const candidates = preamble.map(cleanMd).filter(line => !/^location\s*:/i.test(line));
  const roleLike = (value: string) => /\b(engineer|developer|manager|director|analyst|designer|consultant|specialist|nurse|intern|coordinator|architect|lead|officer)\b/i.test(value);
  let title = candidates.find(line => /^(?:job description|job title)\s*:/i.test(line))?.replace(/^(?:job description|job title)\s*:\s*/i, '') || '';
  let companyLine = labeledCompany ? cleanMd(labeledCompany).replace(/^company\s*:\s*/i, '') : '';
  const dashLine = candidates.find(line => line.includes(' — ') && !/^location:/i.test(line));
  if (!title && dashLine) {
    const [left, right] = dashLine.split(/\s+—\s+/, 2);
    if (roleLike(right)) { companyLine ||= left; title = right; }
  }
  if (!title) {
    const firstTwo = candidates.filter(line => !/^company\s*:/i.test(line)).slice(0, 2);
    const roleIndex = firstTwo.findIndex(roleLike);
    title = roleIndex >= 0 ? firstTwo[roleIndex] : firstTwo[0] || 'Unknown Role';
    if (!companyLine && roleIndex === 1) companyLine = firstTwo[0];
    else if (!companyLine && roleIndex === 0) companyLine = firstTwo[1] || '';
  }
  const requirements = (sections.requirements || []).map(line => line.replace(/^[-*•]\s*/, ''));
  const responsibilities = (sections.responsibilities || []).map(line => line.replace(/^[-*•]\s*/, ''));
  const preferred = (sections.preferred || []).map(line => line.replace(/^[-*•]\s*/, ''));
  const years = rawText.match(/(\d+)\+?\s*(?:years?|yrs?)/i);
  const technologyNames = ['Python', 'TypeScript', 'JavaScript', 'Java', 'Go', 'SQL', 'React', 'Node.js', 'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'PostgreSQL', 'Snowflake', 'dbt', 'Terraform'];
  const technologies = technologyNames.filter(name => new RegExp(`\\b${name.replace('.', '\\.')}\\b`, 'i').test(rawText));
  const level = /principal/i.test(rawText) ? 'principal' : /staff/i.test(rawText) ? 'staff'
    : /senior|sr\./i.test(rawText) ? 'senior' : /intern/i.test(rawText) ? 'intern'
      : /entry|junior|jr\./i.test(rawText) ? 'entry' : 'mid';
  const employment_type = /part[- ]time/i.test(rawText) ? 'part_time'
    : /contract/i.test(rawText) ? 'contract' : /internship|intern\b/i.test(rawText) ? 'internship' : 'full_time';
  const compensationText = rawText.match(/(?:[$€£]\s?[\d,.]+(?:\s*[-–]\s*[$€£]?\s?[\d,.]+)?(?:\s*(?:per|\/)\s*(?:year|yr|hour|hr))?)/i)?.[0] || '';
  return {
    _schema_version: 1,
    _extraction_mode: 'heuristic',
    title: cleanMd(title.replace(/^(?:job description|job title):\s*/i, '')),
    company: cleanMd(companyLine.replace(/^company:\s*/i, '').split(/[|]/)[0]),
    seniority: level,
    level,
    employment_type,
    location: preamble.find(line => /remote|hybrid|onsite|,\s*[A-Z]{2}\b/i.test(line)) || '',
    remote: /remote/i.test(rawText) ? 'remote' : /hybrid/i.test(rawText) ? 'hybrid' : null,
    description_summary: clean((sections.about_the_role || sections.about_role || []).join(' ')),
    responsibilities,
    requirements,
    required_skills: requirements,
    nice_to_haves: preferred,
    preferred_skills: preferred,
    min_years_experience: years ? Number(years[1]) : null,
    technologies,
    education_requirements: requirements.filter(value => /degree|bachelor|master|phd|education/i.test(value)),
    compensation: { explicit: Boolean(compensationText), text: compensationText || null },
    compensation_hint: compensationText,
    keywords: technologies,
    source_evidence: [],
    extraction_metadata: { parser_version: 1, mode: 'heuristic' },
  };
};

export const isDegenerateStructuredResume = (value: any): boolean => {
  if (!value || typeof value !== 'object') return true;
  const name = clean(value.identity?.name);
  const hasBody = ['experience', 'projects', 'education'].some(key => Array.isArray(value[key]) && value[key].length)
    || Object.values(value.skills || {}).some(item => Array.isArray(item) && item.length);
  return !hasBody || !name || /^unknown candidate$/i.test(name);
};

export const isDegenerateStructuredJd = (value: any): boolean => {
  if (!value || typeof value !== 'object') return true;
  const title = clean(value.title);
  const hasBody = ['requirements', 'responsibilities', 'required_skills', 'technologies']
    .some(key => Array.isArray(value[key]) && value[key].length);
  return (!title || /^unknown role$/i.test(title)) && !hasBody;
};
