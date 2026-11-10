// The settings the server shares with the app, read from the same variables with the same
// defaults as app.ts (which the server can't import: it uses Exact's packages, built only by Exact).
export const API: string = process.env.API_BASE_URL ?? 'http://127.0.0.1:8787';
export const CLIENTS = {
  appId: 'app.exalt.audiobooks',
  appleWeb: process.env.APPLE_SERVICES_ID ?? 'app.exalt.audiobooks.web',
  googleWeb: process.env.GOOGLE_WEB_CLIENT_ID ?? 'exalt-web.apps.googleusercontent.com',
  googleIos: process.env.GOOGLE_IOS_CLIENT_ID ?? 'exalt-ios.apps.googleusercontent.com',
};
