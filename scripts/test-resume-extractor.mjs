#!/usr/bin/env node

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

require('dotenv').config({ path: path.join(repositoryRoot, '.env'), quiet: true });

const argumentsList = process.argv.slice(2);
const heuristicOnly = argumentsList.includes('--heuristic');
const resumeArgument = argumentsList.find((argument) => !argument.startsWith('--'));

if (!resumeArgument) {
  console.error(
    'Usage: npm run test:resume-extractor -- /absolute/path/to/resume.pdf [--heuristic]',
  );
  process.exit(2);
}

const resumePath = path.resolve(resumeArgument);
if (!fs.existsSync(resumePath)) {
  console.error(`[resume-extractor] File does not exist: ${resumePath}`);
  process.exit(2);
}

const loadCompiledModule = async (relativePath) => {
  const compiledPath = path.join(repositoryRoot, 'dist-electron', relativePath);
  if (!fs.existsSync(compiledPath)) {
    throw new Error(`Compiled module is missing: ${compiledPath}`);
  }
  return import(pathToFileURL(compiledPath).href);
};

const countSkills = (skills) => {
  if (Array.isArray(skills)) return skills.length;
  if (!skills || typeof skills !== 'object') return 0;
  return Object.values(skills).reduce(
    (total, category) => total + (Array.isArray(category) ? category.length : 0),
    0,
  );
};

const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const normalizedForComparison = (value) => cleanText(value)
  .toLowerCase()
  .replace(/[^\p{L}\p{N}+.#/@-]+/gu, ' ');
const significantTokens = (value) => normalizedForComparison(value)
  .split(/\s+/)
  .filter((token) => token.length > 1);

const flattenStrings = (value, output = []) => {
  if (typeof value === 'string' && cleanText(value)) output.push(cleanText(value));
  else if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, output);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (!key.startsWith('_') && !['source_evidence', 'extraction_metadata'].includes(key)) {
        flattenStrings(item, output);
      }
    }
  }
  return output;
};

const calculateSourceCoverage = (profile, rawText) => {
  const structuredTokens = new Set(significantTokens(flattenStrings(profile).join(' ')));
  const sourceWithoutAnnotationTargets = String(rawText || '')
    .split(/\[Document (?:hyperlink targets|contact hyperlinks)\]/i)[0];
  const sourceLines = sourceWithoutAnnotationTargets
    .split(/\r?\n/)
    .map(cleanText)
    .filter((line) =>
      line
      && !/^\[Page \d+\]$/i.test(line)
      && !/^(?:professional |work |clinical )?(?:summary|experience)$|^(?:technical |core )?skills?$|^(?:selected |personal |academic )?projects?$|^education$|^(?:selected impact )?(?:highlights|achievements?)$|^(?:awards?|honors?|certifications?|leadership|activities)$/i.test(line)
      && !(line.includes('@') && /\b(?:linkedin|github|portfolio|website)\b/i.test(line))
      && !/^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*\s*)?[‘’']?\d{2,4}\s*[-–—]\s*(?:present|current|(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[A-Za-z]*\s*)?[‘’']?\d{2,4})$/i.test(line),
    );
  const unmappedLines = [];
  let mappedLines = 0;
  for (const line of sourceLines) {
    const tokens = significantTokens(line);
    if (!tokens.length) continue;
    const matched = tokens.filter((token) => structuredTokens.has(token)).length;
    const threshold = tokens.length <= 3 ? 1 : 0.7;
    if (matched / tokens.length >= threshold) mappedLines += 1;
    else unmappedLines.push(line);
  }
  const meaningfulLines = mappedLines + unmappedLines.length;
  return {
    meaningfulLines,
    mappedLines,
    coveragePercent: meaningfulLines
      ? Math.round((mappedLines / meaningfulLines) * 1000) / 10
      : 0,
    unmappedLines,
  };
};

const collectSkills = (skills) => {
  if (Array.isArray(skills)) return skills.map(cleanText).filter(Boolean);
  if (!skills || typeof skills !== 'object') return [];
  return Object.values(skills).flatMap((items) =>
    Array.isArray(items) ? items.map(cleanText).filter(Boolean) : []);
};

