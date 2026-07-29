import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  extractResumeWithCleanup,
  normalizeResumeDocument,
  splitResumeSourceForExtraction,
} = await import(
  pathToFileURL(path.resolve(
    __dirname,
    '../../../dist-electron/premium/electron/knowledge/ResumeParserRefiner.js',
  )).href
);

const RAW_RESUME = `SAM PATEL
1 555 010 2222 | LinkedIn | Portfolio | Github

SUMMARY
Engineer who ships reliable products.

SELECTED IMPACT HIGHLIGHTS
● Reduced request latency by 40%, serving two million requests per day.

WORK EXPERIENCE
Senior Engineer, Example Labs — Toronto, Canada Jan '23 - Present
● Built the first customer-facing workflow with TypeScript and React.
● Automated deployment validation, reducing failed releases by 35%.

TECHNICAL SKILLS
1. Languages: TypeScript
2. Frameworks & Libraries: React
4. Databases: Firebase

[Document hyperlink targets]
https://linkedin.com/in/sam-patel
https://sam.dev
https://github.com/sampatel`;

const LABELED_LINK_RESUME = RAW_RESUME.replace(
  `[Document hyperlink targets]
https://linkedin.com/in/sam-patel
https://sam.dev
https://github.com/sampatel`,
  `PROJECTS
Project Atlas
https://atlas.example

[Document contact hyperlinks]
LinkedIn: https://linkedin.com/in/sam-patel
Website: https://sam.dev
GitHub: https://github.com/sampatel`,
);

const base = {
  identity: {
    name: 'SAM PATEL',
    summary: 'Engineer who ships reliable products. SELECTED IMPACT HIGHLIGHTS',
    linkedin: 'https://linkedin.com/in/sam-patel',
    website: 'https://sam.dev',
    github: 'https://github.com/sampatel',
  },
  skills: {
    languages: ['TypeScript'],
    frameworks: ['React'],
    cloud: [],
    databases: ['Firebase'],
    ml: [],
    devops: [],
    tools: [],
  },
  experience: [{
    role: 'Senior Engineer',
    company: 'Example Labs',
    start_date: '2023-01',
    end_date: null,
    bullets: ['Built the first customer-facing workflow with TypeScript and React.'],
  }],
  projects: [],
  education: [],
  achievements: ['Reduced request latency by 40%, serving two million requests per day.'],
  certifications: [],
  leadership: [],
};

