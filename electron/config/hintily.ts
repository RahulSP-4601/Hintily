import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const clean = (value: string | undefined): string => (value || '').trim();

interface PackagedPublicConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  oauthCallbackUrl?: string;
  websiteUrl?: string;
  supportUrl?: string;
  googleCalendarClientId?: string;
}

let packagedConfigCache: PackagedPublicConfig | null | undefined;

const packagedConfig = (): PackagedPublicConfig => {
  if (packagedConfigCache !== undefined) return packagedConfigCache || {};
  if (!app.isPackaged) {
    packagedConfigCache = null;
    return {};
  }
  try {
    const configPath = path.join(process.resourcesPath, 'hintily.public-config.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as PackagedPublicConfig;
    packagedConfigCache = parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    packagedConfigCache = null;
  }
  return packagedConfigCache || {};
};

const first = (...names: string[]): string => {
  for (const name of names) {
    const value = clean(process.env[name]);
    if (value) return value;
  }
  return '';
};

const url = (name: string, value: string, protocols = ['https:']): string => {
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(' or ')}`);
  }
  return parsed.toString().replace(/\/+$/, '');
};

const oauthCallback = (value: string): string => {
  const parsedValue = url('HINTILY_OAUTH_CALLBACK_URL', value, ['http:']);
  const parsed = new URL(parsedValue);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (!loopbackHosts.has(parsed.hostname)) {
    throw new Error('HINTILY_OAUTH_CALLBACK_URL must use a loopback hostname');
  }
  const port = Number(parsed.port);
  if (!parsed.port || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('HINTILY_OAUTH_CALLBACK_URL must include a valid explicit port');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('HINTILY_OAUTH_CALLBACK_URL cannot include credentials, query parameters, or a fragment');
  }
  return parsedValue;
};

export type HintilyEnvironment = 'development' | 'staging' | 'production' | 'test';

export interface HintilyConfig {
  environment: HintilyEnvironment;
  supabaseUrl: string;
  supabaseAnonKey: string;
  oauthCallbackUrl: string;
  websiteUrl: string;
  supportUrl: string;
  googleCalendarClientId: string;
  configured: boolean;
  missing: string[];
}

export function getHintilyConfig(): HintilyConfig {
  const bundled = packagedConfig();
  const rawEnvironment = first('HINTILY_ENV', 'NODE_ENV') || (app.isPackaged ? 'production' : 'development');
  const environment: HintilyEnvironment =
    rawEnvironment === 'production' || rawEnvironment === 'staging' || rawEnvironment === 'test'
      ? rawEnvironment
      : 'development';

  const supabaseUrl = url(
    'HINTILY_SUPABASE_URL',
    first('HINTILY_SUPABASE_URL', 'HINTLY_SUPABASE_URL', 'SUPABASE_URL') || clean(bundled.supabaseUrl),
    environment === 'development' || environment === 'test' ? ['http:', 'https:'] : ['https:'],
  );
  const supabaseAnonKey = first(
    'HINTILY_SUPABASE_ANON_KEY',
    'HINTLY_SUPABASE_ANON_KEY',
    'SUPABASE_ANON_KEY',
  ) || clean(bundled.supabaseAnonKey);
  const oauthCallbackUrl = oauthCallback(
    first('HINTILY_OAUTH_CALLBACK_URL') || clean(bundled.oauthCallbackUrl) || 'http://127.0.0.1:54321/auth/callback',
  );
  const websiteUrl = url(
    'HINTILY_WEBSITE_URL',
    first('HINTILY_WEBSITE_URL') || clean(bundled.websiteUrl) || 'https://hintily.app',
  );
  const supportUrl = url(
    'HINTILY_SUPPORT_URL',
    first('HINTILY_SUPPORT_URL') || clean(bundled.supportUrl) || `${websiteUrl}/support`,
  );
  const googleCalendarClientId =
    first('HINTILY_GOOGLE_CALENDAR_CLIENT_ID') || clean(bundled.googleCalendarClientId);

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('HINTILY_SUPABASE_URL');
  if (!supabaseAnonKey) missing.push('HINTILY_SUPABASE_ANON_KEY');

  return {
    environment,
    supabaseUrl,
    supabaseAnonKey,
    oauthCallbackUrl,
    websiteUrl,
    supportUrl,
    googleCalendarClientId,
    configured: missing.length === 0,
    missing,
  };
}

export function assertHintilyAuthConfigured(): HintilyConfig {
  const config = getHintilyConfig();
  if (!config.configured) {
    throw new Error(`Hintily account services are not configured: ${config.missing.join(', ')}`);
  }
  return config;
}