const validateProfile = (profile, extractedText) => {
  const errors = [];
  const warnings = [];
  const identity = profile?.identity || {};
  const experience = Array.isArray(profile?.experience) ? profile.experience : [];
  const projects = Array.isArray(profile?.projects) ? profile.projects : [];
  const education = Array.isArray(profile?.education) ? profile.education : [];
  const skillsCount = countSkills(profile?.skills);

  if (!cleanText(identity.name)) errors.push('Candidate name was not extracted.');
  if (!cleanText(identity.email)) warnings.push('Email was not extracted.');
  if (!experience.length) errors.push('No work experience entries were extracted.');
  if (!education.length) warnings.push('No education entries were extracted.');
  if (!skillsCount) errors.push('No skills were extracted.');
  if (extractedText.length < 200) warnings.push('The PDF produced unusually little readable text.');
  const phoneDigits = cleanText(identity.phone).replace(/\D/g, '');
  if (cleanText(identity.phone) && (phoneDigits.length < 10 || phoneDigits.length > 15)) {
    errors.push(`Phone appears truncated or malformed: "${identity.phone}".`);
  }
  if (/linkedin\.com/i.test(extractedText) && !cleanText(identity.linkedin)) {
    warnings.push('The source contains LinkedIn, but no LinkedIn URL was extracted.');
  }
  if (/github\.com/i.test(extractedText) && !cleanText(identity.github)) {
    warnings.push('The source contains GitHub, but no GitHub URL was extracted.');
  }

  for (const [index, item] of experience.entries()) {
    const company = cleanText(item?.company);
    const role = cleanText(item?.role);
    if (!company) {
      errors.push(`Experience ${index + 1} is missing its company.`);
    }
    if (!role) {
      errors.push(`Experience ${index + 1} is missing its role.`);
    }
    if (hasDateLikeValue(company) || hasDateLikeValue(role)) {
      errors.push(`Experience ${index + 1} has a date mixed into its company or role.`);
    }
  }
  for (const skill of collectSkills(profile?.skills)) {
    if (/^\d+[.)]\s*/.test(skill) || /^[A-Za-z /&-]{2,30}:\s*/.test(skill)) {
      errors.push(`Skill contains a category label instead of a clean value: "${skill}".`);
    }
  }
  const coverage = calculateSourceCoverage(profile, extractedText);
  if (coverage.coveragePercent < 80) {
    errors.push(
      `Only ${coverage.coveragePercent}% of meaningful source lines map to structured fields; `
      + 'the structured result is incomplete.',
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    coverage,
    counts: {
      experience: experience.length,
      projects: projects.length,
      education: education.length,
      skills: skillsCount,
    },
  };
};

const hasDateLikeValue = (value) =>
  /(?:19|20)\d{2}|[’'‘`]\d{2}|\b(?:present|current)\b/i.test(cleanText(value));

const readFirstEnvironmentValue = (names) => {
  for (const name of names) {
    const value = cleanText(process.env[name]);
    if (value) return { name, value };
  }
  return null;
};

const providerConfiguration = {
  gemini: readFirstEnvironmentValue([
    'HINTILY_GEMINI_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ]),
  groq: readFirstEnvironmentValue([
    'HINTILY_MANAGED_GROQ_API_KEY',
    'GROQ_API_KEY',
  ]),
  openai: readFirstEnvironmentValue([
    'HINTILY_MANAGED_OPENAI_API_KEY',
    'HINTLY_MANAGED_OPENAI_API_KEY',
    'OPENAI_API_KEY',
  ]),
  claude: readFirstEnvironmentValue([
    'HINTILY_MANAGED_CLAUDE_API_KEY',
    'CLAUDE_API_KEY',
    'ANTHROPIC_API_KEY',
  ]),
  deepseek: readFirstEnvironmentValue([
    'HINTILY_MANAGED_DEEPSEEK_API_KEY',
    'DEEPSEEK_API_KEY',
  ]),
};

const createCliGenerator = async () => {
  if (providerConfiguration.openai) {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: providerConfiguration.openai.value });
    const model = cleanText(
      process.env.HINTILY_MANAGED_OPENAI_MODEL
      || process.env.HINTLY_MANAGED_OPENAI_MODEL
      || process.env.OPENAI_MODEL
      || 'gpt-5.4',
    );
    return {
      label: `OpenAI ${model} (${providerConfiguration.openai.name})`,
      generate: async (contents) => {
        const prompt = contents.map((content) =>
          typeof content === 'string' ? content : content?.text || '').join('\n\n');
        const stream = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_completion_tokens: 8000,
          stream: true,
        });
        let output = '';
        for await (const chunk of stream) {
          output += chunk.choices[0]?.delta?.content || '';
        }
        return output;
      },
    };
  }

  if (providerConfiguration.gemini) {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: providerConfiguration.gemini.value });
    const model = cleanText(
      process.env.HINTILY_GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    );
    return {
      label: `Gemini ${model} (${providerConfiguration.gemini.name})`,
      generate: async (contents) => {
        const prompt = contents.map((content) =>
          typeof content === 'string' ? content : content?.text || '').join('\n\n');
        const response = await client.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: 'application/json' },
        });
        return response.text || '';
      },
    };
  }

  if (providerConfiguration.groq) {
    const { default: Groq } = await import('groq-sdk');
    const client = new Groq({ apiKey: providerConfiguration.groq.value });
    const model = cleanText(
      process.env.HINTILY_MANAGED_GROQ_MODEL || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    );
    return {
      label: `Groq ${model} (${providerConfiguration.groq.name})`,
      generate: async (contents) => {
        const prompt = contents.map((content) =>
          typeof content === 'string' ? content : content?.text || '').join('\n\n');
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        });
        return response.choices[0]?.message?.content || '';
      },
    };
  }

  if (providerConfiguration.claude) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: providerConfiguration.claude.value });
    const model = cleanText(
      process.env.HINTILY_MANAGED_CLAUDE_MODEL
      || process.env.CLAUDE_MODEL
      || 'claude-sonnet-4-6',
    );
    return {
      label: `Claude ${model} (${providerConfiguration.claude.name})`,
      generate: async (contents) => {
        const prompt = contents.map((content) =>
          typeof content === 'string' ? content : content?.text || '').join('\n\n');
        const response = await client.messages.create({
          model,
          max_tokens: 16000,
          messages: [{ role: 'user', content: prompt }],
        });
        return response.content
          .flatMap((block) => block.type === 'text' ? [block.text] : [])
          .join('');
      },
    };
  }

  if (providerConfiguration.deepseek) {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: providerConfiguration.deepseek.value,
      baseURL: 'https://api.deepseek.com',
    });
    const model = cleanText(
      process.env.HINTILY_MANAGED_DEEPSEEK_MODEL
      || process.env.DEEPSEEK_MODEL
      || 'deepseek-chat',
    );
    return {
      label: `DeepSeek ${model} (${providerConfiguration.deepseek.name})`,
      generate: async (contents) => {
        const prompt = contents.map((content) =>
          typeof content === 'string' ? content : content?.text || '').join('\n\n');
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        });
        return response.choices[0]?.message?.content || '';
      },
    };
  }

  return null;
};