describe('ResumeParserRefiner completeness reconciliation', () => {
  test('losslessly chunks resume content beyond provider prompt limits', async () => {
    const tailMarker = 'TAIL EXPERIENCE THAT MUST NOT BE DROPPED';
    const longResume = `${RAW_RESUME}\n${'Background detail. '.repeat(1900)}\n${tailMarker}`;
    const prompts = [];
    await extractResumeWithCleanup(
      longResume,
      async ([content]) => {
        prompts.push(content.text);
        return base;
      },
      true,
    );
    const chunks = splitResumeSourceForExtraction(longResume);
    assert.equal(chunks.join(''), longResume);
    assert.ok(chunks.every((chunk) => chunk.length <= 28_000));
    assert.equal(prompts.length >= chunks.length, true);
    assert.ok(prompts.some((prompt) => prompt.includes(tailMarker)));
    // The source is losslessly distributed across bounded requests. Repair
    // prompts may also carry bounded structured context and validation notes.
    assert.ok(prompts.every((prompt) => prompt.length < 150_000));
  });

  test('rejects oversized resumes before issuing any provider requests', async () => {
    let providerCalls = 0;
    const oversizedResume = 'A'.repeat((28_000 * 4) + 1);
    await assert.rejects(
      extractResumeWithCleanup(
        oversizedResume,
        async () => {
          providerCalls += 1;
          return base;
        },
        true,
      ),
      /112,000 character limit/,
    );
    assert.equal(providerCalls, 0);
  });

  test('keeps accepted resumes within the four-chunk provider budget', () => {
    const boundaryHeavyResume = `${'A'.repeat(16_800)}\n`.repeat(6)
      + 'B'.repeat(11_194);
    assert.equal(boundaryHeavyResume.length, 112_000);
    const chunks = splitResumeSourceForExtraction(boundaryHeavyResume);
    assert.equal(chunks.join(''), boundaryHeavyResume);
    assert.ok(chunks.length <= 4);
    assert.ok(chunks.every((chunk) => chunk.length <= 28_000));
  });

  test('preserves successful extraction chunks when another provider request fails', async () => {
    const longResume = `${RAW_RESUME}\n${'Background detail. '.repeat(1900)}\nSECOND CHUNK`;
    const result = await extractResumeWithCleanup(
      longResume,
      async ([content]) => {
        if (/source chunk 2 of \d+/i.test(content.text)) {
          throw new Error('temporary provider failure');
        }
        return base;
      },
      true,
    );

    assert.equal(result.data.identity.name, 'SAM PATEL');
    assert.equal(result.data.identity.linkedin, 'https://linkedin.com/in/sam-patel');
    assert.equal(result.data._parser_metadata.used_llm_repair, false);
  });

  test('distinguishes a missing end date from an explicitly current role', () => {
    const historical = structuredClone(base);
    delete historical.experience[0].end_date;
    historical.experience[0].source_span = [
      "Senior Engineer, Example Labs — Toronto, Canada Jan '23 - Dec '24",
    ];

    const historicalResult = normalizeResumeDocument(historical).data;
    const currentResult = normalizeResumeDocument(structuredClone(base)).data;

    assert.equal(historicalResult.experience[0].end_date, '2024-12');
    assert.equal(currentResult.experience[0].end_date, null);
  });

  test('merges duplicate logical entries emitted on adjacent source chunks', async () => {
    const longResume = `SAM PATEL\nWORK EXPERIENCE\n${'Background detail without bullets. '.repeat(1900)}`;
    const result = await extractResumeWithCleanup(
      longResume,
      async ([content]) => {
        const candidate = structuredClone(base);
        candidate.experience[0].end_date = '2024-12';
        candidate.experience[0].bullets = content.text.includes('source chunk 2 of')
          ? ['Delivered the second chunk accomplishment.']
          : ['Delivered the first chunk accomplishment.'];
        return candidate;
      },
      true,
    );

    assert.equal(result.data.experience.length, 1);
    assert.deepEqual(result.data.experience[0].bullets, [
      'Delivered the first chunk accomplishment.',
      'Delivered the second chunk accomplishment.',
    ]);
  });

  test('runs recovery when a primary chunk fails even if completeness checks otherwise pass', async () => {
    const longResume = `${RAW_RESUME}\n${'Background detail. '.repeat(1900)}\nSECOND CHUNK`;
    let repairRequests = 0;
    const result = await extractResumeWithCleanup(
      longResume,
      async ([content]) => {
        if (/^Repair and normalize/i.test(content.text)) {
          repairRequests += 1;
          return base;
        }
        if (/source chunk 2 of \d+/i.test(content.text)) {
          throw new Error('temporary primary failure');
        }
        return base;
      },
      true,
    );

    assert.ok(repairRequests > 0, 'a partial primary failure must trigger recovery');
    assert.equal(result.data.identity.name, 'SAM PATEL');
    assert.match(result.data._parser_metadata.primary_failure, /primary extraction chunks failed/);
  });

  test('runs recovery when a primary chunk returns malformed JSON without throwing', async () => {
    const longResume = `${RAW_RESUME}\n${'Background detail. '.repeat(1900)}\nSECOND CHUNK`;
    let repairRequests = 0;
    const result = await extractResumeWithCleanup(
      longResume,
      async ([content]) => {
        if (/^Repair and normalize/i.test(content.text)) {
          repairRequests += 1;
          return base;
        }
        if (/source chunk 2 of \d+/i.test(content.text)) {
          return 'This is not JSON.';
        }
        return base;
      },
      true,
    );

    assert.ok(repairRequests > 0, 'invalid primary JSON must trigger recovery');
    assert.match(result.data._parser_metadata.primary_failure, /invalid JSON/);
  });

  test('retains successful repair chunks and retries only failed repair chunks', async () => {
    const longResume = `${RAW_RESUME}\n${'Background detail. '.repeat(1900)}\nSECOND CHUNK`;
    const repairAttemptsByChunk = new Map();
    const completeRepair = structuredClone(base);
    completeRepair.experience[0].location = 'Toronto, Canada';
    completeRepair.experience[0].bullets.push(
      'Automated deployment validation, reducing failed releases by 35%.',
    );
    const result = await extractResumeWithCleanup(
      longResume,
      async ([content]) => {
        const chunkMatch = content.text.match(/source chunk (\d+) of \d+/i);
        const chunkNumber = Number(chunkMatch?.[1] || 1);
        if (/^Extract this resume/i.test(content.text) && chunkNumber === 2) {
          throw new Error('temporary primary failure');
        }
        if (/^Repair and normalize/i.test(content.text)) {
          const attempts = (repairAttemptsByChunk.get(chunkNumber) || 0) + 1;
          repairAttemptsByChunk.set(chunkNumber, attempts);
          if (chunkNumber === 2 && attempts === 1) {
            throw new Error('temporary repair failure');
          }
          return completeRepair;
        }
        return base;
      },
      true,
    );

    assert.equal(repairAttemptsByChunk.get(1), 1);
    assert.equal(repairAttemptsByChunk.get(2), 2);
    assert.equal(result.data.identity.name, 'SAM PATEL');
    assert.equal(result.extractionMode, 'llm_repaired');
  });

  test('retries semantic repair when every request succeeds but evidence is still missing', async () => {
    let repairRequests = 0;
    const repaired = structuredClone(base);
    repaired.experience[0].location = 'Toronto, Canada';
    repaired.experience[0].bullets.push(
      'Automated deployment validation, reducing failed releases by 35%.',
    );
    const result = await extractResumeWithCleanup(
      RAW_RESUME,
      async ([content]) => {
        if (/^Repair and normalize/i.test(content.text)) {
          repairRequests += 1;
          return repairRequests === 1 ? base : repaired;
        }
        return base;
      },
      true,
    );

    assert.equal(repairRequests, 2);
    assert.equal(result.data.experience[0].location, 'Toronto, Canada');
    assert.ok(result.data.experience[0].bullets.includes(
      'Automated deployment validation, reducing failed releases by 35%.',
    ));
  });

  test('audits labeled contact hyperlinks without treating an earlier project URL as identity', async () => {
    const prompts = [];
    const result = await extractResumeWithCleanup(
      LABELED_LINK_RESUME,
      async ([content]) => {
        prompts.push(content.text);
        return base;
      },
      true,
    );

    assert.equal(result.data.identity.website, 'https://sam.dev');
    assert.equal(prompts.some((prompt) =>
      prompt.includes('Missing document hyperlink') && prompt.includes('atlas.example')), false);
  });

  test('repairs missing source evidence without losing categories or splitting commas', async () => {
    const repaired = structuredClone(base);
    repaired.experience[0].location = 'Toronto, Canada';
    repaired.experience[0].bullets.push(
      'Automated deployment validation, reducing failed releases by 35%.',
    );

    const prompts = [];
    const result = await extractResumeWithCleanup(
      RAW_RESUME,
      async ([content]) => {
        prompts.push(content.text);
        return prompts.length === 1 ? base : repaired;
      },
      true,
    );

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Missing source bullet/);
    assert.match(prompts[1], /Missing experience location/);
    assert.equal(result.extractionMode, 'llm_repaired');
    assert.deepEqual(result.data.skills.databases, ['Firebase']);
    assert.deepEqual(result.data.achievements, [
      'Reduced request latency by 40%, serving two million requests per day.',
    ]);
    assert.equal(result.data.experience[0].location, 'Toronto, Canada');
    assert.equal(result.data.experience[0].bullets.length, 2);
    assert.equal(result.data.identity.summary, 'Engineer who ships reliable products.');
  });

  test('deterministically preserves an omitted source bullet when repair still misses it', async () => {
    const result = await extractResumeWithCleanup(
      RAW_RESUME,
      async () => base,
      true,
    );

    assert.ok(result.data.experience[0].bullets.includes(
      'Automated deployment validation, reducing failed releases by 35%.',
    ));
    assert.equal(result.data._parser_metadata.source_bullets_recovered, 1);
    assert.deepEqual(result.data._parser_metadata.unresolved_source_items, []);
  });

  test('normalizes structured achievement objects without leaking object coercion text', async () => {
    const structured = structuredClone(base);
    structured.achievements = [{
      title: 'Hackathon winner',
      description: 'Won first place at the regional final.',
      year: 2025,
    }];

    const result = await extractResumeWithCleanup(
      RAW_RESUME,
      async () => structured,
      true,
    );

    assert.ok(result.data.achievements.some((item) =>
      item.includes('Hackathon winner: Won first place at the regional final.')));
    assert.equal(result.data.achievements.includes('[object Object]'), false);
  });
});
