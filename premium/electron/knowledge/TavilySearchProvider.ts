import { tavily } from '@tavily/core';
import type { CompanySearchProvider, CompanySearchResult } from './CompanyResearchEngine';

export class TavilySearchProvider implements CompanySearchProvider {
  public quotaExhausted = false;
  private readonly client: ReturnType<typeof tavily>;

  constructor(apiKey: string) {
    const key = apiKey.trim();
    if (!key) throw new Error('Tavily API key is required');
    this.client = tavily({ apiKey: key, clientName: 'hintily' });
  }

  async search(query: string): Promise<CompanySearchResult[]> {
    const cleanQuery = query.trim().slice(0, 500);
    if (!cleanQuery) return [];
    try {
      const response = await this.client.search(cleanQuery, {
        searchDepth: 'advanced',
        maxResults: 5,
        includeRawContent: 'text',
        timeout: 15,
      });
      return response.results.map(result => ({
        title: result.title || '',
        url: result.url,
        content: result.rawContent || result.content || '',
        publishedDate: result.publishedDate,
      }));
    } catch (error: any) {
      const status = Number(error?.status || error?.response?.status);
      const message = String(error?.message || '');
      if (status === 402 || status === 429 || /quota|credit|rate limit/i.test(message)) {
        this.quotaExhausted = true;
      }
      throw error;
    }
  }
}
