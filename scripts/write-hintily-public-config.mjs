import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const first = (...names) => {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
};

const required = {
  supabaseUrl: first('HINTILY_SUPABASE_URL', 'HINTLY_SUPABASE_URL', 'SUPABASE_URL'),
  supabaseAnonKey: first(
    'HINTILY_SUPABASE_ANON_KEY',
    'HINTLY_SUPABASE_ANON_KEY',
    'SUPABASE_ANON_KEY',
  ),
};

const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missing.length) {
  throw new Error(`Cannot package Hintily: missing public config values: ${missing.join(', ')}`);
}

const parsed = new URL(required.supabaseUrl);
if (parsed.protocol !== 'https:') {
  throw new Error('Packaged HINTILY_SUPABASE_URL must use HTTPS');
}

const oauthCallbackUrl =
  first('HINTILY_OAUTH_CALLBACK_URL') || 'http://127.0.0.1:54321/auth/callback';
const oauthCallback = new URL(oauthCallbackUrl);
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
const oauthPort = Number(oauthCallback.port);
if (
  oauthCallback.protocol !== 'http:'
  || !loopbackHosts.has(oauthCallback.hostname)
  || !oauthCallback.port
  || !Number.isInteger(oauthPort)
  || oauthPort < 1
  || oauthPort > 65_535
  || oauthCallback.username
  || oauthCallback.password
  || oauthCallback.search
  || oauthCallback.hash
) {
  throw new Error(
    'Packaged HINTILY_OAUTH_CALLBACK_URL must be an HTTP loopback URL with an explicit valid port',
  );
}

const requireHttpsUrl = (name, value) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`Packaged ${name} must be a valid HTTPS URL`);
  }
  if (
    parsedUrl.protocol !== 'https:'
    || parsedUrl.username
    || parsedUrl.password
  ) {
    throw new Error(`Packaged ${name} must be a valid HTTPS URL without credentials`);
  }
  return parsedUrl.toString().replace(/\/+$/, '');
};

const websiteUrl = requireHttpsUrl(
  'HINTILY_WEBSITE_URL',
  first('HINTILY_WEBSITE_URL') || 'https://hintily.app',
);
const supportUrl = requireHttpsUrl(
  'HINTILY_SUPPORT_URL',
  first('HINTILY_SUPPORT_URL') || 'https://hintily.app/support',
);
const googleCalendarClientId = first('HINTILY_GOOGLE_CALENDAR_CLIENT_ID');

const publicConfig = {
  ...required,
  oauthCallbackUrl,
  websiteUrl,
  supportUrl,
  googleCalendarClientId,
};

const destination = path.resolve('build/hintily.public-config.json');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(publicConfig, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
console.log(`Wrote desktop-safe public configuration to ${destination}`);