try {
  const [{ extractSafeResumeDocument }, { extractResumeWithCleanup }] = await Promise.all([
    loadCompiledModule('electron/services/SafeDocumentTextExtractor.js'),
    loadCompiledModule('premium/electron/knowledge/ResumeParserRefiner.js'),
  ]);

  console.log(`[resume-extractor] Reading ${resumePath}`);
  const extracted = await extractSafeResumeDocument(resumePath);

  let generateContent = null;
  let provider = 'heuristic';

  if (!heuristicOnly) {
    const cliGenerator = await createCliGenerator();
    if (cliGenerator) {
      generateContent = cliGenerator.generate;
      provider = cliGenerator.label;
    }
  }

  if (!generateContent) {
    if (!heuristicOnly) {
      throw new Error(
        'No supported Hintily managed LLM key was found in .env. '
        + 'Configure a managed provider or rerun with --heuristic to explicitly test only the fallback.',
      );
    }
    generateContent = async () => {
      throw new Error('LLM disabled by --heuristic');
    };
  }

  console.log(`[resume-extractor] Structuring with ${provider}`);
  const result = await extractResumeWithCleanup(
    extracted.normalizedContent,
    generateContent,
    true,
  );
  const validation = validateProfile(result.data, extracted.normalizedContent);
  if (!heuristicOnly && result.extractionMode === 'heuristic') {
    validation.valid = false;
    validation.errors.push(
      'The configured LLM failed and the parser silently fell back to heuristics.',
    );
  }

  const artifactId = crypto
    .createHash('sha256')
    .update(`${extracted.binarySha256}:${extracted.fileName}`)
    .digest('hex')
    .slice(0, 12);
  const safeName = path.basename(extracted.fileName, extracted.extension)
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    || 'resume';
  const artifactDirectory = path.join(
    repositoryRoot,
    'test-results',
    'resume-extractor',
    `${safeName}-${artifactId}`,
  );
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const report = {
    file: {
      name: extracted.fileName,
      extension: extracted.extension,
      pages: extracted.pageCount ?? null,
      pagesWithText: extracted.extractedPageCount ?? null,
      ocrPages: extracted.ocrPageCount ?? 0,
      pageSources: (extracted.pages || []).map((page) => ({
        page: page.pageNumber,
        source: page.source,
        quality: Math.round(page.qualityScore * 1000) / 1000,
        ocrConfidence: page.ocrConfidence == null
          ? null
          : Math.round(page.ocrConfidence * 1000) / 1000,
      })),
      characters: extracted.normalizedContent.length,
      sha256: extracted.binarySha256,
    },
    extractionMode: result.extractionMode,
    valid: validation.valid,
    counts: validation.counts,
    errors: validation.errors,
    warnings: validation.warnings,
    coverage: validation.coverage,
  };
  fs.writeFileSync(
    path.join(artifactDirectory, 'raw.txt'),
    extracted.normalizedContent,
    'utf8',
  );
  fs.writeFileSync(
    path.join(artifactDirectory, 'structured.json'),
    `${JSON.stringify(result.data, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(artifactDirectory, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );

  console.log('\n=== Extraction summary ===');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\n[resume-extractor] Artifacts: ${artifactDirectory}`);

  console.log('\n=== Structured resume JSON ===');
  console.log(JSON.stringify(result.data, null, 2));

  process.exit(validation.valid ? 0 : 1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[resume-extractor] FAILED: ${message}`);
  process.exit(1);
}
