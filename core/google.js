import { google } from "googleapis";

export function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return {
      ok: false,
      error: {
        message: "Missing Google OAuth environment variables.",
        missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"].filter((name) => !process.env[name])
      }
    };
  }

  const client = new google.auth.OAuth2(clientId, clientSecret, "http://localhost:3000/oauth2callback");
  client.setCredentials({ refresh_token: refreshToken });
  return { ok: true, client };
}
